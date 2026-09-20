import { useCallback, useEffect, useMemo } from "react";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useInstalledPlugin } from "@/plugins/registry";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { providerUsageCopy } from "./copy";
import type { ProviderUsageListPayload, ProviderUsageView } from "./types";

export const PROVIDER_USAGE_STALE_TIME_MS = 5 * 60 * 1000;

type ProviderUsageClient = Pick<DaemonClient, "listProviderUsage">;
type ProviderAccountClient = Pick<DaemonClient, "invokePluginRpc">;

const claudeAccountSchema = z.object({
  state: z.enum(["oauth", "other", "signed-out", "unknown"]),
  email: z.string().nullable(),
});
const codexAccountSchema = z.object({
  state: z.enum(["chatgpt", "signed-out", "other", "unavailable"]),
  email: z.string().nullable(),
});

export type ProviderAccountLabel = "Checking account…" | "Account unknown" | string;

function accountLabel(
  input: { state: string; email: string | null },
  verifiedState: "oauth" | "chatgpt",
): ProviderAccountLabel {
  if (input.state === "signed-out") return "Signed out";
  if (input.state !== verifiedState) return "Account unknown";
  const email = z.email().safeParse(input.email?.trim());
  return email.success ? email.data : "Account unknown";
}

export function providerUsageQueryKey(serverId: string | null | undefined) {
  return ["providerUsage", serverId ?? ""] as const;
}

export function providerAccountQueryKey(
  serverId: string | null | undefined,
  pluginId: string | null,
) {
  return ["providerAccount", serverId ?? "", pluginId ?? ""] as const;
}

// Account-controls 92e84c1 refreshes these per-host plugin queries once a login reaches a
// terminal state. The application observes that settled refresh and refetches its separate
// providerAccount cache; this is deliberately not a shared QueryClient contract.
function isProviderPluginAccountStatusKey(queryKey: readonly unknown[], serverId: string): boolean {
  return (
    queryKey.length === 2 &&
    queryKey[1] === serverId &&
    (queryKey[0] === "claude-host-account" || queryKey[0] === "codex-host-account")
  );
}

export function subscribeToProviderAccountRefresh({
  appQueryClient,
  pluginQueryClient,
  serverId,
  pluginId,
}: {
  appQueryClient: QueryClient;
  pluginQueryClient: QueryClient;
  serverId: string;
  pluginId: string;
}): () => void {
  const queryKey = providerAccountQueryKey(serverId, pluginId);
  let active = true;
  let refreshQueued = false;

  const refresh = () => {
    if (refreshQueued) return;
    refreshQueued = true;
    void Promise.resolve()
      .then(() => {
        refreshQueued = false;
        if (!active) return undefined;
        return appQueryClient.invalidateQueries({
          queryKey,
          exact: true,
          refetchType: "active",
        });
      })
      .catch(() => undefined);
  };

  const unsubscribe = pluginQueryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated") return;
    if (!isProviderPluginAccountStatusKey(event.query.queryKey, serverId)) return;
    if (event.action.type !== "success" && event.action.type !== "error") return;
    refresh();
  });

  return () => {
    active = false;
    unsubscribe();
  };
}

async function fetchProviderUsage(client: ProviderUsageClient): Promise<ProviderUsageListPayload> {
  return client.listProviderUsage();
}

async function fetchProviderAccounts(
  client: ProviderAccountClient,
  pluginId: string,
): Promise<Record<"claude" | "codex", ProviderAccountLabel>> {
  const [claude, codex] = await Promise.allSettled([
    client.invokePluginRpc(pluginId, "account.status", {}),
    client.invokePluginRpc(pluginId, "codex.account.status", {}),
  ]);
  const claudeResult =
    claude.status === "fulfilled" ? claudeAccountSchema.safeParse(claude.value) : null;
  const codexResult =
    codex.status === "fulfilled" ? codexAccountSchema.safeParse(codex.value) : null;
  return {
    claude: claudeResult?.success ? accountLabel(claudeResult.data, "oauth") : "Account unknown",
    codex: codexResult?.success ? accountLabel(codexResult.data, "chatgpt") : "Account unknown",
  };
}

