import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, commands, userEvent } from "vitest/browser";
import { ContextWindowMeter } from "./context-window-meter";

declare module "vitest/browser" {
  interface BrowserCommands {
    wheelUsage: () => Promise<void>;
  }
}
vi.mock("@/provider-usage/use-provider-usage", () => ({
  useProviderUsage: () => ({
    refresh: async () => {},
    view: {
      kind: "ready",
      isRefreshing: false,
      payload: {
        requestId: "fixture",
        fetchedAt: "2026-09-08T00:00:00Z",
        providers: ["claude", "codex"].map((providerId) => ({
          providerId,
          displayName: providerId === "claude" ? "Claude" : "Codex",
          status: "available",
          planLabel: null,
          windows: Array.from({ length: 4 }, (_, i) => ({
            id: String(i),
            label: providerId + " allowance " + i,
            usedPct: 42,
          })),
        })),
      },
    },
  }),
}));
vi.mock("@/constants/platform", () => ({
  isWeb: true,
  isNative: false,
  getIsElectron: () => false,
  getIsElectronMac: () => false,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
// Keep the real RN View and pointer behaviour; animation timing is outside this interaction test.
vi.mock("react-native-reanimated", async () => {
  const { View } = await import("react-native");
  return {
    default: { View },
    FadeIn: { duration: () => undefined },
    FadeOut: { duration: () => undefined },
  };
});
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  container.style.cssText = "position:fixed;bottom:20px;left:180px";
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it.each(["claude", "codex"])(
  "opens and pointer-scrolls both allowances from %s",
  async (provider) => {
    await page.viewport(390, 600);
    act(() =>
      root.render(
        <ContextWindowMeter
          maxTokens={1000}
          usedTokens={330}
          provider={provider}
          showPercentage
        />
      )
    );
    await page.getByTestId("context-window-meter").click();
    await expect
      .element(page.getByTestId("context-window-popup"))
      .toBeVisible();
    const scroll = document.querySelector<HTMLElement>(
      '[data-testid="provider-usage-scroll"]'
    )!;
    expect(scroll.textContent).toContain("Claude");
    expect(scroll.textContent).toContain("Codex");
    expect(container.textContent).toContain("33%");
    expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
    await commands.wheelUsage();
    await expect.poll(() => scroll.scrollTop).toBeGreaterThan(0);
    await expect
      .element(page.getByTestId("context-window-popup"))
      .toBeVisible();
    const rect = document
      .querySelector('[data-testid="context-window-popup"]')!
      .getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(390);
    await userEvent.keyboard("{Escape}");
    await expect
      .element(page.getByTestId("context-window-popup"))
      .not.toBeInTheDocument();
  }
);
