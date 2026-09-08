import type { ProviderUsage } from "./types";

/** Account allowances are host-wide, independently of the active conversation's context. */
export function selectTooltipProviders(
  providers: ProviderUsage[],
  activeProviderId: string | null | undefined
): ProviderUsage[] {
  const ids = ["claude", "codex"];
  const active = activeProviderId?.toLowerCase();
  if (active && !ids.includes(active)) ids.push(active);
  return ids.map(
    (id) =>
      providers.find((usage) => usage.providerId.toLowerCase() === id) ?? {
        providerId: id,
        displayName:
          id === "claude"
            ? "Claude"
            : id === "codex"
            ? "Codex"
            : activeProviderId!,
        status: "unavailable",
        planLabel: null,
        error: "This host did not return usage for this provider.",
        windows: [],
      }
  );
}
