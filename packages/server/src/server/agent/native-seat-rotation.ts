import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";

const execFile = promisify(execFileCallback);

const CheckpointSchema = z.object({
  operationId: z.string().uuid(),
  generation: z.number().int().positive(),
  sessionId: z.string().min(1),
  repoPath: z.string().min(1),
  sourceRevision: z.string().regex(/^[a-f0-9]{7,64}$/i),
  dirtyDisposition: z.literal("clean"),
  nextAction: z.string().min(1),
});

const JournalSchema = z.object({
  version: z.literal(1),
  operationId: z.string().uuid(),
  predecessorId: z.string().uuid(),
  generation: z.number().int().positive(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  checkpointPath: z.string(),
  checkpointHash: z.string().regex(/^[a-f0-9]{64}$/),
  workspaceId: z.string().nullable(),
  sourceRevision: z.string().regex(/^[a-f0-9]{7,64}$/i),
  revision: z.number().int().nonnegative(),
  state: z.enum([
    "requested",
    "admitted",
    "prepared",
    "archived",
    "resume_uncertain",
    "resume_started",
    "cancelled",
    "cancelled_after_fence",
    "blocked",
  ]),
  successorId: z.string().uuid().optional(),
  error: z.string().optional(),
  updatedAt: z.string(),
});

export type NativeSeatRotationJournal = z.infer<typeof JournalSchema>;

export interface NativeSeatRotationRequest {
  operationId: string;
  predecessorId: string;
  generation: number;
  handoverRoot: string;
  checkpointPath: string;
  /** The checkpoint's nextAction is carried as data; only this explicit input is sent to a provider. */
  resumePrompt: string;
}

export interface NativeSeatRotationResult {
  accepted: boolean;
  operation: NativeSeatRotationJournal;
}

export interface NativeSeatRotationClientState {
  operationId: string;
  phase: "pending" | "succeeded" | "failed";
  successorId: string | null;
  workspaceId: string | null;
  sourceRevision: string;
  revision: number;
  failureCode: string | null;
}

interface ValidatedCheckpoint {
  checkpoint: z.infer<typeof CheckpointSchema>;
  checkpointPath: string;
  checkpointHash: string;
  repoPath: string;
}

/**
 * Daemon-owned handover operation. It does not decide when a rotation should
 * occur; callers must provide a checkpoint and explicit resume prompt. Unknown
 * outcomes remain in the receipt and are never replayed blindly.
 */
export class NativeSeatRotationService {
  private readonly resumeTails = new Map<string, Promise<void>>();
  /**
   * Serialises admission and Stop for one durable operation. The cancellation
   * file remains the crash-safe latch; this tail prevents Stop from releasing
   * an in-memory admission before rotate has acquired it.
   */
  private readonly operationTails = new Map<string, Promise<void>>();

  constructor(
    private readonly options: {
      paseoHome: string;
      agentManager: AgentManager;
      agentStorage: AgentStorage;
    },
  ) {}

  async rotate(request: NativeSeatRotationRequest): Promise<NativeSeatRotationResult> {
    return await this.withOperationLock(
      request.operationId,
      async () => await this.rotateUnlocked(request),
    );
  }

  private async rotateUnlocked(
    request: NativeSeatRotationRequest,
  ): Promise<NativeSeatRotationResult> {
    const fingerprint = digest(request);
    const existing = await this.read(request.operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new Error("rotation operation fingerprint mismatch");
      return {
        accepted: ["archived", "resume_uncertain", "resume_started"].includes(existing.state),
        operation: existing,
      };
    }

    const predecessor = this.options.agentManager.getAgent(request.predecessorId);
    if (!predecessor || predecessor.lifecycle === "closed") {
      throw new Error("rotation predecessor is not a live session");
    }
    const checkpoint = await this.validateCheckpoint(request, predecessor);
    await this.claimGeneration(request);

    let journal = await this.write({
      version: 1,
      operationId: request.operationId,
      predecessorId: request.predecessorId,
      generation: request.generation,
      fingerprint,
      checkpointPath: checkpoint.checkpointPath,
      checkpointHash: checkpoint.checkpointHash,
      workspaceId: predecessor.workspaceId ?? null,
      sourceRevision: checkpoint.checkpoint.sourceRevision,
      revision: 0,
      state: "requested",
      updatedAt: new Date().toISOString(),
    });

    try {
      this.options.agentManager.beginNativeSeatRotationAdmission(request.predecessorId, {
        operationId: request.operationId,
        generation: request.generation,
      });
    } catch (error) {
      journal = await this.write({ ...journal, state: "blocked", error: errorMessage(error) });
      throw error;
    }
    journal = await this.write({ ...journal, state: "admitted" });

    try {
      const successorId = randomUUID();
      // Persist the successor identity before createSession. If the process dies
      // after a provider acknowledgement, recovery can inspect this one ID and
      // must not make another create call.
      journal = await this.write({ ...journal, state: "prepared", successorId });
      const successor = await this.options.agentManager.createAgent(
        { ...predecessor.config },
        successorId,
        {
          labels: { ...predecessor.labels },
          initialTitle: predecessor.config.title,
          workspaceId: predecessor.workspaceId,
          owner: predecessor.owner,
        },
      );
      this.assertPreparedSuccessor({ predecessor, successor, checkpoint });

      if (await this.isCancelled(request.operationId)) {
        return await this.stopBeforeArchive(journal);
      }

      await this.options.agentManager.archiveAgent(request.predecessorId);
      journal = await this.write({ ...journal, state: "archived" });

      if (await this.isCancelled(request.operationId)) {
        return await this.stopAfterFence(journal);
      }

      // Persist uncertainty before the provider can accept the resume prompt.
      // A restart at this point must reconcile the recorded successor, never
      // create a replacement or repeat the prompt.
      journal = await this.write({ ...journal, state: "resume_uncertain" });
      const stream = this.options.agentManager.streamAgent(successor.id, request.resumePrompt, {
        clientMessageId: `seat-rotation:${request.operationId}`,
      });
      const drain = this.drainResume(stream, journal);
      this.resumeTails.set(request.operationId, drain);
      void drain.finally(() => {
        if (this.resumeTails.get(request.operationId) === drain) {
          this.resumeTails.delete(request.operationId);
        }
      });
      return { accepted: true, operation: journal };
    } catch (error) {
      const latest = await this.read(request.operationId);
      if (
        latest &&
        !["resume_uncertain", "cancelled", "cancelled_after_fence"].includes(latest.state)
      ) {
        await this.write({ ...latest, state: "blocked", error: errorMessage(error) });
      }
      throw error;
    }
  }

  async cancel(operationId: string): Promise<NativeSeatRotationResult> {
    // Latch synchronously with the caller, before waiting for an in-flight
    // rotate. rotate re-reads this durable marker at both irreversible edges.
    await this.requireJournal(operationId);
    await writeJsonDurably(this.cancellationPath(operationId), {
      operationId,
      requestedAt: new Date(),
    });
    return await this.withOperationLock(
      operationId,
      async () => await this.cancelUnlocked(operationId),
    );
  }

  private async cancelUnlocked(operationId: string): Promise<NativeSeatRotationResult> {
    const journal = await this.requireJournal(operationId);
    if (["cancelled", "cancelled_after_fence"].includes(journal.state)) {
      return { accepted: false, operation: journal };
    }
    await writeJsonDurably(this.cancellationPath(operationId), {
      operationId,
      requestedAt: new Date(),
    });
    if (["requested", "admitted", "prepared"].includes(journal.state)) {
      return await this.stopBeforeArchive(journal);
    }
    return await this.stopAfterFence(journal);
  }

  async read(operationId: string): Promise<NativeSeatRotationJournal | null> {
    try {
      return JournalSchema.parse(
        JSON.parse(await fs.readFile(this.operationPath(operationId), "utf8")),
      );
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async inspect(operationId: string): Promise<NativeSeatRotationClientState | null> {
    const journal = await this.read(operationId);
    return journal ? clientState(journal) : null;
  }

  async waitForOperation(operationId: string): Promise<void> {
    await this.resumeTails.get(operationId);
  }

  private async drainResume(
    stream: AsyncGenerator<unknown>,
    journal: NativeSeatRotationJournal,
  ): Promise<void> {
    try {
      for await (const _event of stream) {
        // AgentManager owns stream fan-out and durable timeline writes.
      }
      if (!(await this.isCancelled(journal.operationId))) {
        await this.write({ ...journal, state: "resume_started" });
      }
    } catch (error) {
      if (!(await this.isCancelled(journal.operationId))) {
        await this.write({ ...journal, state: "blocked", error: errorMessage(error) });
      }
    }
  }

  private async stopBeforeArchive(
    journal: NativeSeatRotationJournal,
  ): Promise<NativeSeatRotationResult> {
    if (journal.successorId) await this.options.agentManager.closeAgent(journal.successorId);
    this.options.agentManager.endNativeSeatRotationAdmission(
      journal.predecessorId,
      journal.operationId,
    );
    return { accepted: false, operation: await this.write({ ...journal, state: "cancelled" }) };
  }

  private async stopAfterFence(
    journal: NativeSeatRotationJournal,
  ): Promise<NativeSeatRotationResult> {
    if (journal.successorId) {
      await this.options.agentManager.cancelAgentRun(journal.successorId).catch(() => undefined);
      await this.options.agentManager.closeAgent(journal.successorId).catch(() => undefined);
    }
    return {
      accepted: false,
      operation: await this.write({ ...journal, state: "cancelled_after_fence" }),
    };
  }

  private async validateCheckpoint(
    request: NativeSeatRotationRequest,
    predecessor: ManagedAgent,
  ): Promise<ValidatedCheckpoint> {
    if (!predecessor.persistence?.sessionId)
      throw new Error("predecessor has no durable provider session");
    await Promise.all([
      refuseSymlinks(request.handoverRoot),
      refuseSymlinks(request.checkpointPath),
      refuseSymlinks(predecessor.cwd),
    ]);
    const [handoverRoot, checkpointPath, repoPath] = await Promise.all([
      fs.realpath(request.handoverRoot),
      fs.realpath(request.checkpointPath),
      fs.realpath(predecessor.cwd),
    ]);
    requireWithin(handoverRoot, checkpointPath, "checkpoint is outside handover root");
    requireWithin(repoPath, handoverRoot, "handover root is outside predecessor repository");
    const raw = await fs.readFile(checkpointPath);
    const checkpointHash = createHash("sha256").update(raw).digest("hex");
    const checkpoint = CheckpointSchema.parse(JSON.parse(raw.toString("utf8")));
    if (
      checkpoint.operationId !== request.operationId ||
      checkpoint.generation !== request.generation ||
      checkpoint.sessionId !== predecessor.persistence.sessionId ||
      checkpoint.repoPath !== repoPath
    ) {
      throw new Error("checkpoint provenance does not match predecessor identity");
    }
    const snapshot = await readCleanGitSnapshot(repoPath, checkpointPath);
    if (snapshot.sourceRevision !== checkpoint.sourceRevision) {
      throw new Error("checkpoint source revision no longer matches the repository");
    }
    return { checkpoint, checkpointPath, checkpointHash, repoPath };
  }

  private assertPreparedSuccessor(input: {
    predecessor: ManagedAgent;
    successor: ManagedAgent;
    checkpoint: ValidatedCheckpoint;
  }): void {
    const { predecessor, successor, checkpoint } = input;
    if (
      successor.lifecycle === "closed" ||
      successor.id === predecessor.id ||
      !successor.persistence?.sessionId ||
      successor.persistence.sessionId === predecessor.persistence?.sessionId ||
      successor.cwd !== checkpoint.repoPath ||
      successor.provider !== predecessor.provider ||
      JSON.stringify(successor.config) !== JSON.stringify(predecessor.config)
    ) {
      throw new Error("successor preparation does not preserve a distinct safe session");
    }
  }

  private async claimGeneration(request: NativeSeatRotationRequest): Promise<void> {
    const directory = this.generationLockPath(request.predecessorId, request.generation);
    await fs.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
    try {
      await fs.mkdir(directory, { recursive: false, mode: 0o700 });
      await writeJsonDurably(path.join(directory, "owner.json"), {
        operationId: request.operationId,
        predecessorId: request.predecessorId,
        generation: request.generation,
      });
    } catch (error) {
      if (isAlreadyExists(error)) {
        const owner = await fs
          .readFile(path.join(directory, "owner.json"), "utf8")
          .then((value) => JSON.parse(value) as { operationId?: string })
          .catch((): { operationId?: string } => ({}));
        if (owner.operationId === request.operationId) return;
        throw new Error("predecessor generation already has a native rotation admission", {
          cause: error,
        });
      }
      throw error;
    }
  }

  private async isCancelled(operationId: string): Promise<boolean> {
    return await fs
      .access(this.cancellationPath(operationId))
      .then(() => true)
      .catch(() => false);
  }

  private async requireJournal(operationId: string): Promise<NativeSeatRotationJournal> {
    const journal = await this.read(operationId);
    if (!journal) throw new Error("rotation operation is unknown");
    return journal;
  }

  private async write(journal: NativeSeatRotationJournal): Promise<NativeSeatRotationJournal> {
    const next = {
      ...journal,
      revision: journal.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    await writeJsonDurably(this.operationPath(next.operationId), next);
    return next;
  }

  private async withOperationLock<T>(operationId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.operationTails.get(operationId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => tail);
    this.operationTails.set(operationId, queued);
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.operationTails.get(operationId) === queued) {
        this.operationTails.delete(operationId);
      }
    }
  }

  private operationPath(operationId: string): string {
    return path.join(this.options.paseoHome, "seat-rotations", "operations", `${operationId}.json`);
  }

  private cancellationPath(operationId: string): string {
    return path.join(
      this.options.paseoHome,
      "seat-rotations",
      "cancellations",
      `${operationId}.json`,
    );
  }

  private generationLockPath(predecessorId: string, generation: number): string {
    return path.join(
      this.options.paseoHome,
      "seat-rotations",
      "admissions",
      `${predecessorId}.${generation}.lock`,
    );
  }
}

async function readCleanGitSnapshot(
  repoPath: string,
  checkpointPath: string,
): Promise<{ sourceRevision: string }> {
  const [{ stdout: revision }, { stdout: dirty }] = await Promise.all([
    execFile("git", ["-C", repoPath, "rev-parse", "HEAD"]),
    execFile("git", ["-C", repoPath, "status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  const checkpointRelative = path.relative(repoPath, checkpointPath);
  const unrelatedDirty = dirty
    .split("\n")
    .filter(Boolean)
    // The checkpoint is expected to be a handover artefact and is protected by
    // its recorded hash. Every other dirty path remains unsupported.
    .filter((line) => line.slice(3) !== checkpointRelative);
  if (unrelatedDirty.length > 0) throw new Error("dirty worktree rotation is unsupported");
  return { sourceRevision: revision.trim() };
}

async function refuseSymlinks(value: string): Promise<void> {
  if (!path.isAbsolute(value)) throw new Error("rotation paths must be absolute");
  const parsed = path.parse(path.resolve(value));
  let current = parsed.root;
  for (const part of path
    .resolve(value)
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) {
      // macOS exposes /var as a system alias for /private/var. It is outside
      // caller control and is how tmpdir commonly reaches test/runtime state.
      if (current === "/var" && (await fs.realpath(current)) === "/private/var") continue;
      throw new Error(`symlink refused: ${current}`);
    }
  }
}

function requireWithin(root: string, candidate: string, message: string): void {
  const relative = path.relative(root, candidate);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(message);
  }
}

async function writeJsonDurably(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, filePath);
  const directoryHandle = await fs.open(directory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clientState(journal: NativeSeatRotationJournal): NativeSeatRotationClientState {
  const succeeded = ["archived", "resume_uncertain", "resume_started"].includes(journal.state);
  const failed = ["blocked", "cancelled", "cancelled_after_fence"].includes(journal.state);
  let phase: NativeSeatRotationClientState["phase"] = "pending";
  if (succeeded) phase = "succeeded";
  if (failed) phase = "failed";
  return {
    operationId: journal.operationId,
    phase,
    successorId: succeeded ? (journal.successorId ?? null) : null,
    workspaceId: succeeded ? journal.workspaceId : null,
    sourceRevision: journal.sourceRevision,
    revision: journal.revision,
    // Do not return provider or filesystem errors to another client.
    failureCode: failed ? journal.state : null,
  };
}
