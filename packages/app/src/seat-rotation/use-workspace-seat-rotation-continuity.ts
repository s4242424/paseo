import { useMemo } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useFetchQueries } from "@/data/query";
import type { WorkspaceTab } from "@/workspace-tabs/model";

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
}): ReadonlySet<string> {
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
  const enabled = input.supported && input.isConnected && input.client !== null;
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

  return useMemo(() => {
    if (!enabled) return new Set<string>();
    const protectedAgentIds = new Set<string>();
    for (const [index, inspection] of inspections.entries()) {
      const predecessor = predecessors[index];
      if (!predecessor) continue;
      if (
        inspection.data?.phase ||
        (predecessor.archivedAt !== null && (inspection.isPending || inspection.data === undefined))
      ) {
        protectedAgentIds.add(predecessor.id);
      }
    }
    return protectedAgentIds;
  }, [enabled, inspections, predecessors]);
}
