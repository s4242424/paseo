import { ScrollView, Text, View, useWindowDimensions } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ProviderUsageCard } from "./card";
import { providerUsageCopy } from "./copy";
import type { ProviderUsageView } from "./types";

import { selectTooltipProviders } from "./tooltip-providers";

// The ring describes this conversation; these cards describe host account allowances.
export function ProviderUsageTooltipSection({
  view,
  activeProviderId,
}: {
  view: ProviderUsageView;
  activeProviderId: string | null | undefined;
}) {
  const { height, width } = useWindowDimensions();
  if (view.kind === "loading") {
    return (
      <>
        <View style={styles.divider} />
        <Text style={styles.detail}>{providerUsageCopy.tooltipLoading}</Text>
      </>
    );
  }

  if (view.kind === "error") {
    return (
      <>
        <View style={styles.divider} />
        <Text style={styles.error}>{view.message}</Text>
      </>
    );
  }

  const providers = selectTooltipProviders(view.payload.providers, activeProviderId);

  return (
    <>
      <View style={styles.divider} />
      <Text style={styles.detail}>Account allowances on this host</Text>
      <ScrollView
        testID="provider-usage-scroll"
        style={{ maxHeight: Math.max(100, Math.min(360, height * 0.45)), width: Math.min(320, width - 48) }}
        contentContainerStyle={styles.providers}
        nestedScrollEnabled
      >
        {providers.map((usage) => <ProviderUsageCard key={usage.providerId.toLowerCase()} usage={usage} compact />)}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  providers: {
    gap: theme.spacing[4],
    paddingVertical: theme.spacing[1],
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
}));