interface UseProviderUsageOptions {
  enabled?: boolean;
}

export function useProviderUsage(
  serverId: string | null | undefined,
  options: UseProviderUsageOptions = {},
): {
  view: ProviderUsageView;
  refresh: () => Promise<void>;
  canFetch: boolean;
} {
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const supportsProviderUsage = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.providerUsageList === true,
  );
  const queryKey = useMemo(() => providerUsageQueryKey(serverId), [serverId]);
  const canFetch = Boolean(serverId && client && isConnected && supportsProviderUsage);
  const enabled = Boolean((options.enabled ?? true) && canFetch);

  const queryFn = useCallback(async () => {
    if (!client) {
      throw new Error(providerUsageCopy.clientUnavailable);
    }
    return fetchProviderUsage(client);
  }, [client]);

  const query = useQuery({
    queryKey,
    queryFn,
    enabled,
    staleTime: PROVIDER_USAGE_STALE_TIME_MS,
    refetchOnMount: true,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });

  const refresh = useCallback(async () => {
    if (!canFetch) return;
    await queryClient.invalidateQueries({ queryKey });
    await queryClient.fetchQuery({
      queryKey,
      queryFn,
      staleTime: PROVIDER_USAGE_STALE_TIME_MS,
    });
  }, [canFetch, queryClient, queryFn, queryKey]);

  const view = useMemo<ProviderUsageView>(() => {
    if (!serverId || !client || !isConnected) {
      return { kind: "error", message: providerUsageCopy.hostUnavailable };
    }
    if (!supportsProviderUsage) {
      return { kind: "error", message: providerUsageCopy.hostUpgradeRequired };
    }
    if (query.data) {
      return {
        kind: "ready",
        payload: query.data,
        isRefreshing: query.isFetching,
      };
    }
    if (query.isError) {
      return {
        kind: "error",
        message: query.error instanceof Error ? query.error.message : String(query.error),
      };
    }
    return { kind: "loading" };
  }, [
    client,
    isConnected,
    query.data,
    query.error,
    query.isError,
    query.isFetching,
    serverId,
    supportsProviderUsage,
  ]);

  return { view, refresh, canFetch };
}

// Account identity is deliberately read from the selected host's account plugin.
// Usage payloads contain plan and quota information only, never an account identity.
export function useProviderAccountLabels(
  serverId: string | null | undefined,
  pluginId: string | null,
  isPopoverOpen: boolean,
): Record<"claude" | "codex", ProviderAccountLabel> {
  const appQueryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const plugin = useInstalledPlugin(serverId ?? "", pluginId ?? "");
  const queryKey = useMemo(() => providerAccountQueryKey(serverId, pluginId), [pluginId, serverId]);
  const enabled = Boolean(client && isConnected && pluginId && isPopoverOpen);
  const queryFn = useCallback(
    () => fetchProviderAccounts(client as ProviderAccountClient, pluginId as string),
    [client, pluginId],
  );
  const query = useQuery({
    queryKey,
    queryFn,
    enabled,
    // Identity is reread when the popover opens. It never confirms a switch.
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (!enabled || !serverId || !pluginId || !plugin) return;
    return subscribeToProviderAccountRefresh({
      appQueryClient,
      pluginQueryClient: plugin.queryClient,
      serverId,
      pluginId,
    });
  }, [appQueryClient, enabled, plugin, pluginId, serverId]);
  if (!enabled || query.isError) return { claude: "Account unknown", codex: "Account unknown" };
  if (query.isFetching || !query.data) {
    return { claude: "Checking account…", codex: "Checking account…" };
  }
  return query.data;
}
