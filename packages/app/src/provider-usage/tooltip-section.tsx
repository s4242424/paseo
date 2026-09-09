import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ProviderUsageCard } from "./card";
import { providerUsageCopy } from "./copy";
import type { ProviderUsageView } from "./types";

import { selectTooltipProviders } from "./tooltip-providers";
import { ProviderAccountSummary } from "./account-controls";
import type { AccountProvider } from "./accounts";

export function ProviderUsageTooltipSection({
  view,
  activeProviderId,
  serverId,
  scopeAvailable = false,
  onChangeLogin,
}: {
  view: ProviderUsageView;
  activeProviderId: string | null | undefined;
  serverId?: string;
  scopeAvailable?: boolean;
  onChangeLogin?: (provider: AccountProvider) => void;
}) {
  const providers = selectTooltipProviders(
    view.kind === "ready" ? view.payload.providers : [],
    activeProviderId,
  );
  return (
    <>
      <View style={styles.divider} />
      <Text style={styles.detail}>Account allowances · separate from conversation context</Text>
      {view.kind === "loading" ? (
        <Text style={styles.detail}>{providerUsageCopy.tooltipLoading}</Text>
      ) : null}
      {view.kind === "error" ? <Text style={styles.error}>{view.message}</Text> : null}
      {view.kind === "ready" && view.isRefreshing ? (
        <Text style={styles.detail}>Refreshing allowances; previous observation shown below.</Text>
      ) : null}
      {providers.map((usage) => (
        <View key={usage.providerId}>
          <View style={styles.divider} />
          <ProviderUsageCard usage={usage} compact detailed />
          {onChangeLogin &&
          (usage.providerId.toLowerCase() === "claude" ||
            usage.providerId.toLowerCase() === "codex") ? (
            <ProviderAccountSummary
              serverId={serverId}
              provider={usage.providerId.toLowerCase() as AccountProvider}
              scopeAvailable={scopeAvailable}
              onChangeLogin={onChangeLogin}
            />
          ) : null}
        </View>
      ))}
      <Text style={styles.detail}>
        Logins are observed on the selected host. They do not prove which account an existing
        conversation uses.
      </Text>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
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
}));
