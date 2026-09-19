import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";

import pino from "pino";
import { describe, expect, test } from "vitest";

import type { AgentProvider } from "../agent/agent-sdk-types.js";
import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import { CodexAppServerAgentClient } from "../agent/providers/codex-app-server-agent.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const receiptDir = process.env.PROVIDER_LIVE_RECEIPT_DIR;
const cwd = process.env.PROVIDER_LIVE_CWD;

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

async function runProvider(
  client: DaemonClient,
  provider: "claude" | "codex",
  expected: ProviderEvidence["expected"],
): Promise<ProviderEvidence> {
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

  for (const prompt of ["Reply exactly PONG-ONE.", "Reply exactly PONG-TWO."]) {
    await client.sendMessage(agent.id, prompt);
    evidence.lifecycle.push({ at: new Date().toISOString(), status: "running", event: "sent" });
    const finished = await client.waitForFinish(agent.id, 180_000);
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
    const fetched = await client.fetchAgent({ agentId: agent.id });
    const snapshot = fetched?.agent;
    const usage = snapshot?.lastUsage;
    const observation = usage?.contextWindowObservation;
    expect(finiteObservation(observation)).toBe(true);
    const runtime = snapshot?.runtimeInfo;
    expect(runtime?.model).toBe(expected.model);
    evidence.turns.push({
      managerTurnId: typeof observation?.turnId === "string" ? observation.turnId : null,
      nativeSessionId: typeof observation?.sessionId === "string" ? observation.sessionId : null,
      contextWindowObservation: observation ?? null,
      runtime: runtime ?? null,
      finishedAt: new Date().toISOString(),
    });
  }

  expect(evidence.turns).toHaveLength(2);
  expect(evidence.turns[0]?.managerTurnId).not.toBe(evidence.turns[1]?.managerTurnId);
  expect(evidence.turns[0]?.nativeSessionId).toBe(evidence.turns[1]?.nativeSessionId);
  return evidence;
}

describe("seat rotation provider telemetry (real, isolated)", () => {
  test("captures provider-confirmed context observations from Fable and Codex", async () => {
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
    const report: Record<string, unknown> = {
      startedAt: new Date().toISOString(),
      listen: `127.0.0.1:${daemon.port}`,
      stateRoot,
      staticDir,
      cwd: worktree,
      providers: [],
      cleanup: "pending",
    };

    try {
      await client.connect();
      await client.fetchAgents({
        subscribe: { subscriptionId: "seat-rotation-provider-telemetry" },
      });
      (report.providers as ProviderEvidence[]).push(
        await runProvider(client, "claude", {
          model: "claude-fable-5-1",
          effort: "low",
          mode: "auto",
          cwd: worktree,
        }),
      );
      (report.providers as ProviderEvidence[]).push(
        await runProvider(client, "codex", {
          model: "gpt-5.6-terra",
          effort: "medium",
          mode: "auto-review",
          cwd: worktree,
        }),
      );
      report.result = "pass";
    } catch (error) {
      report.result = "fail";
      report.error =
        error instanceof Error ? { name: error.name, message: error.message } : String(error);
      throw error;
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
      report.cleanup = "daemon stopped; receipt-local state retained";
      report.finishedAt = new Date().toISOString();
      await writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    }
  }, 600_000);
});
