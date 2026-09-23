import type { AgentTimelineFetchResult } from "./agent-timeline-store-types.js";

/**
 * Durable retirement is a one-way exclusion fence, separate from archive.
 * Archive is a reversible soft-delete; retirement additionally forbids any
 * future interactive provider entry for the agent, even after the plugin or
 * daemon that requested it is gone. There is no public unretire operation:
 * once persisted, the fence is load-bearing for the lifetime of the record.
 */
export interface AgentRetirementRecord {
  /** Idempotency key for the operation that requested retirement. */
  operationId: string;
  reason: string;
  retiredAt: string;
}

export function buildAgentRetirementRecord(
  operationId: string,
  reason: string,
  retiredAt: string = new Date().toISOString(),
): AgentRetirementRecord {
  return { operationId, reason, retiredAt };
}

/**
 * A frozen copy of the agent's accumulated timeline, captured at the instant
 * retirement is admitted and persisted atomically alongside the fence in the
 * same `AgentStorage` record write. This is the only durable, host-default
 * source for a retired agent's read-only history: there is no production
 * durable timeline store wired in this codebase (it is an optional seam with
 * no concrete disk-backed implementation), so history cannot depend on one
 * existing. Trade-off: a retired agent's JSON record now carries its full
 * captured conversation, so retired-record file size scales with
 * conversation length, unlike an ordinary (non-retired) agent record, which
 * stays small metadata only. This is accepted deliberately rather than
 * introducing a new global transcript store or timeline migration.
 */
export interface AgentRetiredHistorySnapshot extends Pick<
  AgentTimelineFetchResult,
  "epoch" | "rows" | "window"
> {
  capturedAt: string;
}

export class AgentRetiredError extends Error {
  constructor(public readonly agentId: string) {
    super(`Agent is retired: ${agentId}`);
    this.name = "AgentRetiredError";
  }
}

/** Thrown when admission conditions (active turn, pending permissions, running
 * native children) make it unsafe to persist the exclusion fence right now. */
export class AgentRetirementBusyError extends Error {
  constructor(
    public readonly agentId: string,
    reason: string,
  ) {
    super(`Agent ${agentId} cannot be retired: ${reason}`);
    this.name = "AgentRetirementBusyError";
  }
}

/** Thrown when a different retirement operation already holds the fence. */
export class AgentRetirementConflictError extends Error {
  constructor(
    public readonly agentId: string,
    public readonly existingOperationId: string,
    public readonly requestedOperationId: string,
  ) {
    super(
      `Agent ${agentId} was already retired by operation ${existingOperationId}, ` +
        `refusing conflicting operation ${requestedOperationId}`,
    );
    this.name = "AgentRetirementConflictError";
  }
}
