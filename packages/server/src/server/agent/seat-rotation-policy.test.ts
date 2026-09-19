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

test("prepares through the manager, then delegates one native rotation at the safe boundary", async () => {
  const f = await fixture();
  f.emit();
  await f.flush();

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

  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]).toMatchObject({ predecessorId: agentId, generation: 1 });
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
  const agent = createAgent(repo);
  const manager = {
    getAgent(id: string) {
      return id === agentId ? agent : null;
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
  } as unknown as Pick<AgentManager, "getAgent" | "subscribe" | "streamAgent">;
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
          repositoryPath: repo,
          handoverRoot,
          checkpointPath,
          progressWitnessPath: witnessPath,
          resumePrompt: "Read the checkpoint and continue.",
        },
      ],
    }),
  });
  policy.start();
  return {
    agent,
    journalPath: path.join(
      root,
      "paseo-home",
      "seat-rotation-policy",
      "operations",
      `${agentId}.json`,
    ),
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
    labels: {},
    lifecycle: "running",
    activeForegroundTurnId: "turn-1",
    session: {} as never,
  };
}
