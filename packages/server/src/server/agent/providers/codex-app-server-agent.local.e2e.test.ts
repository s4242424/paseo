import { describe, expect, test, vi } from "vitest";
import { type ChildProcessWithoutNullStreams, execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";

import { randomUUID } from "node:crypto";
import { AgentManager } from "../agent-manager.js";
import type { AgentSession } from "../agent-sdk-types.js";
import { CodexAppServerAgentClient } from "./codex-app-server-agent.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentStreamEvent } from "../agent-sdk-types.js";

function isCodexInstalled(): boolean {
  try {
    const out = execFileSync("which", ["codex"], { encoding: "utf8" }).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

function sse(events: unknown[]): string {
  return events
    .map((event) => {
      const type =
        typeof event === "object" &&
        event !== null &&
        "type" in event &&
        typeof (event as { type?: unknown }).type === "string"
          ? (event as { type: string }).type
          : "message";
      return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
    })
    .join("");
}

function responseCreated(id: string): Record<string, unknown> {
  return {
    type: "response.created",
    response: { id },
  };
}

function responseCompleted(id: string): Record<string, unknown> {
  return {
    type: "response.completed",
    response: {
      id,
      usage: {
        input_tokens: 0,
        input_tokens_details: null,
        output_tokens: 0,
        output_tokens_details: null,
        total_tokens: 0,
      },
    },
  };
}

function functionCallEvent(
  callId: string,
  name: string,
  argumentsJson: string,
): Record<string, unknown> {
  return {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      call_id: callId,
      name,
      arguments: argumentsJson,
    },
  };
}

function assistantMessageEvent(id: string, text: string): Record<string, unknown> {
  return {
    type: "response.output_item.done",
    item: {
      type: "message",
      role: "assistant",
      id,
      content: [{ type: "output_text", text }],
    },
  };
}

function requestUserInputSse(callId: string): string {
  return sse([
    responseCreated("resp-1"),
    functionCallEvent(
      callId,
      "request_user_input",
      JSON.stringify({
        questions: [
          {
            id: "confirm_path",
            header: "Confirm",
            question: "Proceed with the plan?",
            options: [
              {
                label: "Yes (Recommended)",
                description: "Continue the current plan.",
              },
              {
                label: "No",
                description: "Stop and revisit the approach.",
              },
            ],
          },
        ],
      }),
    ),
    responseCompleted("resp-1"),
  ]);
}

function assistantMessageSse(text: string): string {
  return sse([
    responseCreated("resp-2"),
    assistantMessageEvent("msg-1", text),
    responseCompleted("resp-2"),
  ]);
}

async function startMockResponsesServer(sequence: string[]): Promise<{
  url: string;
  close: () => Promise<void>;
  requestBodies: string[];
}> {
  const requestBodies: string[] = [];
  let index = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      requestBodies.push(Buffer.concat(chunks).toString("utf8"));
      if (req.method !== "POST" || req.url !== "/v1/responses") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const body = sequence[index] ?? assistantMessageSse("done");
      index += 1;
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-cache");
      res.end(body);
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP address for mock responses server");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    requestBodies,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

function writeMockCodexConfig(codexHome: string, serverUrl: string): void {
  writeFileSync(
    path.join(codexHome, "config.toml"),
    `
model = "mock-model"
approval_policy = "never"
sandbox_mode = "read-only"

model_provider = "mock_provider"

[model_providers.mock_provider]
name = "Mock provider for test"
base_url = "${serverUrl}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
`,
  );
}

function waitForEvent<TEvent extends AgentStreamEvent>(params: {
  session: {
    subscribe(callback: (event: AgentStreamEvent) => void): () => void;
  };
  predicate: (event: AgentStreamEvent) => event is TEvent;
  timeoutMs: number;
  label: string;
}): Promise<TEvent> {
  return new Promise<TEvent>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for ${params.label}`));
    }, params.timeoutMs);

    const unsubscribe = params.session.subscribe((event) => {
      if (!params.predicate(event)) {
        return;
      }
      clearTimeout(timeout);
      unsubscribe();
      resolve(event);
    });
  });
}

describe("Codex app-server provider (local e2e)", () => {
  test.runIf(isCodexInstalled())(
    "reload continues one native conversation only after the old process exits",
    async () => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), "codex-exclusive-cwd-"));
      const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-exclusive-home-"));
      const server = await startMockResponsesServer([
        assistantMessageSse("first response"),
        assistantMessageSse("continued response"),
      ]);
      const children: ChildProcessWithoutNullStreams[] = [];
      const sessions: AgentSession[] = [];
      const logger = createTestLogger();
      const client = new CodexAppServerAgentClient(logger);
      const spawnOwner = client as unknown as {
        spawnAppServer: (
          env?: Record<string, string>,
          options?: { goalsEnabled?: boolean; agentId?: string },
        ) => Promise<ChildProcessWithoutNullStreams>;
      };
      const spawn = spawnOwner.spawnAppServer.bind(client);
      vi.spyOn(spawnOwner, "spawnAppServer").mockImplementation(async (env, options) => {
        for (const previous of children)
          expect(previous.exitCode !== null || previous.signalCode !== null).toBe(true);
        const child = await spawn(env, options);
        children.push(child);
        return child;
      });
      const create = client.createSession.bind(client);
      const resume = client.resumeSession.bind(client);
      client.createSession = async (config, context) => {
        const session = await create(config, {
          ...context,
          env: { ...context?.env, CODEX_HOME: codexHome },
        });
        sessions.push(session);
        return session;
      };
      client.resumeSession = async (handle, config, context, options) => {
        const session = await resume(
          handle,
          config,
          { ...context, env: { ...context?.env, CODEX_HOME: codexHome } },
          options,
        );
        sessions.push(session);
        return session;
      };
      const manager = new AgentManager({
        clients: { codex: client },
        logger,
        idFactory: randomUUID,
      });
      let agentId: string | undefined;
      const turn = async (session: AgentSession, prompt: string) => {
        const finished = waitForEvent({
          session,
          timeoutMs: 15000,
          label: "native turn completion",
          predicate: (
            event,
          ): event is Extract<AgentStreamEvent, { type: "turn_completed" | "turn_failed" }> =>
            event.type === "turn_completed" || event.type === "turn_failed",
        });
        await session.startTurn(prompt);
        expect((await finished).type).toBe("turn_completed");
      };
      try {
        writeMockCodexConfig(codexHome, server.url);
        const agent = await manager.createAgent(
          {
            provider: "codex",
            cwd,
            modeId: "auto",
            model: "mock-model",
            thinkingOptionId: "medium",
          },
          undefined,
          {},
        );
        agentId = agent.id;
        await turn(sessions[0]!, "Remember the first exchange.");
        const handle = sessions[0]!.describePersistence();
        await manager.reloadAgentSession(agent.id, undefined, { rehydrateFromDisk: true });
        expect(sessions[1]!.describePersistence().sessionId).toBe(handle.sessionId);
        await turn(sessions[1]!, "Continue this conversation.");
        expect(children).toHaveLength(2);
        expect(server.requestBodies.at(-1)).toContain("Remember the first exchange.");
        expect(server.requestBodies.at(-1)).toContain("first response");
        expect(server.requestBodies.at(-1)).toContain("Continue this conversation.");
      } finally {
        if (agentId) await manager.closeAgent(agentId);
        for (const session of sessions) await session.close();
        expect(
          children.every((child) => child.exitCode !== null || child.signalCode !== null),
        ).toBe(true);
        await server.close();
        rmSync(cwd, { recursive: true, force: true });
        rmSync(codexHome, { recursive: true, force: true });
      }
    },
    45000,
  );

  test.runIf(isCodexInstalled())(
    "surfaces request_user_input from the app-server as question permissions and timeline tool calls",
    async () => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), "codex-app-server-question-cwd-"));
      const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-app-server-question-home-"));
      const mockServer = await startMockResponsesServer([
        requestUserInputSse("call1"),
        assistantMessageSse("done"),
      ]);

      try {
        writeMockCodexConfig(codexHome, mockServer.url);

        const client = new CodexAppServerAgentClient(createTestLogger());
        const session = await client.createSession(
          {
            provider: "codex",
            cwd,
            modeId: "auto",
            model: "mock-model",
            thinkingOptionId: "medium",
          },
          {
            env: {
              CODEX_HOME: codexHome,
            },
          },
        );

        try {
          await session.setFeature?.("plan_mode", true);

          const events: AgentStreamEvent[] = [];
          session.subscribe((event) => {
            events.push(event);
          });

          const questionRequested = waitForEvent({
            session,
            timeoutMs: 15_000,
            label: "question permission request",
            predicate: (
              event,
            ): event is Extract<AgentStreamEvent, { type: "permission_requested" }> =>
              event.type === "permission_requested" &&
              event.request.provider === "codex" &&
              event.request.kind === "question" &&
              event.request.name === "request_user_input",
          });

          const turnFinished = waitForEvent({
            session,
            timeoutMs: 15_000,
            label: "turn completion",
            predicate: (
              event,
            ): event is Extract<
              AgentStreamEvent,
              { type: "turn_completed" | "turn_failed" | "turn_canceled" }
            > =>
              event.type === "turn_completed" ||
              event.type === "turn_failed" ||
              event.type === "turn_canceled",
          });

          await session.startTurn("ask something");

          const permissionEvent = await questionRequested;
          expect(permissionEvent.request.input).toEqual({
            questions: [
              {
                id: "confirm_path",
                header: "Confirm",
                question: "Proceed with the plan?",
                isOther: true,
                options: [
                  {
                    label: "Yes (Recommended)",
                    description: "Continue the current plan.",
                  },
                  {
                    label: "No",
                    description: "Stop and revisit the approach.",
                  },
                ],
              },
            ],
          });

          const runningQuestionCall = events.find(
            (event) =>
              event.type === "timeline" &&
              event.provider === "codex" &&
              event.item.type === "tool_call" &&
              event.item.name === "request_user_input" &&
              event.item.status === "running",
          );
          expect(runningQuestionCall).toBeDefined();

          await session.respondToPermission(permissionEvent.request.id, {
            behavior: "allow",
            updatedInput: {
              answers: {
                Confirm: "Yes (Recommended)",
              },
            },
          });

          const terminalEvent = await turnFinished;
          expect(terminalEvent.type).toBe("turn_completed");

          const completedQuestionCall = events.find(
            (event) =>
              event.type === "timeline" &&
              event.provider === "codex" &&
              event.item.type === "tool_call" &&
              event.item.name === "request_user_input" &&
              event.item.status === "completed",
          );
          expect(completedQuestionCall).toBeDefined();
          if (
            !completedQuestionCall ||
            completedQuestionCall.type !== "timeline" ||
            completedQuestionCall.item.type !== "tool_call"
          ) {
            throw new Error("Expected completed request_user_input tool call");
          }
          expect(completedQuestionCall.item.metadata).toMatchObject({
            answers: {
              confirm_path: ["Yes (Recommended)"],
            },
          });
          expect(
            mockServer.requestBodies.some(
              (body) =>
                body.includes('"type":"function_call_output"') &&
                body.includes('"call_id":"call1"'),
            ),
          ).toBe(true);

          const finalAssistantMessage = [...events]
            .toReversed()
            .find((event) => event.type === "timeline" && event.item.type === "assistant_message");
          expect(finalAssistantMessage).toBeDefined();
          if (
            !finalAssistantMessage ||
            finalAssistantMessage.type !== "timeline" ||
            finalAssistantMessage.item.type !== "assistant_message"
          ) {
            throw new Error("Expected final assistant message");
          }
          expect(finalAssistantMessage.item.text.trim()).toBe("done");
        } finally {
          await session.close();
        }
      } finally {
        await mockServer.close();
        rmSync(cwd, { recursive: true, force: true });
        rmSync(codexHome, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
