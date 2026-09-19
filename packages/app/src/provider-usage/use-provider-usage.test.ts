import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
  providerAccountQueryKey,
  subscribeToProviderAccountRefresh,
  type ProviderAccountLabel,
} from "./use-provider-usage";

const oldLabels: Record<"claude" | "codex", ProviderAccountLabel> = {
  claude: "old@example.test",
  codex: "codex@example.test",
};
const newLabels: Record<"claude" | "codex", ProviderAccountLabel> = {
  claude: "new@example.test",
  codex: "codex@example.test",
};

function createQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

async function flushRefresh() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function observeLabels(
  queryClient: QueryClient,
  queryFn: () => Promise<Record<"claude" | "codex", ProviderAccountLabel>>,
) {
  const observer = new QueryObserver(queryClient, {
    queryKey: providerAccountQueryKey("host-a", "account-controls"),
    queryFn,
    staleTime: 0,
  });
  let resolveInitial: (() => void) | null = null;
  const initial = new Promise<void>((resolve) => {
    resolveInitial = resolve;
  });
  const unsubscribe = observer.subscribe((result) => {
    if (result.isSuccess && !result.isFetching) resolveInitial?.();
  });
  await initial;
  return unsubscribe;
}

describe("subscribeToProviderAccountRefresh", () => {
  it("refreshes the visible app label from a distinct selected plugin cache", async () => {
    const appQueryClient = createQueryClient();
    const pluginQueryClient = createQueryClient();
    const queryFn = vi
      .fn<() => Promise<typeof oldLabels>>()
      .mockResolvedValueOnce(oldLabels)
      .mockResolvedValueOnce(newLabels);
    const queryKey = providerAccountQueryKey("host-a", "account-controls");
    const unsubscribeObserver = await observeLabels(appQueryClient, queryFn);
    const unsubscribe = subscribeToProviderAccountRefresh({
      appQueryClient,
      pluginQueryClient,
      serverId: "host-a",
      pluginId: "account-controls",
    });

    pluginQueryClient.setQueryData(["claude-host-account", "host-a"], {
      email: "new@example.test",
    });
    await flushRefresh();

    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(appQueryClient.getQueryData(queryKey)).toEqual(newLabels);
    unsubscribe();
    unsubscribeObserver();
  });

  it("ignores another host and stops refreshing when the popover subscription closes", async () => {
    const appQueryClient = createQueryClient();
    const pluginQueryClient = createQueryClient();
    const queryFn = vi.fn<() => Promise<typeof oldLabels>>().mockResolvedValue(oldLabels);
    const unsubscribeObserver = await observeLabels(appQueryClient, queryFn);
    const unsubscribe = subscribeToProviderAccountRefresh({
      appQueryClient,
      pluginQueryClient,
      serverId: "host-a",
      pluginId: "account-controls",
    });

    pluginQueryClient.setQueryData(["claude-host-account", "host-b"], {
      email: "other@example.test",
    });
    await flushRefresh();
    expect(queryFn).toHaveBeenCalledTimes(1);

    unsubscribe();
    pluginQueryClient.setQueryData(["codex-host-account", "host-a"], {
      email: "new@example.test",
    });
    await flushRefresh();
    expect(queryFn).toHaveBeenCalledTimes(1);
    unsubscribeObserver();
  });

  it("refreshes labels after a selected plugin status query settles with an error", async () => {
    const appQueryClient = createQueryClient();
    const pluginQueryClient = createQueryClient();
    const queryFn = vi
      .fn<() => Promise<typeof newLabels>>()
      .mockResolvedValueOnce(oldLabels)
      .mockResolvedValueOnce(newLabels);
    const queryKey = providerAccountQueryKey("host-a", "account-controls");
    appQueryClient.setQueryData(queryKey, oldLabels);
    const unsubscribeObserver = await observeLabels(appQueryClient, queryFn);
    const unsubscribe = subscribeToProviderAccountRefresh({
      appQueryClient,
      pluginQueryClient,
      serverId: "host-a",
      pluginId: "account-controls",
    });

    await expect(
      pluginQueryClient.fetchQuery({
        queryKey: ["codex-host-account", "host-a"],
        queryFn: async () => Promise.reject(new Error("status unavailable")),
        retry: false,
      }),
    ).rejects.toThrow("status unavailable");
    await flushRefresh();

    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(appQueryClient.getQueryData(queryKey)).toEqual(newLabels);
    unsubscribe();
    unsubscribeObserver();
  });
});
