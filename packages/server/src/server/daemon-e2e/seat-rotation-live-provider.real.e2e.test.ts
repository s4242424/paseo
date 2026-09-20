import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

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

const execFile = promisify(execFileCallback);
const liveProviderSmoke = process.env.RUN_LIVE_PROVIDER_SMOKE === "1" ? test : test.skip;
const receiptDir = process.env.PROVIDER_LIVE_RECEIPT_DIR;

const TURN_TIMEOUT_MS = 150_000;
const ROTATION_TIMEOUT_MS = 180_000;

type Provider = "claude" | "codex";

interface ProviderConfig {
  provider: Provider;
  model: string;
  effort: string;
  mode: string;
}

interface RotationEvidence {
  generation: number;
  operationId: string;
  predecessorId: string;
  predecessorSessionId: string;
  successorId: string | null;
  successorSessionId: string | null;
  request: unknown;
  terminal: unknown;
  checkpoint: { path: string; hash: string; canonicalHash: string };
  timelineRevision: number;
  lifecycleEvents: Array<{ at: string; agentId: string; status: string | null }>;
  progressAfter: unknown;
}

interface ProviderRunEvidence {
  provider: Provider;
  expected: ProviderConfig;
  taskRepo: string;
  workspaceId: string;
  initialAgentId: string;
  initialSessionId: string | null;
  initialRuntime: unknown;
  initialProgress: unknown;
  rotations: RotationEvidence[];
  finalProgress?: unknown;
  archivedPredecessors: string[];
}

interface LiveRotationReport {
  startedAt: string;
  source: { cwd: string; revision: string };
  daemon: { listen: string; stateRoot: string; staticDir: string; pid: number };
  providers: ProviderRunEvidence[];
  cleanup: "pending" | ProviderSmokeCleanupReport;
  result?: "pass" | "fail";
  error?: { name: string; message: string };
  finishedAt?: string;
}

function requireEnv(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required for the live seat rotation qualification`);
  return value;
}

async function command(cwd: string, args: string[]): Promise<string> {
  const result = await execFile("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return result.stdout.trim();
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorDetails(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "NonError", message: String(error) };
}

function hasFiniteProviderObservation(value: unknown): value is Record<string, unknown> {
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
    typeof observation.maxTokens === "number" &&
    Number.isFinite(observation.maxTokens) &&
    observation.maxTokens > 0
  );
}

async function createTaskRepo(root: string, provider: Provider, nonce: string): Promise<string> {
  const repo = await realpath(await mkdtemp(path.join(root, `${provider}-task-`)));
  await mkdir(path.join(repo, ".handover"));
  await writeFile(
    path.join(repo, "AGENTS.md"),
    "Use the files named by TASK.md. Do not create agents, answer permissions, or modify files outside this repository.\n",
  );
  await writeFile(
    path.join(repo, "TASK.md"),
    [
      "This is an exact, four-step continuity task.",
      "Read progress.json and .handover/CURRENT.json before acting.",
      `The nonce is ${nonce}.`,
      "For exactly the requested next step n, calculate value = prior value * 37 + n.",
      "Append exactly one {step,value,nonce} object to progress.json and replace .handover/CURRENT.json with {completedStep,value,nextStep,nonce}.",
      "Commit only progress.json and .handover/CURRENT.json with git. Do not modify, stage, or commit any other file. Then stop.",
    ].join("\n") + "\n",
  );
  await writeFile(path.join(repo, "progress.json"), '{\n  "steps": [],\n  "seed": 1\n}\n');
  await writeFile(
    path.join(repo, ".handover", "CURRENT.json"),
    JSON.stringify({ completedStep: 0, value: 1, nextStep: 1, nonce }, null, 2) + "\n",
  );
  await command(repo, ["init", "--quiet"]);
  await command(repo, ["config", "user.email", "seat-rotation@example.invalid"]);
  await command(repo, ["config", "user.name", "Seat Rotation Qualification"]);
  await command(repo, ["add", "AGENTS.md", "TASK.md", "progress.json", ".handover/CURRENT.json"]);
  await command(repo, ["commit", "--quiet", "-m", "seed continuity task"]);
  return repo;
}

async function readProgress(repo: string, nonce: string, completedStep: number): Promise<unknown> {
  const progress = JSON.parse(await readFile(path.join(repo, "progress.json"), "utf8")) as {
    seed: number;
    steps: Array<{ step: number; value: number; nonce: string }>;
  };
  const current = JSON.parse(
    await readFile(path.join(repo, ".handover", "CURRENT.json"), "utf8"),
  ) as {
    completedStep: number;
    value: number;
    nextStep: number;
    nonce: string;
  };
  let value = progress.seed;
  const expected = Array.from({ length: completedStep }, (_, index) => {
    const step = index + 1;
    value = value * 37 + step;
    return { step, value, nonce };
  });
  expect(progress.steps).toEqual(expected);
  expect(current).toEqual({
    completedStep,
    value: expected.at(-1)?.value ?? progress.seed,
    nextStep: completedStep + 1,
    nonce,
  });
  return { progress, current };
}

async function assertModelCommit(repo: string): Promise<void> {
  expect(await command(repo, ["diff", "--name-only", "HEAD^", "HEAD"])).toBe(
    ".handover/CURRENT.json\nprogress.json",
  );
}

async function waitForTurn(
  client: DaemonClient,
  agentId: string,
  provider: Provider,
): Promise<void> {
  const finished = await client.waitForFinish(agentId, TURN_TIMEOUT_MS);
  if (finished.status === "permission") {
    throw new Error(`${provider} requested a permission; no response was sent`);
  }
  if (finished.status !== "idle") {
    throw new Error(`${provider} turn did not complete safely: ${finished.status}`);
  }
}

async function awaitSecondIdle(input: {
  events: Array<{ at: string; agentId: string; status: string | null }>;
  notifier: { signal: () => void };
  agentId: string;
}): Promise<void> {
  const idleCount = () =>
    input.events.filter((event) => event.agentId === input.agentId && event.status === "idle")
      .length;
  if (idleCount() >= 2) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for durable second idle for ${input.agentId}`)),
      ROTATION_TIMEOUT_MS,
    );
    input.notifier.signal = () => {
      if (idleCount() >= 2) {
        clearTimeout(timer);
        resolve();
      }
    };
  });
}

