import test from "node:test";
import assert from "node:assert/strict";

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { SeatRotationCore, UsageLatchStore } from "./core.mjs";

async function fixture({ adapterPatch = {}, checkpointPatch = {} } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "seat-rotation-")));
  const repoPath = path.join(root, "repo");
  const handoverRoot = path.join(root, "handover");
  await fs.mkdir(repoPath);
  await fs.mkdir(handoverRoot);
  const operationId = "rotate-001";
  const checkpointPath = path.join(handoverRoot, "checkpoint.json");
  const checkpoint = {
    operationId,
    generation: 1,
    sessionId: "old-session",
    repoPath,
    sourceRevision: "8f0f65c9058585d0c58d98f1db240b5fe48af8db",
    nextAction: "continue the bounded task",
    ...checkpointPatch,
  };
  await fs.writeFile(checkpointPath, JSON.stringify(checkpoint));
  const contract = {
    checkpointPath,
    checkpointHash: createHash("sha256")
      .update(await fs.readFile(checkpointPath))
      .digest("hex"),
    generation: 1,
    sessionId: "old-session",
    repoPath,
    sourceRevision: "8f0f65c9058585d0c58d98f1db240b5fe48af8db",
    runtime: { provider: "fable", model: "fable-1", effort: "medium", mode: "auto", cwd: repoPath },
  };
  const calls = [];
  const adapter = {
    async preflight({ contract: received }) {
      calls.push("preflight");
      return {
        safe: true,
        writerActive: false,
        permissionPending: false,
        childWriters: false,
        externalOperation: false,
        queuedGoalWriters: false,
        restartCapacity: 1,
        sessionId: received.sessionId,
        repoPath: received.repoPath,
        sourceRevision: received.sourceRevision,
        generation: received.generation,
        runtime: received.runtime,
      };
    },
    async createPreparedSuccessor() {
      calls.push("create");
      return { successorId: "new-session" };
    },
    async readSuccessorReadiness({ contract: received }) {
      calls.push("ready");
      return {
        ready: true,
        prepared: true,
        readCheckpoint: true,
        sessionId: "new-session",
        repoPath: received.repoPath,
        sourceRevision: received.sourceRevision,
        checkpointHash: received.checkpointHash,
        runtime: received.runtime,
      };
    },
    async fencePredecessor() {
      calls.push("fence");
      return { fenced: true };
    },
    async activateSuccessor() {
      calls.push("activate");
      return { active: true, liveness: "established" };
    },
    async archivePredecessor() {
      calls.push("archive");
      return { archived: true };
    },
    async reconcile() {
      calls.push("reconcile");
      return { known: false };
    },
    ...adapterPatch,
  };
  const journalRoot = path.join(root, "journal");
  const core = new SeatRotationCore({
    journalRoot,
    adapter,
    maxReconcileAttempts: 1,
    usageLatchStore: new UsageLatchStore({ journalRoot, maxAgeMs: 1_000 }),
  });
  return {
    root,
    repoPath,
    handoverRoot,
    operationId,
    checkpointPath,
    contract,
    calls,
    core,
    adapter,
  };
}

function request(f) {
  return {
    operationId: f.operationId,
    predecessorId: "old-seat",
    handoverRoot: f.handoverRoot,
    contract: f.contract,
  };
}

test("valid checkpoint transfers exactly once with a prepared successor", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const first = await f.core.run(request(f));
  const replay = await f.core.run(request(f));
  assert.deepEqual(first.operation.effects, [
    "prepared_successor_created",
    "predecessor_fenced",
    "predecessor_archived",
    "successor_activated",
  ]);
  assert.equal(first.operation.state, "completed");
  assert.equal(replay.replay, true);
  assert.deepEqual(f.calls, ["preflight", "create", "ready", "fence", "archive", "activate"]);
});

