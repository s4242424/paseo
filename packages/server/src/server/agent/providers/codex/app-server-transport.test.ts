import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import {
  createCodexAppServerChildProcess,
  createFakeCodexAppServer,
} from "./test-utils/fake-app-server.js";
import { CodexAppServerClient } from "./app-server-transport.js";

describe("Codex app-server transport", () => {
  test("dispose coalesces callers and rejects unconfirmed exit until an observed exit", async () => {
    vi.useFakeTimers();
    const child = createCodexAppServerChildProcess();
    child.kill = vi.fn(() => true);
    const client = new CodexAppServerClient(child, createTestLogger());
    try {
      const first = client.dispose();
      expect(client.dispose()).toBe(first);
      const rejected = expect(first).rejects.toThrow("exit is unconfirmed");
      await vi.advanceTimersByTimeAsync(3001);
      await rejected;
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      Object.defineProperty(child, "signalCode", { value: "SIGKILL" });
      child.emit("exit", null, "SIGKILL");
      await expect(client.dispose()).resolves.toBeUndefined();
    } finally {
      child.stdout.end();
      child.stderr.end();
      child.stdin.end();
      vi.useRealTimers();
    }
  });

  test("an error notification alone never acknowledges process exit", async () => {
    const child = createCodexAppServerChildProcess();
    const kill = vi.spyOn(child, "kill");
    const client = new CodexAppServerClient(child, createTestLogger());
    child.emit("error", new Error("Synthetic transport error, process still owned"));
    await client.dispose();
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    child.stdout.end();
    child.stderr.end();
    child.stdin.end();
  });

  test("ignores non-JSON stdout lines without dropping pending requests", async () => {
    const child = createCodexAppServerChildProcess();
    const client = new CodexAppServerClient(child, createTestLogger());

    const request = client.request("model/list", {});
    child.stdout.write("Codex ha iniciado en modo localizado\n");
    child.stdout.write('{"id":1,"result":{"data":[]}}\n');

    await expect(request).resolves.toEqual({ data: [] });
    child.stdout.end();
    child.stderr.end();
    child.stdin.end();
  });

  test.each([
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/tool/requestUserInput",
    "tool/requestUserInput",
  ])("answers server-initiated %s requests through registered handlers", async (method) => {
    const codex = createFakeCodexAppServer();
    const client = new CodexAppServerClient(codex.child, createTestLogger());
    const handlerCalls: unknown[] = [];
    client.setRequestHandler(method, async (params) => {
      handlerCalls.push(params);
      return { ok: true };
    });

    const response = codex.nextResponse();
    codex.child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method, params: {} })}\n`);

    await expect(response).resolves.toBe('{"id":7,"result":{"ok":true}}\n');
    expect(handlerCalls).toEqual([{}]);
    codex.child.stdout.end();
    codex.child.stderr.end();
    codex.child.stdin.end();
  });

  test("forks a Codex thread through thread/fork", async () => {
    const codex = createFakeCodexAppServer({
      "thread/fork": (params) => ({
        thread: {
          id: "forked-thread",
          sessionId: "forked-session",
          forkedFromId: (params as { threadId?: string }).threadId,
          turns: [],
        },
        model: "gpt-5.4",
        modelProvider: "openai",
        serviceTier: null,
        cwd: "/workspace/project",
        runtimeWorkspaceRoots: [],
        instructionSources: [],
        approvalPolicy: "on-request",
        approvalsReviewer: null,
        sandbox: { type: "workspaceWrite", networkAccess: false },
        activePermissionProfile: null,
        reasoningEffort: null,
      }),
    });
    const client = new CodexAppServerClient(codex.child, createTestLogger());

    const forked = await client.forkThread({
      threadId: "source-thread",
      cwd: "/workspace/project",
      excludeTurns: true,
    });

    expect(forked.thread.id).toBe("forked-thread");
    expect(forked.thread.forkedFromId).toBe("source-thread");
    codex.assertNoErrors();
    codex.child.stdout.end();
    codex.child.stderr.end();
    codex.child.stdin.end();
  });

  test("rolls back a Codex thread by N turns", async () => {
    const codex = createFakeCodexAppServer({
      "thread/rollback": (params) => {
        expect(params).toEqual({ threadId: "forked-thread", numTurns: 2 });
        return {
          thread: {
            id: "forked-thread",
            sessionId: "forked-session",
            turns: [{ id: "remaining-turn" }],
          },
        };
      },
    });
    const client = new CodexAppServerClient(codex.child, createTestLogger());

    const rolledBack = await client.rollbackThread({
      threadId: "forked-thread",
      numTurns: 2,
    });

    expect(rolledBack.thread.id).toBe("forked-thread");
    expect(rolledBack.thread.turns).toEqual([{ id: "remaining-turn" }]);
    codex.assertNoErrors();
    codex.child.stdout.end();
    codex.child.stderr.end();
    codex.child.stdin.end();
  });
});
