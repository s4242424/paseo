import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { SeatRotationPolicy } from "./seat-rotation-policy.js";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "./agent-manager.js";
import type { NativeSeatRotationService } from "./native-seat-rotation.js";

const agentId = "00000000-0000-4000-8000-000000000001";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("latches only a fresh provider-confirmed observation strictly above 40 percent", async () => {
  const f = await fixture();
  f.agent.lastUsage!.contextWindowObservation!.usedTokens = 40;
  f.emit();
  await f.flush();
  await expect(readFile(f.journalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

  f.agent.lastUsage!.contextWindowObservation!.usedTokens = 41;
  f.emit();
  await f.flush();
  await expect(readFile(f.journalPath, "utf8")).resolves.toContain('"state":"latched"');
});

test.each([
  [
    "catalog fallback",
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.agent.lastUsage!.contextWindowObservation!.contextWindowSource = "catalog-fallback";
    },
  ],
  [
    "a different provider session",
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.agent.lastUsage!.contextWindowObservation!.sessionId = "other-session";
    },
  ],
  [
    "a different active turn",
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.agent.lastUsage!.contextWindowObservation!.turnId = "other-turn";
    },
  ],
  [
    "a stale observation time",
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.agent.lastUsage!.contextWindowObservation!.observedAt = "2026-09-19T00:00:00.000Z";
    },
  ],
  [
    "a non-finite token count",
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.agent.lastUsage!.contextWindowObservation!.usedTokens = Number.NaN;
    },
  ],
])("does not latch %s", async (_name, mutate) => {
  const f = await fixture();
  mutate(f);
  f.emit();
  await f.flush();
  await expect(readFile(f.journalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("exposes inactive and pre-native latch state with explicit checkpoint-only continuation", async () => {
  const f = await fixture();
  await expect(f.policy.inspectByPredecessor(agentId)).resolves.toEqual({
    operationId: null,
    phase: "inactive",
    reason: null,
    goalContinuation: "checkpoint_only",
  });
  f.emit();
  await f.flush();
  await expect(f.policy.inspectByPredecessor(agentId)).resolves.toMatchObject({
    operationId: expect.any(String),
    phase: "latched",
    goalContinuation: "checkpoint_only",
  });
});

test("prepares through the manager, then delegates one native rotation at the safe boundary", async () => {
  const f = await fixture();
  f.emit();
  await f.flush();
  await writePreparedCheckpoint(f);
  const prepared = JSON.parse(await readFile(f.checkpointPath, "utf8")) as {
    operationId: string;
    generation: number;
    sessionId: string;
    repoPath: string;
  };
  const latched = JSON.parse(await readFile(f.journalPath, "utf8")) as {
    operationId: string;
    generation: number;
    sessionId: string;
    repositoryPath: string;
  };
  expect(prepared).toMatchObject({
    operationId: latched.operationId,
    generation: latched.generation,
    sessionId: latched.sessionId,
    repoPath: latched.repositoryPath,
  });

  f.agent.lifecycle = "idle";
  f.agent.activeForegroundTurnId = null;
  f.emit();
  await f.flush();
  expect(f.prompts).toHaveLength(1);
  expect(f.prompts[0]).toContain("Prepare the repository's existing seat-rotation checkpoint");

  f.agent.lifecycle = "running";
  f.agent.activeForegroundTurnId = "preparation-turn";
  f.agent.lastUserMessageAt = new Date();
  f.emit();
  await f.flush();
  f.agent.lifecycle = "idle";
  f.agent.activeForegroundTurnId = null;
  f.emit();
  await f.flush();

  await expect(f.policy.inspectByPredecessor(agentId)).resolves.toMatchObject({ reason: null });
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]).toMatchObject({ predecessorId: agentId, generation: 1 });
  await expect(readFile(f.checkpointPath, "utf8")).resolves.toContain('"timelineRevision":7');
});

test("a Stop cancels a latched preparation and later observations do not replay it", async () => {
  const f = await fixture();
  f.emit();
  await f.flush();
  await expect(f.policy.cancelForPredecessor(agentId)).resolves.toBe(true);
  f.agent.lifecycle = "idle";
  f.agent.activeForegroundTurnId = null;
  f.emit();
  await f.flush();
  expect(f.prompts).toHaveLength(0);
  await expect(readFile(f.journalPath, "utf8")).resolves.toContain('"state":"cancelled"');
});

test("blocks a latched seat when human work changes its safe boundary", async () => {
  const f = await fixture();
  f.emit();
  await f.flush();
  f.agent.lastUserMessageAt = new Date("2026-09-20T00:01:00.000Z");
  f.agent.lifecycle = "idle";
  f.agent.activeForegroundTurnId = null;
  f.emit();
  await f.flush();
  expect(f.prompts).toHaveLength(0);
  await expect(readFile(f.journalPath, "utf8")).resolves.toContain(
    '"reason":"boundary_invalidated_by_user_work"',
  );
});

test("refuses a configured repository without its logical seat binding", async () => {
  const f = await fixture();
  f.agent.labels = {};
  await expect(f.policy.inspectByPredecessor(agentId)).resolves.toEqual({
    operationId: null,
    phase: "unsupported",
    reason: "seat_rotation_policy_seat_binding_missing",
    goalContinuation: null,
  });
  f.emit();
  await f.flush();
  await expect(readFile(f.journalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("refuses a second live writer for the same logical seat and checkpoint", async () => {
  const f = await fixture();
  f.liveAgents.push({ ...f.agent, id: "00000000-0000-4000-8000-000000000002" });
  await expect(f.policy.inspectByPredecessor(agentId)).resolves.toMatchObject({
    phase: "unsupported",
    reason: "seat_rotation_policy_seat_binding_missing",
  });
  f.emit();
  await f.flush();
  await expect(readFile(f.journalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("an immediately high successor remains blocked until its configured witness changes", async () => {
  const f = await fixture();
  await writeFile(f.witnessPath, "unchanged");
  f.progressGates.set(agentId, createHash("sha256").update("unchanged").digest("hex"));
  f.emit();
  await f.flush();
  await expect(readFile(f.journalPath, "utf8")).resolves.toContain(
    '"reason":"no_progress_immediate_retrigger"',
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "seat-rotation-policy-"));
  roots.push(root);
  const repo = path.join(root, "repo");
  const handoverRoot = path.join(repo, ".handover");
  const checkpointPath = path.join(handoverRoot, "checkpoint.json");
  const witnessPath = path.join(repo, ".handover", "progress.txt");
  await mkdir(handoverRoot, { recursive: true });
  await writeFile(witnessPath, "initial");
  let callback: ((event: AgentManagerEvent) => void) | undefined;
  const prompts: string[] = [];
  const requests: unknown[] = [];
  const liveAgents: ManagedAgent[] = [];
  const agent = createAgent(repo);
  const manager = {
    getAgent(id: string) {
      return id === agentId ? agent : null;
    },
    getTimelineRows() {
      return [{ seq: 7 }];
    },
    listAgents() {
      return [agent, ...liveAgents];
    },
    subscribe(listener: (event: AgentManagerEvent) => void) {
      callback = listener;
      return () => {
        callback = undefined;
      };
    },
    streamAgent(_: string, prompt: string) {
      prompts.push(prompt);
      return (async function* () {})();
    },
  } as unknown as Pick<
    AgentManager,
    "getAgent" | "getTimelineRows" | "listAgents" | "subscribe" | "streamAgent"
  >;
  const native = {
    async rotate(request: unknown) {
      requests.push(request);
      return { accepted: true, operation: { successorId: null } };
    },
    async cancel() {
      return { accepted: true, operation: null };
    },
  } as unknown as Pick<NativeSeatRotationService, "rotate" | "cancel">;
  const policy = new SeatRotationPolicy({
    paseoHome: path.join(root, "paseo-home"),
    agentManager: manager,
    nativeSeatRotation: native,
    readConfig: () => ({
      enabled: true,
      seats: [
        {
          seatId: "seat-a",
          repositoryPath: repo,
          handoverRoot,
          checkpointPath,
          progressWitnessPath: witnessPath,
          resumePrompt: "Read the checkpoint and continue.",
          goalContinuation: "checkpoint_only",
        },
      ],
    }),
  });
  policy.start();
  return {
    agent,
    checkpointPath,
    journalPath: path.join(
      root,
      "paseo-home",
      "seat-rotation-policy",
      "operations",
      `${agentId}.json`,
    ),
    liveAgents,
    policy,
    progressGates: (policy as unknown as { progressGates: Map<string, string> }).progressGates,
    prompts,
    requests,
    witnessPath,
    emit() {
      callback?.({ type: "agent_state", agent: { ...agent } });
    },
    async flush() {
      await policy.waitForAgent(agentId);
    },
  };
}

async function writePreparedCheckpoint(f: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  const journal = JSON.parse(await readFile(f.journalPath, "utf8")) as {
    operationId: string;
    generation: number;
    sessionId: string;
    repositoryPath: string;
  };
  await writeFile(
    f.checkpointPath,
    JSON.stringify({
      operationId: journal.operationId,
      generation: journal.generation,
      sessionId: journal.sessionId,
      repoPath: journal.repositoryPath,
      sourceRevision: "abcdef0",
      timelineRevision: 0,
      dirtyDisposition: "clean",
      nextAction: "continue",
    }),
  );
}

function createAgent(repo: string): ManagedAgent {
  return {
    id: agentId,
    provider: "codex",
    cwd: repo,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: false,
    },
    config: { provider: "codex", cwd: repo },
    createdAt: new Date(),
    updatedAt: new Date(),
    availableModes: [],
    currentModeId: null,
    pendingPermissions: new Map(),
    bufferedPermissionResolutions: new Map(),
    inFlightPermissionResponses: new Set(),
    pendingReplacement: false,
    persistence: { provider: "codex", sessionId: "provider-session" },
    historyPrimed: true,
    lastUserMessageAt: new Date("2026-09-20T00:00:00.000Z"),
    activeTurnId: "turn-1",
    activeTurnStartedAt: new Date(),
    lastUsage: {
      contextWindowObservation: {
        sessionId: "provider-session",
        turnId: "turn-1",
        observedAt: new Date().toISOString(),
        contextWindowSource: "provider-confirmed",
        usedTokens: 41,
        maxTokens: 100,
      },
    },
    attention: { requiresAttention: false },
    foregroundTurnWaiters: new Set(),
    finalizedForegroundTurnIds: new Set(),
    unsubscribeSession: null,
    labels: { "paseo.seat-id": "seat-a" },
    lifecycle: "running",
    activeForegroundTurnId: "turn-1",
    session: {} as never,
  };
}
