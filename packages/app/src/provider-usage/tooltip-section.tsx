import { useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { useInstalledPlugins } from "@/plugins/registry";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { ProviderUsageCard } from "./card";
import { canOpenAccountPanel, resolveAccountPanelTarget } from "./account-panel";
import { providerUsageCopy } from "./copy";
import type { ProviderUsage, ProviderUsageView } from "./types";
import { useProviderAccountLabels } from "./use-provider-usage";

const COMBINED_PROVIDER_IDS = new Set(["claude", "codex"]);

export function selectCombinedProviderUsage(providers: ProviderUsage[]): ProviderUsage[] {
  return providers.filter((usage) => COMBINED_PROVIDER_IDS.has(usage.providerId.toLowerCase()));
}

export function ProviderUsageTooltipSection({
  view,
  serverId,
  workspaceId,
  agentId,
  isPopoverOpen,
}: {
  view: ProviderUsageView;
  serverId: string | null | undefined;
  workspaceId: string | null | undefined;
  agentId: string | null | undefined;
  isPopoverOpen: boolean;
}) {
  const plugins = useInstalledPlugins();
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const accountPanel = resolveAccountPanelTarget(plugins, serverId);
  const accountLabels = useProviderAccountLabels(
    serverId,
    accountPanel?.pluginId ?? null,
    isPopoverOpen,
  );
  const accountPanelAvailable = canOpenAccountPanel({
    accountPanel,
    isConnected,
    workspaceId,
    agentId,
  });

  const openAccountPanel = useCallback(() => {
    if (!accountPanel || !serverId || !workspaceId || !agentId) return;
    navigateToWorkspace({
      serverId,
      workspaceId,
      target: {
        kind: "plugin",
        pluginId: accountPanel.pluginId,
        panelId: accountPanel.panelId,
        context: "agent",
        agentId,
      },
    });
  }, [accountPanel, agentId, serverId, workspaceId]);
  const accountAction = (
    <>
      <Button
        accessibilityLabel="Switch account"
        disabled={!accountPanelAvailable}
        onPress={openAccountPanel}
        size="xs"
        style={styles.accountAction}
        testID="provider-usage-switch-account"
        variant="outline"
      >
        Switch
      </Button>
      {!accountPanelAvailable ? (
        <Text style={styles.detail}>Account switching is unavailable on this host.</Text>
      ) : null}
    </>
  );

  if (view.kind === "loading") {
    return (
      <>
        <View style={styles.divider} />
        <Text style={styles.detail}>{providerUsageCopy.tooltipLoading}</Text>
        {accountAction}
      </>
    );
  }

  if (view.kind === "error") {
    return (
      <>
        <View style={styles.divider} />
        <Text style={styles.error}>{view.message}</Text>
        {accountAction}
      </>
    );
  }

  const usages = selectCombinedProviderUsage(view.payload.providers);
  if (usages.length === 0) {
    return (
      <>
        <View style={styles.divider} />
        {accountAction}
      </>
    );
  }

  return (
    <>
      <View style={styles.divider} />
      <View style={styles.usages}>
        {usages.map((usage) => (
          <ProviderUsageCard
            key={usage.providerId}
            usage={usage}
            compact
            showRemaining
            accountLabel={accountLabels[usage.providerId.toLowerCase() as "claude" | "codex"]}
          />
        ))}
      </View>
      {accountAction}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  accountAction: {
    alignSelf: "flex-end",
  },
  divider: {
    height: 1,
    // Same token the popover draws its own outline with, so the rule reads as the
    // popover's edge. `border` is invisible here (equals the popover background).
    backgroundColor: theme.colors.borderAccent,
    marginVertical: theme.spacing[2],
    // Cancel the tooltip content's horizontal padding so the rule spans edge to edge.
    marginHorizontal: -theme.spacing[2],
  },
  detail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  error: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  usages: {
    gap: theme.spacing[4],
  },
}));
