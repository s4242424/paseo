export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${Math.round(value / 1_000_000)}m`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return Math.round(value).toString();
}

export type ContextMeterSeverity = "normal" | "warning" | "critical";

const CLAUDE_MODEL_PREFIX = "claude-";

/**
 * Identity comes from the runtime provider or model, never a display label:
 * custom profiles that extend Claude carry their own provider id, but run a
 * `claude-*` model. Unknown identity keeps the default thresholds.
 */
export function isClaudeContextIdentity(input: {
  provider?: string | null;
  model?: string | null;
  runtimeModel?: string | null;
}): boolean {
  if (input.provider === "claude") {
    return true;
  }
  return [input.model, input.runtimeModel].some(
    (model) =>
      typeof model === "string" && model.trim().toLowerCase().startsWith(CLAUDE_MODEL_PREFIX),
  );
}

/**
 * Claude degrades earlier than the window suggests, so its ring warns at 40%
 * and goes critical at 50%. Everything else keeps 70% (inclusive) and >90%.
 */
export function getContextMeterSeverity(
  percentage: number,
  isClaude: boolean,
): ContextMeterSeverity {
  if (isClaude) {
    if (percentage >= 50) {
      return "critical";
    }
    return percentage >= 40 ? "warning" : "normal";
  }
  if (percentage > 90) {
    return "critical";
  }
  return percentage >= 70 ? "warning" : "normal";
}
