import { CircleAlert } from "lucide-react-native";
import invariant from "tiny-invariant";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel, type PanelDescriptor } from "@/panels/panel-registry";
import { resolvePluginIcon } from "../icons";
import { useInstalledPlugin } from "../registry";
import { EmbeddedPluginPanel } from "./content";

function PluginPanel() {
  const { serverId, workspaceId, target } = usePaneContext();
  invariant(target.kind === "plugin", "PluginPanel requires plugin target");
  return <EmbeddedPluginPanel serverId={serverId} workspaceId={workspaceId} target={target} />;
}

function usePluginPanelDescriptor(
  target: Extract<import("@/workspace-tabs/model").WorkspaceTabTarget, { kind: "plugin" }>,
  context: { serverId: string },
): PanelDescriptor {
  const plugin = useInstalledPlugin(context.serverId, target.pluginId);
  const panel = plugin?.workspacePanels.find(
    (contribution) => contribution.id === target.panelId && contribution.context === target.context,
  );
  if (!panel) {
    return {
      label: "Plugin unavailable",
      subtitle: target.pluginId,
      tooltip: "This plugin panel is unavailable",
      titleState: "ready",
      icon: CircleAlert,
      statusBucket: null,
    };
  }
  return {
    label: panel.title,
    subtitle: target.pluginId,
    tooltip: panel.title,
    titleState: "ready",
    icon: resolvePluginIcon(panel.icon),
    statusBucket: null,
  };
}

export const pluginPanelRegistration = definePanel("plugin", {
  component: PluginPanel,
  useDescriptor: usePluginPanelDescriptor,
});
