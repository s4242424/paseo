import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";

import pino from "pino";
import { describe, expect, test } from "vitest";

import type { AgentProvider } from "../agent/agent-sdk-types.js";
import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import { CodexAppServerAgentClient } from "../agent/providers/codex-app-server-agent.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import {
  closeProviderSmokeResources,
  ProviderSmokeCleanupError,
  type ProviderSmokeCleanupReport,
} from "./provider-smoke-cleanup.js";

const receiptDir = process.env.PROVIDER_LIVE_RECEIPT_DIR;
const cwd = process.env.PROVIDER_LIVE_CWD;
const liveProviderSmoke = process.env.RUN_LIVE_PROVIDER_SMOKE === "1" ? test : test.skip;

interface TurnEvidence {
  managerTurnId: string | null;
  nativeSessionId: string | null;
  contextWindowObservation: unknown;
  runtime: unknown;
  finishedAt: string;
}

interface ProviderEvidence {
  provider: "claude" | "codex";
  expected: { model: string; effort: string; mode: string; cwd: string };
  agentId: string;
  turns: TurnEvidence[];
  lifecycle: Array<{ at: string; status: string | null; event: string }>;
}

interface SmokeReport {
  startedAt: string;
  listen: string;
  stateRoot: string;
  staticDir: string;
  cwd: string;
  providers: ProviderEvidence[];
  cleanup: "pending" | ProviderSmokeCleanupReport;
  result?: "pass" | "fail";
  error?: unknown;
  finishedAt?: string;
}

