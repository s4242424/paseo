import { describe, expect, it } from "vitest";
import type { InstalledPlugin } from "@/plugins/types";
import { canOpenAccountPanel, resolveAccountPanelTarget } from "./account-panel";

function plugin(input: {
  serverId: string;
  id: string;
  panels: Array<{ id: string; context: "agent" }>;
}): InstalledPlugin {
  return {
    id: input.id,
    serverId: input.serverId,
    clientBundle: "",
    cleanup: () => undefined,
    surfaces: [],
    settingsScreens: [],
    sidebarItems: [],
    workspacePanels: input.panels.map((panel) => ({
      ...panel,
      title: panel.id,
      icon: "Blocks",
      locations: ["workspace"],
      Component: () => null,
    })),
    commandCenterItems: [],
    clientSlashCommands: [],
    attachmentSources: [],
    themes: [],
    timelineTransformers: [],
    timelineRenderers: [],
    queryClient: {} as InstalledPlugin["queryClient"],
  };
}

describe("resolveAccountPanelTarget", () => {
  it("uses only the current host's registered agent account panel", () => {
    const target = resolveAccountPanelTarget(
      [
        plugin({
          serverId: "mini",
          id: "indicator",
          panels: [{ id: "account", context: "agent" }],
        }),
        plugin({
          serverId: "other",
          id: "indicator",
          panels: [{ id: "account", context: "agent" }],
        }),
      ],
      "mini",
    );

    expect(target).toEqual({ pluginId: "indicator", panelId: "account" });
  });

  it("does not fall through to another host or an ambiguous panel", () => {
    expect(
      resolveAccountPanelTarget(
        [
          plugin({
            serverId: "other",
            id: "indicator",
            panels: [{ id: "account", context: "agent" }],
          }),
        ],
        "mini",
      ),
    ).toBeNull();
    expect(
      resolveAccountPanelTarget(
        [
          plugin({ serverId: "mini", id: "one", panels: [{ id: "account", context: "agent" }] }),
          plugin({ serverId: "mini", id: "two", panels: [{ id: "account", context: "agent" }] }),
        ],
        "mini",
      ),
    ).toBeNull();
  });

  it("requires the current host to remain connected before enabling navigation", () => {
    const accountPanel = { pluginId: "indicator", panelId: "account" };
    expect(
      canOpenAccountPanel({
        accountPanel,
        isConnected: false,
        workspaceId: "workspace",
        agentId: "agent",
      }),
    ).toBe(false);
    expect(
      canOpenAccountPanel({
        accountPanel,
        isConnected: true,
        workspaceId: "workspace",
        agentId: "agent",
      }),
    ).toBe(true);
  });
});
