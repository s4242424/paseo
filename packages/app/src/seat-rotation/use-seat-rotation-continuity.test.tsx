// @vitest-environment jsdom

import React, { type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "@/stores/session-store";
import { useSeatRotationContinuity } from "./use-seat-rotation-continuity";

const serverId = "seat-rotation-panel-hook";
const predecessorId = "predecessor";
const successorId = "successor";

describe("useSeatRotationContinuity", () => {
  beforeEach(() => {
    useSessionStore.getState().initializeSession(serverId, null);
    useSessionStore.getState().setAgents(
      serverId,
      new Map([
        [
          predecessorId,
          {
            id: predecessorId,
            status: "idle",
            archivedAt: new Date(1),
            updatedAt: new Date(1),
          } as never,
        ],
        [
          successorId,
          { id: successorId, status: "idle", archivedAt: null, updatedAt: new Date(1) } as never,
        ],
      ]),
    );
  });

  afterEach(() => {
    useSessionStore.getState().clearSession(serverId);
  });

  it("passes the completed operation to the visible-seat retarget", async () => {
    const retargetCurrentTab = vi.fn();
    const client = {
      inspectAgentSeatRotationByPredecessor: vi.fn(async () => ({
        operationId: "operation-1",
        phase: "succeeded" as const,
        successorId,
        workspaceId: "workspace-1",
        sourceRevision: "revision-1",
        revision: 1,
        failureCode: null,
      })),
    } as unknown as DaemonClient;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(
      () =>
        useSeatRotationContinuity({
          serverId,
          workspaceId: "workspace-1",
          predecessorId,
          client,
          isConnected: true,
          supported: true,
          policySupported: false,
          retargetCurrentTab,
        }),
      { wrapper },
    );

    await waitFor(() =>
      expect(retargetCurrentTab).toHaveBeenCalledWith(
        { kind: "agent", agentId: successorId },
        "operation-1",
      ),
    );
  });
});