async function assertRuntime(input: {
  client: DaemonClient;
  agentId: string;
  expected: ProviderConfig;
  repo: string;
  workspaceId: string;
}): Promise<{ sessionId: string | null; runtime: unknown }> {
  const fetched = await input.client.fetchAgent({ agentId: input.agentId });
  const agent = fetched?.agent;
  expect(agent).toMatchObject({
    id: input.agentId,
    cwd: input.repo,
    workspaceId: input.workspaceId,
  });
  const observation = agent?.lastUsage?.contextWindowObservation;
  expect(hasFiniteProviderObservation(observation)).toBe(true);
  const runtime = agent?.runtimeInfo;
  expect(runtime).toMatchObject({
    provider: input.expected.provider,
    model: input.expected.model,
    modeId: input.expected.mode,
    sessionId: observation?.sessionId,
  });
  if (input.expected.provider === "codex") {
    expect(runtime?.thinkingOptionId).toBe(input.expected.effort);
  }
  return {
    sessionId: typeof observation?.sessionId === "string" ? observation.sessionId : null,
    runtime,
  };
}

async function writeEnvelope(input: {
  repo: string;
  operationId: string;
  generation: number;
  sessionId: string;
  sourceRevision: string;
  timelineRevision: number;
}): Promise<{ path: string; hash: string; canonicalHash: string }> {
  const checkpointPath = path.join(input.repo, ".handover", "checkpoint.json");
  const canonical = await readFile(path.join(input.repo, ".handover", "CURRENT.json"));
  const body =
    JSON.stringify(
      {
        operationId: input.operationId,
        generation: input.generation,
        sessionId: input.sessionId,
        repoPath: input.repo,
        sourceRevision: input.sourceRevision,
        timelineRevision: input.timelineRevision,
        dirtyDisposition: "clean",
        nextAction:
          "read TASK.md, progress.json, and .handover/CURRENT.json; perform exactly the next step",
        canonicalCheckpointPath: ".handover/CURRENT.json",
        canonicalCheckpointHash: sha256(canonical),
      },
      null,
      2,
    ) + "\n";
  await writeFile(checkpointPath, body);
  return { path: checkpointPath, hash: sha256(body), canonicalHash: sha256(canonical) };
}

