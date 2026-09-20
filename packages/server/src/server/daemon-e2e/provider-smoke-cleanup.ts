export interface ProviderSmokeCleanupAttempt {
  operation: "client.close" | "daemon.close";
  status: "succeeded" | "failed";
  error?: { name: string; message: string };
}

export interface ProviderSmokeCleanupReport {
  status: "succeeded" | "failed";
  receiptState: "retained";
  attempts: ProviderSmokeCleanupAttempt[];
}

export class ProviderSmokeCleanupError extends Error {
  constructor(readonly cleanup: ProviderSmokeCleanupReport) {
    super(
      `Provider smoke cleanup failed: ${cleanup.attempts
        .filter((attempt) => attempt.status === "failed")
        .map((attempt) => attempt.operation)
        .join(", ")}`,
    );
    this.name = "ProviderSmokeCleanupError";
  }
}

function errorDetails(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "NonError", message: String(error) };
}

export async function closeProviderSmokeResources(input: {
  closeClient: () => Promise<void>;
  closeDaemon: () => Promise<void>;
}): Promise<ProviderSmokeCleanupReport> {
  const attempts: ProviderSmokeCleanupAttempt[] = [];

  for (const [operation, close] of [
    ["client.close", input.closeClient],
    ["daemon.close", input.closeDaemon],
  ] as const) {
    try {
      await close();
      attempts.push({ operation, status: "succeeded" });
    } catch (error) {
      attempts.push({ operation, status: "failed", error: errorDetails(error) });
    }
  }

  return {
    status: attempts.some((attempt) => attempt.status === "failed") ? "failed" : "succeeded",
    receiptState: "retained",
    attempts,
  };
}