function requireEnv(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required for the live provider smoke`);
  return value;
}

function finiteObservation(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const observation = value as Record<string, unknown>;
  return (
    observation.contextWindowSource === "provider-confirmed" &&
    typeof observation.sessionId === "string" &&
    observation.sessionId.length > 0 &&
    typeof observation.turnId === "string" &&
    observation.turnId.length > 0 &&
    typeof observation.usedTokens === "number" &&
    Number.isFinite(observation.usedTokens) &&
    observation.usedTokens >= 0 &&
    typeof observation.maxTokens === "number" &&
    Number.isFinite(observation.maxTokens) &&
    observation.maxTokens > 0 &&
    observation.usedTokens <= observation.maxTokens
  );
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function assertFinishedTurnObservation(
  finished: Awaited<ReturnType<DaemonClient["waitForFinish"]>>,
  agentId: string,
  turnId: string | undefined,
): void {
  expect(finished.final).toMatchObject({ id: agentId, status: "idle" });
  if (finished.final) {
    expect(finished.final.lastUsage?.contextWindowObservation?.turnId).toBe(turnId);
  }
}

async function runTurn(input: {
  client: DaemonClient;
  provider: "claude" | "codex";
  expected: ProviderEvidence["expected"];
  evidence: ProviderEvidence;
  prompt: string;
  persist: () => Promise<void>;
}): Promise<void> {
  const { client, evidence, expected, persist, prompt, provider } = input;
  await client.sendMessage(evidence.agentId, prompt);
  evidence.lifecycle.push({ at: new Date().toISOString(), status: "running", event: "sent" });
  await persist();
  const finished = await client.waitForFinish(evidence.agentId, 180_000);
  evidence.lifecycle.push({
    at: new Date().toISOString(),
    status: finished.status,
    event: "finished",
  });
  if (finished.status === "permission") {
    throw new Error(`${provider} requested a permission; no response was sent`);
  }
  if (finished.status !== "idle") {
    throw new Error(`${provider} did not finish idle (status ${finished.status})`);
  }
  const fetched = await client.fetchAgent({ agentId: evidence.agentId });
  const snapshot = fetched?.agent;
  const observation = snapshot?.lastUsage?.contextWindowObservation;
  expect(finiteObservation(observation)).toBe(true);
  const runtime = snapshot?.runtimeInfo;
  expect(runtime).toMatchObject({
    provider,
    sessionId: observation?.sessionId,
    model: expected.model,
    modeId: expected.mode,
  });
  expect(validTimestamp(observation?.observedAt)).toBe(true);
  if (provider === "codex") {
    expect(runtime?.thinkingOptionId).toBe(expected.effort);
  }
  assertFinishedTurnObservation(finished, evidence.agentId, observation?.turnId);
  evidence.turns.push({
    managerTurnId: typeof observation?.turnId === "string" ? observation.turnId : null,
    nativeSessionId: typeof observation?.sessionId === "string" ? observation.sessionId : null,
    contextWindowObservation: observation ?? null,
    runtime: runtime ?? null,
    finishedAt: new Date().toISOString(),
  });
  await persist();
}

async function runProvider(
  client: DaemonClient,
  provider: "claude" | "codex",
  expected: ProviderEvidence["expected"],
  providers: ProviderEvidence[],
  persist: () => Promise<void>,
): Promise<void> {
  const agent = await client.createAgent({
    provider: provider as AgentProvider,
    cwd: expected.cwd,
    title: `seat-rotation-${provider}-telemetry`,
    model: expected.model,
    modeId: expected.mode,
    thinkingOptionId: expected.effort,
    ...(provider === "codex" ? { featureValues: { fast_mode: false } } : {}),
  });
  const evidence: ProviderEvidence = {
    provider,
    expected,
    agentId: agent.id,
    turns: [],
    lifecycle: [{ at: new Date().toISOString(), status: agent.status, event: "created" }],
  };
  providers.push(evidence);
  await persist();

  for (const prompt of ["Reply exactly PONG-ONE.", "Reply exactly PONG-TWO."]) {
    await runTurn({ client, provider, expected, evidence, prompt, persist });
  }

  expect(evidence.turns).toHaveLength(2);
  expect(evidence.turns[0]?.managerTurnId).not.toBe(evidence.turns[1]?.managerTurnId);
  expect(evidence.turns[0]?.nativeSessionId).toBe(evidence.turns[1]?.nativeSessionId);
}

describe("seat rotation provider telemetry (real, isolated)", () => {
  liveProviderSmoke(
    "captures provider-confirmed context observations from Fable and Codex",
    async () => {
      const outputDir = requireEnv(receiptDir, "PROVIDER_LIVE_RECEIPT_DIR");
      const worktree = requireEnv(cwd, "PROVIDER_LIVE_CWD");
      await mkdir(outputDir, { recursive: true });
      const stateRoot = await mkdtemp(path.join(outputDir, "state-"));
      const staticDir = await mkdtemp(path.join(outputDir, "static-"));
      const logger = pino({ level: "warn" });
      const daemon = await createTestPaseoDaemon({
        paseoHomeRoot: stateRoot,
        staticDir,
        cleanup: false,
        mcpEnabled: false,
        logger,
        agentClients: {
          claude: new ClaudeAgentClient({ logger }),
          codex: new CodexAppServerAgentClient(logger),
        },
      });
      const client = new DaemonClient({
        url: `ws://127.0.0.1:${daemon.port}/ws`,
        appVersion: "0.1.153",
      });
      const report: SmokeReport = {
        startedAt: new Date().toISOString(),
        listen: `127.0.0.1:${daemon.port}`,
        stateRoot,
        staticDir,
        cwd: worktree,
        providers: [],
        cleanup: "pending",
      };
      const persist = async (): Promise<void> => {
        await writeFile(
          path.join(outputDir, "report.json"),
          `${JSON.stringify(report, null, 2)}\n`,
        );
      };
      let primaryError: unknown = null;
      let cleanupFailure: ProviderSmokeCleanupError | null = null;

      try {
        await client.connect();
        await client.fetchAgents({
          subscribe: { subscriptionId: "seat-rotation-provider-telemetry" },
        });
        await runProvider(
          client,
          "claude",
          {
            model: "claude-fable-5-1",
            effort: "low",
            mode: "auto",
            cwd: worktree,
          },
          report.providers,
          persist,
        );
        await runProvider(
          client,
          "codex",
          {
            model: "gpt-5.6-terra",
            effort: "medium",
            mode: "auto-review",
            cwd: worktree,
          },
          report.providers,
          persist,
        );
        report.result = "pass";
      } catch (error) {
        report.result = "fail";
        report.error =
          error instanceof Error ? { name: error.name, message: error.message } : String(error);
        primaryError = error;
      } finally {
        report.cleanup = await closeProviderSmokeResources({
          closeClient: () => client.close(),
          closeDaemon: () => daemon.close(),
        });
        report.finishedAt = new Date().toISOString();
        await persist();
        if (report.cleanup.status === "failed") {
          cleanupFailure = new ProviderSmokeCleanupError(report.cleanup);
        }
      }
      if (cleanupFailure) throw cleanupFailure;
      if (primaryError) throw primaryError;
    },
    600_000,
  );
});