async function runProvider(input: {
  client: DaemonClient;
  daemon: Awaited<ReturnType<typeof createTestPaseoDaemon>>;
  root: string;
  expected: ProviderConfig;
  runs: ProviderRunEvidence[];
  persist: () => Promise<void>;
}): Promise<ProviderRunEvidence> {
  const nonce = randomUUID();
  const repo = await createTaskRepo(input.root, input.expected.provider, nonce);
  const workspace = await input.client.createWorkspace({
    source: { kind: "directory", path: repo },
    title: `live rotation ${input.expected.provider}`,
  });
  if (!workspace.workspace) throw new Error("isolated workspace was not created");
  const workspaceId = workspace.workspace.id;
  const events: Array<{ at: string; agentId: string; status: string | null }> = [];
  const notifier = { signal: () => {} };
  const unsubscribe = input.client.on("agent_update", (message) => {
    if (message.payload.kind !== "upsert") return;
    events.push({
      at: new Date().toISOString(),
      agentId: message.payload.agent.id,
      status: message.payload.agent.status,
    });
    notifier.signal();
  });
  const agent = await input.client.createAgent({
    provider: input.expected.provider as AgentProvider,
    cwd: repo,
    workspaceId,
    title: `seat-rotation-live-${input.expected.provider}`,
    model: input.expected.model,
    modeId: input.expected.mode,
    thinkingOptionId: input.expected.effort,
    ...(input.expected.provider === "codex" ? { featureValues: { fast_mode: false } } : {}),
  });
  const evidence: ProviderRunEvidence = {
    provider: input.expected.provider,
    expected: input.expected,
    taskRepo: repo,
    workspaceId,
    initialAgentId: agent.id,
    initialSessionId: null,
    initialRuntime: null,
    initialProgress: null,
    rotations: [],
    archivedPredecessors: [],
  };
  input.runs.push(evidence);
  try {
    await input.persist();
    await input.client.sendMessage(
      agent.id,
      "Read TASK.md, progress.json, and .handover/CURRENT.json. Perform exactly step 1 now and then stop.",
    );
    await waitForTurn(input.client, agent.id, input.expected.provider);
    evidence.initialProgress = await readProgress(repo, nonce, 1);
    await assertModelCommit(repo);
    const initialRuntime = await assertRuntime({
      client: input.client,
      agentId: agent.id,
      expected: input.expected,
      repo,
      workspaceId,
    });
    evidence.initialSessionId = initialRuntime.sessionId;
    evidence.initialRuntime = initialRuntime.runtime;
    await input.persist();

    let predecessorId = agent.id;
    for (const generation of [1, 2, 3]) {
      const predecessor = input.daemon.daemon.agentManager.getAgent(predecessorId);
      const predecessorSessionId = predecessor?.persistence?.sessionId;
      if (!predecessor || !predecessorSessionId)
        throw new Error("predecessor identity was unavailable before rotation");
      const sourceRevision = await command(repo, ["rev-parse", "HEAD"]);
      const timelineRevision =
        (await input.daemon.daemon.agentManager.getTimelineRows(predecessorId)).at(-1)?.seq ?? 0;
      const operationId = randomUUID();
      const checkpoint = await writeEnvelope({
        repo,
        operationId,
        generation,
        sessionId: predecessorSessionId,
        sourceRevision,
        timelineRevision,
      });
      const rotation: RotationEvidence = {
        generation,
        operationId,
        predecessorId,
        predecessorSessionId,
        successorId: null,
        successorSessionId: null,
        request: { operationId, generation, sourceRevision, timelineRevision },
        terminal: null,
        checkpoint,
        timelineRevision,
        lifecycleEvents: [],
        progressAfter: null,
      };
      evidence.rotations.push(rotation);
      await input.persist();
      const request = await input.client.rotateAgentSeat({
        operationId,
        predecessorId,
        generation,
        handoverRoot: path.join(repo, ".handover"),
        checkpointPath: checkpoint.path,
        resumePrompt:
          "Read TASK.md, progress.json, and .handover/CURRENT.json. Verify the checkpoint and perform exactly the next step once. Do not create agents or answer permissions. Commit only the two task state files, then stop.",
      });
      rotation.request = request;
      rotation.successorId = request.successorId;
      if (!request.successorId)
        throw new Error("native rotation accepted without an observable successor id");
      await input.persist();
      await awaitSecondIdle({ events, notifier, agentId: request.successorId });
      await waitForTurn(input.client, request.successorId, input.expected.provider);
      rotation.terminal = await input.client.inspectAgentSeatRotation(operationId);
      expect(rotation.terminal).toMatchObject({
        phase: "succeeded",
        successorId: request.successorId,
      });
      rotation.lifecycleEvents = events.filter(
        (event) => event.agentId === predecessorId || event.agentId === request.successorId,
      );
      const successorRuntime = await assertRuntime({
        client: input.client,
        agentId: request.successorId,
        expected: input.expected,
        repo,
        workspaceId,
      });
      rotation.successorSessionId = successorRuntime.sessionId;
      expect(rotation.successorSessionId).toBeTruthy();
      expect(rotation.successorSessionId).not.toBe(predecessorSessionId);
      expect(await input.daemon.daemon.agentStorage.get(predecessorId)).toMatchObject({
        archivedAt: expect.any(String),
      });
      evidence.archivedPredecessors.push(predecessorId);
      rotation.progressAfter = await readProgress(repo, nonce, generation + 1);
      await assertModelCommit(repo);
      await rm(checkpoint.path);
      expect(await command(repo, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe("");
      await input.persist();
      predecessorId = request.successorId;
    }
    evidence.finalProgress = await readProgress(repo, nonce, 4);
    expect(evidence.rotations).toHaveLength(3);
    return evidence;
  } finally {
    unsubscribe();
  }
}

describe("seat rotation live providers (real, isolated)", () => {
  liveProviderSmoke(
    "performs three actual Fable handovers then three actual Codex handovers with committed task continuity",
    async () => {
      const outputDir = requireEnv(receiptDir, "PROVIDER_LIVE_RECEIPT_DIR");
      await mkdir(outputDir, { recursive: true });
      const root = await mkdtemp(path.join(os.tmpdir(), "paseo-seat-rotation-live-"));
      const stateRoot = await mkdtemp(path.join(outputDir, "state-"));
      const staticDir = await mkdtemp(path.join(outputDir, "static-"));
      const sourceCwd = process.cwd();
      const report: LiveRotationReport = {
        startedAt: new Date().toISOString(),
        source: { cwd: sourceCwd, revision: await command(sourceCwd, ["rev-parse", "HEAD"]) },
        daemon: { listen: "pending", stateRoot, staticDir, pid: process.pid },
        providers: [],
        cleanup: "pending",
      };
      const persist = async () =>
        await writeFile(
          path.join(outputDir, "report.json"),
          `${JSON.stringify(report, null, 2)}\n`,
        );
      const logger = pino({ level: "warn" });
      const daemon = await createTestPaseoDaemon({
        paseoHomeRoot: stateRoot,
        staticDir,
        cleanup: false,
        mcpEnabled: false,
        logger,
        enableNativeSeatRotation: true,
        agentClients: {
          claude: new ClaudeAgentClient({ logger }),
          codex: new CodexAppServerAgentClient(logger),
        },
      });
      report.daemon.listen = `127.0.0.1:${daemon.port}`;
      const client = new DaemonClient({
        url: `ws://127.0.0.1:${daemon.port}/ws`,
        appVersion: "0.8.0",
      });
      let primaryError: unknown = null;
      let cleanupFailure: ProviderSmokeCleanupError | null = null;
      try {
        await client.connect();
        await client.fetchAgents({ subscribe: { subscriptionId: "seat-rotation-live-provider" } });
        for (const expected of [
          { provider: "claude", model: "claude-fable-5-1", effort: "low", mode: "auto" },
          { provider: "codex", model: "gpt-5.6-terra", effort: "medium", mode: "auto-review" },
        ] as ProviderConfig[]) {
          await runProvider({ client, daemon, root, expected, runs: report.providers, persist });
          await persist();
        }
        report.result = "pass";
      } catch (error) {
        primaryError = error;
        report.result = "fail";
        report.error = errorDetails(error);
      } finally {
        report.cleanup = await closeProviderSmokeResources({
          closeClient: () => client.close(),
          closeDaemon: () => daemon.close(),
        });
        report.finishedAt = new Date().toISOString();
        await persist();
        if (report.cleanup.status === "failed")
          cleanupFailure = new ProviderSmokeCleanupError(report.cleanup);
      }
      if (cleanupFailure) throw cleanupFailure;
      if (primaryError) throw primaryError;
    },
    1_200_000,
  );
});
