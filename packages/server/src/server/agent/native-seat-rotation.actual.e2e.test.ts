import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
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

async function setup(options?: {
  agentClients?: Record<string, AgentClient>;
  retainDaemonState?: boolean;
  enableNativeSeatRotation?: boolean;
}) {
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
    cleanup: options?.retainDaemonState ? false : undefined,
    enableNativeSeatRotation: options?.enableNativeSeatRotation ?? true,
    agentClients: options?.agentClients,
    paseoHomeRoot: options?.retainDaemonState ? path.join(root, "daemon-home") : undefined,
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
    daemonRoot: path.join(root, "daemon-home"),
    predecessor,
    sessionId: managed.persistence.sessionId,
  };
}

async function readJournal(input: Awaited<ReturnType<typeof setup>>, operationId: string) {
  return JSON.parse(
    await readFile(
      path.join(input.daemon.paseoHome, "seat-rotations", "operations", `${operationId}.json`),
      "utf8",
    ),
  ) as { state: string; successorId?: string };
}

async function checkpoint(
  input: Awaited<ReturnType<typeof setup>>,
  operationId: string,
  timelineRevision: number,
  generation = 1,
) {
  const checkpointPath = path.join(input.handoverRoot, `${operationId}.json`);
  await writeFile(
    checkpointPath,
    JSON.stringify({
      operationId,
      generation,
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

test("native-default-off denies the normal client request without altering the predecessor", async () => {
  const f = await setup({ enableNativeSeatRotation: false });
  const operationId = randomUUID();
  const checkpointPath = await checkpoint(f, operationId, 0);
  await expect(
    f.first.rotateAgentSeat({
      operationId,
      predecessorId: f.predecessor.id,
      generation: 1,
      handoverRoot: f.handoverRoot,
      checkpointPath,
      resumePrompt: "must not start",
    }),
  ).rejects.toThrow("Update the host");
  await expect(f.daemon.daemon.agentStorage.get(f.predecessor.id)).resolves.not.toHaveProperty(
    "archivedAt",
  );
  await expect(f.first.inspectAgentSeatRotation(operationId)).rejects.toThrow("Update the host");
});

test("pending human permission and an active managed child refuse normal rotation requests", async () => {
  const f = await setup();
  const pendingPermission = f.daemon.daemon.agentManager.getAgent(f.predecessor.id);
  if (!pendingPermission || pendingPermission.lifecycle === "closed") {
    throw new Error("fixture predecessor is not live");
  }
  pendingPermission.pendingPermissions.set("pending-human", {} as never);
  const permissionOperationId = randomUUID();
  const permissionCheckpoint = await checkpoint(f, permissionOperationId, 0);
  await expect(
    f.first.rotateAgentSeat({
      operationId: permissionOperationId,
      predecessorId: f.predecessor.id,
      generation: 1,
      handoverRoot: f.handoverRoot,
      checkpointPath: permissionCheckpoint,
      resumePrompt: "must not start",
    }),
  ).rejects.toThrow("unresolved permissions");
  pendingPermission.pendingPermissions.clear();
  await rm(permissionCheckpoint);

  await f.daemon.daemon.agentManager.createAgent(
    { provider: "codex", cwd: f.repoPath },
    undefined,
    { labels: { [PARENT_AGENT_ID_LABEL]: f.predecessor.id } },
  );
  const childOperationId = randomUUID();
  await expect(
    f.second.rotateAgentSeat({
      operationId: childOperationId,
      predecessorId: f.predecessor.id,
      generation: 2,
      handoverRoot: f.handoverRoot,
      checkpointPath: await checkpoint(f, childOperationId, 0, 2),
      resumePrompt: "must not start",
    }),
  ).rejects.toThrow("active managed children");
  await expect(f.daemon.daemon.agentStorage.get(f.predecessor.id)).resolves.not.toHaveProperty(
    "archivedAt",
  );
});

test("different operation generations admit one successor and fence a queued normal prompt", async () => {
  let sessionCreates = 0;
  let holdSuccessorCreate = false;
  let releaseSuccessorCreate: (() => void) | undefined;
  const successorCreate = new Promise<void>((resolve) => {
    releaseSuccessorCreate = resolve;
  });
  const base = createTestAgentClient("codex");
  const client: AgentClient = {
    provider: base.provider,
    capabilities: base.capabilities,
    async createSession(...args) {
      sessionCreates += 1;
      if (holdSuccessorCreate) await successorCreate;
      return await base.createSession(...args);
    },
    resumeSession: base.resumeSession.bind(base),
    fetchCatalog: base.fetchCatalog.bind(base),
    isAvailable: base.isAvailable.bind(base),
  };
  const f = await setup({ agentClients: { codex: client } });
  sessionCreates = 0;
  holdSuccessorCreate = true;
  const firstOperationId = randomUUID();
  const secondOperationId = randomUUID();
  const firstCheckpoint = await checkpoint(f, firstOperationId, 0);
  const firstRotation = f.first.rotateAgentSeat({
    operationId: firstOperationId,
    predecessorId: f.predecessor.id,
    generation: 1,
    handoverRoot: f.handoverRoot,
    checkpointPath: firstCheckpoint,
    resumePrompt: "continue once",
  });
  await vi.waitFor(async () => {
    expect(await readJournal(f, firstOperationId).catch(() => null)).toMatchObject({
      state: "prepared",
    });
  });
  await expect(
    f.second.sendMessage(f.predecessor.id, "queued around rotation admission"),
  ).rejects.toThrow("reserved by native rotation");
  const secondRotation = f.second.rotateAgentSeat({
    operationId: secondOperationId,
    predecessorId: f.predecessor.id,
    generation: 2,
    handoverRoot: f.handoverRoot,
    // Deliberately reuse the first receipt: the queued second generation is
    // invalid without leaving another untracked handover artefact in the repo.
    checkpointPath: firstCheckpoint,
    resumePrompt: "must not start",
  });
  releaseSuccessorCreate?.();
  const [first, second] = await Promise.allSettled([firstRotation, secondRotation]);
  expect(first.status).toBe("fulfilled");
  expect(second).toMatchObject({ status: "rejected" });
  await vi.waitFor(async () => {
    await expect(f.first.inspectAgentSeatRotation(firstOperationId)).resolves.toMatchObject({
      phase: "succeeded",
    });
  });
  await expect(f.first.inspectAgentSeatRotation(secondOperationId)).resolves.toMatchObject({
    phase: null,
  });
  expect(sessionCreates).toBe(1);
});

test("a queued invalid operation cannot hide a held pre-journal intent from normal Stop", async () => {
  const f = await setup();
  const firstOperationId = randomUUID();
  const checkpointPath = await checkpoint(f, firstOperationId, 0);
  const checkpointBody = await readFile(checkpointPath);
  await rm(checkpointPath);
  execFileSync("mkfifo", [checkpointPath]);

  const firstRotation = f.first.rotateAgentSeat({
    operationId: firstOperationId,
    predecessorId: f.predecessor.id,
    generation: 1,
    handoverRoot: f.handoverRoot,
    checkpointPath,
    resumePrompt: "must not start",
  });
  const invalidRotation = f.second.rotateAgentSeat({
    operationId: randomUUID(),
    predecessorId: f.predecessor.id,
    generation: 2,
    handoverRoot: f.handoverRoot,
    checkpointPath: path.join(f.handoverRoot, "missing-checkpoint.json"),
    resumePrompt: "must not start",
  });
  await f.second.cancelAgent(f.predecessor.id);
  await writeFile(checkpointPath, checkpointBody);
  await expect(firstRotation).rejects.toThrow("Native seat rotation was rejected");
  await expect(invalidRotation).rejects.toThrow();
  await expect(f.first.inspectAgentSeatRotation(firstOperationId)).resolves.toMatchObject({
    phase: "failed",
    failureCode: "cancelled",
  });
  await f.first.sendMessage(f.predecessor.id, "pre-journal Stop leaves the predecessor live");
  await f.first.waitForFinish(f.predecessor.id, 5_000);
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

test("normal client Stop cancels a held successor resume and restart does not retry it", async () => {
  let sessionCreates = 0;
  const prompts: string[] = [];
  const base = createTestAgentClient("codex", {
    onStartTurn: (prompt) => prompts.push(String(prompt)),
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
  const f = await setup({ agentClients: { codex: client }, retainDaemonState: true });
  const operationId = randomUUID();
  const checkpointPath = await checkpoint(f, operationId, 0);
  await f.first.rotateAgentSeat({
    operationId,
    predecessorId: f.predecessor.id,
    generation: 1,
    handoverRoot: f.handoverRoot,
    checkpointPath,
    resumePrompt: "sleep while waiting for permission",
  });
  await vi.waitFor(async () => {
    expect(await readJournal(f, operationId).catch(() => null)).toMatchObject({
      state: "resume_uncertain",
    });
  });
  await f.second.cancelAgent(f.predecessor.id);
  await vi.waitFor(async () => {
    await expect(f.first.inspectAgentSeatRotation(operationId)).resolves.toMatchObject({
      phase: "failed",
      failureCode: "cancelled_after_fence",
    });
  });
  expect(prompts).toEqual(["sleep while waiting for permission"]);
  await f.first.close();
  await f.second.close();
  await f.daemon.close();

  const restarted = await createTestPaseoDaemon({
    agentClients: { codex: client },
    cleanup: false,
    enableNativeSeatRotation: true,
    paseoHomeRoot: f.daemonRoot,
  });
  daemons.push(restarted);
  const resumedClient = new DaemonClient({ url: `ws://127.0.0.1:${restarted.port}/ws` });
  await resumedClient.connect();
  await resumedClient.fetchAgents({ subscribe: { subscriptionId: "native-restarted" } });
  await expect(resumedClient.inspectAgentSeatRotation(operationId)).resolves.toMatchObject({
    phase: "failed",
    failureCode: "cancelled_after_fence",
  });
  await expect(
    resumedClient.rotateAgentSeat({
      operationId,
      predecessorId: f.predecessor.id,
      generation: 1,
      handoverRoot: f.handoverRoot,
      checkpointPath,
      resumePrompt: "sleep while waiting for permission",
    }),
  ).rejects.toThrow("Native seat rotation was rejected");
  expect(sessionCreates).toBe(2);
  expect(prompts).toEqual(["sleep while waiting for permission"]);
  await resumedClient.close();
});

test("a retained terminal receipt reconciles after daemon restart without another successor", async () => {
  let sessionCreates = 0;
  const prompts: string[] = [];
  const base = createTestAgentClient("codex", {
    onStartTurn: (prompt) => prompts.push(String(prompt)),
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
  const f = await setup({ agentClients: { codex: client }, retainDaemonState: true });
  const operationId = randomUUID();
  const checkpointPath = await checkpoint(f, operationId, 0);
  const first = await f.first.rotateAgentSeat({
    operationId,
    predecessorId: f.predecessor.id,
    generation: 1,
    handoverRoot: f.handoverRoot,
    checkpointPath,
    resumePrompt: "resume once before restart",
  });
  await vi.waitFor(async () => {
    await expect(f.first.inspectAgentSeatRotation(operationId)).resolves.toMatchObject({
      phase: "succeeded",
      successorId: first.successorId,
    });
  });
  await f.first.close();
  await f.second.close();
  await f.daemon.close();

  const restarted = await createTestPaseoDaemon({
    agentClients: { codex: client },
    cleanup: false,
    enableNativeSeatRotation: true,
    paseoHomeRoot: f.daemonRoot,
  });
  daemons.push(restarted);
  const resumedClient = new DaemonClient({ url: `ws://127.0.0.1:${restarted.port}/ws` });
  await resumedClient.connect();
  await resumedClient.fetchAgents({ subscribe: { subscriptionId: "native-terminal-restart" } });
  await expect(resumedClient.inspectAgentSeatRotation(operationId)).resolves.toMatchObject({
    phase: "succeeded",
    successorId: first.successorId,
  });
  await expect(
    resumedClient.rotateAgentSeat({
      operationId,
      predecessorId: f.predecessor.id,
      generation: 1,
      handoverRoot: f.handoverRoot,
      checkpointPath,
      resumePrompt: "resume once before restart",
    }),
  ).resolves.toMatchObject({ accepted: true, successorId: first.successorId });
  expect(sessionCreates).toBe(2);
  expect(prompts).toEqual(["resume once before restart"]);
  await resumedClient.close();
});

test("a successor create failure leaves the real predecessor live and writable", async () => {
  let sessionCreates = 0;
  const prompts: string[] = [];
  const base = createTestAgentClient("codex", {
    onStartTurn: (prompt) => prompts.push(String(prompt)),
  });
  const client: AgentClient = {
    provider: base.provider,
    capabilities: base.capabilities,
    async createSession(...args) {
      sessionCreates += 1;
      if (sessionCreates === 2) throw new Error("prepared successor unavailable");
      return await base.createSession(...args);
    },
    resumeSession: base.resumeSession.bind(base),
    fetchCatalog: base.fetchCatalog.bind(base),
    isAvailable: base.isAvailable.bind(base),
  };
  const f = await setup({ agentClients: { codex: client } });
  const operationId = randomUUID();
  const checkpointPath = await checkpoint(f, operationId, 0);
  await expect(
    f.first.rotateAgentSeat({
      operationId,
      predecessorId: f.predecessor.id,
      generation: 1,
      handoverRoot: f.handoverRoot,
      checkpointPath,
      resumePrompt: "continue",
    }),
  ).rejects.toThrow("prepared successor unavailable");
  expect(await f.daemon.daemon.agentStorage.get(f.predecessor.id)).not.toHaveProperty("archivedAt");
  await expect(f.first.inspectAgentSeatRotation(operationId)).resolves.toMatchObject({
    phase: "failed",
    failureCode: "blocked",
  });
  await f.first.sendMessage(
    f.predecessor.id,
    "old seat remains available after preparation failure",
  );
  await f.first.waitForFinish(f.predecessor.id, 5_000);
  expect(sessionCreates).toBe(2);
  expect(prompts).toEqual(["old seat remains available after preparation failure"]);
});

test("a provider late write after archive leaves a prepared successor closed and unprompted", async () => {
  let lateWrite: (() => Promise<void>) | undefined;
  let sessionCreates = 0;
  const prompts: string[] = [];
  const base = createTestAgentClient("codex", {
    closeSession: async () => await lateWrite?.(),
    onStartTurn: (prompt) => prompts.push(String(prompt)),
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
  const journal = JSON.parse(
    await readFile(
      path.join(f.daemon.paseoHome, "seat-rotations", "operations", `${operationId}.json`),
      "utf8",
    ),
  ) as { successorId?: string };
  expect(journal.successorId).toMatch(/[a-f0-9-]{36}/);
  expect(f.daemon.daemon.agentManager.getAgent(journal.successorId!)).toBeNull();
  await expect(f.daemon.daemon.agentStorage.get(journal.successorId!)).resolves.toMatchObject({
    id: journal.successorId,
  });
  expect(sessionCreates).toBe(2);
  expect(prompts).toEqual([]);
});
