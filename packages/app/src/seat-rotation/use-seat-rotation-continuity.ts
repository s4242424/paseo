import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useFetchQuery } from "@/data/query";
import { useSessionStore } from "@/stores/session-store";
import {
  resolveSeatRotationModel,
  resolveSeatRotationPolicyModel,
  retainNewestSeatRotationInspection,
  type SeatRotationInspection,
  type SeatRotationModel,
  type SeatRotationPolicyInspection,
  type SeatRotationPolicyModel,
} from "./model";

export interface SeatRotationContinuityController {
  state: SeatRotationModel;
  policyState: SeatRotationPolicyModel;
  cancel: () => void;
  isCancelling: boolean;
}

/**
 * Reconciles the daemon-owned receipt with the local snapshot replica. It never
 * creates, archives, or resumes agents: those mutations belong to the daemon.
 */
export function useSeatRotationContinuity(input: {
  serverId: string;
  workspaceId: string;
  predecessorId: string;
  client: DaemonClient | null;
  isConnected: boolean;
  supported: boolean;
  policySupported: boolean;
  retargetCurrentTab: (target: { kind: "agent"; agentId: string }) => void;
}): SeatRotationContinuityController {
  const retargetCurrentTab = input.retargetCurrentTab;
  const enabled = input.supported && input.isConnected && input.client !== null;
  const policyEnabled = input.policySupported && input.isConnected && input.client !== null;
  const [acceptedInspection, setAcceptedInspection] = useState<SeatRotationInspection>();
  const appliedSuccessRef = useRef<string | null>(null);
  const inspectedAgentStateRef = useRef<string | null>(null);
  const inspectedPolicyAgentStateRef = useRef<string | null>(null);
  const predecessorArchivedAt = useSessionStore((state) => {
    const session = state.sessions[input.serverId];
    const predecessor =
      session?.agents.get(input.predecessorId) ??
      session?.agentDetails.get(input.predecessorId) ??
      null;
    return predecessor?.archivedAt?.toISOString() ?? null;
  });
  const agentStateKey = useSessionStore((state) => {
    const session = state.sessions[input.serverId];
    return (
      [...(session?.agents.values() ?? [])]
        // Agent manager stamps updatedAt monotonically for every durable
        // agent_state event. A second idle event can therefore trigger the
        // receipt readback after the journal is durable without a timer.
        .map(
          (agent) =>
            `${agent.id}:${agent.status}:${agent.archivedAt?.toISOString() ?? ""}:${agent.updatedAt.toISOString()}`,
        )
        .sort()
        .join("|")
    );
  });
  const hasSuccessorSnapshot = useSessionStore((state) => {
    const successorId = acceptedInspection?.successorId;
    if (!successorId) return false;
    const session = state.sessions[input.serverId];
    return Boolean(session?.agents.has(successorId) || session?.agentDetails.has(successorId));
  });

  const inspection = useFetchQuery({
    queryKey: ["seatRotation", input.serverId, input.predecessorId, predecessorArchivedAt],
    dataShape: "value",
    staleTimeMs: 5_000,
    enabled,
    queryFn: async () => {
      if (!input.client) {
        throw new Error("The host client is unavailable.");
      }
      return await input.client.inspectAgentSeatRotationByPredecessor(input.predecessorId);
    },
    retry: false,
  });

  const policyInspection = useFetchQuery({
    queryKey: ["seatRotationPolicy", input.serverId, input.predecessorId],
    dataShape: "value",
    staleTimeMs: 5_000,
    enabled: policyEnabled,
    queryFn: async (): Promise<SeatRotationPolicyInspection> => {
      if (!input.client) throw new Error("The host client is unavailable.");
      return await input.client.inspectAgentSeatRotationPolicy(input.predecessorId);
    },
    retry: false,
  });

  useEffect(() => {
    if (!inspection.data) return;
    setAcceptedInspection((current) =>
      retainNewestSeatRotationInspection(current, inspection.data),
    );
  }, [inspection.data]);

  const operationInspection = useFetchQuery({
    queryKey: ["seatRotationOperation", input.serverId, acceptedInspection?.operationId ?? ""],
    dataShape: "value",
    staleTimeMs: 5_000,
    // A predecessor lookup seeds the operation. The daemon sends its ordinary
    // successor agent_state notification after the receipt becomes durable;
    // that state change is the sole trigger for a known-operation re-inspect.
    // Do not turn this fetch query into a timer or mount-time poll.
    enabled: false,
    queryFn: async () => {
      if (!input.client || !acceptedInspection?.operationId) {
        throw new Error("The native rotation operation is unavailable.");
      }
      return await input.client.inspectAgentSeatRotation(acceptedInspection.operationId);
    },
    retry: false,
  });

  useEffect(() => {
    if (!operationInspection.data) return;
    setAcceptedInspection((current) =>
      retainNewestSeatRotationInspection(current, operationInspection.data),
    );
  }, [operationInspection.data]);

  useEffect(() => {
    if (acceptedInspection?.phase !== "pending" || !acceptedInspection.operationId) return;
    if (inspectedAgentStateRef.current === agentStateKey) return;
    inspectedAgentStateRef.current = agentStateKey;
    void operationInspection.refetch();
  }, [
    acceptedInspection?.operationId,
    acceptedInspection?.phase,
    agentStateKey,
    operationInspection,
  ]);

  useEffect(() => {
    if (!policyEnabled || !agentStateKey) return;
    if (inspectedPolicyAgentStateRef.current === agentStateKey) return;
    inspectedPolicyAgentStateRef.current = agentStateKey;
    void policyInspection.refetch();
  }, [agentStateKey, policyEnabled, policyInspection]);

  useEffect(() => {
    // A policy handoff identifies an intent, not a successor. Re-read the
    // daemon-owned native receipt by predecessor and retain its normal snapshot gate.
    if (policyInspection.data?.phase !== "native_handoff") return;
    void inspection.refetch();
  }, [inspection, policyInspection.data?.phase]);

  const state = useMemo(
    () =>
      resolveSeatRotationModel({
        inspection: acceptedInspection,
        workspaceId: input.workspaceId,
        hasSuccessorSnapshot,
      }),
    [acceptedInspection, hasSuccessorSnapshot, input.workspaceId],
  );
  const policyState = useMemo(
    () => resolveSeatRotationPolicyModel(policyInspection.data),
    [policyInspection.data],
  );

  useEffect(() => {
    if (state.kind !== "ready") return;
    const successKey = `${state.operationId}:${state.successorId}`;
    if (appliedSuccessRef.current === successKey) return;
    appliedSuccessRef.current = successKey;
    retargetCurrentTab({ kind: "agent", agentId: state.successorId });
  }, [retargetCurrentTab, state]);

  const cancelMutation = useMutation({
    mutationFn: async () => {
      let operationId: string | null = null;
      if (state.kind === "pending") {
        operationId = state.operationId;
      } else if (policyState.kind !== "idle") {
        operationId = policyState.operationId;
      }
      if (!input.client || !operationId) {
        return;
      }
      await input.client.cancelAgentSeatRotation(operationId, input.predecessorId);
      await Promise.all([inspection.refetch(), policyInspection.refetch()]);
    },
  });
  const cancel = useCallback(() => {
    if (
      state.kind === "pending" ||
      policyState.kind === "preparing" ||
      policyState.kind === "nativeHandoff"
    ) {
      cancelMutation.mutate();
    }
  }, [cancelMutation, policyState.kind, state.kind]);

  return {
    state,
    policyState,
    cancel,
    isCancelling: cancelMutation.isPending,
  };
}
