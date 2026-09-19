import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import type { AgentClient, AgentSessionConfig } from "./agent-sdk-types.js";
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

function heldSecondCodexSession() {
  const base = createTestAgentClient("codex");
  let sessions = 0;
  let release!: () => void;
  let reached!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const preparing = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const client: AgentClient = {
    provider: base.provider,
    capabilities: base.capabilities,
    async createSession(config: AgentSessionConfig, launchContext) {
      sessions += 1;
      if (sessions === 2) {
        reached();
        await released;
      }
      return await base.createSession(config, launchContext);
    },
    resumeSession: base.resumeSession.bind(base),
    fetchCatalog: base.fetchCatalog.bind(base),
    isAvailable: base.isAvailable.bind(base),
  };
  return { client, preparing, release: () => release() };
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

test("the real manager fences normal client writes during preparation and releases a failed changed checkpoint", async () => {
  const held = heldSecondCodexSession();
  const f = await setup({ agentClients: { codex: held.client } });
  const operationId = randomUUID();
  const checkpointPath = await checkpoint(f, operationId, 0);
  const rotation = f.first.rotateAgentSeat({
    operationId,
    predecessorId: f.predecessor.id,
    generation: 1,
    handoverRoot: f.handoverRoot,
    checkpointPath,
    resumePrompt: "continue",
  });
  await held.preparing;
  await expect(f.second.sendMessage(f.predecessor.id, "writer during preparation")).rejects.toThrow(
    "reserved by native rotation",
  );
  await writeFile(
    checkpointPath,
    JSON.stringify({
      operationId,
      generation: 1,
      sessionId: f.sessionId,
      repoPath: f.repoPath,
      sourceRevision: f.revision,
      timelineRevision: 0,
      dirtyDisposition: "clean",
      nextAction: "checkpoint changed while preparing",
    }),
  );
  held.release();
  await expect(rotation).rejects.toThrow("changed after admission");
  await expect(f.first.inspectAgentSeatRotation(operationId)).resolves.toMatchObject({
    phase: "failed",
    failureCode: "blocked",
  });
  await expect(
    f.second.sendMessage(f.predecessor.id, "writer after failed preparation"),
  ).resolves.toBeUndefined();
  await f.second.waitForFinish(f.predecessor.id, 5_000);
});
