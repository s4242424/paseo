import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, useWindowDimensions } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ProviderUsageTooltipSection } from "@/provider-usage/tooltip-section";
import { useProviderUsage } from "@/provider-usage/use-provider-usage";
import { ProviderAccountDialog } from "@/provider-usage/account-controls";
import type { AccountProvider } from "@/provider-usage/accounts";
import { formatTokenCount } from "./context-window-meter.utils";

interface ContextWindowMeterProps {
  maxTokens: number | null;
  usedTokens: number | null;
  totalCostUsd?: number | null;
  showPercentage?: boolean;
  serverId?: string;
  workspaceId?: string | null;
  agentId?: string;
  /** The Paseo provider key, e.g. "claude", "gemini", "codex" */
  provider?: string | null;
  /** Reserve the meter footprint and show a loading ring while usage is pending. */
  pending?: boolean;
  /** Optional glyph envelope for icon-toolbar alignment. */
  glyphSize?: number;
}

const SVG_SIZE = 14;
const COMPACT_SVG_SIZE = 12;
const COMPACT_CENTER = COMPACT_SVG_SIZE / 2;
const COMPACT_RADIUS = 5;
const STROKE_WIDTH = 2;
const COMPACT_STROKE_WIDTH = 1.75;
const COMPACT_CIRCUMFERENCE = 2 * Math.PI * COMPACT_RADIUS;

