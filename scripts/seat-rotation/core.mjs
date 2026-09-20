import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const STATES = new Set([
  "requested",
  "preflighted",
  "create_uncertain",
  "prepared",
  "ready",
  "fenced",
  "archived",
  "activated",
  "archive_uncertain",
  "completed",
  "cancelled",
  "cancelled_after_fence",
  "blocked",
]);

function fail(code, detail = undefined) {
  return { ok: false, code, ...(detail === undefined ? {} : { detail }) };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function safeId(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,160}$/.test(value)) {
    throw new Error(`${label} must be a safe identifier`);
  }
}

async function fsyncDirectory(directory) {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeJsonDurably(filePath, value) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, filePath);
    await fsyncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function realExistingPath(value, label) {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be absolute`);
  return fs.realpath(value);
}

async function refuseSymlinks(value) {
  const resolved = path.resolve(value);
  const pieces = resolved.split(path.sep).filter(Boolean);
  let current = path.parse(resolved).root;
  for (const piece of pieces) {
    current = path.join(current, piece);
    const entry = await fs.lstat(current);
    if (entry.isSymbolicLink()) throw new Error(`symlink refused: ${current}`);
  }
}

// oxlint-disable-next-line eslint(complexity) -- one checkpoint contract is audited as one fail-closed boundary.
async function checkpointContract(request) {
  const contract = request.contract;
  if (!contract || typeof contract !== "object") throw new Error("missing checkpoint contract");
  safeId(request.operationId, "operationId");
  safeId(request.predecessorId, "predecessorId");
  safeId(contract.sessionId, "sessionId");
  if (!Number.isSafeInteger(contract.generation) || contract.generation < 1) {
    throw new Error("generation must be a positive integer");
  }
  if (!/^[a-f0-9]{7,64}$/i.test(contract.sourceRevision ?? "")) {
    throw new Error("sourceRevision must be a git revision");
  }
  if (!/^[a-f0-9]{64}$/i.test(contract.checkpointHash ?? "")) {
    throw new Error("checkpointHash must be sha256");
  }
  // A Git revision alone says nothing about uncommitted writes. Until the
  // native operation has a recorded dirty-tree fingerprint it supports only a
  // positively clean checkpoint contract.
  if (contract.dirtyDisposition !== "clean") {
    throw new Error("dirty worktree rotation is unsupported");
  }
  if (
    !contract.runtime ||
    typeof contract.runtime !== "object" ||
    Array.isArray(contract.runtime)
  ) {
    throw new Error("runtime contract is required");
  }

  // Inspect the caller-provided path before realpath: checking only the
  // resolved path would silently accept a symlinked handover root.
  await Promise.all([
    refuseSymlinks(request.handoverRoot),
    refuseSymlinks(contract.repoPath),
    refuseSymlinks(contract.checkpointPath),
  ]);
  const [handoverRoot, repoPath] = await Promise.all([
    realExistingPath(request.handoverRoot, "handoverRoot"),
    realExistingPath(contract.repoPath, "repoPath"),
  ]);
  const checkpointPath = await realExistingPath(contract.checkpointPath, "checkpointPath");
  const handoverInRepo = path.relative(repoPath, handoverRoot);
  if (handoverInRepo.startsWith(`..${path.sep}`) || path.isAbsolute(handoverInRepo)) {
    throw new Error("handoverRoot is outside the agent repository");
  }
  const relative = path.relative(handoverRoot, checkpointPath);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("checkpoint is outside handoverRoot");
  }
  const raw = await fs.readFile(checkpointPath);
  const checkpointHash = createHash("sha256").update(raw).digest("hex");
  if (checkpointHash !== contract.checkpointHash) throw new Error("checkpoint hash mismatch");
  const checkpoint = JSON.parse(raw.toString("utf8"));
  if (
    checkpoint.operationId !== request.operationId ||
    checkpoint.generation !== contract.generation ||
    checkpoint.sessionId !== contract.sessionId ||
    checkpoint.repoPath !== repoPath ||
    checkpoint.sourceRevision !== contract.sourceRevision ||
    checkpoint.dirtyDisposition !== "clean" ||
    typeof checkpoint.nextAction !== "string" ||
    checkpoint.nextAction.length === 0 ||
    "command" in checkpoint ||
    "shell" in checkpoint
  ) {
    throw new Error("checkpoint contents do not match contract");
  }
  return { ...contract, repoPath, checkpointPath, checkpointHash };
}

export class SeatRotationCore {
  constructor({ journalRoot, adapter, maxReconcileAttempts = 2, usageLatchStore = undefined }) {
    this.journalRoot = journalRoot;
    this.adapter = adapter;
    this.maxReconcileAttempts = maxReconcileAttempts;
    this.usageLatchStore = usageLatchStore;
  }

  journalPath(operationId) {
    safeId(operationId, "operationId");
    return path.join(this.journalRoot, "operations", `${operationId}.json`);
  }

  async read(operationId) {
    try {
      return await readJson(this.journalPath(operationId));
    } catch (error) {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async #write(journal) {
    if (!STATES.has(journal.state)) throw new Error(`invalid journal state ${journal.state}`);
    journal.updatedAt = new Date().toISOString();
    await writeJsonDurably(this.journalPath(journal.operationId), journal);
    return journal;
  }

  cancellationPath(operationId) {
    safeId(operationId, "operationId");
    return path.join(this.journalRoot, "cancellations", `${operationId}.json`);
  }

  async #cancellation(operationId) {
    try {
      return await readJson(this.cancellationPath(operationId));
    } catch (error) {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async #honourCancellation(journal) {
    if (!(await this.#cancellation(journal.operationId))) return false;
    if (journal.state === "completed") return false;
    if (["fenced", "archived", "activated", "archive_uncertain"].includes(journal.state)) {
      try {
        const stopped = await this.adapter.stopSuccessor?.({
          successorId: journal.successorId,
          operationId: journal.operationId,
          state: journal.state,
        });
        if (stopped?.stopped !== true) throw new Error("successor stop was not acknowledged");
      } catch (error) {
        journal.error = `successor stop uncertain: ${error.message}`;
        await this.#write(journal);
        return fail("cancellation_uncertain", journal.error);
      }
      journal.state = "cancelled_after_fence";
    } else {
      journal.state = "cancelled";
    }
    journal.cancelledAt = new Date().toISOString();
    await this.#write(journal);
    return fail("cancelled", journal.state);
  }

  async #lock(predecessorId, generation) {
    // The operation lock serialises retries of one request. The generation lock
    // is the admission fence: a different request must not retire the same
    // predecessor generation while this request is unresolved.
    const directory = path.join(
      this.journalRoot,
      "locks",
      "generations",
      `${predecessorId}.${generation}.lock`,
    );
    try {
      await fs.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
      await fs.mkdir(directory, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (error.code === "EEXIST") return undefined;
      throw error;
    }
    return async () => fs.rm(directory, { recursive: true, force: true });
  }

  // oxlint-disable-next-line eslint(complexity) -- ordered uncertainty states are intentionally visible in this reference flow.
  async run(request) {
    let existing = await this.read(request.operationId);
    if (existing) return { ok: existing.state === "completed", replay: true, operation: existing };
    let contract;
    try {
      contract = await checkpointContract(request);
    } catch (error) {
      return fail("invalid_checkpoint", error.message);
    }
    const release = await this.#lock(request.predecessorId, contract.generation);
    if (!release) return fail("predecessor_generation_locked");
    try {
      existing = await this.read(request.operationId);
      if (existing)
        return { ok: existing.state === "completed", replay: true, operation: existing };
      let journal = await this.#write({
        version: 1,
        operationId: request.operationId,
        predecessorId: request.predecessorId,
        contract,
        state: "requested",
        reconcileAttempts: 0,
        effects: [],
      });
      const initiallyCancelled = await this.#honourCancellation(journal);
      if (initiallyCancelled) return initiallyCancelled;
      let safety;
      try {
        safety = await this.adapter.preflight({ predecessorId: request.predecessorId, contract });
      } catch (error) {
        journal.state = "blocked";
        journal.error = `preflight uncertain: ${error.message}`;
        await this.#write(journal);
        return fail("preflight_uncertain", journal.error);
      }
      const unsafe =
        safety?.safe !== true ||
        safety.writerActive !== false ||
        safety.permissionPending !== false ||
        safety.childWriters !== false ||
        safety.externalOperation !== false ||
        safety.queuedGoalWriters !== false ||
        !Number.isSafeInteger(safety.restartCapacity) ||
        safety.restartCapacity < 1 ||
        safety.sessionId !== contract.sessionId ||
        safety.repoPath !== contract.repoPath ||
        safety.sourceRevision !== contract.sourceRevision ||
        safety.generation !== contract.generation ||
        !sameJson(safety.runtime, contract.runtime);
      if (unsafe) {
        journal.state = "blocked";
        journal.error = "preflight safety or ownership mismatch";
        await this.#write(journal);
        return fail("unsafe_preflight", journal.error);
      }
      let source;
      try {
        source = await this.adapter.readSourceSnapshot({ repoPath: contract.repoPath });
      } catch (error) {
        journal.state = "blocked";
        journal.error = `source snapshot uncertain: ${error.message}`;
        await this.#write(journal);
        return fail("source_snapshot_uncertain", journal.error);
      }
      if (
        source?.repoPath !== contract.repoPath ||
        source?.sourceRevision !== contract.sourceRevision ||
        source?.dirtyDisposition !== "clean"
      ) {
        journal.state = "blocked";
        journal.error = "source snapshot no longer matches the clean checkpoint";
        await this.#write(journal);
        return fail("source_snapshot_mismatch", journal.error);
      }
      journal.state = "preflighted";
      await this.#write(journal);
      const preCreateCancellation = await this.#honourCancellation(journal);
      if (preCreateCancellation) return preCreateCancellation;
      let created;
      try {
        created = await this.adapter.createPreparedSuccessor({
          idempotencyKey: request.operationId,
          contract,
        });
      } catch (error) {
        journal.state = "create_uncertain";
        journal.error = `create uncertain: ${error.message}`;
        await this.#write(journal);
        return fail("create_uncertain", journal.error);
      }
      if (!created?.successorId) {
        journal.state = "create_uncertain";
        journal.error = "create returned no successor identity";
        await this.#write(journal);
        return fail("create_uncertain", journal.error);
      }
      journal.successorId = created.successorId;
      journal.effects.push("prepared_successor_created");
      journal.state = "prepared";
      await this.#write(journal);
      const preparedCancellation = await this.#honourCancellation(journal);
      if (preparedCancellation) return preparedCancellation;
      let readiness;
      try {
        readiness = await this.adapter.readSuccessorReadiness({
          successorId: journal.successorId,
          contract,
        });
      } catch (error) {
        journal.error = `readiness uncertain: ${error.message}`;
        await this.#write(journal);
        return fail("readiness_uncertain", journal.error);
      }
      if (
        readiness?.ready !== true ||
        readiness.prepared !== true ||
        readiness.readCheckpoint !== true ||
        readiness.repoPath !== contract.repoPath ||
        readiness.sourceRevision !== contract.sourceRevision ||
        readiness.checkpointHash !== contract.checkpointHash ||
        readiness.sessionId === contract.sessionId ||
        !sameJson(readiness.runtime, contract.runtime)
      ) {
        journal.error = "successor readiness cannot establish a distinct prepared session";
        await this.#write(journal);
        return fail("successor_not_ready", journal.error);
      }
      journal.state = "ready";
      journal.successorSessionId = readiness.sessionId;
      journal.successorGeneration = contract.generation + 1;
      await this.#write(journal);
      const readyCancellation = await this.#honourCancellation(journal);
      if (readyCancellation) return readyCancellation;
      let fence;
      try {
        fence = await this.adapter.fencePredecessor({
          predecessorId: request.predecessorId,
          operationId: request.operationId,
        });
      } catch (error) {
        journal.error = `fence uncertain: ${error.message}`;
        await this.#write(journal);
        return fail("fence_uncertain", journal.error);
      }
      if (fence?.fenced !== true) {
        journal.error = "predecessor fence not established";
        await this.#write(journal);
        return fail("fence_failed", journal.error);
      }
      journal.effects.push("predecessor_fenced");
      journal.state = "fenced";
      await this.#write(journal);
      const fencedCancellation = await this.#honourCancellation(journal);
      if (fencedCancellation) return fencedCancellation;
      try {
        const archived = await this.adapter.archivePredecessor({
          predecessorId: request.predecessorId,
          operationId: request.operationId,
        });
        if (archived?.archived !== true) throw new Error("archive not acknowledged");
      } catch (error) {
        journal.state = "archive_uncertain";
        journal.error = `archive uncertain: ${error.message}`;
        await this.#write(journal);
        return fail("archive_uncertain", journal.error);
      }
      journal.effects.push("predecessor_archived");
      journal.state = "archived";
      await this.#write(journal);
      const archivedCancellation = await this.#honourCancellation(journal);
      if (archivedCancellation) return archivedCancellation;
      let activation;
      try {
        activation = await this.adapter.activateSuccessor({
          successorId: journal.successorId,
          operationId: request.operationId,
        });
      } catch (error) {
        journal.error = `activation uncertain: ${error.message}`;
        await this.#write(journal);
        return fail("activation_uncertain", journal.error);
      }
      if (activation?.active !== true || activation.liveness !== "established") {
        journal.error = "successor liveness was not established";
        await this.#write(journal);
        return fail("activation_unproven", journal.error);
      }
      journal.effects.push("successor_activated");
      journal.state = "activated";
      await this.#write(journal);
      const activatedCancellation = await this.#honourCancellation(journal);
      if (activatedCancellation) return activatedCancellation;
      journal.state = "completed";
      await this.#write(journal);
      return { ok: true, replay: false, operation: journal };
    } finally {
      await release();
    }
  }

  async cancel(operationId) {
    const journal = await this.read(operationId);
    if (!journal) return fail("operation_missing");
    if (journal.state === "completed") return fail("cancellation_unsafe", journal.state);
    // Do not race the operation journal. This sidecar is a durable, monotonic
    // Stop latch; the running operation observes it before activation and after
    // every awaited irreversible call.
    await writeJsonDurably(this.cancellationPath(operationId), {
      operationId,
      requestedAt: new Date().toISOString(),
    });
    const result = await this.#honourCancellation(journal);
    return result?.code === "cancelled"
      ? { ok: true, operation: await this.read(operationId) }
      : { ok: true, cancellationRequested: true, operation: journal };
  }

  async reconcile(operationId) {
    const journal = await this.read(operationId);
    if (!journal) return fail("operation_missing");
    if (["completed", "cancelled", "cancelled_after_fence"].includes(journal.state))
      return { ok: true, terminal: true, operation: journal };
    if (journal.reconcileAttempts >= this.maxReconcileAttempts) {
      journal.state = "blocked";
      journal.error = "reconcile budget exhausted before safe retirement";
      await this.#write(journal);
      return fail("reconcile_budget_exhausted", journal.error);
    }
    journal.reconcileAttempts += 1;
    try {
      const result = await this.adapter.reconcile({ operation: journal });
      journal.reconcile = result ?? { known: false };
    } catch (error) {
      journal.reconcile = { known: false, error: error.message };
    }
    await this.#write(journal);
    return { ok: false, code: "reconciliation_required", operation: journal };
  }

  async observeSuccessorUsage({ operationId, sample, now, progress }) {
    const journal = await this.read(operationId);
    if (!journal?.successorId || !journal.successorSessionId) return fail("successor_unavailable");
    if (!this.usageLatchStore) return fail("usage_latch_store_unavailable");
    const observed = await this.usageLatchStore.observe({
      seatId: journal.successorId,
      generation: journal.successorGeneration,
      activeSessionId: journal.successorSessionId,
      sample,
      now,
    });
    if (!observed.latched) return { ok: true, observed, operation: journal };
    if (!Number.isSafeInteger(progress?.completedActions) || progress.completedActions < 1) {
      journal.state = "blocked";
      journal.error = "no progress: successor immediately retriggered rotation";
      journal.immediateRetrigger = { sample, observedAt: now };
      await this.#write(journal);
      return fail("no_progress_immediate_retrigger", journal.error);
    }
    return { ok: true, observed, operation: journal };
  }
}

export class UsageLatchStore {
  constructor({ journalRoot, maxAgeMs }) {
    this.journalRoot = journalRoot;
    this.maxAgeMs = maxAgeMs;
  }

  #path(seatId, generation) {
    safeId(seatId, "seatId");
    if (!Number.isSafeInteger(generation) || generation < 1)
      throw new Error("generation must be positive");
    return path.join(this.journalRoot, "usage-latches", `${seatId}.${generation}.json`);
  }

  async observe({ seatId, generation, activeSessionId, sample, now }) {
    safeId(activeSessionId, "activeSessionId");
    const valid =
      sample &&
      sample.sessionId === activeSessionId &&
      Number.isFinite(sample.used) &&
      Number.isFinite(sample.limit) &&
      sample.limit > 0 &&
      Number.isFinite(sample.observedAt) &&
      sample.observedAt <= now &&
      now - sample.observedAt <= this.maxAgeMs;
    if (!valid) return { active: false, latched: false, reason: "invalid_or_stale_sample" };
    const priorPath = this.#path(seatId, generation);
    try {
      const prior = await readJson(priorPath);
      if (prior.sessionId === activeSessionId)
        return { active: true, latched: true, reason: "already_latched" };
      return { active: false, latched: false, reason: "session_reset" };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (sample.used / sample.limit <= 0.4)
      return { active: true, latched: false, reason: "below_or_equal_threshold" };
    const latch = { version: 1, seatId, generation, sessionId: activeSessionId, sample };
    await writeJsonDurably(priorPath, latch);
    return { active: true, latched: true, reason: "threshold_latched" };
  }
}
