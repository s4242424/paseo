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
  const unsubscribe = options.subscribe(() => {
    dirty = true;
    wake?.();
  });
  try {
    while (true) {
      if (dirty) {
        dirty = false;
        const receipt = await options.inspect();
        if (receipt && receipt.phase !== "pending") return receipt;
        if (dirty) continue;
      }
      await new Promise<void>((resolve, reject) => {
        const cancelTimeout = (
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
        wake = () => {
          cancelTimeout();
          wake = null;
          resolve();
        };
      });
    }
  } finally {
    unsubscribe();
  }
}
