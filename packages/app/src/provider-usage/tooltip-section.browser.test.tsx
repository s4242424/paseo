import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderUsageTooltipSection } from "./tooltip-section";
import type { ProviderUsageView } from "./types";
beforeEach(() => vi.stubGlobal("React", React));
const mounts: { root: Root; container: HTMLDivElement }[] = [];
const view: Extract<ProviderUsageView, { kind: "ready" }> = {
  kind: "ready",
  isRefreshing: false,
  payload: {
    requestId: "fixture",
    fetchedAt: "2026-09-08T00:00:00Z",
    providers: [
      {
        providerId: "claude",
        displayName: "Claude",
        status: "available",
        planLabel: null,
        windows: [{ id: "session", label: "Claude allowance", usedPct: 91 }],
      },
      {
        providerId: "codex",
        displayName: "Codex",
        status: "available",
        planLabel: null,
        windows: [{ id: "weekly", label: "Codex allowance", usedPct: 12 }],
      },
    ],
  },
};
function mount(v: ProviderUsageView, active: string) {
  const container = document.createElement("div");
  container.style.width = "340px";
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <ProviderUsageTooltipSection view={v} activeProviderId={active} />
    )
  );
  mounts.push({ root, container });
  return container;
}
afterEach(() => {
  for (const m of mounts.splice(0)) {
    act(() => m.root.unmount());
    m.container.remove();
  }
  vi.unstubAllGlobals();
});
describe("provider allowance wheel popover", () => {
  it.each(["claude", "codex"])(
    "shows both account cards from a %s conversation",
    (active) => {
      const c = mount(view, active);
      expect(c.textContent).toContain("Claude allowance");
      expect(c.textContent).toContain("Codex allowance");
      expect(c.textContent).toContain("91%");
      expect(c.textContent).toContain("12%");
      expect(c.textContent).toContain("Account allowances on this host");
      const scroll = c.querySelector('[data-testid="provider-usage-scroll"]')!;
      expect(
        parseFloat(getComputedStyle(scroll).maxHeight)
      ).toBeLessThanOrEqual(360);
      expect(getComputedStyle(scroll).overflowY).toBe("auto");
    }
  );
  it("keeps missing Codex visibly unavailable", () => {
    const c = mount(
      {
        ...view,
        payload: {
          ...view.payload,
          providers: view.payload.providers.slice(0, 1),
        },
      },
      "claude"
    );
    expect(c.textContent).toContain("Claude allowance");
    expect(c.textContent).toContain("Codex");
    expect(c.textContent).toContain("Unavailable");
    expect(c.textContent).not.toContain("0%");
  });
});
