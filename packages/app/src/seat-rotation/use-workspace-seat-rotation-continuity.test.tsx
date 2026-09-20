// @vitest-environment jsdom

import React, { type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "@/stores/session-store";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import { useWorkspaceSeatRotationContinuity } from "./use-workspace-seat-rotation-continuity";

const serverId = "seat-rotation-hook";
const predecessorId = "predecessor";
const tabs: WorkspaceTab[] = [
  { tabId: "agent_predecessor", target: { kind: "agent", agentId: predecessorId }, createdAt: 1 },
];
const receipt = {
  operationId: "operation-1",
  phase: "pending" as const,
  successorId: null,
  workspaceId: "workspace-1",
  sourceRevision: "abc",
  revision: 1,
  failureCode: null,
};

function setAgent(updatedAt: Date) {
  useSessionStore.getState().setAgents(
    serverId,
    new Map([
      [
        predecessorId,
        {
          id: predecessorId,
          status: "idle",
          archivedAt: null,
          updatedAt,
        } as never,
      ],
    ]),
  );
}

describe("useWorkspaceSeatRotationContinuity", () => {
  beforeEach(() => {
    useSessionStore.getState().initializeSession(serverId, null);
    setAgent(new Date(1));
  });

  afterEach(() => {
    useSessionStore.getState().clearSession(serverId);
  });

  it("issues one known-operation readback for one agent-state event despite equal-revision rerenders", async () => {
    const inspectByPredecessor = vi.fn(async () => receipt);
    const inspectOperation = vi.fn(async () => ({ ...receipt }));
    const client = {
      inspectAgentSeatRotationByPredecessor: inspectByPredecessor,
      inspectAgentSeatRotation: inspectOperation,
    } as unknown as DaemonClient;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const input = {
      serverId,
      tabs,
      agentArchiveState: new Map([[predecessorId, null]]),
      client,
      isConnected: true,
      supported: true,
      retargetAgentTab: vi.fn(),
    };
    const { rerender } = renderHook(() => useWorkspaceSeatRotationContinuity(input), { wrapper });

    await waitFor(() => expect(inspectByPredecessor).toHaveBeenCalledOnce());
    await act(async () => undefined);
    await act(async () => setAgent(new Date(2)));
    await waitFor(() => expect(inspectOperation).toHaveBeenCalledOnce());
    rerender();
    rerender();
    rerender();
    expect(inspectOperation).toHaveBeenCalledOnce();
  });
});
