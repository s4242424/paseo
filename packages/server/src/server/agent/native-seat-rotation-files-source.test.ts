import { symlink } from "node:fs/promises";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { NativeSeatRotationService, readCleanFilesSnapshot } from "./native-seat-rotation.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";

// Additive, non-Git canonical-continuity source (docs/seat-rotation/IMPLEMENTATION.md).
// These tests cover the "files" source kind only; existing Git-source coverage
// in native-seat-rotation.test.ts is untouched and must keep passing unchanged.

const predecessorId = "00000000-0000-4000-8000-000000000101";
const successorId = "00000000-0000-4000-8000-000000000102";
const operationId = "00000000-0000-4000-8000-000000000103";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  root: string;
  repoPath: string;
  handoverRoot: string;
  checkpointPath: string;
  service: NativeSeatRotationService;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-seat-rotation-files-"));
  roots.push(root);
  const repoPath = await realpath(
    await mkdir(path.join(root, "repo"), { recursive: true }).then(() => path.join(root, "repo")),
  );
  const handoverRoot = path.join(repoPath, ".handover");
  await mkdir(handoverRoot, { recursive: true });
  await writeFile(path.join(repoPath, "canon-a.md"), "alpha\n");
  await mkdir(path.join(repoPath, "nested"), { recursive: true });
  await writeFile(path.join(repoPath, "nested", "canon-b.md"), "beta\n");
  const checkpointPath = path.join(handoverRoot, "checkpoint.json");

  const predecessor = agent({ id: predecessorId, repoPath, sessionId: "old-provider-session" });
  const successor = agent({ id: successorId, repoPath, sessionId: "new-provider-session" });
  const manager = {
    getAgent(id: string) {
      if (id === predecessorId) return predecessor;
      if (id === successorId) return successor;
      return null;
    },
    beginNativeSeatRotationAdmission() {},
    setNativeSeatRotationAdmissionLookup() {},
    async getTimelineRows() {
      return [];
    },
    endNativeSeatRotationAdmission() {},
    async createAgent() {
      return successor;
    },
    async archiveAgent() {
      predecessor.lifecycle = "closed";
      return { archivedAt: new Date().toISOString() };
    },
    async cancelAgentRun() {},
    async closeAgent() {},
    streamAgent: async function* () {
      yield { type: "turn_completed" };
    },
    notifyAgentState() {},
  } as unknown as AgentManager;

  const service = new NativeSeatRotationService({
    paseoHome: path.join(root, "paseo-home"),
    agentManager: manager,
    agentStorage: {
      async list() {
        return [];
      },
    } as AgentStorage,
    isEnabled: () => true,
  });

  return { root, repoPath, handoverRoot, checkpointPath, service };
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

const manifest = {
  kind: "files" as const,
  manifestVersion: 1,
  paths: ["canon-a.md", "nested/canon-b.md"],
};

async function writeCheckpoint(f: Awaited<ReturnType<typeof fixture>>, generation = 1) {
  const digest = await readCleanFilesSnapshot(f.repoPath, f.checkpointPath, manifest);
  await writeFile(
    f.checkpointPath,
    JSON.stringify({
      operationId,
      generation,
      sessionId: "old-provider-session",
      repoPath: f.repoPath,
      sourceRevision: digest.sourceRevision,
      timelineRevision: 0,
      dirtyDisposition: "clean",
      nextAction: "continue",
    }),
  );
}

function request(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    operationId,
    predecessorId,
    generation: 1,
    handoverRoot: f.handoverRoot,
    checkpointPath: f.checkpointPath,
    resumePrompt: "Read the checkpoint and continue exactly once.",
    source: manifest,
  };
}

test("rotates a non-Git seat using an explicit file manifest and records files provenance", async () => {
  const f = await fixture();
  await writeCheckpoint(f);
  const result = await f.service.rotate(request(f));
  await f.service.waitForOperation(operationId);
  expect(result.accepted).toBe(true);
  expect(result.operation.sourceKind).toBe("files");
  expect(result.operation.manifestVersion).toBe(1);
  expect(result.operation.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
});

test("refuses a manifest file that changed after the checkpoint recorded its digest", async () => {
  const f = await fixture();
  await writeCheckpoint(f);
  await writeFile(path.join(f.repoPath, "canon-a.md"), "tampered\n");
  await expect(f.service.rotate(request(f))).rejects.toThrow(
    "checkpoint source revision no longer matches the repository",
  );
});

test("refuses a missing manifest file", async () => {
  const f = await fixture();
  await writeCheckpoint(f);
  await rm(path.join(f.repoPath, "nested", "canon-b.md"));
  await expect(f.service.rotate(request(f))).rejects.toThrow(/manifest file is missing/);
});

test("refuses a symlink standing in for a manifest file", async () => {
  const f = await fixture();
  await writeCheckpoint(f);
  await rm(path.join(f.repoPath, "canon-a.md"));
  await symlink(path.join(f.repoPath, "nested", "canon-b.md"), path.join(f.repoPath, "canon-a.md"));
  await expect(f.service.rotate(request(f))).rejects.toThrow(/symlink refused/);
});

test("refuses a manifest path that escapes the repository root", async () => {
  const f = await fixture();
  await writeCheckpoint(f);
  const escaping = { ...request(f), source: { ...manifest, paths: ["../outside.md"] } };
  await expect(f.service.rotate(escaping)).rejects.toThrow(/escapes the repository/);
});

test("refuses a duplicate manifest path", async () => {
  const f = await fixture();
  await writeCheckpoint(f);
  const duplicated = {
    ...request(f),
    source: { ...manifest, paths: ["canon-a.md", "canon-a.md"] },
  };
  await expect(f.service.rotate(duplicated)).rejects.toThrow(/duplicate path/);
});

test("refuses a manifest entry that is the checkpoint file itself", async () => {
  const f = await fixture();
  await writeCheckpoint(f);
  const selfReferencing = {
    ...request(f),
    source: { ...manifest, paths: [...manifest.paths, ".handover/checkpoint.json"] },
  };
  await expect(f.service.rotate(selfReferencing)).rejects.toThrow(
    /must not include the checkpoint file itself/,
  );
});

test("refuses an oversized manifest entry count", async () => {
  const f = await fixture();
  await writeCheckpoint(f);
  const oversized = {
    ...request(f),
    source: { ...manifest, paths: Array.from({ length: 501 }, (_, i) => `canon-a.md#${i}`) },
  };
  await expect(f.service.rotate(oversized)).rejects.toThrow(/exceeds the configured entry bound/);
});

test("an old journal without a recorded source kind is read back as git, never files", async () => {
  const f = await fixture();
  // Simulate a pre-existing journal record written before this field existed.
  const journalPath = path.join(
    f.root,
    "paseo-home",
    "seat-rotations",
    "operations",
    `${operationId}.json`,
  );
  await mkdir(path.dirname(journalPath), { recursive: true });
  await writeFile(
    journalPath,
    JSON.stringify({
      version: 1,
      operationId,
      predecessorId,
      generation: 1,
      fingerprint: "a".repeat(64),
      checkpointPath: f.checkpointPath,
      checkpointHash: "a".repeat(64),
      workspaceId: null,
      sourceRevision: "a".repeat(40),
      revision: 0,
      state: "requested",
      updatedAt: new Date().toISOString(),
    }),
  );
  const journal = await f.service.read(operationId);
  expect(journal?.sourceKind).toBe("git");
});
