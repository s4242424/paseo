import { execFileSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { NativeSeatRotationService } from "./native-seat-rotation.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";

const predecessorId = "00000000-0000-4000-8000-000000000001";
const operationId = "00000000-0000-4000-8000-000000000003";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(options?: {
  holdCreate?: boolean;
  emptyResume?: boolean;
  failStop?: boolean;
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-seat-rotation-"));
  roots.push(root);
  const repoPath = path.join(root, "repo");
  const handoverRoot = path.join(repoPath, ".handover");
  await mkdir(handoverRoot, { recursive: true });
  execFileSync("git", ["init", "--quiet", repoPath]);
  execFileSync("git", ["-C", repoPath, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repoPath, "config", "user.name", "Test"]);
  await writeFile(path.join(repoPath, "README.md"), "fixture\n");
  execFileSync("git", ["-C", repoPath, "add", "README.md"]);
  execFileSync("git", ["-C", repoPath, "commit", "--quiet", "-m", "fixture"]);
  const revision = execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const realRepoPath = await realpath(repoPath);
  const checkpointPath = path.join(handoverRoot, "checkpoint.json");
  await writeFile(
    checkpointPath,
    JSON.stringify({
      operationId,
      generation: 1,
      sessionId: "old-provider-session",
      repoPath: realRepoPath,
      sourceRevision: revision,
      timelineRevision: 0,
      dirtyDisposition: "clean",
      nextAction: "continue",
    }),
  );
  const calls: string[] = [];
  let releaseCreate: (() => void) | undefined;
  const waitForCreate = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  const predecessor = agent({
    id: predecessorId,
    repoPath: realRepoPath,
    sessionId: "old-provider-session",
  });
  const successor = agent({
    id: "00000000-0000-4000-8000-000000000002",
    repoPath: realRepoPath,
    sessionId: "new-provider-session",
  });
  const manager = {
    getAgent(id: string) {
      return id === predecessorId ? predecessor : null;
    },
    beginNativeSeatRotationAdmission() {
      calls.push("admit");
    },
    setNativeSeatRotationAdmissionLookup() {},
    async getTimelineRows() {
      return [];
    },
    endNativeSeatRotationAdmission() {
      calls.push("release");
    },
    notifyAgentState() {},
    async createAgent() {
      calls.push("create");
      if (options?.holdCreate) await waitForCreate;
      return successor;
    },
    async archiveAgent() {
      calls.push("archive");
      return { archivedAt: new Date().toISOString() };
    },
    streamAgent() {
      calls.push("resume");
      return (async function* () {
        if (options?.emptyResume) return;
        yield { type: "turn_completed" };
      })();
    },
    async cancelAgentRun() {
      calls.push("stop");
      if (options?.failStop) throw new Error("provider stop refused");
      return { status: "not_running" as const };
    },
    async closeAgent() {
      calls.push("close");
    },
  } as unknown as AgentManager;
  const service = new NativeSeatRotationService({
    paseoHome: path.join(root, "paseo-home"),
    agentManager: manager,
    agentStorage: {} as AgentStorage,
    isEnabled: () => true,
  });
  return {
    calls,
    checkpointPath,
    handoverRoot,
    releaseCreate: releaseCreate!,
    service,
    journalPath: path.join(
      root,
      "paseo-home",
      "seat-rotations",
      "operations",
      `${operationId}.json`,
    ),
    cancellationPath: path.join(
      root,
      "paseo-home",
      "seat-rotations",
      "cancellations",
      `${operationId}.json`,
    ),
  };
}

function agent(input: { id: string; repoPath: string; sessionId: string }): ManagedAgent {
  return {
    id: input.id,
    provider: "codex",
    cwd: input.repoPath,
    workspaceId: "workspace-1",
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: false,
    },
    config: { provider: "codex", cwd: input.repoPath, model: "model-a" },
    createdAt: new Date(),
    updatedAt: new Date(),
    availableModes: [],
    currentModeId: null,
    pendingPermissions: new Map(),
    bufferedPermissionResolutions: new Map(),
    inFlightPermissionResponses: new Set(),
    pendingReplacement: false,
    persistence: { provider: "codex", sessionId: input.sessionId },
    historyPrimed: true,
    lastUserMessageAt: null,
    activeTurnId: null,
    activeTurnStartedAt: null,
    attention: { requiresAttention: false },
    foregroundTurnWaiters: new Set(),
    finalizedForegroundTurnIds: new Set(),
    unsubscribeSession: null,
    labels: {},
    lifecycle: "idle",
    activeForegroundTurnId: null,
    session: {} as never,
  };
}

function request(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    operationId,
    predecessorId,
    generation: 1,
    handoverRoot: f.handoverRoot,
    checkpointPath: f.checkpointPath,
    resumePrompt: "Read the checkpoint and continue exactly once.",
  };
}

