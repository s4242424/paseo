import { describe, expect, test } from "vitest";
import {
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  type SessionInboundMessage,
  type SessionOutboundMessage,
} from "../messages.js";
import {
  DAEMON_PERMISSIONS,
  OWNER_PERMISSIONS,
  SessionAuthorization,
  permissionsForLegacyHubScopes,
  parseDaemonPermissions,
} from "./index.js";

function inboundOperationTypes(): SessionInboundMessage["type"][] {
  return SessionInboundMessageSchema.options.map((option) => option.shape.type.value);
}

function outboundOperationTypes(): SessionOutboundMessage["type"][] {
  return SessionOutboundMessageSchema.options.map((option) => option.shape.type.value);
}

function inboundMessage(type: SessionInboundMessage["type"]): SessionInboundMessage {
  return { type } as SessionInboundMessage;
}

function outboundMessage(type: SessionOutboundMessage["type"]): SessionOutboundMessage {
  if (type === "status")
    return {
      type,
      payload: { status: "agent_create_failed", error: "test", requestId: "test" },
    } as SessionOutboundMessage;
  return { type } as SessionOutboundMessage;
}

describe("SessionAuthorization", () => {
  test("owner authority covers every session operation", () => {
    const authorization = new SessionAuthorization(OWNER_PERMISSIONS);

    expect(
      inboundOperationTypes().every((type) => authorization.allowsInbound(inboundMessage(type))),
    ).toBe(true);
    expect(
      outboundOperationTypes().every((type) => authorization.allowsOutbound(outboundMessage(type))),
    ).toBe(true);
  });

  test("semantic permissions authorize operations instead of RPC namespaces", () => {
    const authorization = new SessionAuthorization(["hub.execute"]);

    expect(authorization.allowsInbound(inboundMessage("hub.execution.agent.create.request"))).toBe(
      true,
    );
    expect(authorization.allowsOutbound(outboundMessage("hub.execution.agent.update"))).toBe(true);
    expect(authorization.allowsInbound(inboundMessage("get_providers_snapshot_request"))).toBe(
      true,
    );
    expect(authorization.allowsInbound(inboundMessage("refresh_providers_snapshot_request"))).toBe(
      true,
    );
    expect(authorization.allowsOutbound(outboundMessage("get_providers_snapshot_response"))).toBe(
      true,
    );
    expect(authorization.allowsOutbound(outboundMessage("providers_snapshot_update"))).toBe(true);
    expect(
      authorization.allowsOutbound(outboundMessage("refresh_providers_snapshot_response")),
    ).toBe(true);
    expect(authorization.allowsInbound(inboundMessage("get_daemon_config_request"))).toBe(false);
    expect(authorization.allowsInbound(inboundMessage("provider_diagnostic_request"))).toBe(false);
    expect(authorization.allowsInbound(inboundMessage("ping"))).toBe(false);
    expect(
      authorization.allowsInbound(inboundMessage("hub.management.daemon.get_status.request")),
    ).toBe(false);
  });

  test("Hub can operate ordinary agents and recover workspaces without daemon administration", () => {
    const authorization = new SessionAuthorization(["hub.execute"]);
    for (const type of [
      "create_agent_request",
      "send_agent_message_request",
      "fetch_agent_request",
      "agent.timeline.set_subscription.request",
      "workspace.recovery.inspect.request",
      "workspace.recovery.restore.request",
    ] as const) {
      expect(authorization.allowsInbound(inboundMessage(type))).toBe(true);
    }
    for (const type of [
      "status",
      "agent_update",
      "agent_stream",
      "send_agent_message_response",
      "workspace.recovery.restore.response",
    ] as const) {
      expect(authorization.allowsOutbound(outboundMessage(type))).toBe(true);
    }
    for (const type of [
      "restart_server_request",
      "terminal_input",
      "hub.management.daemon.permissions.update.request",
    ] as const) {
      expect(authorization.allowsInbound(inboundMessage(type))).toBe(false);
    }
    expect(
      authorization.allowsOutbound({
        type: "status",
        payload: { status: "shutdown_requested", clientId: "owner", requestId: "shutdown" },
      }),
    ).toBe(false);
    authorization.replacePermissions([]);
    expect(authorization.allowsInbound(inboundMessage("send_agent_message_request"))).toBe(false);
    expect(authorization.allowsOutbound(outboundMessage("agent_update"))).toBe(false);
  });

  test("correlated authorization errors can always be emitted", () => {
    const authorization = new SessionAuthorization([]);

    expect(authorization.allowsOutbound(outboundMessage("rpc_error"))).toBe(true);
  });

  test("seat rotation control requires workspace write and revocation removes it", () => {
    const viewer = new SessionAuthorization(["workspace.read"]);
    const operator = new SessionAuthorization(["workspace.write"]);
    const hub = new SessionAuthorization(["hub.execute"]);
    for (const type of [
      "agent.seat_rotation.request",
      "agent.seat_rotation.cancel.request",
    ] as const) {
      expect(viewer.allowsInbound(inboundMessage(type))).toBe(false);
      expect(hub.allowsInbound(inboundMessage(type))).toBe(false);
      expect(operator.allowsInbound(inboundMessage(type))).toBe(true);
    }
    operator.replacePermissions([]);
    expect(operator.allowsInbound(inboundMessage("agent.seat_rotation.request"))).toBe(false);
    expect(operator.allowsInbound(inboundMessage("agent.seat_rotation.cancel.request"))).toBe(
      false,
    );
  });

  test("native and policy rotation receipts require workspace read in both directions", () => {
    const viewer = new SessionAuthorization(["workspace.read"]);
    const unrelated = new SessionAuthorization(["daemon.read", "hub.execute"]);
    for (const operation of [
      "agent.seat_rotation.inspect",
      "agent.seat_rotation.predecessor.inspect",
      "agent.seat_rotation.policy.inspect",
    ] as const) {
      const request = inboundMessage(`${operation}.request`);
      const response = outboundMessage(`${operation}.response`);
      expect(viewer.allowsInbound(request)).toBe(true);
      expect(viewer.allowsOutbound(response)).toBe(true);
      expect(unrelated.allowsInbound(request)).toBe(false);
      expect(unrelated.allowsOutbound(response)).toBe(false);
    }
  });

  test("legacy Hub authority is translated at one compatibility boundary", () => {
    expect(permissionsForLegacyHubScopes(["hub.execution.*"])).toEqual(["hub.execute"]);
    expect(permissionsForLegacyHubScopes(["*"])).toEqual([]);
  });

  test("permission names are semantic", () => {
    expect(
      DAEMON_PERMISSIONS.every(
        (permission) => !permission.includes("*") && !permission.includes("request"),
      ),
    ).toBe(true);
  });

  test("permission parsing validates against the shared registry and removes duplicates", () => {
    expect(parseDaemonPermissions(["hub.execute", "hub.execute"])).toEqual(["hub.execute"]);
    expect(() => parseDaemonPermissions(["hub.execution.*"])).toThrow("Invalid daemon permission");
  });
});
