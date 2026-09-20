import { describe, expect, test, vi } from "vitest";

import {
  closeProviderSmokeResources,
  ProviderSmokeCleanupError,
} from "./provider-smoke-cleanup.js";

describe("provider smoke cleanup reporting", () => {
  test("records a client cleanup failure and still closes the daemon", async () => {
    const closeClient = vi.fn(async () => {
      throw new Error("client close failed");
    });
    const closeDaemon = vi.fn(async () => undefined);

    const cleanup = await closeProviderSmokeResources({ closeClient, closeDaemon });

    expect(closeClient).toHaveBeenCalledOnce();
    expect(closeDaemon).toHaveBeenCalledOnce();
    expect(cleanup).toEqual({
      status: "failed",
      receiptState: "retained",
      attempts: [
        {
          operation: "client.close",
          status: "failed",
          error: { name: "Error", message: "client close failed" },
        },
        { operation: "daemon.close", status: "succeeded" },
      ],
    });
    expect(() => {
      throw new ProviderSmokeCleanupError(cleanup);
    }).toThrow("Provider smoke cleanup failed: client.close");
  });
});
