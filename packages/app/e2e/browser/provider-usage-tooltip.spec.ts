import { expect, test, type Page } from "../support/fixtures";
import { expectComposerVisible } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { installProviderUsageFixture } from "../support/helpers/provider-usage";
import { ensureExplorerSidebar } from "../support/helpers/workspace-tabs";

const MOBILE_VIEWPORT = { width: 390, height: 844 };
const ACCOUNT_PLUGIN_ID = "provider-usage-account";
const ACCOUNT_PLUGIN_BUNDLE = `(function() {
  const module = { exports: {} };
  module.exports.default = function(plugin) {
    function AccountPanel(props) { return "Account panel for " + props.agentId; }
    plugin.addWorkspacePanel({
      id: "account",
      title: "Account",
      icon: "Blocks",
      context: "agent",
      Component: AccountPanel,
    });
    return function() {};
  };
  return module.exports;
})`;
const ACCOUNT_PLUGIN_CATALOG = [
  {
    id: ACCOUNT_PLUGIN_ID,
    clientBundle: ACCOUNT_PLUGIN_BUNDLE,
    requirements: { paseo: ">=0.8.0" },
  },
];
const ACCOUNT_OBSERVER_PLUGIN_BUNDLE = `(function(require) {
  const module = { exports: {} };
  module.exports.default = function(plugin) {
    const React = require("react");
    const { Text } = require("react-native");
    const { useRpc } = require("@getpaseo/plugin/client");
    const { useQuery } = require("@tanstack/react-query");
    const accountStatus = { name: "account.status" };
    function AccountStatusObserver(props) {
      const rpc = useRpc(accountStatus);
      const query = useQuery({
        queryKey: ["claude-host-account", props.host.id],
        queryFn: () => rpc({}),
        staleTime: 30000,
      });
      React.useEffect(() => {
        const refresh = () => void query.refetch();
        globalThis.addEventListener("provider-usage-test-refresh", refresh);
        return () => globalThis.removeEventListener("provider-usage-test-refresh", refresh);
      }, [query.refetch]);
      return React.createElement(Text, { testID: "plugin-account-status-observer" }, "Account status observer");
    }
    function AccountPanel(props) { return "Account panel for " + props.agentId; }
    plugin.addWorkspacePanel({
      id: "status-observer",
      title: "Status observer",
      icon: "Blocks",
      context: "workspace",
      locations: ["explorer"],
      Component: AccountStatusObserver,
    });
    plugin.addWorkspacePanel({
      id: "account",
      title: "Account",
      icon: "Blocks",
      context: "agent",
      Component: AccountPanel,
    });
    return function() {};
  };
  return module.exports;
})`;
const ACCOUNT_OBSERVER_PLUGIN_CATALOG = [
  {
    id: ACCOUNT_PLUGIN_ID,
    clientBundle: ACCOUNT_OBSERVER_PLUGIN_BUNDLE,
    requirements: { paseo: ">=0.8.0" },
  },
];

async function openMockAgent(page: Page, viewport = MOBILE_VIEWPORT) {
  await page.setViewportSize(viewport);
  const session = await seedMockAgentWorkspace({
    repoPrefix: "provider-usage-tooltip-",
    title: "Provider usage tooltip e2e",
    initialPrompt: "emit 1 coalesced agent stream update for provider usage tooltip.",
  });
  await openAgentRoute(page, session);
  await expectComposerVisible(page);
  await expect(page.getByTestId("context-window-meter")).toBeVisible({
    timeout: 30_000,
  });
  return session;
}

