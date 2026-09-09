import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, commands, userEvent } from "vitest/browser";
import { ContextWindowMeter } from "./context-window-meter";

declare module "vitest/browser" {
  interface BrowserCommands {
    wheelAccountPopover(): Promise<void>;
    moveOutsidePopover(): Promise<void>;
  }
}
const fixture = vi.hoisted(() => ({ unavailable: false, dialogue: false, mutations: 0 }));
function fixtureSignIn() {
  fixture.mutations++;
}
vi.mock("@/provider-usage/use-provider-accounts", () => ({
  useProviderAccount: () => ({
    available: !fixture.unavailable,
    reason: fixture.unavailable ? "Host is offline" : null,
    checking: false,
    identity: fixture.unavailable
      ? undefined
      : {
          state: "signed-in",
          email: "rob@example.test",
          plan: "max",
          checkedAt: "2026-09-09T12:00:00Z",
        },
  }),
}));
vi.mock("@/plugins/workspace-panels/content", () => ({
  EmbeddedPluginPanel: ({ target }: { target: { panelId: string } }) => (
    <div data-testid="fixture-account-panel">
      {target.panelId}
      <button type="button" onClick={fixtureSignIn}>
        Fixture sign-in
      </button>
    </div>
  ),
}));
vi.mock("@/provider-usage/use-provider-usage", () => ({
  useProviderUsage: () => ({
    refresh: async () => {},
    view: {
      kind: "ready",
      isRefreshing: false,
      payload: {
        requestId: "fixture",
        fetchedAt: "2026-09-09T12:00:00Z",
        providers: ["claude", "codex"].map((providerId) => ({
          providerId,
          displayName: providerId === "claude" ? "Claude" : "Codex",
          status: "available",
          planLabel: null,
          windows: Array.from({ length: 4 }, (_, i) => ({
            id: String(i),
            label: providerId + " allowance " + i,
            usedPct: 42,
            resetsAt: "2026-09-10T12:00:00Z",
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
vi.mock("expo-router", () => ({
  router: {},
  usePathname: () => "/",
  useLocalSearchParams: () => ({}),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-native-reanimated", async () => {
  const { View } = await import("react-native");
  return {
    default: { View },
    useAnimatedStyle: (fn: () => unknown) => fn(),
    FadeIn: { duration: () => undefined },
    FadeOut: { duration: () => undefined },
  };
});
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  fixture.unavailable = false;
  fixture.mutations = 0;
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
function mount(provider = "claude", unknown = false) {
  act(() =>
    root.render(
      <>
        <button type="button" data-testid="before-meter">
          Before
        </button>
        <ContextWindowMeter
          maxTokens={unknown ? null : 1000}
          usedTokens={unknown ? null : 330}
          serverId="host"
          workspaceId="workspace"
          agentId="agent"
          provider={provider}
          showPercentage
        />
        <button type="button" data-testid="after-meter">
          After
        </button>
      </>,
    ),
  );
}
it.each(["claude", "codex"])(
  "hovering %s exposes both allowances and pointer scrolling",
  async (provider) => {
    await page.viewport(390, 600);
    mount(provider);
    await page.getByTestId("context-window-meter").hover();
    await expect.element(page.getByTestId("usage-account-popover")).toBeVisible();
    const scroll = document.querySelector<HTMLElement>('[data-testid="usage-account-scroll"]')!;
    expect(scroll.textContent).toContain("Claude");
    expect(scroll.textContent).toContain("Codex");
    expect(scroll.textContent).toContain("42% used");
    expect(scroll.textContent).toContain("58% remaining");
    expect(container.textContent).toContain("33%");
    await commands.wheelAccountPopover();
    await expect.poll(() => scroll.scrollTop).toBeGreaterThan(0);
    await expect.element(page.getByTestId("usage-account-popover")).toBeVisible();
    const rect = document
      .querySelector('[data-testid="usage-account-popover"]')!
      .getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(390);
    expect(rect.bottom).toBeLessThanOrEqual(600);
    expect(fixture.mutations).toBe(0);
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByTestId("usage-account-popover")).not.toBeInTheDocument();
  },
);
it("click pins, a second click closes, and keyboard focus opens unknown context without invented zero", async () => {
  await page.viewport(800, 700);
  mount("claude", true);
  await page.getByTestId("context-window-meter").click();
  await commands.moveOutsidePopover();
  await expect.element(page.getByTestId("usage-account-popover")).toBeVisible();
  expect(document.querySelector('[data-testid="usage-account-popover"]')!.textContent).toContain(
    "Context usage unavailable",
  );
  expect(container.textContent).not.toContain("0%");
  await page.getByTestId("context-window-meter").click();
  await expect.element(page.getByTestId("usage-account-popover")).not.toBeInTheDocument();
  await page.getByTestId("before-meter").click();
  await userEvent.keyboard("{Tab}");
  await expect.element(page.getByTestId("usage-account-popover")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByTestId("usage-account-popover")).not.toBeInTheDocument();
});
it("offline identity is unavailable and cannot open login controls", async () => {
  fixture.unavailable = true;
  await page.viewport(800, 700);
  mount();
  await page.getByTestId("context-window-meter").click();
  await expect.element(page.getByRole("button", { name: "Change Claude login" })).toBeDisabled();
  expect(document.body.textContent).toContain("Host is offline");
  expect(document.body.textContent).not.toContain("rob@example.test");
  expect(fixture.mutations).toBe(0);
});
it("login dialogue survives popover dismissal and opening it makes no mutation", async () => {
  await page.viewport(800, 700);
  mount();
  await page.getByTestId("context-window-meter").click();
  await page.getByRole("button", { name: "Change Codex login" }).click();
  await expect.element(page.getByTestId("usage-account-popover")).not.toBeInTheDocument();
  await expect.element(page.getByTestId("fixture-account-panel")).toBeVisible();
  expect(document.body.textContent).toContain("codex-account");
  expect(fixture.mutations).toBe(0);
});

it("keyboard traverses both login actions between surrounding toolbar controls", async () => {
  await page.viewport(800, 700);
  mount();
  await page.getByTestId("before-meter").click();
  await userEvent.keyboard("{Tab}");
  await expect.element(page.getByTestId("usage-account-popover")).toBeVisible();
  for (const label of ["Change Claude login", "Change Codex login"]) {
    for (let i = 0; i < 6 && document.activeElement?.getAttribute("aria-label") !== label; i++)
      await userEvent.keyboard("{Tab}");
    expect(document.activeElement?.getAttribute("aria-label")).toBe(label);
  }
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByTestId("fixture-account-panel")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByTestId("fixture-account-panel")).not.toBeInTheDocument();
  await expect
    .poll(() => document.activeElement?.getAttribute("data-testid"))
    .toBe("context-window-meter");
  await expect.element(page.getByTestId("usage-account-popover")).not.toBeInTheDocument();
});
