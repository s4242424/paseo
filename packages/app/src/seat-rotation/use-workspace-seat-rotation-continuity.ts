import { useEffect, useMemo, useRef, useState } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useFetchQueries } from "@/data/query";
import { useSessionStore } from "@/stores/session-store";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import { retainNewestSeatRotationInspection, type SeatRotationInspection } from "./model";

/**
 * Do not let ordinary archived-tab pruning win the race against a durable
 * predecessor lookup. Once a receipt exists, its panel owns the in-place
 * replacement; no receipt leaves normal archive behaviour unchanged.
 */
export function useWorkspaceSeatRotationContinuity(input: {
  serverId: string;
  tabs: readonly WorkspaceTab[];
  agentArchiveState: ReadonlyMap<string, string | null>;
  client: DaemonClient | null;
  isConnected: boolean;
  supported: boolean;
  retargetAgentTab: (predecessorId: string, successorId: string, operationId: string) => void;
}): ReadonlySet<string> {
  const retargetAgentTab = input.retargetAgentTab;
  const predecessors = useMemo(
    () =>
      [
        ...new Set(
          input.tabs.flatMap((tab) => (tab.target.kind === "agent" ? [tab.target.agentId] : [])),
        ),
      ]
        .filter(Boolean)
        .sort()
        .map((id) => ({ id, archivedAt: input.agentArchiveState.get(id) ?? null })),
    [input.agentArchiveState, input.tabs],
  );
  const predecessorKey = useMemo(
    () =>
      predecessors
        .map((predecessor) => `${predecessor.id}:${predecessor.archivedAt ?? ""}`)
        .join("|"),
    [predecessors],
  );
  const enabled = input.supported && input.isConnected && input.client !== null;
  const [acceptedInspections, setAcceptedInspections] = useState<
    ReadonlyMap<string, SeatRotationInspection>
  >(new Map());
  const acceptedInspectionsRef = useRef(acceptedInspections);
  acceptedInspectionsRef.current = acceptedInspections;
  const agentStateKey = useSessionStore((state) => {
    const session = state.sessions[input.serverId];
    return [...(session?.agents.values() ?? [])]
      .map(
        (agent) =>
          `${agent.id}:${agent.status}:${agent.archivedAt?.toISOString() ?? ""}:${agent.updatedAt.toISOString()}`,
      )
      .sort()
      .join("|");
  });
  const knownSnapshotAgentIdsKey = useSessionStore((state) => {
    const session = state.sessions[input.serverId];
    return [...(session?.agents.keys() ?? []), ...(session?.agentDetails.keys() ?? [])]
      .sort()
      .join("|");
  });
  const knownSnapshotAgentIds = useMemo(
    () => new Set(knownSnapshotAgentIdsKey ? knownSnapshotAgentIdsKey.split("|") : []),
    [knownSnapshotAgentIdsKey],
  );
  const inspections = useFetchQueries(
    predecessors.map((predecessor) => ({
      // An archive transition needs a fresh lookup even when the active-tab
      // lookup just resolved empty; native admission may have occurred between
      // those two snapshots.
      queryKey: ["seatRotation", input.serverId, predecessor.id, predecessor.archivedAt],
      dataShape: "value" as const,
      staleTimeMs: 5_000,
      queryFn: async () => {
        if (!input.client) {
          throw new Error("The host client is unavailable.");
        }
        return await input.client.inspectAgentSeatRotationByPredecessor(predecessor.id);
      },
      enabled,
      retry: false,
    })),
  );
  const inspectionsRef = useRef(inspections);
  inspectionsRef.current = inspections;
  const predecessorsRef = useRef(predecessors);
  predecessorsRef.current = predecessors;
  const previousAgentStateKey = useRef<string | null>(null);
  const pendingAgentStateKey = useRef<string | null>(null);
  const inspectedAgentStateKey = useRef<string | null>(null);

  useEffect(() => {
    setAcceptedInspections((current) => {
      let next: Map<string, SeatRotationInspection> | null = null;
      for (const [index, inspection] of inspections.entries()) {
        const predecessor = predecessors[index];
        if (!predecessor || !inspection.data) continue;
        const retained = retainNewestSeatRotationInspection(
          (next ?? current).get(predecessor.id),
          inspection.data,
        );
        if (retained === (next ?? current).get(predecessor.id)) continue;
        next ??= new Map(current);
        next.set(predecessor.id, retained);
      }
      return next ?? current;
    });
  }, [inspections, predecessors]);

  useEffect(() => {
    if (!enabled || !input.client || !agentStateKey) return;
    const stateChanged =
      previousAgentStateKey.current !== null && previousAgentStateKey.current !== agentStateKey;
    previousAgentStateKey.current = agentStateKey;
    for (const [index, inspection] of inspectionsRef.current.entries()) {
      const predecessor = predecessorsRef.current[index];
      if (!predecessor) continue;
      const accepted = acceptedInspectionsRef.current.get(predecessor.id);
      if (!accepted?.operationId) {
        if (stateChanged) pendingAgentStateKey.current = agentStateKey;
        void inspection.refetch();
        continue;
      }
      const shouldReadback = stateChanged || pendingAgentStateKey.current === agentStateKey;
      if (!shouldReadback || inspectedAgentStateKey.current === agentStateKey) continue;
      void input.client
        .inspectAgentSeatRotation(accepted.operationId)
        .then((receipt) => {
          setAcceptedInspections((current) => {
            const retained = retainNewestSeatRotationInspection(
              current.get(predecessor.id),
              receipt,
            );
            if (retained === current.get(predecessor.id)) return current;
            const next = new Map(current);
            next.set(predecessor.id, retained);
            return next;
          });
          return undefined;
        })
        .catch(() => undefined);
      inspectedAgentStateKey.current = agentStateKey;
      pendingAgentStateKey.current = null;
    }
  }, [acceptedInspections, agentStateKey, enabled, input.client, predecessorKey]);

  const appliedSuccesses = useRef(new Set<string>());
  useEffect(() => {
    if (!enabled) return;
    for (const [index, inspection] of inspections.entries()) {
      const predecessor = predecessors[index];
      if (!predecessor) continue;
      const receipt = acceptedInspections.get(predecessor.id) ?? inspection.data;
      if (
        receipt?.phase !== "succeeded" ||
        !receipt.operationId ||
        !receipt.successorId ||
        !knownSnapshotAgentIds.has(receipt.successorId)
      ) {
        continue;
      }
      const successKey = `${receipt.operationId ?? ""}:${predecessor.id}:${receipt.successorId}`;
      if (appliedSuccesses.current.has(successKey)) continue;
      appliedSuccesses.current.add(successKey);
      retargetAgentTab(predecessor.id, receipt.successorId, receipt.operationId);
    }
  }, [
    acceptedInspections,
    enabled,
    inspections,
    knownSnapshotAgentIds,
    predecessors,
    retargetAgentTab,
  ]);

  return useMemo(() => {
    if (!enabled) return new Set<string>();
    const protectedAgentIds = new Set<string>();
    for (const [index, inspection] of inspections.entries()) {
      const predecessor = predecessors[index];
      if (!predecessor) continue;
      const receipt = acceptedInspections.get(predecessor.id) ?? inspection.data;
      const phase = receipt?.phase;
      const needsSuccessorSnapshot =
        phase === "succeeded" &&
        (!receipt?.successorId || !knownSnapshotAgentIds.has(receipt.successorId));
      if (
        phase === "pending" ||
        needsSuccessorSnapshot ||
        (predecessor.archivedAt !== null && (inspection.isPending || inspection.data === undefined))
      ) {
        protectedAgentIds.add(predecessor.id);
      }
    }
    return protectedAgentIds;
  }, [acceptedInspections, enabled, inspections, knownSnapshotAgentIds, predecessors]);
}
