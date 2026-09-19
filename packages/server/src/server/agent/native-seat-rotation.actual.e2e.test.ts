import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import type { AgentClient } from "./agent-sdk-types.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const roots: string[] = [];
const daemons: TestPaseoDaemon[] = [];

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(options?: { agentClients?: Record<string, AgentClient> }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-seat-rotation-actual-"));
  roots.push(root);
  const repo = path.join(root, "repo");
  const handoverRoot = path.join(repo, ".handover");
  await mkdir(handoverRoot, { recursive: true });
  execFileSync("git", ["init", "--quiet", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  await writeFile(path.join(repo, "README.md"), "fixture\n");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "commit", "--quiet", "-m", "fixture"]);
  const repoPath = await realpath(repo);
  const revision = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const daemon = await createTestPaseoDaemon({
    enableNativeSeatRotation: true,
    agentClients: options?.agentClients,
  });
  daemons.push(daemon);
  const first = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const second = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  await Promise.all([first.connect(), second.connect()]);
  await Promise.all([
    first.fetchAgents({ subscribe: { subscriptionId: "native-first" } }),
    second.fetchAgents({ subscribe: { subscriptionId: "native-second" } }),
  ]);
  const predecessor = await first.createAgent({ provider: "codex", cwd: repoPath });
  const managed = daemon.daemon.agentManager.getAgent(predecessor.id);
  if (!managed?.persistence?.sessionId) throw new Error("fixture agent lacks a durable session");
  return {
    daemon,
    first,
    second,
    repoPath,
    revision,
    handoverRoot,
    predecessor,
    sessionId: managed.persistence.sessionId,
  };
}

async function checkpoint(
  input: Awaited<ReturnType<typeof setup>>,
  operationId: string,
  timelineRevision: number,
) {
  const checkpointPath = path.join(input.handoverRoot, `${operationId}.json`);
  await writeFile(
    checkpointPath,
    JSON.stringify({
      operationId,
      generation: 1,
      sessionId: input.sessionId,
      repoPath: input.repoPath,
      sourceRevision: input.revision,
      timelineRevision,
      dirtyDisposition: "clean",
      nextAction: "continue",
    }),
  );
  return checkpointPath;
}

test("two normal WebSocket clients share one real manager admission and one successor", async () => {
  const f = await setup();
  const operationId = randomUUID();
  const checkpointPath = await checkpoint(f, operationId, 0);
  const request = {
    operationId,
    predecessorId: f.predecessor.id,
    generation: 1,
    handoverRoot: f.handoverRoot,
    checkpointPath,
    resumePrompt: "Read the checkpoint and continue exactly once.",
  };
  const [left, right] = await Promise.all([
    f.first.rotateAgentSeat(request),
    f.second.rotateAgentSeat(request),
  ]);
  expect(left.successorId).toMatch(/[a-f0-9-]{36}/);
  expect(right.successorId).toBe(left.successorId);
  await vi.waitFor(async () => {
    await expect(f.first.inspectAgentSeatRotation(operationId)).resolves.toMatchObject({
      phase: "succeeded",
    });
  });
  await expect(f.daemon.daemon.agentStorage.get(f.predecessor.id)).resolves.toMatchObject({
    archivedAt: expect.any(String),
  });
});

test("a stale checkpoint is refused after a later normal chat changes the real manager timeline", async () => {
  const f = await setup();
  await f.first.sendMessage(f.predecessor.id, "first completed chat");
  await f.first.waitForFinish(f.predecessor.id, 5_000);
  const revision =
    (await f.daemon.daemon.agentManager.getTimelineRows(f.predecessor.id)).at(-1)?.seq ?? 0;
  const operationId = randomUUID();
  const checkpointPath = await checkpoint(f, operationId, revision);
  await f.second.sendMessage(f.predecessor.id, "later completed chat without a git change");
  await f.second.waitForFinish(f.predecessor.id, 5_000);
  await expect(
    f.first.rotateAgentSeat({
      operationId,
      predecessorId: f.predecessor.id,
      generation: 1,
      handoverRoot: f.handoverRoot,
      checkpointPath,
      resumePrompt: "continue",
    }),
  ).rejects.toThrow("conversation boundary");
});

test("a provider late write during archive is detected before a successor session exists", async () => {
  let lateWrite: (() => Promise<void>) | undefined;
  let sessionCreates = 0;
  const base = createTestAgentClient("codex", {
    closeSession: async () => await lateWrite?.(),
  });
  const client: AgentClient = {
    provider: base.provider,
    capabilities: base.capabilities,
    async createSession(...args) {
      sessionCreates += 1;
      return await base.createSession(...args);
    },
    resumeSession: base.resumeSession.bind(base),
    fetchCatalog: base.fetchCatalog.bind(base),
    isAvailable: base.isAvailable.bind(base),
  };
  const f = await setup({ agentClients: { codex: client } });
  const operationId = randomUUID();
  const checkpointPath = await checkpoint(f, operationId, 0);
  lateWrite = async () => await writeFile(path.join(f.repoPath, "late-write.txt"), "late\n");
  await expect(
    f.first.rotateAgentSeat({
      operationId,
      predecessorId: f.predecessor.id,
      generation: 1,
      handoverRoot: f.handoverRoot,
      checkpointPath,
      resumePrompt: "continue",
    }),
  ).rejects.toThrow("dirty worktree rotation is unsupported");
  await expect(f.first.inspectAgentSeatRotation(operationId)).resolves.toMatchObject({
    phase: "failed",
    failureCode: "blocked",
  });
  expect(sessionCreates).toBe(1);
});
