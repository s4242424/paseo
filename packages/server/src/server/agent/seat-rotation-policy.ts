import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { SeatRotationPolicyConfig } from "@getpaseo/protocol/messages";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "./agent-manager.js";
import type {
  NativeSeatRotationRequest,
  NativeSeatRotationService,
} from "./native-seat-rotation.js";

const THRESHOLD = 0.4;
const MAX_OBSERVATION_AGE_MS = 5 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 1000;

type PolicyState =
  | "latched"
  | "preparing"
  | "rotating"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled";

interface PolicyJournal {
  version: 1;
  operationId: string;
  predecessorId: string;
  generation: number;
  repositoryPath: string;
  sessionId: string;
  observedTurnId: string;
  state: PolicyState;
  observedAt: string;
  lastUserMessageAt: string | null;
  preparationTurnId?: string;
  preparationLastUserMessageAt?: string | null;
  preparationPromptObserved?: true;
  successorId?: string;
  progressWitnessHash?: string;
  reason?: string;
  updatedAt: string;
}

interface SeatConfig {
  seatId: string;
  repositoryPath: string;
  handoverRoot: string;
  checkpointPath: string;
  progressWitnessPath: string;
  resumePrompt: string;
  goalContinuation: "checkpoint_only";
}

export interface SeatRotationPolicyClientState {
  operationId: string | null;
  phase:
    | "unsupported"
    | "inactive"
    | "latched"
    | "preparing"
    | "rotating"
    | "native_handoff"
    | "blocked"
    | "failed"
    | "cancelled";
  reason: string | null;
  goalContinuation: "checkpoint_only" | null;
}

/**
 * The threshold policy is deliberately not a second rotation coordinator. It
 * records intent and dispatches a normal preparation turn; NativeSeatRotation
 * remains the only component that fences, archives, and resumes a seat.
 */