test.describe("provider usage tooltip", () => {
  test("opens on mobile tap and renders Claude and Codex usage only", async ({ page }) => {
    test.setTimeout(180_000);
    const usageFixture = await installProviderUsageFixture(
      page,
      [
        {
          fetchedAt: "2026-06-19T00:00:00.000Z",
          providers: [
            {
              providerId: "claude",
              displayName: "Claude",
              status: "available",
              planLabel: null,
              windows: [
                {
                  id: "session",
                  label: "Session",
                  usedPct: 25,
                  remainingPct: 75,
                  resetsAt: "2026-06-19T05:00:00.000Z",
                },
                {
                  id: "weekly",
                  label: "Weekly",
                  usedPct: 69,
                  remainingPct: 31,
                },
                {
                  id: "weekly-fable",
                  label: "Weekly · Fable",
                  usedPct: 82,
                  remainingPct: 18,
                },
              ],
              balances: [
                {
                  id: "extra-usage",
                  label: "Extra usage",
                  remaining: 0,
                  unit: "usd",
                },
              ],
              details: [{ id: "extra-usage", label: "Extra usage", value: "Disabled" }],
            },
            {
              providerId: "codex",
              displayName: "Codex",
              status: "available",
              planLabel: null,
              windows: [
                {
                  id: "session",
                  label: "Session",
                  usedPct: 52,
                  remainingPct: 48,
                },
              ],
            },
            {
              providerId: "copilot",
              displayName: "Copilot",
              status: "unavailable",
              planLabel: null,
              windows: [],
            },
          ],
        },
      ],
      { pluginCatalog: ACCOUNT_PLUGIN_CATALOG },
    );
    const session = await openMockAgent(page);
    try {
      expect(usageFixture.requestCount()).toBe(0);

      await page.getByTestId("context-window-meter").click();
      await usageFixture.waitForRequestCount(1);

      await expect(page.getByText("Claude", { exact: true })).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByText("Codex", { exact: true })).toBeVisible();
      await expect(page.getByText("claude@example.test", { exact: true })).toBeVisible();
      await expect(page.getByText("codex@example.test", { exact: true })).toBeVisible();
      await expect(page.getByText("Session", { exact: true })).toHaveCount(2);
      await expect(page.getByText("75% remaining", { exact: false })).toBeVisible();
      await expect(page.getByText("Copilot", { exact: true })).toHaveCount(0);
      await expect(page.getByText("Extra usage", { exact: true })).toHaveCount(0);
      const popover = page.getByTestId("context-window-meter-popover");
      await expect(popover).toBeVisible();
      const popoverBox = await popover.boundingBox();
      if (!popoverBox) throw new Error("Context-meter popover has no layout box.");
      expect(popoverBox.width).toBeLessThanOrEqual(MOBILE_VIEWPORT.width - 16);
      expect(popoverBox.height).toBeLessThanOrEqual(MOBILE_VIEWPORT.height - 16);
      const switchAccount = page.getByTestId("provider-usage-switch-account");
      const switchAccountBox = await switchAccount.boundingBox();
      if (!switchAccountBox) throw new Error("Switch account button has no layout box.");
      expect(switchAccountBox.y + switchAccountBox.height).toBeLessThanOrEqual(
        MOBILE_VIEWPORT.height,
      );
      await expect(switchAccount).toBeEnabled();
      await switchAccount.click();
      await expect(page.getByText(`Account panel for ${session.agentId}`)).toBeVisible();
    } finally {
      await session.cleanup();
    }
  });

  test("keeps compact provider status and rejects unverified account labels", async ({ page }) => {
    test.setTimeout(180_000);
    const usageFixture = await installProviderUsageFixture(
      page,
      [
        {
          fetchedAt: "2026-06-19T00:00:00.000Z",
          providers: [
            {
              providerId: "claude",
              displayName: "Claude",
              status: "unavailable",
              planLabel: "Max 20x",
              windows: [],
            },
            {
              providerId: "codex",
              displayName: "Codex",
              status: "error",
              planLabel: "Pro",
              error: "Codex authentication failed",
              windows: [],
            },
          ],
        },
      ],
      {
        pluginCatalog: ACCOUNT_PLUGIN_CATALOG,
        accountStatuses: {
          claude: { state: "signed-out", email: "stray-claude@example.test" },
          codex: { state: "other", email: "stray-codex@example.test" },
        },
      },
    );
    const session = await openMockAgent(page);
    try {
      await page.getByTestId("context-window-meter").click();
      await usageFixture.waitForRequestCount(1);

      await expect(page.getByText("Signed out", { exact: true })).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByText("Account unknown", { exact: true })).toBeVisible();
      await expect(page.getByText("Unavailable", { exact: true })).toBeVisible();
      await expect(page.getByText("Error", { exact: true })).toBeVisible();
      await expect(page.getByText("Codex authentication failed", { exact: true })).toBeVisible();
      await expect(page.getByText("stray-claude@example.test", { exact: true })).toHaveCount(0);
      await expect(page.getByText("stray-codex@example.test", { exact: true })).toHaveCount(0);
      await expect(page.getByText("Max 20x", { exact: true })).toHaveCount(0);
      await expect(page.getByText("Pro", { exact: true })).toHaveCount(0);
    } finally {
      await session.cleanup();
    }
  });

  test("replaces the open popover account name after the selected plugin status query settles", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const accountStatuses = {
      claude: { state: "oauth", email: "old@example.test" },
      codex: { state: "chatgpt", email: "codex@example.test" },
    };
    const usageFixture = await installProviderUsageFixture(
      page,
      [
        {
          fetchedAt: "2026-06-19T00:00:00.000Z",
          providers: [
            {
              providerId: "claude",
              displayName: "Claude",
              status: "available",
              planLabel: null,
              windows: [{ id: "session", label: "Session", usedPct: 25 }],
            },
            {
              providerId: "codex",
              displayName: "Codex",
              status: "available",
              planLabel: null,
              windows: [{ id: "session", label: "Session", usedPct: 52 }],
            },
          ],
        },
      ],
      { pluginCatalog: ACCOUNT_OBSERVER_PLUGIN_CATALOG, accountStatuses },
    );
    const session = await openMockAgent(page, { width: 1280, height: 800 });
    try {
      const explorer = await ensureExplorerSidebar(page);
      await explorer.getByTestId("explorer-sidebar-tab-rail").click({
        button: "right",
        position: { x: 20, y: 2 },
      });
      const menu = page.getByTestId("explorer-sidebar-tab-configuration");
      await menu.getByRole("menuitem", { name: "Status observer", exact: true }).click();
      await expect(page.getByTestId("plugin-account-status-observer")).toBeVisible();

      await page.getByTestId("context-window-meter").hover();
      await usageFixture.waitForRequestCount(1);
      await expect(page.getByText("old@example.test", { exact: true })).toBeVisible({
        timeout: 10_000,
      });

      accountStatuses.claude.email = "new@example.test";
      await page.evaluate(() => globalThis.dispatchEvent(new Event("provider-usage-test-refresh")));

      await expect(page.getByText("new@example.test", { exact: true })).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByText("old@example.test", { exact: true })).toHaveCount(0);
      expect(usageFixture.requestCount()).toBe(1);

      await page.mouse.move(0, 0);
      await expect(page.getByTestId("context-window-meter-popover")).not.toBeVisible();
      await page.getByTestId("context-window-meter").hover();
      await expect(page.getByText("new@example.test", { exact: true })).toBeVisible({
        timeout: 10_000,
      });
    } finally {
      await session.cleanup();
    }
  });

  test("refreshes usage again each time the tooltip is shown", async ({ page }) => {
    test.setTimeout(180_000);
    const usageFixture = await installProviderUsageFixture(
      page,
      [
        {
          fetchedAt: "2026-06-19T00:00:00.000Z",
          providers: [
            {
              providerId: "claude",
              displayName: "Claude",
              status: "available",
              planLabel: "Test plan",
              windows: [{ id: "session", label: "Session", usedPct: 41 }],
            },
          ],
        },
        {
          fetchedAt: "2026-06-19T00:01:00.000Z",
          providers: [
            {
              providerId: "claude",
              displayName: "Claude",
              status: "available",
              planLabel: "Test plan",
              windows: [{ id: "session", label: "Session", usedPct: 64 }],
            },
          ],
        },
      ],
      { pluginCatalog: ACCOUNT_PLUGIN_CATALOG },
    );
    const session = await openMockAgent(page, { width: 1280, height: 800 });
    try {
      const meter = page.getByTestId("context-window-meter");

      await meter.hover();
      await usageFixture.waitForRequestCount(1);
      await expect(page.getByText("59% remaining", { exact: false })).toBeVisible({
        timeout: 10_000,
      });
      await page.getByTestId("provider-usage-switch-account").hover();
      await expect(page.getByText("59% remaining", { exact: false })).toBeVisible();
      await page.getByTestId("provider-usage-switch-account").focus();
      await expect(page.getByText("59% remaining", { exact: false })).toBeVisible();

      await page.mouse.move(0, 0);
      await expect(page.getByText("59% remaining", { exact: false })).toBeVisible();
      await page.keyboard.press("Tab");
      await expect(page.getByText("Claude", { exact: true })).toHaveCount(0);

      await meter.hover();
      await usageFixture.waitForRequestCount(2);
      expect(usageFixture.requestCount()).toBe(2);
      await expect(page.getByText("36% remaining", { exact: false })).toBeVisible();
      await page.getByTestId("provider-usage-switch-account").click();
      await expect(page.getByText(`Account panel for ${session.agentId}`)).toBeVisible();
    } finally {
      await session.cleanup();
    }
  });
});
