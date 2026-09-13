import type { InstalledPlugin } from "@/plugins/types";

export interface AccountPanelTarget {
  pluginId: string;
  panelId: string;
}

export function canOpenAccountPanel(input: {
  accountPanel: AccountPanelTarget | null;
  isConnected: boolean;
  workspaceId: string | null | undefined;
  agentId: string | null | undefined;
}): boolean {
  return Boolean(input.accountPanel && input.isConnected && input.workspaceId && input.agentId);
}

// The account panel belongs to a plugin installation, so resolve it from the
// connected host's registry instead of assuming the installed plugin identity.
export function resolveAccountPanelTarget(
  plugins: readonly InstalledPlugin[],
  serverId: string | null | undefined,
): AccountPanelTarget | null {
  if (!serverId) return null;
  const matches = plugins.flatMap((plugin) =>
    plugin.serverId === serverId
      ? plugin.workspacePanels
          .filter(
            (panel) =>
              panel.id === "account" &&
              panel.context === "agent" &&
              (panel.locations?.includes("workspace") ?? true),
          )
          .map((panel) => ({ pluginId: plugin.id, panelId: panel.id }))
      : [],
  );
  return matches.length === 1 ? matches[0] : null;
}