test("missing, tampered, wrong-repo and symlink checkpoints do not create successors", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  await fs.rm(f.checkpointPath);
  assert.equal((await f.core.run(request(f))).code, "invalid_checkpoint");
  await fs.writeFile(f.checkpointPath, "{}");
  f.contract.checkpointHash = createHash("sha256")
    .update(await fs.readFile(f.checkpointPath))
    .digest("hex");
  assert.equal(
    (await f.core.run({ ...request(f), operationId: "rotate-002" })).code,
    "invalid_checkpoint",
  );
  const wrong = await fixture({ checkpointPatch: { repoPath: "/wrong-repo" } });
  t.after(() => fs.rm(wrong.root, { recursive: true, force: true }));
  assert.equal((await wrong.core.run(request(wrong))).code, "invalid_checkpoint");
  const target = path.join(f.root, "target.json");
  await fs.writeFile(target, "{}");
  await fs.rm(f.checkpointPath);
  await fs.symlink(target, f.checkpointPath);
  assert.equal(
    (await f.core.run({ ...request(f), operationId: "rotate-003" })).code,
    "invalid_checkpoint",
  );
  assert.deepEqual(f.calls, []);
});

test("preflight refuses writers, permissions, children, external operations and queued goal writers", async (t) => {
  for (const field of [
    "writerActive",
    "permissionPending",
    "childWriters",
    "externalOperation",
    "queuedGoalWriters",
  ]) {
    const f = await fixture({
      adapterPatch: {
        async preflight(args) {
          return { ...(await fixturePreflight(args)), [field]: true };
        },
      },
    });
    t.after(() => fs.rm(f.root, { recursive: true, force: true }));
    assert.equal((await f.core.run(request(f))).code, "unsafe_preflight", field);
    assert.deepEqual(f.calls, [], field);
  }
});

async function fixturePreflight({ contract }) {
  return {
    safe: true,
    writerActive: false,
    permissionPending: false,
    childWriters: false,
    externalOperation: false,
    queuedGoalWriters: false,
    restartCapacity: 1,
    sessionId: contract.sessionId,
    repoPath: contract.repoPath,
    sourceRevision: contract.sourceRevision,
    generation: contract.generation,
    runtime: contract.runtime,
  };
}

test("concurrent and duplicate triggers cannot duplicate the effect", async (t) => {
  let releaseCreate;
  const waiting = new Promise((resolve) => {
    releaseCreate = resolve;
  });
  const f = await fixture({
    adapterPatch: {
      async createPreparedSuccessor() {
        f.calls.push("create");
        await waiting;
        return { successorId: "new-session" };
      },
    },
  });
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const first = f.core.run(request(f));
  while (!f.calls.includes("create")) await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await f.core.run(request(f))).replay, true);
  releaseCreate();
  assert.equal((await first).ok, true);
  assert.equal((await f.core.run(request(f))).replay, true);
  assert.equal(f.calls.filter((call) => call === "create").length, 1);
});

test("create timeout and post-create interruption retain a reconcile-only journal", async (t) => {
  const timedOut = await fixture({
    adapterPatch: {
      async createPreparedSuccessor() {
        throw new Error("timeout");
      },
    },
  });
  t.after(() => fs.rm(timedOut.root, { recursive: true, force: true }));
  assert.equal((await timedOut.core.run(request(timedOut))).code, "create_uncertain");
  assert.equal((await timedOut.core.read(timedOut.operationId)).state, "create_uncertain");
  const afterCreate = await fixture({
    adapterPatch: {
      async readSuccessorReadiness() {
        throw new Error("process interrupted after create");
      },
    },
  });
  t.after(() => fs.rm(afterCreate.root, { recursive: true, force: true }));
  assert.equal((await afterCreate.core.run(request(afterCreate))).code, "readiness_uncertain");
  assert.equal((await afterCreate.core.read(afterCreate.operationId)).state, "prepared");
  assert.equal(
    (await afterCreate.core.reconcile(afterCreate.operationId)).code,
    "reconciliation_required",
  );
  assert.equal(afterCreate.calls.filter((call) => call === "create").length, 1);
});

test("readiness, activation and archive failures never claim liveness or completion", async (t) => {
  const notReady = await fixture({
    adapterPatch: {
      async readSuccessorReadiness() {
        return { ready: false };
      },
    },
  });
  const noLive = await fixture({
    adapterPatch: {
      async activateSuccessor() {
        return { active: true, liveness: "unknown" };
      },
    },
  });
  const archiveFail = await fixture({
    adapterPatch: {
      async archivePredecessor() {
        throw new Error("timeout");
      },
    },
  });
  for (const f of [notReady, noLive, archiveFail])
    t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  assert.equal((await notReady.core.run(request(notReady))).code, "successor_not_ready");
  assert.equal((await noLive.core.run(request(noLive))).code, "activation_unproven");
  assert.equal((await archiveFail.core.run(request(archiveFail))).code, "archive_uncertain");
  assert.equal((await archiveFail.core.read(archiveFail.operationId)).state, "archive_uncertain");
});

