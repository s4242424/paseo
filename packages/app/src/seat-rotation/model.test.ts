import { describe, expect, it } from "vitest";
import {
  resolveSeatRotationModel,
  retainNewestSeatRotationInspection,
  type SeatRotationInspection,
} from "./model";

const operation: SeatRotationInspection = {
  operationId: "operation-1",
  phase: "pending",
  successorId: null,
  workspaceId: "workspace-1",
  sourceRevision: "abc1234",
  revision: 4,
  failureCode: null,
};

describe("seat rotation continuity", () => {
  it("keeps the predecessor visible while the durable operation is pending", () => {
    expect(
      resolveSeatRotationModel({
        inspection: operation,
        workspaceId: "workspace-1",
        hasSuccessorSnapshot: false,
      }),
    ).toEqual({ kind: "pending", operationId: "operation-1" });
  });

  it("keeps a failed predecessor recoverable without making a draft", () => {
    expect(
      resolveSeatRotationModel({
        inspection: { ...operation, phase: "failed", failureCode: "resume_failed" },
        workspaceId: "workspace-1",
        hasSuccessorSnapshot: false,
      }),
    ).toEqual({
      kind: "failed",
      operationId: "operation-1",
      failureCode: "resume_failed",
    });
  });

  it("waits for the successor snapshot before replacing the visible seat", () => {
    expect(
      resolveSeatRotationModel({
        inspection: { ...operation, phase: "succeeded", successorId: "successor-1" },
        workspaceId: "workspace-1",
        hasSuccessorSnapshot: false,
      }),
    ).toEqual({ kind: "waitingForSuccessor", operationId: "operation-1" });
  });

  it("only makes an in-workspace successor ready after its snapshot arrives", () => {
    expect(
      resolveSeatRotationModel({
        inspection: { ...operation, phase: "succeeded", successorId: "successor-1" },
        workspaceId: "workspace-1",
        hasSuccessorSnapshot: true,
      }),
    ).toEqual({ kind: "ready", operationId: "operation-1", successorId: "successor-1" });
    expect(
      resolveSeatRotationModel({
        inspection: { ...operation, phase: "succeeded", successorId: "successor-1" },
        workspaceId: "other-workspace",
        hasSuccessorSnapshot: true,
      }),
    ).toEqual({ kind: "waitingForSuccessor", operationId: "operation-1" });
  });

  it("does not let an out-of-order inspection regress a durable operation", () => {
    expect(
      retainNewestSeatRotationInspection(
        { ...operation, revision: 8, phase: "succeeded", successorId: "successor-1" },
        operation,
      ),
    ).toEqual({ ...operation, revision: 8, phase: "succeeded", successorId: "successor-1" });
  });
});
