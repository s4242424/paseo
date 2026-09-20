import { describe, expect, test } from "vitest";

import { waitForSeatRotationReceipt } from "./seat-rotation-receipt.js";

interface Receipt {
  phase: "pending" | "succeeded" | "failed";
  revision: number;
}

function createUpdates() {
  let listener: (() => void) | null = null;
  let unsubscribeCount = 0;
  return {
    subscribe(onUpdate: () => void) {
      listener = onUpdate;
      return () => {
        unsubscribeCount += 1;
        listener = null;
      };
    },
    emit() {
      listener?.();
    },
    get unsubscribeCount() {
      return unsubscribeCount;
    },
  };
}

function createTimeout() {
  let onTimeout: (() => void) | null = null;
  let cancelCount = 0;
  let scheduleCount = 0;
  return {
    schedule(callback: () => void) {
      scheduleCount += 1;
      onTimeout = callback;
      return () => {
        cancelCount += 1;
        onTimeout = null;
      };
    },
    fire() {
      onTimeout?.();
    },
    get cancelCount() {
      return cancelCount;
    },
    get scheduleCount() {
      return scheduleCount;
    },
  };
}

describe("waitForSeatRotationReceipt", () => {
  test("subscribes before the first inspect when a notification already exists", async () => {
    let subscribed = false;
    let unsubscribeCount = 0;
    const timeout = createTimeout();
    let inspectCount = 0;
    async function inspect(): Promise<Receipt> {
      inspectCount += 1;
      expect(subscribed).toBe(true);
      return { phase: "succeeded", revision: 4 };
    }

    await expect(
      waitForSeatRotationReceipt({
        timeoutMs: 20,
        inspect,
        subscribe: (onUpdate) => {
          subscribed = true;
          onUpdate();
          return () => {
            unsubscribeCount += 1;
          };
        },
        scheduleTimeout: timeout.schedule,
      }),
    ).resolves.toEqual({ phase: "succeeded", revision: 4 });

    expect(inspectCount).toBe(1);
    expect(unsubscribeCount).toBe(1);
    expect(timeout.cancelCount).toBe(1);
  });

  test("reinspects once when an update arrives during the first inspect", async () => {
    const updates = createUpdates();
    const timeout = createTimeout();
    let resolveFirst: ((receipt: Receipt) => void) | null = null;
    let inspectCount = 0;
    async function inspect(): Promise<Receipt> {
      inspectCount += 1;
      if (inspectCount === 1)
        return await new Promise<Receipt>((resolve) => {
          resolveFirst = resolve;
        });
      return { phase: "succeeded", revision: 2 };
    }
    const waiting = waitForSeatRotationReceipt({
      timeoutMs: 20,
      inspect,
      subscribe: updates.subscribe,
      scheduleTimeout: timeout.schedule,
    });

    expect(inspectCount).toBe(1);
    updates.emit();
    resolveFirst?.({ phase: "pending", revision: 1 });

    await expect(waiting).resolves.toEqual({ phase: "succeeded", revision: 2 });
    expect(inspectCount).toBe(2);
  });

  test("reinspects after a pending receipt receives an update", async () => {
    const updates = createUpdates();
    const timeout = createTimeout();
    let inspectCount = 0;
    async function inspect(): Promise<Receipt> {
      inspectCount += 1;
      return inspectCount === 1
        ? { phase: "pending", revision: 1 }
        : { phase: "succeeded", revision: 2 };
    }
    const waiting = waitForSeatRotationReceipt({
      timeoutMs: 20,
      inspect,
      subscribe: updates.subscribe,
      scheduleTimeout: timeout.schedule,
    });

    await Promise.resolve();
    expect(inspectCount).toBe(1);
    updates.emit();

    await expect(waiting).resolves.toEqual({ phase: "succeeded", revision: 2 });
    expect(inspectCount).toBe(2);
  });

  test("coalesces duplicate identical idle notifications", async () => {
    const updates = createUpdates();
    const timeout = createTimeout();
    let inspectCount = 0;
    async function inspect(): Promise<Receipt> {
      inspectCount += 1;
      return inspectCount === 1
        ? { phase: "pending", revision: 1 }
        : { phase: "succeeded", revision: 2 };
    }
    const waiting = waitForSeatRotationReceipt({
      timeoutMs: 20,
      inspect,
      subscribe: updates.subscribe,
      scheduleTimeout: timeout.schedule,
    });

    await Promise.resolve();
    expect(inspectCount).toBe(1);
    updates.emit();
    updates.emit();

    await expect(waiting).resolves.toEqual({ phase: "succeeded", revision: 2 });
    expect(inspectCount).toBe(2);
  });

  test("returns a terminal failure without waiting for another notification", async () => {
    const updates = createUpdates();
    const timeout = createTimeout();
    let inspectCount = 0;
    async function inspect(): Promise<Receipt> {
      inspectCount += 1;
      return { phase: "failed", revision: 3 };
    }

    await expect(
      waitForSeatRotationReceipt({
        timeoutMs: 20,
        inspect,
        subscribe: updates.subscribe,
        scheduleTimeout: timeout.schedule,
      }),
    ).resolves.toEqual({ phase: "failed", revision: 3 });

    expect(inspectCount).toBe(1);
    expect(updates.unsubscribeCount).toBe(1);
  });

  test("times out and unsubscribes without further inspection", async () => {
    const updates = createUpdates();
    const timeout = createTimeout();
    let inspectCount = 0;
    async function inspect(): Promise<Receipt> {
      inspectCount += 1;
      return { phase: "pending", revision: 1 };
    }

    const waiting = waitForSeatRotationReceipt({
      timeoutMs: 1,
      inspect,
      subscribe: updates.subscribe,
      scheduleTimeout: timeout.schedule,
    });
    await Promise.resolve();
    timeout.fire();
    await expect(waiting).rejects.toThrow("Timed out waiting for terminal seat rotation receipt");

    updates.emit();
    expect(inspectCount).toBe(1);
    expect(updates.unsubscribeCount).toBe(1);
  });

  test("keeps one absolute deadline through continuous notifications", async () => {
    const updates = createUpdates();
    const timeout = createTimeout();
    const inspectors: Array<(receipt: Receipt) => void> = [];
    let resolveNextInspection: (() => void) | null = null;
    const nextInspection = () =>
      new Promise<void>((resolve) => {
        resolveNextInspection = resolve;
      });
    const inspect = async (): Promise<Receipt> =>
      await new Promise<Receipt>((resolve) => {
        inspectors.push(resolve);
        resolveNextInspection?.();
        resolveNextInspection = null;
      });
    const waiting = waitForSeatRotationReceipt({
      timeoutMs: 20,
      inspect,
      subscribe: updates.subscribe,
      scheduleTimeout: timeout.schedule,
    });

    expect(inspectors).toHaveLength(1);
    updates.emit();
    const secondInspection = nextInspection();
    inspectors.shift()?.({ phase: "pending", revision: 1 });
    await secondInspection;
    expect(inspectors).toHaveLength(1);
    updates.emit();
    updates.emit();
    const thirdInspection = nextInspection();
    inspectors.shift()?.({ phase: "pending", revision: 2 });
    await thirdInspection;
    expect(inspectors).toHaveLength(1);
    expect(timeout.scheduleCount).toBe(1);

    timeout.fire();
    await expect(waiting).rejects.toThrow("Timed out waiting for terminal seat rotation receipt");
    expect(updates.unsubscribeCount).toBe(1);
    expect(timeout.cancelCount).toBe(1);
  });

  test("times out and unsubscribes when inspection never resolves", async () => {
    const updates = createUpdates();
    const timeout = createTimeout();
    const waiting = waitForSeatRotationReceipt({
      timeoutMs: 20,
      inspect: async () => await new Promise<never>(() => {}),
      subscribe: updates.subscribe,
      scheduleTimeout: timeout.schedule,
    });

    timeout.fire();
    await expect(waiting).rejects.toThrow("Timed out waiting for terminal seat rotation receipt");
    expect(timeout.scheduleCount).toBe(1);
    expect(timeout.cancelCount).toBe(1);
    expect(updates.unsubscribeCount).toBe(1);
  });

  test("disposes the deadline when subscription fails", async () => {
    const timeout = createTimeout();

    await expect(
      waitForSeatRotationReceipt({
        timeoutMs: 20,
        inspect: async () => ({ phase: "pending", revision: 1 }),
        subscribe: () => {
          throw new Error("subscription unavailable");
        },
        scheduleTimeout: timeout.schedule,
      }),
    ).rejects.toThrow("subscription unavailable");

    expect(timeout.scheduleCount).toBe(1);
    expect(timeout.cancelCount).toBe(1);
  });
});