export class SeatRotationPolicy {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly journals = new Map<string, PolicyJournal>();
  private readonly progressGates = new Map<string, string>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly options: {
      paseoHome: string;
      agentManager: Pick<
        AgentManager,
        "getAgent" | "getTimelineRows" | "listAgents" | "subscribe" | "streamAgent"
      >;
      nativeSeatRotation: Pick<NativeSeatRotationService, "rotate" | "cancel">;
      readConfig: () => SeatRotationPolicyConfig;
      now?: () => Date;
    },
  ) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.options.agentManager.subscribe((event) => this.onManagerEvent(event), {
      replayState: true,
    });
    void this.reconcile();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async waitForAgent(agentId: string): Promise<void> {
    await this.tails.get(agentId);
  }

  async cancelForPredecessor(predecessorId: string): Promise<boolean> {
    const journal = this.journals.get(predecessorId) ?? (await this.read(predecessorId));
    if (!journal || isTerminal(journal.state)) return false;
    const cancelled = await this.write({
      ...journal,
      state: "cancelled",
      reason: "cancelled_by_user",
    });
    this.journals.set(predecessorId, cancelled);
    if (journal.state === "rotating") {
      await this.options.nativeSeatRotation.cancel(journal.operationId, predecessorId);
    }
    return true;
  }

  async inspectByPredecessor(predecessorId: string): Promise<SeatRotationPolicyClientState> {
    const journal = this.journals.get(predecessorId) ?? (await this.read(predecessorId));
    if (journal) return clientState(journal);
    const agent = this.options.agentManager.getAgent(predecessorId);
    if (!agent) return unsupportedState("seat_rotation_policy_not_configured");
    const seat = this.seatFor(agent);
    if (seat) {
      return {
        operationId: null,
        phase: "inactive",
        reason: null,
        goalContinuation: seat.goalContinuation,
      };
    }
    const sameRepository = this.options
      .readConfig()
      .seats.some((candidate) => candidate.repositoryPath === agent.cwd);
    return unsupportedState(
      sameRepository
        ? "seat_rotation_policy_seat_binding_missing"
        : "seat_rotation_policy_not_configured",
    );
  }

  private onManagerEvent(event: AgentManagerEvent): void {
    if (event.type !== "agent_state") return;
    const previous = this.tails.get(event.agent.id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => await this.onAgentState(event.agent));
    this.tails.set(event.agent.id, next);
    void next.finally(() => {
      if (this.tails.get(event.agent.id) === next) this.tails.delete(event.agent.id);
    });
  }

  private async onAgentState(agent: ManagedAgent): Promise<void> {
    const seat = this.seatFor(agent);
    if (!seat) return;
    const journal = this.journals.get(agent.id) ?? (await this.read(agent.id));
    if (journal) this.journals.set(agent.id, journal);
    if (journal?.state === "cancelled") return;
    if (!journal) {
      await this.latch(agent, seat);
      return;
    }
    if (!sameIdentity(journal, agent)) {
      await this.replace(agent.id, {
        ...journal,
        state: "failed",
        reason: "predecessor_identity_changed",
      });
      return;
    }
    await this.advance(agent, seat, journal);
  }

  private async latch(agent: ManagedAgent, seat: SeatConfig): Promise<void> {
    if (!this.isValidThresholdObservation(agent)) return;
    const progressGate = this.progressGates.get(agent.id);
    const blocked = progressGate && !(await hasChanged(seat.progressWitnessPath, progressGate));
    const observation = agent.lastUsage!.contextWindowObservation!;
    const journal = await this.write({
      version: 1,
      operationId: randomUUID(),
      predecessorId: agent.id,
      generation: 1,
      repositoryPath: agent.cwd,
      sessionId: agent.persistence!.sessionId,
      observedTurnId: observation.turnId,
      state: blocked ? "blocked" : "latched",
      observedAt: observation.observedAt,
      lastUserMessageAt: toIso(agent.lastUserMessageAt),
      ...(blocked ? { reason: "no_progress_immediate_retrigger" } : {}),
      updatedAt: this.now().toISOString(),
    });
    this.journals.set(agent.id, journal);
  }

  private async advance(
    agent: ManagedAgent,
    seat: SeatConfig,
    journal: PolicyJournal,
  ): Promise<void> {
    switch (journal.state) {
      case "blocked":
        await this.advanceBlocked(agent, seat, journal);
        return;
      case "latched":
        await this.advanceLatched(agent, seat, journal);
        return;
      case "preparing":
        await this.advancePreparation(agent, seat, journal);
        return;
      case "rotating":
        await this.beginRotation(agent, seat, journal);
        return;
      default:
        return;
    }
  }

  private async advanceBlocked(
    agent: ManagedAgent,
    seat: SeatConfig,
    journal: PolicyJournal,
  ): Promise<void> {
    const progressGate = this.progressGates.get(agent.id);
    if (
      journal.reason !== "no_progress_immediate_retrigger" ||
      !progressGate ||
      !this.isValidThresholdObservation(agent) ||
      !(await hasChanged(seat.progressWitnessPath, progressGate))
    )
      return;
    const observation = agent.lastUsage!.contextWindowObservation!;
    await this.replace(agent.id, {
      ...journal,
      operationId: randomUUID(),
      generation: journal.generation + 1,
      observedTurnId: observation.turnId,
      observedAt: observation.observedAt,
      lastUserMessageAt: toIso(agent.lastUserMessageAt),
      state: "latched",
      reason: undefined,
    });
  }

  private async advanceLatched(
    agent: ManagedAgent,
    seat: SeatConfig,
    journal: PolicyJournal,
  ): Promise<void> {
    if (toIso(agent.lastUserMessageAt) !== journal.lastUserMessageAt) {
      await this.replace(agent.id, {
        ...journal,
        state: "blocked",
        reason: "boundary_invalidated_by_user_work",
      });
      return;
    }
    if (agent.lifecycle === "idle" && agent.pendingPermissions.size === 0) {
      await this.beginPreparation(agent, seat, journal);
    }
  }

  private async advancePreparation(
    agent: ManagedAgent,
    seat: SeatConfig,
    journal: PolicyJournal,
  ): Promise<void> {
    if (agent.lifecycle === "running" && agent.activeForegroundTurnId) {
      await this.observePreparationTurn(agent, journal);
      return;
    }
    if (
      !journal.preparationTurnId ||
      agent.pendingPermissions.size > 0 ||
      agent.lifecycle !== "idle"
    )
      return;
    if (toIso(agent.lastUserMessageAt) !== journal.preparationLastUserMessageAt) {
      await this.replace(agent.id, {
        ...journal,
        state: "blocked",
        reason: "preparation_boundary_changed",
      });
      return;
    }
    const sealed = await this.sealCheckpoint(agent, seat, journal);
    if (!sealed) return;
    await this.beginRotation(agent, seat, journal);
  }

  private async observePreparationTurn(agent: ManagedAgent, journal: PolicyJournal): Promise<void> {
    if (!journal.preparationTurnId) {
      await this.replace(agent.id, {
        ...journal,
        preparationTurnId: agent.activeForegroundTurnId!,
        preparationLastUserMessageAt: toIso(agent.lastUserMessageAt),
      });
      return;
    }
    if (journal.preparationTurnId !== agent.activeForegroundTurnId) return;
    const lastUserMessageAt = toIso(agent.lastUserMessageAt);
    if (lastUserMessageAt === journal.preparationLastUserMessageAt) return;
    if (journal.preparationPromptObserved) {
      await this.replace(agent.id, {
        ...journal,
        state: "blocked",
        reason: "preparation_boundary_changed",
      });
      return;
    }
    await this.replace(agent.id, {
      ...journal,
      preparationLastUserMessageAt: lastUserMessageAt,
      preparationPromptObserved: true,
    });
  }

  private async beginPreparation(
    agent: ManagedAgent,
    seat: SeatConfig,
    journal: PolicyJournal,
  ): Promise<void> {
    const preparing = await this.write({ ...journal, state: "preparing" });
    this.journals.set(agent.id, preparing);
    try {
      const stream = this.options.agentManager.streamAgent(
        agent.id,
        preparationPrompt({ journal: preparing, seat }),
        { clientMessageId: `seat-rotation-preparation:${preparing.operationId}` },
      );
      void drain(stream).catch(async () => {
        await this.replace(agent.id, {
          ...preparing,
          state: "failed",
          reason: "preparation_failed",
        });
      });
    } catch {
      await this.replace(agent.id, {
        ...preparing,
        state: "failed",
        reason: "preparation_not_admitted",
      });
    }
  }

  private async beginRotation(
    agent: ManagedAgent,
    seat: SeatConfig,
    journal: PolicyJournal,
  ): Promise<void> {
    const rotating = await this.write({ ...journal, state: "rotating" });
    this.journals.set(agent.id, rotating);
    const request: NativeSeatRotationRequest = {
      operationId: rotating.operationId,
      predecessorId: agent.id,
      generation: rotating.generation,
      handoverRoot: seat.handoverRoot,
      checkpointPath: seat.checkpointPath,
      resumePrompt: seat.resumePrompt,
    };
    try {
      const result = await this.options.nativeSeatRotation.rotate(request);
      const successorId = result.operation.successorId;
      const progressWitnessHash = successorId
        ? await fingerprint(seat.progressWitnessPath)
        : undefined;
      if (successorId && progressWitnessHash)
        this.progressGates.set(successorId, progressWitnessHash);
      await this.replace(agent.id, {
        ...rotating,
        state: result.accepted ? "completed" : "blocked",
        successorId,
        progressWitnessHash,
        reason: result.accepted ? undefined : "native_rotation_not_accepted",
      });
    } catch (error) {
      await this.replace(agent.id, {
        ...rotating,
        state: "failed",
        reason: `native_rotation_failed:${errorMessage(error)}`,
      });
    }
  }

  /**
   * A provider cannot know the terminal timeline sequence while it is writing
   * its checkpoint. Seal that one daemon-owned field only after the normal
   * preparation turn has ended, then let native rotation revalidate it.
   */
  private async sealCheckpoint(
    agent: ManagedAgent,
    seat: SeatConfig,
    journal: PolicyJournal,
  ): Promise<boolean> {
    try {
      const [repoPath, handoverRoot, checkpointPath] = await Promise.all([
        fs.realpath(agent.cwd),
        fs.realpath(seat.handoverRoot),
        fs.realpath(seat.checkpointPath),
      ]);
      if (!isWithin(repoPath, handoverRoot) || !isWithin(handoverRoot, checkpointPath)) {
        throw new Error("checkpoint paths are outside the configured repository handover home");
      }
      const stat = await fs.lstat(checkpointPath);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error("checkpoint is not a regular file");
      const checkpoint = parseCheckpointEnvelope(
        await fs.readFile(checkpointPath, "utf8"),
        journal,
        repoPath,
      );
      const timelineRevision =
        (await this.options.agentManager.getTimelineRows(agent.id)).at(-1)?.seq ?? 0;
      const sealed = { ...checkpoint, timelineRevision };
      await writeJsonDurably(checkpointPath, sealed);
      const current = this.options.agentManager.getAgent(agent.id);
      if (
        !current ||
        current.lifecycle !== "idle" ||
        current.pendingPermissions.size > 0 ||
        !sameIdentity(journal, current) ||
        toIso(current.lastUserMessageAt) !== journal.preparationLastUserMessageAt
      ) {
        throw new Error("checkpoint boundary changed while sealing");
      }
      return true;
    } catch (error) {
      await this.replace(agent.id, {
        ...journal,
        state: "blocked",
        reason: `checkpoint_seal_failed_or_boundary_changed:${errorMessage(error)}`,
      });
      return false;
    }
  }

  private async reconcile(): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.journalDirectory());
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    for (const entry of entries.filter((name) => name.endsWith(".json"))) {
      const journal = await this.read(entry.slice(0, -5));
      if (!journal) continue;
      this.journals.set(journal.predecessorId, journal);
      if (journal.state === "preparing") {
        await this.replace(journal.predecessorId, {
          ...journal,
          state: "blocked",
          reason: "preparation_reconciliation_required",
        });
      }
      // A native receipt is idempotent, but a policy process must not replay a
      // preparation prompt whose provider acknowledgement was lost.
    }
  }

  private seatFor(agent: ManagedAgent): SeatConfig | null {
    const config = this.options.readConfig();
    if (!config.enabled) return null;
    const matches = config.seats.filter(
      (candidate) =>
        candidate.repositoryPath === agent.cwd &&
        candidate.seatId === agent.labels["paseo.seat-id"],
    );
    if (matches.length !== 1) return null;
    const seat = matches[0]!;
    // An explicit logical seat is both the successor binding and the sole
    // writer lease for its checkpoint. Refuse an ambiguous config or a second
    // live writer instead of allowing two providers to prepare one handover.
    if (
      config.seats.some(
        (candidate) =>
          candidate !== seat &&
          candidate.repositoryPath === seat.repositoryPath &&
          candidate.checkpointPath === seat.checkpointPath,
      )
    )
      return null;
    const writers = this.options.agentManager
      .listAgents()
      .filter(
        (candidate) =>
          candidate.lifecycle !== "closed" &&
          candidate.cwd === agent.cwd &&
          candidate.labels["paseo.seat-id"] === seat.seatId,
      );
    return writers.length === 1 && writers[0]?.id === agent.id ? seat : null;
  }

  private isValidThresholdObservation(agent: ManagedAgent): boolean {
    const observation = agent.lastUsage?.contextWindowObservation;
    if (
      !observation ||
      observation.contextWindowSource !== "provider-confirmed" ||
      !agent.persistence?.sessionId ||
      observation.sessionId !== agent.persistence.sessionId ||
      observation.turnId !== agent.activeForegroundTurnId ||
      agent.lifecycle !== "running"
    ) {
      return false;
    }
    const observedAt = Date.parse(observation.observedAt);
    const now = this.now().getTime();
    if (
      !Number.isFinite(observedAt) ||
      observedAt < now - MAX_OBSERVATION_AGE_MS ||
      observedAt > now + MAX_FUTURE_SKEW_MS
    )
      return false;
    const used = observation.usedTokens;
    const max = observation.maxTokens;
    return (
      typeof used === "number" &&
      typeof max === "number" &&
      Number.isFinite(used) &&
      Number.isFinite(max) &&
      used >= 0 &&
      max > 0 &&
      used / max > THRESHOLD
    );
  }

  private async replace(agentId: string, journal: PolicyJournal): Promise<void> {
    const next = await this.write(journal);
    this.journals.set(agentId, next);
  }

  private async read(predecessorId: string): Promise<PolicyJournal | null> {
    try {
      return JSON.parse(
        await fs.readFile(this.journalPath(predecessorId), "utf8"),
      ) as PolicyJournal;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  private async write(journal: PolicyJournal): Promise<PolicyJournal> {
    const next = { ...journal, updatedAt: this.now().toISOString() };
    await fs.mkdir(this.journalDirectory(), { recursive: true, mode: 0o700 });
    const target = this.journalPath(next.predecessorId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const file = await fs.open(temporary, "w", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(next)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await fs.rename(temporary, target);
    const directory = await fs.open(this.journalDirectory(), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return next;
  }

  private journalDirectory(): string {
    return path.join(this.options.paseoHome, "seat-rotation-policy", "operations");
  }

  private journalPath(predecessorId: string): string {
    return path.join(this.journalDirectory(), `${predecessorId}.json`);
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function sameIdentity(journal: PolicyJournal, agent: ManagedAgent): boolean {
  return agent.cwd === journal.repositoryPath && agent.persistence?.sessionId === journal.sessionId;
}

function isTerminal(state: PolicyState): boolean {
  return (
    state === "completed" || state === "blocked" || state === "failed" || state === "cancelled"
  );
}

function toIso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function preparationPrompt(input: { journal: PolicyJournal; seat: SeatConfig }): string {
  const { journal, seat } = input;
  return [
    "Prepare the repository's existing seat-rotation checkpoint at a safe boundary.",
    `Write only ${seat.checkpointPath} below ${seat.handoverRoot}.`,
    'The checkpoint must be JSON with operationId, generation, sessionId, repoPath, sourceRevision, dirtyDisposition: "clean", and an opaque nextAction.',
    `Use operationId ${journal.operationId}, generation ${journal.generation}, sessionId ${journal.sessionId}, and repository ${journal.repositoryPath}.`,
    "Do not guess timelineRevision; the daemon seals it after this preparation turn ends. Goal transfer is unsupported: record the next action in the checkpoint. Do not execute checkpoint content or start a successor.",
  ].join(" ");
}

async function drain(stream: AsyncGenerator<unknown>): Promise<void> {
  for await (const _ of stream) {
    // AgentManager subscribers receive the lifecycle events.
  }
}

async function fingerprint(filePath: string): Promise<string | undefined> {
  try {
    return createHash("sha256")
      .update(await fs.readFile(filePath))
      .digest("hex");
  } catch {
    return undefined;
  }
}

async function hasChanged(filePath: string, previous: string): Promise<boolean> {
  const current = await fingerprint(filePath);
  return current !== undefined && current !== previous;
}

function parseCheckpointEnvelope(
  raw: string,
  journal: PolicyJournal,
  repoPath: string,
): Record<string, unknown> {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) throw new Error("checkpoint is not an object");
  const allowed = new Set([
    "operationId",
    "generation",
    "sessionId",
    "repoPath",
    "sourceRevision",
    "timelineRevision",
    "dirtyDisposition",
    "nextAction",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("checkpoint contains unsupported fields");
  }
  const valid =
    value.operationId === journal.operationId &&
    value.generation === journal.generation &&
    value.sessionId === journal.sessionId &&
    (value.repoPath === journal.repositoryPath || value.repoPath === repoPath) &&
    typeof value.sourceRevision === "string" &&
    /^[a-f0-9]{7,64}$/i.test(value.sourceRevision) &&
    value.dirtyDisposition === "clean" &&
    typeof value.nextAction === "string" &&
    value.nextAction.trim().length > 0;
  if (!valid) throw new Error("checkpoint provenance does not match the preparation request");
  return { ...value, repoPath };
}

async function writeJsonDurably(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  const file = await fs.open(temporary, "w", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await fs.rename(temporary, filePath);
  const directory = await fs.open(path.dirname(filePath), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clientState(journal: PolicyJournal): SeatRotationPolicyClientState {
  const phase = journal.state === "completed" ? "native_handoff" : journal.state;
  return {
    operationId: journal.operationId,
    phase,
    reason: journal.reason ?? null,
    goalContinuation: "checkpoint_only",
  };
}

function unsupportedState(reason: string): SeatRotationPolicyClientState {
  return { operationId: null, phase: "unsupported", reason, goalContinuation: null };
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}
