import { afterEach, expect, it, vi } from "vitest";
import { parseAccountIdentity, readAccountIdentity } from "./accounts";
const identity = {
  state: "oauth",
  email: "rob@example.test",
  plan: "max",
  checkedAt: "2026-09-09T12:00:00Z",
};
afterEach(() => vi.useRealTimers());
it("validates provider-specific identities and suppresses stale signed-out email", () => {
  expect(parseAccountIdentity("claude", identity).state).toBe("signed-in");
  expect(parseAccountIdentity("claude", { ...identity, state: "signed-out" }).email).toBeNull();
  expect(() => parseAccountIdentity("codex", identity)).toThrow();
  expect(() => parseAccountIdentity("claude", { ...identity, email: "bad\nlabel" })).toThrow();
  expect(() => parseAccountIdentity("claude", { ...identity, checkedAt: "yesterday" })).toThrow();
});
it("only issues the adopted read method on the requested provider", async () => {
  const invoke = vi.fn().mockResolvedValue({ ...identity, state: "chatgpt", canSignIn: true });
  await readAccountIdentity(invoke, "codex", new AbortController().signal);
  expect(invoke.mock.calls).toEqual([["plugin-version-indicator", "codex.account.status", {}]]);
});
it("bounds a stalled host and cleans its timer", async () => {
  vi.useFakeTimers();
  const pending = readAccountIdentity(
    () => new Promise(() => {}),
    "claude",
    new AbortController().signal,
  );
  const rejected = expect(pending).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(5000);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});
it("aborted scopes do not start reads and in-flight cancellation rejects late results", async () => {
  const controller = new AbortController();
  controller.abort();
  const invoke = vi.fn().mockResolvedValue(identity);
  await expect(readAccountIdentity(invoke, "claude", controller.signal)).rejects.toThrow(
    "cancelled",
  );
  expect(invoke).not.toHaveBeenCalled();
  const next = new AbortController();
  let finish!: (value: unknown) => void;
  const pending = readAccountIdentity(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    "claude",
    next.signal,
  );
  const rejected = expect(pending).rejects.toThrow("cancelled");
  next.abort();
  await rejected;
  finish(identity);
});
