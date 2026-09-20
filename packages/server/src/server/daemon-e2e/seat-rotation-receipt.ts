export interface SeatRotationReceipt {
  phase: "pending" | "succeeded" | "failed";
}

export interface SeatRotationReceiptWaitOptions<TReceipt extends SeatRotationReceipt> {
  timeoutMs: number;
  inspect: () => Promise<TReceipt | null>;
  subscribe: (onAgentUpdate: () => void) => () => void;
  scheduleTimeout?: (onTimeout: () => void, timeoutMs: number) => () => void;
}

/**
 * Observe a rotation receipt without polling. Subscribe before the first inspect
 * so an update delivered while that inspect is in flight marks the receipt dirty
 * and causes exactly one coalesced reinspection afterwards.
 */
export async function waitForSeatRotationReceipt<TReceipt extends SeatRotationReceipt>(
  options: SeatRotationReceiptWaitOptions<TReceipt>,
): Promise<TReceipt> {
  let dirty = true;
  let wake: (() => void) | null = null;
  let cancelDeadline: (() => void) | null = null;
  const deadline = new Promise<never>((_resolve, reject) => {
    cancelDeadline = (
      options.scheduleTimeout ??
      ((onTimeout, timeoutMs) => {
        const timer = setTimeout(onTimeout, timeoutMs);
        return () => clearTimeout(timer);
      })
    )(
      () =>
        reject(
          new Error(
            `Timed out waiting for terminal seat rotation receipt after ${options.timeoutMs}ms`,
          ),
        ),
      options.timeoutMs,
    );
  });
  const beforeDeadline = async <T>(operation: Promise<T>): Promise<T> =>
    await Promise.race([operation, deadline]);
  let unsubscribe: (() => void) | null = null;
  try {
    unsubscribe = options.subscribe(() => {
      dirty = true;
      wake?.();
    });
    while (true) {
      if (dirty) {
        dirty = false;
        const receipt = await beforeDeadline(options.inspect());
        if (receipt && receipt.phase !== "pending") return receipt;
        if (dirty) continue;
      }
      await beforeDeadline(
        new Promise<void>((resolve) => {
          wake = () => {
            wake = null;
            resolve();
          };
        }),
      );
    }
  } finally {
    wake = null;
    cancelDeadline?.();
    unsubscribe?.();
  }
}
