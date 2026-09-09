import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useInstalledPlugin } from "@/plugins/registry";
import {
  ACCOUNT_PLUGIN_ID,
  ACCOUNT_PANELS,
  readAccountIdentity,
  type AccountProvider,
} from "./accounts";

export function useProviderAccount(
  serverId: string | undefined,
  provider: AccountProvider,
  enabled: boolean,
) {
  const hostId = serverId ?? "";
  const client = useHostRuntimeClient(hostId);
  const connected = useHostRuntimeIsConnected(hostId);
  const plugin = useInstalledPlugin(hostId, ACCOUNT_PLUGIN_ID);
  const panel = plugin?.workspacePanels.find(
    (item) => item.id === ACCOUNT_PANELS[provider] && item.context === "agent",
  );
  const available = Boolean(serverId && client && connected && panel);
  const query = useFetchQuery({
    dataShape: "value",
    queryKey: ["usage-account", hostId, provider, plugin?.clientBundle],
    queryFn: ({ signal }) =>
      readAccountIdentity((...args) => client!.invokePluginRpc(...args), provider, signal),
    enabled: enabled && available,
    staleTimeMs: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  // A failed refresh never leaves an old identity looking current.
  const identity = available && !query.isError && !query.isFetching ? query.data : undefined;
  let reason: string | null = null;
  if (!connected) reason = "Host is offline";
  else if (!panel) reason = "Account controls are unavailable on this host";
  else if (query.isError) reason = "Account identity unavailable";
  return { identity, checking: available && query.isFetching, available, reason };
}
