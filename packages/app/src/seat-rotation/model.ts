export interface SeatRotationInspection {
  operationId: string | null;
  phase: "pending" | "succeeded" | "failed" | null;
  successorId: string | null;
  workspaceId: string | null;
  sourceRevision: string | null;
  revision: number | null;
  failureCode: string | null;
}

export type SeatRotationModel =
  | { kind: "idle" }
  | { kind: "pending"; operationId: string }
  | { kind: "failed"; operationId: string; failureCode: string | null }
  | { kind: "waitingForSuccessor"; operationId: string }
  | { kind: "ready"; operationId: string; successorId: string };

/**
 * The durable receipt is the authority. A completed receipt does not retarget a
 * visible seat until the named successor snapshot is locally recoverable.
 */
export function resolveSeatRotationModel(input: {
  inspection: SeatRotationInspection | undefined;
  workspaceId: string;
  hasSuccessorSnapshot: boolean;
}): SeatRotationModel {
  const inspection = input.inspection;
  if (!inspection?.operationId || !inspection.phase) {
    return { kind: "idle" };
  }
  if (inspection.phase === "pending") {
    return { kind: "pending", operationId: inspection.operationId };
  }
  if (inspection.phase === "failed") {
    return {
      kind: "failed",
      operationId: inspection.operationId,
      failureCode: inspection.failureCode,
    };
  }
  if (
    !inspection.successorId ||
    inspection.workspaceId !== input.workspaceId ||
    !input.hasSuccessorSnapshot
  ) {
    return { kind: "waitingForSuccessor", operationId: inspection.operationId };
  }
  return {
    kind: "ready",
    operationId: inspection.operationId,
    successorId: inspection.successorId,
  };
}

/** Ignore an older reply for the same durable operation. */
export function retainNewestSeatRotationInspection(
  current: SeatRotationInspection | undefined,
  incoming: SeatRotationInspection,
): SeatRotationInspection {
  if (
    current?.operationId === incoming.operationId &&
    typeof current.revision === "number" &&
    typeof incoming.revision === "number" &&
    incoming.revision < current.revision
  ) {
    return current;
  }
  return incoming;
}
