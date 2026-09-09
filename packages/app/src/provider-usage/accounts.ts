import { z } from "zod";

export const ACCOUNT_PLUGIN_ID = "plugin-version-indicator";
export const ACCOUNT_PANELS = { claude: "account", codex: "codex-account" } as const;
export type AccountProvider = keyof typeof ACCOUNT_PANELS;
export interface AccountIdentity {
  state: "signed-in" | "signed-out" | "unknown";
  email: string | null;
  plan: string | null;
  checkedAt: string;
}
const safeText = z
  .string()
  .max(320)
  .refine((value) =>
    Array.from(value).every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127),
  );
const common = {
  email: safeText.nullable(),
  plan: safeText.nullable(),
  checkedAt: z.iso.datetime(),
};
const claude = z.object({ ...common, state: z.enum(["oauth", "other", "signed-out", "unknown"]) });
const codex = z.object({
  ...common,
  state: z.enum(["chatgpt", "signed-out", "other", "unavailable"]),
  canSignIn: z.boolean(),
});
export function parseAccountIdentity(provider: AccountProvider, input: unknown): AccountIdentity {
  const result = (provider === "claude" ? claude : codex).parse(input);
  const signedIn = result.state === "oauth" || result.state === "chatgpt";
  let state: AccountIdentity["state"] = "unknown";
  if (signedIn) state = "signed-in";
  else if (result.state === "signed-out") state = "signed-out";
  return {
    state,
    email: signedIn ? result.email : null,
    plan: signedIn ? result.plan : null,
    checkedAt: result.checkedAt,
  };
}

// This adapter reads only the two adopted status RPCs. It cannot initiate a login.
export async function readAccountIdentity(
  invoke: (plugin: string, method: string, input: unknown) => Promise<unknown>,
  provider: AccountProvider,
  signal: AbortSignal,
): Promise<AccountIdentity> {
  if (signal.aborted) throw new Error("Account read cancelled");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const boundary = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Account read timed out")), 5000);
      abort = () => reject(new Error("Account read cancelled"));
      signal.addEventListener("abort", abort, { once: true });
    });
    const result = await Promise.race([
      invoke(
        ACCOUNT_PLUGIN_ID,
        provider === "claude" ? "account.status" : "codex.account.status",
        {},
      ),
      boundary,
    ]);
    return parseAccountIdentity(provider, result);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
  }
}
