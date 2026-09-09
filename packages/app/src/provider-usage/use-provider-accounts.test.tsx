/** @vitest-environment jsdom */
import React from "react";
import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useProviderAccount } from "./use-provider-accounts";
import { useProviderUsage } from "./use-provider-usage";
const fixture = vi.hoisted(() => ({
  connected: true,
  installed: true,
  invoke: vi.fn(),
  usage: vi.fn(),
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: (hostId: string) => ({
    invokePluginRpc: (...args: unknown[]) => fixture.invoke(hostId, ...args),
    listProviderUsage: () => fixture.usage(hostId),
  }),
  useHostRuntimeIsConnected: () => fixture.connected,
}));
vi.mock("@/plugins/registry", () => ({
  useInstalledPlugin: () =>
    fixture.installed
      ? {
          clientBundle: "fixture-v1",
          workspacePanels: [
            { id: "account", context: "agent" },
            { id: "codex-account", context: "agent" },
          ],
        }
      : null,
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (select: (state: unknown) => unknown) =>
    select({ sessions: { host: { serverInfo: { features: { providerUsageList: true } } } } }),
}));
const response = (email: string) => ({
  state: "oauth",
  email,
  plan: "max",
  checkedAt: "2026-09-09T12:00:00Z",
});
let queryClient: QueryClient;
beforeEach(() => {
  fixture.connected = true;
  fixture.installed = true;
  fixture.invoke.mockReset();
  fixture.usage.mockReset();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});
function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
it("does not read a closed or disconnected host; reads only when requested", async () => {
  fixture.invoke.mockResolvedValue(response("a@example.test"));
  const { result, rerender } = renderHook(
    ({ enabled }) => useProviderAccount("host", "claude", enabled),
    { initialProps: { enabled: false }, wrapper },
  );
  expect(fixture.invoke).not.toHaveBeenCalled();
  rerender({ enabled: true });
  await waitFor(() => expect(result.current.identity?.email).toBe("a@example.test"));
  expect(fixture.invoke.mock.calls[0]).toEqual([
    "host",
    "plugin-version-indicator",
    "account.status",
    {},
  ]);
  fixture.connected = false;
  rerender({ enabled: true });
  expect(result.current.identity).toBeUndefined();
  expect(result.current.available).toBe(false);
});
it("late host A response never becomes host B identity", async () => {
  let resolveA!: (value: unknown) => void;
  fixture.invoke.mockImplementation((host: string) =>
    host === "a"
      ? new Promise((resolve) => {
          resolveA = resolve;
        })
      : Promise.resolve(response("b@example.test")),
  );
  const { result, rerender } = renderHook(({ host }) => useProviderAccount(host, "claude", true), {
    initialProps: { host: "a" },
    wrapper,
  });
  await waitFor(() => expect(fixture.invoke).toHaveBeenCalled());
  rerender({ host: "b" });
  await waitFor(() => expect(result.current.identity?.email).toBe("b@example.test"));
  await act(async () => {
    resolveA(response("a@example.test"));
    await Promise.resolve();
  });
  expect(result.current.identity?.email).toBe("b@example.test");
});
it("failed identity refresh clears previous success", async () => {
  fixture.invoke.mockResolvedValue(response("old@example.test"));
  const { result } = renderHook(() => useProviderAccount("host", "claude", true), { wrapper });
  await waitFor(() => expect(result.current.identity?.email).toBe("old@example.test"));
  fixture.invoke.mockRejectedValue(new Error("PRIVATE HOST DETAIL"));
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: ["usage-account"] });
  });
  await waitFor(() => expect(result.current.reason).toBe("Account identity unavailable"));
  expect(result.current.identity).toBeUndefined();
});
it("failed allowance refresh cannot leave cached figures ready", async () => {
  fixture.usage.mockResolvedValue({
    requestId: "fixture",
    providers: [],
    fetchedAt: "2026-09-09T12:00:00Z",
  });
  const { result } = renderHook(() => useProviderUsage("host"), { wrapper });
  await waitFor(() => expect(result.current.view.kind).toBe("ready"));
  fixture.usage.mockRejectedValue(new Error("Unavailable"));
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: ["providerUsage"] });
  });
  await waitFor(() => expect(result.current.view.kind).toBe("error"));
});