test("writes a receipt and fences the real manager surface before archive and resume", async () => {
  const f = await fixture();
  const result = await f.service.rotate(request(f));
  expect(result.accepted).toBe(true);
  expect(result.operation.state).toBe("resume_uncertain");
  expect(f.calls).toEqual(["admit", "archive", "create", "resume"]);
  const journal = JSON.parse(await readFile(f.journalPath, "utf8"));
  expect(journal).toMatchObject({ operationId, state: "resume_uncertain" });
  expect(journal.successorId).toMatch(/[a-f0-9-]{36}/);
  await f.service.waitForOperation(operationId);
  await expect(f.service.inspect(operationId)).resolves.toMatchObject({
    operationId,
    phase: "succeeded",
    workspaceId: "workspace-1",
    sourceRevision: expect.any(String),
    revision: expect.any(Number),
  });
  await expect(f.service.rotate(request(f))).resolves.toMatchObject({ accepted: true });
  expect(f.calls.filter((call) => call === "create")).toHaveLength(1);
});

test("a Stop latched during successor preparation closes it and records the archive fence", async () => {
  const f = await fixture({ holdCreate: true });
  const rotation = f.service.rotate(request(f));
  while (!f.calls.includes("create")) await new Promise((resolve) => setImmediate(resolve));
  const stopped = f.service.cancel(operationId);
  while (!(await exists(f.cancellationPath))) await new Promise((resolve) => setImmediate(resolve));
  f.releaseCreate();
  await expect(stopped).resolves.toMatchObject({
    operation: { state: "cancelled_after_fence" },
  });
  await expect(rotation).resolves.toMatchObject({ accepted: false });
  expect(f.calls).toContain("archive");
  expect(f.calls).not.toContain("resume");
});

test("a predecessor Stop records intent before the first journal and prevents admission", async () => {
  const f = await fixture();
  const rotation = f.service.rotate(request(f));
  await expect(f.service.cancelForPredecessor(predecessorId)).resolves.toMatchObject({
    accepted: true,
    operation: null,
  });
  await expect(rotation).resolves.toMatchObject({
    accepted: false,
    operation: { state: "cancelled" },
  });
  expect(f.calls).not.toContain("admit");
  expect(f.calls).not.toContain("archive");
  expect(f.calls).not.toContain("resume");
});

async function exists(filePath: string): Promise<boolean> {
  return await access(filePath)
    .then(() => true)
    .catch(() => false);
}

test("a Stop after successor activation interrupts it and records a recoverable failure", async () => {
  const f = await fixture();
  await f.service.rotate(request(f));
  await f.service.waitForOperation(operationId);

  const stopped = await f.service.cancel(operationId);

  expect(stopped).toMatchObject({ accepted: false, operation: { state: "cancelled_after_fence" } });
  expect(f.calls).toContain("stop");
  expect(f.calls).toContain("close");
  await expect(f.service.inspect(operationId)).resolves.toMatchObject({
    phase: "failed",
    failureCode: "cancelled_after_fence",
  });
});

test("dirty repository state is refused before the manager admission", async () => {
  const f = await fixture();
  await writeFile(path.join(f.handoverRoot, "uncommitted.txt"), "dirty\n");
  await expect(f.service.rotate(request(f))).rejects.toThrow(
    "dirty worktree rotation is unsupported",
  );
  expect(f.calls).toEqual([]);
});

test("does not promote an empty successor iterator to success", async () => {
  const f = await fixture({ emptyResume: true });
  await f.service.rotate(request(f));
  await f.service.waitForOperation(operationId);
  await expect(f.service.inspect(operationId)).resolves.toMatchObject({
    phase: "failed",
    failureCode: "resume_failed",
  });
});

test("records cancellation uncertainty when the successor stop is refused", async () => {
  const f = await fixture({ failStop: true });
  await f.service.rotate(request(f));
  await f.service.waitForOperation(operationId);
  await expect(f.service.cancel(operationId)).resolves.toMatchObject({
    accepted: false,
    operation: { state: "cancel_uncertain" },
  });
  await expect(f.service.inspect(operationId)).resolves.toMatchObject({
    phase: "failed",
    failureCode: "cancel_uncertain",
  });
});
