/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { theme } = vi.hoisted(() => ({
  theme: {
    borderRadius: { full: 999 },
    spacing: { 1: 4, 1.5: 6 },
    fontSize: { sm: 13, base: 15 },
    fontWeight: { normal: "400" },
    colors: {
      foreground: "#foreground",
      foregroundMuted: "#muted",
      surface3: "#track",
      destructive: "#red",
      palette: { amber: { 500: "#yellow" } },
    },
  },
}));

vi.mock("react-native", () => {
  const passthrough =
    (tag: string) =>
    ({ children, testID, accessibilityLabel }: React.PropsWithChildren<Record<string, string>>) =>
      React.createElement(
        tag,
        { "data-testid": testID, "aria-label": accessibilityLabel },
        children,
      );
  return { View: passthrough("div"), Pressable: passthrough("button"), Text: passthrough("span") };
});

vi.mock("react-native-svg", () => ({
  default: ({ children }: React.PropsWithChildren) => React.createElement("svg", null, children),
  Circle: ({ stroke }: { stroke: string }) =>
    React.createElement("circle", { "data-stroke": stroke }),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: { create: (factory: (value: typeof theme) => unknown) => factory(theme) },
  useUnistyles: () => ({ theme }),
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => React.createElement("div", null, children),
  TooltipTrigger: ({ children }: React.PropsWithChildren) =>
    React.createElement("div", null, children),
  TooltipContent: () => null,
}));

vi.mock("@/provider-usage/tooltip-section", () => ({ ProviderUsageTooltipSection: () => null }));
vi.mock("@/provider-usage/use-provider-usage", () => ({
  useProviderUsage: () => ({ view: null, refresh: async () => {} }),
}));

import { ContextWindowMeter } from "./context-window-meter";
import { isClaudeContextIdentity } from "./context-window-meter.utils";

const MAX = 1000;
const MUTED = "#muted";
const YELLOW = "#yellow";
const RED = "#red";

// The unit project compiles JSX with the classic runtime; the component file has no React import.
(globalThis as { React?: typeof React }).React = React;

let container: HTMLDivElement;
let root: Root;

function progressStroke(used: number | null, isClaude: boolean | undefined): string | null {
  act(() => {
    root.render(
      <ContextWindowMeter
        maxTokens={used === null ? null : MAX}
        usedTokens={used}
        isClaude={isClaude}
      />,
    );
  });
  const circles = container.querySelectorAll("circle");
  return circles.length === 2 ? circles[1].getAttribute("data-stroke") : null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ContextWindowMeter colours", () => {
  it.each([
    [399, MUTED],
    [400, YELLOW],
    [499, YELLOW],
    [500, RED],
    [1000, RED],
  ])("Claude at %i/1000 uses %s", (used, colour) => {
    expect(progressStroke(used, true)).toBe(colour);
  });

  it.each([
    [699, MUTED],
    [700, YELLOW],
    [900, YELLOW],
    [901, RED],
  ])("non-Claude (explicit) at %i/1000 keeps default %s", (used, colour) => {
    expect(progressStroke(used, false)).toBe(colour);
  });

  it("keeps the default thresholds when identity is missing", () => {
    expect(progressStroke(500, undefined)).toBe(MUTED);
    expect(progressStroke(700, undefined)).toBe(YELLOW);
  });

  it("renders no ring when usage is missing and nothing is pending", () => {
    expect(progressStroke(null, true)).toBeNull();
    expect(container.querySelector("[data-testid=context-window-meter]")).toBeNull();
  });

  it("renders the meter with fractional Claude percentages either side of 40 and 50", () => {
    expect(progressStroke(399, true)).toBe(MUTED); // 39.9%
    expect(progressStroke(499, true)).toBe(YELLOW); // 49.9%
  });
});

describe("isClaudeContextIdentity", () => {
  it("accepts the claude provider and claude-* runtime models", () => {
    expect(isClaudeContextIdentity({ provider: "claude" })).toBe(true);
    expect(
      isClaudeContextIdentity({ provider: "claude-controller", model: "claude-sonnet-5" }),
    ).toBe(true);
    expect(
      isClaudeContextIdentity({
        provider: "sonnet-medium-builder",
        runtimeModel: "claude-sonnet-5[1m]",
      }),
    ).toBe(true);
  });

  it("rejects Codex, other custom providers and missing identity", () => {
    expect(isClaudeContextIdentity({ provider: "codex", model: "gpt-5" })).toBe(false);
    expect(isClaudeContextIdentity({ provider: "zai-claude", model: "glm-4.6" })).toBe(false);
    expect(isClaudeContextIdentity({ provider: "claude-lookalike", model: null })).toBe(false);
    expect(isClaudeContextIdentity({})).toBe(false);
  });
});