function isValidMaxTokens(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isValidUsedTokens(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function getUsagePercentage(maxTokens: number, usedTokens: number): number | null {
  if (!isValidMaxTokens(maxTokens) || !isValidUsedTokens(usedTokens)) {
    return null;
  }
  return (usedTokens / maxTokens) * 100;
}

function clampPercentage(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function formatSessionCost(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  if (value < 0.01) {
    return `$${value.toFixed(4)}`;
  }
  return `$${value.toFixed(2)}`;
}

function getMeterColors(
  percentage: number,
  theme: ReturnType<typeof useUnistyles>["theme"],
): { progress: string; track: string } {
  const track = theme.colors.surface3;
  if (percentage > 90) {
    return { progress: theme.colors.destructive, track };
  }
  if (percentage >= 70) {
    return { progress: theme.colors.palette.amber[500], track };
  }
  return { progress: theme.colors.foregroundMuted, track };
}

function getMeterGeometry(showPercentage: boolean, glyphSize?: number) {
  if (showPercentage) {
    return {
      svgSize: COMPACT_SVG_SIZE,
      center: COMPACT_CENTER,
      radius: COMPACT_RADIUS,
      strokeWidth: COMPACT_STROKE_WIDTH,
      circumference: COMPACT_CIRCUMFERENCE,
      containerStyle: styles.containerWithLabel,
    };
  }
  const resolvedSize = glyphSize ?? SVG_SIZE;
  const resolvedStrokeWidth = glyphSize ? 2 : STROKE_WIDTH;
  return {
    svgSize: resolvedSize,
    center: resolvedSize / 2,
    radius: (resolvedSize - resolvedStrokeWidth) / 2,
    strokeWidth: resolvedStrokeWidth,
    circumference: Math.PI * (resolvedSize - resolvedStrokeWidth),
    containerStyle: styles.container,
  };
}

interface AccountDialogScope {
  provider: AccountProvider;
  serverId: string;
  workspaceId: string;
  agentId: string;
}
function dialogMatchesScope(
  dialog: AccountDialogScope | null,
  serverId?: string,
  workspaceId?: string | null,
  agentId?: string,
): dialog is AccountDialogScope {
  return Boolean(
    dialog &&
    dialog.serverId === serverId &&
    dialog.workspaceId === workspaceId &&
    dialog.agentId === agentId,
  );
}

export function ContextWindowMeter({
  maxTokens,
  usedTokens,
  totalCostUsd,
  showPercentage = false,
  serverId,
  workspaceId,
  agentId,
  provider,
  pending = false,
  glyphSize,
}: ContextWindowMeterProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const [isTooltipOpen, setIsTooltipOpen] = useState(false);
  const [dialog, setDialog] = useState<AccountDialogScope | null>(null);
  const viewport = useWindowDimensions();
  const popoverWidth = Math.min(360, Math.max(200, viewport.width - 32));
  const popoverHeight = Math.max(120, Math.min(520, viewport.height - 80));
  const scrollStyle = useMemo(
    () => ({ width: popoverWidth - 16, maxHeight: popoverHeight }),
    [popoverWidth, popoverHeight],
  );
  const accessibilityState = useMemo(() => ({ expanded: isTooltipOpen }), [isTooltipOpen]);
  const closeDialog = useCallback(() => setDialog(null), []);
  useEffect(() => {
    setIsTooltipOpen(false);
    setDialog(null);
  }, [serverId, workspaceId, agentId]);
  const changeLogin = useCallback(
    (accountProvider: AccountProvider) => {
      if (!serverId || !workspaceId || !agentId) return;
      setIsTooltipOpen(false);
      setDialog({ provider: accountProvider, serverId, workspaceId, agentId });
    },
    [serverId, workspaceId, agentId],
  );
  const { view: providerUsageView, refresh: refreshProviderUsage } = useProviderUsage(
    serverId ?? null,
    { enabled: isTooltipOpen },
  );
  const percentage =
    maxTokens !== null && usedTokens !== null ? getUsagePercentage(maxTokens, usedTokens) : null;
  const handleTooltipOpenChange = useCallback(
    (nextOpen: boolean) => {
      setIsTooltipOpen(nextOpen);
      if (nextOpen) {
        void refreshProviderUsage().catch(() => {});
      }
    },
    [refreshProviderUsage],
  );

  const geometry = getMeterGeometry(showPercentage, glyphSize);

  // Host allowance access remains available when the context measurement is unknown.
  if (percentage === null && !pending && !serverId) return null;

  const clampedPercentage = clampPercentage(percentage ?? 0);
  const roundedPercentage = percentage === null ? null : Math.round(percentage);
  const { svgSize, center, radius, strokeWidth, circumference, containerStyle } = geometry;
  const dashOffset = circumference - (clampedPercentage / 100) * circumference;
  const colors = getMeterColors(clampedPercentage, theme);
  const formattedSessionCost =
    typeof totalCostUsd === "number" ? formatSessionCost(totalCostUsd) : null;

  return (
    <>
      <Tooltip
        open={isTooltipOpen}
        onOpenChange={handleTooltipOpenChange}
        delayDuration={0}
        enabledOnDesktop
        enabledOnMobile
        interactive
      >
        <TooltipTrigger asChild triggerRefProp="ref">
          <Pressable
            style={containerStyle}
            testID="context-window-meter"
            accessibilityRole="button"
            accessibilityState={accessibilityState}
            accessibilityLabel={
              roundedPercentage === null
                ? "Usage and accounts · context unavailable"
                : `${t("contextWindow.accessibility", { percentage: roundedPercentage })}. Usage and accounts`
            }
          >
            <Svg
              width={svgSize}
              height={svgSize}
              viewBox={`0 0 ${svgSize} ${svgSize}`}
              style={styles.svg}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              <Circle
                cx={center}
                cy={center}
                r={radius}
                fill="none"
                stroke={colors.track}
                strokeWidth={strokeWidth}
              />
              {percentage !== null ? (
                <Circle
                  cx={center}
                  cy={center}
                  r={radius}
                  fill="none"
                  stroke={colors.progress}
                  strokeWidth={strokeWidth}
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                />
              ) : null}
            </Svg>
            {showPercentage ? (
              <Text style={styles.percentageLabel}>
                {roundedPercentage === null ? "—" : `${roundedPercentage}%`}
              </Text>
            ) : null}
          </Pressable>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          align="center"
          offset={8}
          maxWidth={popoverWidth}
          testID="usage-account-popover"
        >
          <ScrollView
            testID="usage-account-scroll"
            style={scrollStyle}
            contentContainerStyle={styles.tooltipContent}
          >
            <ContextUsageDetails
              maxTokens={maxTokens}
              usedTokens={usedTokens}
              percentage={roundedPercentage}
              formattedSessionCost={formattedSessionCost}
            />
            <ProviderUsageTooltipSection
              view={providerUsageView}
              activeProviderId={provider}
              serverId={serverId}
              scopeAvailable={Boolean(serverId && workspaceId && agentId)}
              onChangeLogin={changeLogin}
            />
          </ScrollView>
        </TooltipContent>
      </Tooltip>
      {dialogMatchesScope(dialog, serverId, workspaceId, agentId) ? (
        <ProviderAccountDialog {...dialog} onClose={closeDialog} />
      ) : null}
    </>
  );
}

function ContextUsageDetails({
  maxTokens,
  usedTokens,
  percentage,
  formattedSessionCost,
}: {
  maxTokens: number | null;
  usedTokens: number | null;
  percentage: number | null;
  formattedSessionCost: string | null;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Text style={styles.tooltipTitle}>{t("contextWindow.title")}</Text>
      <Text style={styles.tooltipText}>
        {percentage === null
          ? "Context usage unavailable"
          : t("contextWindow.used", { percentage: percentage })}
      </Text>
      {usedTokens !== null && maxTokens !== null && percentage !== null ? (
        <Text style={styles.tooltipDetail}>
          {t("contextWindow.tokens", {
            used: formatTokenCount(usedTokens),
            max: formatTokenCount(maxTokens),
          })}
        </Text>
      ) : null}
      {formattedSessionCost ? (
        <Text style={styles.tooltipDetail}>
          {t("contextWindow.sessionCost", { cost: formattedSessionCost })}
        </Text>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  containerWithLabel: {
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
  },
  svg: {
    transform: [{ rotate: "-90deg" }],
  },
  percentageLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  skeletonLabel: {
    width: 22,
    height: theme.fontSize.base,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
  },
  tooltipContent: {
    gap: theme.spacing[1.5],
    minWidth: 200,
  },
  tooltipTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.4,
  },
  tooltipDetail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
}));
