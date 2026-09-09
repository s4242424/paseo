import { describe, expect, it } from "vitest";
import { selectTooltipProviders } from "./tooltip-providers";
import type { ProviderUsage } from "./types";
const claude: ProviderUsage = {
  providerId: "claude",
  displayName: "Claude",
  status: "available",
  planLabel: null,
  windows: [{ id: "session", label: "Session", usedPct: 91 }],
};
const codex: ProviderUsage = {
  providerId: "codex",
  displayName: "Codex",
  status: "available",
  planLabel: null,
  windows: [{ id: "weekly", label: "Weekly", usedPct: 12 }],
};
describe("provider allowance tooltip selection", () => {
  it.each(["claude", "codex", null, undefined])(
    "shows both host accounts while active provider is %s",
    (active) => {
      expect(selectTooltipProviders([codex, claude], active)).toEqual([claude, codex]);
    },
  );
  it("missing Codex stays visibly unavailable with no invented zero", () => {
    const selected = selectTooltipProviders([claude], "claude");
    expect(selected[0]).toBe(claude);
    expect(selected[1]).toMatchObject({
      providerId: "codex",
      status: "unavailable",
      windows: [],
    });
    expect(selected[1].error).toBeTruthy();
  });
  it("keeps provider errors and does not hide the other account", () => {
    const failed = {
      ...codex,
      status: "error" as const,
      error: "Sign in again",
      windows: [],
    };
    expect(selectTooltipProviders([claude, failed], "codex")).toEqual([claude, failed]);
  });
  it("retains a third active provider without duplicating Claude or Codex", () => {
    const other = { ...codex, providerId: "gemini", displayName: "Gemini" };
    expect(selectTooltipProviders([claude, codex, other], "gemini")).toEqual([
      claude,
      codex,
      other,
    ]);
    expect(selectTooltipProviders([claude, codex], "CLAUDE")).toHaveLength(2);
  });
  it("empty provider results are unavailable for both, never an empty tooltip", () => {
    expect(selectTooltipProviders([], null).map((p) => p.status)).toEqual([
      "unavailable",
      "unavailable",
    ]);
  });
});
