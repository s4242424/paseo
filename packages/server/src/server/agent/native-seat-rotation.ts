import { createHash, randomUUID } from "node:crypto";
import { promises as fs, readFileSync, readdirSync } from "node:fs";
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
  /** Last committed predecessor timeline sequence when this checkpoint was made. */
  timelineRevision: z.number().int().nonnegative(),
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
    "resumed",
    "resume_failed",
    "cancelled",
    "cancelled_after_fence",
    "cancel_uncertain",
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

export interface NativeSeatRotationCancelResult {
  accepted: boolean;
  operation: NativeSeatRotationJournal | null;
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
  /** Covers the pre-journal window for a normal predecessor Stop in this daemon. */
  private readonly predecessorOperations = new Map<string, string>();
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
      isEnabled?: () => boolean;
    },
  ) {
    this.options.agentManager.setNativeSeatRotationAdmissionLookup((agentId) =>
      this.getDurableAdmission(agentId),
    );
  }

  isEnabled(): boolean {
    return this.options.isEnabled?.() === true;
  }

  async rotate(request: NativeSeatRotationRequest): Promise<NativeSeatRotationResult> {
    this.predecessorOperations.set(request.predecessorId, request.operationId);
    try {
      return await this.withOperationLock(
        request.operationId,
        async () => await this.rotateUnlocked(request),
      );
    } catch (error) {
      if (!(await this.read(request.operationId))) {
        this.predecessorOperations.delete(request.predecessorId);
      }
      throw error;
    }
  }

  private async rotateUnlocked(
    request: NativeSeatRotationRequest,
  ): Promise<NativeSeatRotationResult> {
    if (!this.isEnabled())
      throw new Error("native seat rotation is disabled by daemon configuration");
    const fingerprint = digest(request);
    const existing = await this.read(request.operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new Error("rotation operation fingerprint mismatch");
      return {
        accepted: ["archived", "resume_uncertain", "resume_started", "resumed"].includes(
          existing.state,
        ),
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

    if (await this.isCancelledFor(request.operationId, request.predecessorId)) {
      return await this.stopBeforeArchive(journal);
    }

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
      // validateCheckpoint reads the real repository and checkpoint after the
      // manager fence, not only before it. Provider work can complete while the
      // first validation is awaiting git/filesystem reads.
      const revalidatedPredecessor = this.options.agentManager.getAgent(request.predecessorId);
      if (!revalidatedPredecessor || revalidatedPredecessor.lifecycle === "closed") {
        throw new Error("rotation predecessor changed before successor preparation");
      }
      const revalidatedCheckpoint = await this.validateCheckpoint(request, revalidatedPredecessor);
      this.assertPredecessorUnchanged(
        predecessor,
        revalidatedPredecessor,
        checkpoint,
        revalidatedCheckpoint,
      );
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

      if (await this.isCancelledFor(request.operationId, request.predecessorId)) {
        return await this.stopBeforeArchive(journal);
      }

      const beforeArchive = this.options.agentManager.getAgent(request.predecessorId);
      if (!beforeArchive || beforeArchive.lifecycle === "closed") {
        throw new Error("rotation predecessor changed before archive");
      }
      const checkpointBeforeArchive = await this.validateCheckpoint(request, beforeArchive);
      this.assertPredecessorUnchanged(
        predecessor,
        beforeArchive,
        checkpoint,
        checkpointBeforeArchive,
      );

      await this.options.agentManager.archiveAgent(request.predecessorId);
      journal = await this.write({ ...journal, state: "archived" });

      if (await this.isCancelledFor(request.operationId, request.predecessorId)) {
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
        if (["requested", "admitted", "prepared"].includes(latest.state)) {
          await this.releaseFailedPreparation(latest);
        }
        await this.write({ ...latest, state: "blocked", error: errorMessage(error) });
      }
      throw error;
    }
  }

  async cancel(
    operationId: string,
    predecessorId?: string,
  ): Promise<NativeSeatRotationCancelResult> {
    // Latch synchronously with the caller, before waiting for an in-flight
    // rotate. rotate re-reads this durable marker at both irreversible edges.
    const existing = await this.read(operationId);
    if (existing && predecessorId && existing.predecessorId !== predecessorId) {
      throw new Error("rotation cancellation predecessor does not match the operation");
    }
    if (!existing && !predecessorId) {
      throw new Error(
        "rotation operation is unknown; predecessor binding is required before admission",
      );
    }
    await writeJsonDurably(this.cancellationPath(operationId), {
      operationId,
      predecessorId: predecessorId ?? existing!.predecessorId,
      requestedAt: new Date(),
    });
    if (!existing) return { accepted: true, operation: null };
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
      predecessorId: journal.predecessorId,
      requestedAt: new Date(),
    });
    if (["requested", "admitted", "prepared"].includes(journal.state)) {
      return await this.stopBeforeArchive(journal);
    }
    return await this.stopAfterFence(journal);
  }

  async cancelForPredecessor(
    predecessorId: string,
  ): Promise<NativeSeatRotationCancelResult | null> {
    const pendingOperationId = this.predecessorOperations.get(predecessorId);
    if (pendingOperationId) return await this.cancel(pendingOperationId, predecessorId);
    const state = await this.inspectByPredecessor(predecessorId);
    if (!state) return null;
    return await this.cancel(state.operationId, predecessorId);
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

  /** Lookup is intentionally by predecessor so an app reconnect can recover an
   * operation ID after its local optimistic state was lost. */
  async inspectByPredecessor(predecessorId: string): Promise<NativeSeatRotationClientState | null> {
    const directory = path.join(this.options.paseoHome, "seat-rotations", "operations");
    let entries: string[];
    try {
      entries = await fs.readdir(directory);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    const candidates = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => this.read(entry.slice(0, -5))),
    );
    const journal = candidates
      .filter(
        (candidate): candidate is NativeSeatRotationJournal =>
          candidate?.predecessorId === predecessorId,
      )
      .sort((a, b) => b.revision - a.revision || b.updatedAt.localeCompare(a.updatedAt))[0];
    return journal ? clientState(journal) : null;
  }

  async waitForOperation(operationId: string): Promise<void> {
    await this.resumeTails.get(operationId);
  }

  private async drainResume(
    stream: AsyncGenerator<unknown>,
    journal: NativeSeatRotationJournal,
  ): Promise<void> {
    let completed = false;
    try {
      for await (const event of stream) {
        // AgentManager owns stream fan-out and durable timeline writes.
        if (isTurnCompleted(event)) completed = true;
      }
      await this.withOperationLock(journal.operationId, async () => {
        const latest = await this.requireJournal(journal.operationId);
        if (await this.isCancelledFor(journal.operationId, journal.predecessorId)) return;
        if (completed) {
          await this.write({ ...latest, state: "resumed", error: undefined });
          // The provider's final idle event is emitted before the receipt is
          // durable. Re-emit the normal successor state after the receipt so a
          // connected client can inspect the terminal operation without polling.
          if (latest.successorId) this.options.agentManager.notifyAgentState(latest.successorId);
          return;
        }
        await this.write({
          ...latest,
          state: "resume_failed",
          error: "successor resume ended before established liveness",
        });
      });
    } catch (error) {
      await this.withOperationLock(journal.operationId, async () => {
        if (await this.isCancelledFor(journal.operationId, journal.predecessorId)) return;
        const latest = await this.requireJournal(journal.operationId);
        await this.write({ ...latest, state: "resume_failed", error: errorMessage(error) });
      });
    }
  }

  private async stopBeforeArchive(
    journal: NativeSeatRotationJournal,
  ): Promise<NativeSeatRotationResult> {
    try {
      if (journal.successorId) await this.options.agentManager.closeAgent(journal.successorId);
    } catch (error) {
      return {
        accepted: false,
        operation: await this.write({
          ...journal,
          state: "cancel_uncertain",
          error: errorMessage(error),
        }),
      };
    }
    this.options.agentManager.endNativeSeatRotationAdmission(
      journal.predecessorId,
      journal.operationId,
    );
    return { accepted: false, operation: await this.write({ ...journal, state: "cancelled" }) };
  }

  /** A pre-fence failure leaves the predecessor usable rather than stranded. */
  private async releaseFailedPreparation(journal: NativeSeatRotationJournal): Promise<void> {
    if (journal.successorId) {
      try {
        await this.options.agentManager.closeAgent(journal.successorId);
      } catch {
        // The retained successor ID lets repair reconcile a close failure.
      }
    }
    this.options.agentManager.endNativeSeatRotationAdmission(
      journal.predecessorId,
      journal.operationId,
    );
  }

  private async stopAfterFence(
    journal: NativeSeatRotationJournal,
  ): Promise<NativeSeatRotationResult> {
    try {
      if (journal.successorId) {
        await this.options.agentManager.cancelAgentRun(journal.successorId);
        await this.options.agentManager.closeAgent(journal.successorId);
      }
    } catch (error) {
      return {
        accepted: false,
        operation: await this.write({
          ...journal,
          state: "cancel_uncertain",
          error: errorMessage(error),
        }),
      };
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
    const timelineRows = await this.options.agentManager.getTimelineRows(predecessor.id);
    const timelineRevision = timelineRows.at(-1)?.seq ?? 0;
    if (checkpoint.timelineRevision !== timelineRevision) {
      throw new Error("checkpoint conversation boundary no longer matches the predecessor");
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

  private assertPredecessorUnchanged(
    initial: ManagedAgent,
    current: ManagedAgent,
    initialCheckpoint: ValidatedCheckpoint,
    currentCheckpoint: ValidatedCheckpoint,
  ): void {
    if (
      initial.id !== current.id ||
      initial.persistence?.sessionId !== current.persistence?.sessionId ||
      initial.cwd !== current.cwd ||
      initialCheckpoint.repoPath !== currentCheckpoint.repoPath ||
      initialCheckpoint.checkpointPath !== currentCheckpoint.checkpointPath ||
      initialCheckpoint.checkpointHash !== currentCheckpoint.checkpointHash ||
      initialCheckpoint.checkpoint.sourceRevision !== currentCheckpoint.checkpoint.sourceRevision
    ) {
      throw new Error(
        "rotation source, checkpoint, or predecessor session changed after admission",
      );
    }
  }

  private getDurableAdmission(agentId: string): { operationId: string; generation: number } | null {
    const directory = path.join(this.options.paseoHome, "seat-rotations", "admissions");
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.startsWith(`${agentId}.`) || !entry.endsWith(".lock")) continue;
      try {
        const owner = JSON.parse(
          readFileSync(path.join(directory, entry, "owner.json"), "utf8"),
        ) as {
          operationId?: string;
          generation?: number;
        };
        const generation =
          Number.isInteger(owner.generation) && (owner.generation ?? 0) > 0
            ? owner.generation!
            : null;
        if (!owner.operationId || generation === null) continue;
        const journal = JSON.parse(
          readFileSync(this.operationPath(owner.operationId), "utf8"),
        ) as NativeSeatRotationJournal;
        // A preparation failure before archive has released the predecessor.
        // Its generation lock remains as an idempotency receipt, but cannot
        // continue to deny ordinary writes to a still-live old session.
        if (journal.predecessorId !== agentId || ["cancelled", "blocked"].includes(journal.state))
          continue;
        return { operationId: owner.operationId, generation };
      } catch {
        // A torn/missing receipt is a fence, never permission to write.
        const generation = Number(entry.slice(agentId.length + 1, -".lock".length));
        return {
          operationId: "durable-receipt-unreadable",
          generation: Number.isSafeInteger(generation) ? generation : 1,
        };
      }
    }
    return null;
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

  private async isCancelledFor(operationId: string, predecessorId: string): Promise<boolean> {
    try {
      const value = JSON.parse(await fs.readFile(this.cancellationPath(operationId), "utf8")) as {
        operationId?: string;
        predecessorId?: string;
      };
      if (value.operationId !== operationId || value.predecessorId !== predecessorId) {
        throw new Error("rotation cancellation intent does not match the operation");
      }
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
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
  const succeeded = journal.state === "resumed";
  const failed = [
    "blocked",
    "resume_failed",
    "cancelled",
    "cancelled_after_fence",
    "cancel_uncertain",
  ].includes(journal.state);
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

function isTurnCompleted(event: unknown): boolean {
  return (
    typeof event === "object" &&
    event !== null &&
    "type" in event &&
    event.type === "turn_completed"
  );
}
