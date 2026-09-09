import { useCallback, useMemo } from "react";
import type { PluginWorkspaceTabTarget } from "@/workspace-tabs/model";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { EmbeddedPluginPanel } from "@/plugins/workspace-panels/content";
import { ACCOUNT_PLUGIN_ID, ACCOUNT_PANELS, type AccountProvider } from "./accounts";
import { useProviderAccount } from "./use-provider-accounts";

export function ProviderAccountSummary({
  serverId,
  provider,
  scopeAvailable,
  onChangeLogin,
}: {
  serverId?: string;
  provider: AccountProvider;
  scopeAvailable: boolean;
  onChangeLogin(provider: AccountProvider): void;
}) {
  const account = useProviderAccount(serverId, provider, true);
  const name = provider === "claude" ? "Claude" : "Codex";
  const identity = account.identity;
  let label = "Host login not confirmed";
  if (identity?.state === "signed-in") label = identity.email ?? "Email unavailable";
  else if (identity?.state === "signed-out") label = "Signed out";
  if (account.reason) label = account.reason;
  if (account.checking) label = "Checking host login…";
  const disabled = !account.available || !scopeAvailable;
  const accessibilityState = useMemo(() => ({ disabled }), [disabled]);
  const changeLogin = useCallback(() => onChangeLogin(provider), [onChangeLogin, provider]);
  return (
    <View style={styles.identity} testID={`usage-account-${provider}`}>
      <Text style={styles.detail}>
        {provider === "codex" ? "ChatGPT login for Codex" : "Claude host login"}
      </Text>
      <Text selectable style={styles.text}>
        {label}
      </Text>
      {identity?.plan ? <Text style={styles.detail}>{identity.plan}</Text> : null}
      {identity?.checkedAt ? (
        <Text style={styles.detail}>
          Login checked {new Date(identity.checkedAt).toLocaleString("en-GB")}
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Change ${name} login`}
        accessibilityState={accessibilityState}
        disabled={disabled}
        onPress={changeLogin}
        style={styles.action}
      >
        <Text style={disabled ? styles.detail : styles.link}>Change {name} login</Text>
      </Pressable>
      {!scopeAvailable ? (
        <Text style={styles.detail}>
          Select an available conversation to manage its host login.
        </Text>
      ) : null}
    </View>
  );
}

export function ProviderAccountDialog({
  serverId,
  workspaceId,
  agentId,
  provider,
  onClose,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  provider: AccountProvider;
  onClose(): void;
}) {
  const header = useMemo(
    () => ({ title: `Change ${provider === "claude" ? "Claude" : "Codex"} login` }),
    [provider],
  );
  const target = useMemo<PluginWorkspaceTabTarget>(
    () => ({
      kind: "plugin",
      pluginId: ACCOUNT_PLUGIN_ID,
      panelId: ACCOUNT_PANELS[provider],
      context: "agent",
      agentId,
    }),
    [provider, agentId],
  );
  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      header={header}
      scrollable={false}
      desktopHeight="85%"
    >
      <EmbeddedPluginPanel serverId={serverId} workspaceId={workspaceId} target={target} />
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  identity: { gap: theme.spacing[1], marginTop: theme.spacing[2] },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  detail: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  link: { color: theme.colors.accent, fontSize: theme.fontSize.sm },
  action: { minHeight: 36, justifyContent: "center" },
}));