test("cancellation stops a pre-fence uncertain operation and reconcile budget blocks before retirement", async (t) => {
  const f = await fixture({
    adapterPatch: {
      async createPreparedSuccessor() {
        throw new Error("disconnect");
      },
    },
  });
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  await f.core.run(request(f));
  assert.equal((await f.core.cancel(f.operationId)).ok, true);
  assert.equal((await f.core.reconcile(f.operationId)).terminal, true);
  const b = await fixture({
    adapterPatch: {
      async createPreparedSuccessor() {
        throw new Error("disconnect");
      },
    },
  });
  t.after(() => fs.rm(b.root, { recursive: true, force: true }));
  await b.core.run(request(b));
  assert.equal((await b.core.reconcile(b.operationId)).code, "reconciliation_required");
  assert.equal((await b.core.reconcile(b.operationId)).code, "reconcile_budget_exhausted");
  assert.equal((await b.core.read(b.operationId)).state, "blocked");
});

test("restart capacity exhaustion blocks before creating, fencing or retiring the predecessor", async (t) => {
  const f = await fixture({
    adapterPatch: {
      async preflight(args) {
        return { ...(await fixturePreflight(args)), restartCapacity: 0 };
      },
    },
  });
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  assert.equal((await f.core.run(request(f))).code, "unsafe_preflight");
  assert.deepEqual(f.calls, []);
  assert.equal((await f.core.read(f.operationId)).state, "blocked");
});

test("usage latches only a fresh strictly above-40 session sample once per generation", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "seat-rotation-usage-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new UsageLatchStore({ journalRoot: root, maxAgeMs: 1_000 });
  const common = { seatId: "fable-seat", generation: 1, activeSessionId: "session-a", now: 10_000 };
  assert.deepEqual(
    await store.observe({
      ...common,
      sample: { sessionId: "session-a", used: 40, limit: 100, observedAt: 9_999 },
    }),
    { active: true, latched: false, reason: "below_or_equal_threshold" },
  );
  assert.equal(
    (
      await store.observe({
        ...common,
        sample: { sessionId: "session-a", used: 41, limit: 100, observedAt: 9_999 },
      })
    ).reason,
    "threshold_latched",
  );
  assert.equal(
    (
      await store.observe({
        ...common,
        sample: { sessionId: "session-a", used: 1, limit: 100, observedAt: 9_999 },
      })
    ).reason,
    "already_latched",
  );
  assert.equal(
    (
      await store.observe({
        ...common,
        activeSessionId: "session-b",
        sample: { sessionId: "session-a", used: 90, limit: 100, observedAt: 9_999 },
      })
    ).reason,
    "invalid_or_stale_sample",
  );
  assert.equal(
    (
      await store.observe({
        ...common,
        generation: 2,
        sample: { sessionId: "session-a", used: 90, limit: 100, observedAt: 8_000 },
      })
    ).reason,
    "invalid_or_stale_sample",
  );
  assert.equal(
    (
      await store.observe({
        ...common,
        generation: 2,
        sample: { sessionId: "session-a", used: "bad", limit: 100, observedAt: 9_999 },
      })
    ).reason,
    "invalid_or_stale_sample",
  );
});

test("a fresh successor immediate retrigger with no task progress is blocked without a new rotation", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  assert.equal((await f.core.run(request(f))).ok, true);
  const stale = await f.core.observeSuccessorUsage({
    operationId: f.operationId,
    now: 10_000,
    progress: { completedActions: 0 },
    sample: { sessionId: "old-session", used: 90, limit: 100, observedAt: 9_999 },
  });
  assert.equal(stale.observed.reason, "invalid_or_stale_sample");
  const retrigger = await f.core.observeSuccessorUsage({
    operationId: f.operationId,
    now: 10_000,
    progress: { completedActions: 0 },
    sample: { sessionId: "new-session", used: 41, limit: 100, observedAt: 9_999 },
  });
  assert.equal(retrigger.code, "no_progress_immediate_retrigger");
  assert.equal((await f.core.read(f.operationId)).state, "blocked");
  assert.equal(f.calls.filter((call) => call === "create").length, 1);
});
