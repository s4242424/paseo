import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "./agent-sdk-types.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const roots: string[] = [];
const daemons: TestPaseoDaemon[] = [];
const clients: DaemonClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(daemons.splice(0).map((daemon) => daemon.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setupActual(
  input: {
    earlySuccessorUsage?: boolean;
    paseoHomeRoot?: string;
    cleanup?: boolean;
  } = {},
) {
  const root =
    input.paseoHomeRoot ?? (await mkdtemp(path.join(os.tmpdir(), "seat-rotation-policy-actual-")));
  if (!input.paseoHomeRoot) roots.push(root);
  const repo = path.join(root, "repo");
  const handoverRoot = path.join(repo, ".handover");
  const checkpointPath = path.join(handoverRoot, "checkpoint.json");
  const witnessPath = path.join(handoverRoot, "progress.txt");
  await mkdir(handoverRoot, { recursive: true });
  await writeFile(path.join(repo, "README.md"), "fixture\n");
  await writeFile(path.join(repo, ".gitignore"), ".handover/progress.txt\n");
  await writeFile(witnessPath, "initial\n");
  execFileSync("git", ["init", "--quiet", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repo, "add", "README.md", ".gitignore"]);
  execFileSync("git", ["-C", repo, "commit", "--quiet", "-m", "fixture"]);
  const repoPath = await realpath(repo);
  const revision = execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const provider = new ControlledClient(
    { checkpointPath, repoPath, revision },
    { earlySuccessorUsage: input.earlySuccessorUsage },
  );
  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot: input.paseoHomeRoot ?? root,
    cleanup: input.cleanup ?? !input.paseoHomeRoot,
    enableNativeSeatRotation: true,
    seatRotationPolicy: {
      enabled: true,
      seats: [
        {
          seatId: "integration-seat",
          repositoryPath: repoPath,
          handoverRoot,
          checkpointPath,
          progressWitnessPath: witnessPath,
          resumePrompt: "Read the checkpoint and continue.",
          goalContinuation: "checkpoint_only",
        },
      ],
    },
    agentClients: { codex: provider },
  });
  daemons.push(daemon);
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  clients.push(client);
  await client.connect();
  await client.fetchAgents({ subscribe: { subscriptionId: "policy-actual" } });
  const predecessor = await client.createAgent({ provider: "codex", cwd: repoPath });
  await daemon.daemon.agentManager.setLabels(predecessor.id, {
    "paseo.seat-id": "integration-seat",
  });
  return {
    checkpointPath,
    client,
    daemon,
    handoverRoot,
    predecessor,
    provider,
    repoPath,
    root,
    witnessPath,
  };
}

test("real daemon manager hands a busy valid observation through preparation and native rotation", async () => {
  const { checkpointPath, client, daemon, predecessor, provider } = await setupActual();

  await client.sendMessage(predecessor.id, "continue current work");
  await vi.waitFor(() =>
    expect(daemon.daemon.agentManager.getAgent(predecessor.id)?.lifecycle).toBe("running"),
  );
  const source = provider.sessions.at(-1)!;
  await source.emitUsage(41, 100);
  expect(provider.preparationPrompts).toHaveLength(0);
  await source.complete();

  await vi.waitFor(() => expect(provider.preparationPrompts).toHaveLength(1));
  await vi.waitFor(async () => {
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")) as {
      timelineRevision?: number;
    };
    expect(checkpoint.timelineRevision).toBeGreaterThanOrEqual(0);
  });
  const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")) as { operationId: string };
  await vi.waitFor(async () => {
    const policyState = await client.inspectAgentSeatRotationPolicy(predecessor.id);
    if (policyState.phase !== "native_handoff") throw new Error(JSON.stringify(policyState));
    await expect(client.inspectAgentSeatRotation(checkpoint.operationId)).resolves.toMatchObject({
      phase: "succeeded",
    });
  });
  expect(provider.sessions).toHaveLength(2);
  expect(daemon.daemon.agentManager.getAgent(predecessor.id)).toBeNull();
});

test("an early high successor event is progress-gated before policy rotation returns", async () => {
  const { checkpointPath, client, daemon, predecessor, provider } = await setupActual({
    earlySuccessorUsage: true,
  });
  await client.sendMessage(predecessor.id, "continue current work");
  await vi.waitFor(() =>
    expect(daemon.daemon.agentManager.getAgent(predecessor.id)?.lifecycle).toBe("running"),
  );
  await provider.sessions.at(-1)!.emitUsage(41, 100);
  await provider.sessions.at(-1)!.complete();
  await vi.waitFor(async () => {
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")) as {
      operationId: string;
    };
    const operation = await client.inspectAgentSeatRotation(checkpoint.operationId);
    expect(operation.phase).toBe("succeeded");
    expect(operation.successorId).toEqual(expect.any(String));
    await expect(
      client.inspectAgentSeatRotationPolicy(operation.successorId!),
    ).resolves.toMatchObject({
      phase: "blocked",
      reason: "no_progress_immediate_retrigger",
    });
  });
  expect(provider.preparationPrompts).toHaveLength(1);
});

test("actual manager rejects high observations without provider-confirmed provenance", async () => {
  const { client, daemon, predecessor, provider } = await setupActual();
  await client.sendMessage(predecessor.id, "continue current work");
  await vi.waitFor(() =>
    expect(daemon.daemon.agentManager.getAgent(predecessor.id)?.lifecycle).toBe("running"),
  );
  await provider.sessions.at(-1)!.emitUsage(41, 100, "catalog-fallback");
  await provider.sessions.at(-1)!.complete();
  await vi.waitFor(() =>
    expect(daemon.daemon.agentManager.getAgent(predecessor.id)?.lifecycle).toBe("idle"),
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(provider.preparationPrompts).toHaveLength(0);
  await expect(client.inspectAgentSeatRotationPolicy(predecessor.id)).resolves.toMatchObject({
    phase: "inactive",
  });
});

test("normal Stop makes a latched policy terminal before a later high observation", async () => {
  const { client, daemon, predecessor, provider } = await setupActual();
  await client.sendMessage(predecessor.id, "continue current work");
  await vi.waitFor(() =>
    expect(daemon.daemon.agentManager.getAgent(predecessor.id)?.lifecycle).toBe("running"),
  );
  await provider.sessions.at(-1)!.emitUsage(41, 100);
  await vi.waitFor(async () => {
    await expect(client.inspectAgentSeatRotationPolicy(predecessor.id)).resolves.toMatchObject({
      phase: "latched",
    });
  });
  await client.cancelAgent(predecessor.id);
  await vi.waitFor(async () => {
    await expect(client.inspectAgentSeatRotationPolicy(predecessor.id)).resolves.toMatchObject({
      phase: "cancelled",
    });
  });
  await client.sendMessage(predecessor.id, "continue after Stop");
  await vi.waitFor(() =>
    expect(daemon.daemon.agentManager.getAgent(predecessor.id)?.lifecycle).toBe("running"),
  );
  await provider.sessions.at(-1)!.emitUsage(41, 100);
  await provider.sessions.at(-1)!.complete();
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(provider.preparationPrompts).toHaveLength(0);
});

test("daemon restart restores a successor progress gate before replayed state", async () => {
  const f = await setupActual({ cleanup: false });
  await f.client.sendMessage(f.predecessor.id, "continue current work");
  await vi.waitFor(() =>
    expect(f.daemon.daemon.agentManager.getAgent(f.predecessor.id)?.lifecycle).toBe("running"),
  );
  await f.provider.sessions.at(-1)!.emitUsage(41, 100);
  await f.provider.sessions.at(-1)!.complete();
  let checkpoint: { operationId: string; successorId: string } | undefined;
  await vi.waitFor(async () => {
    const value = JSON.parse(await readFile(f.checkpointPath, "utf8")) as { operationId: string };
    const operation = await f.client.inspectAgentSeatRotation(value.operationId);
    expect(operation.phase).toBe("succeeded");
    expect(operation.successorId).toEqual(expect.any(String));
    checkpoint = { operationId: value.operationId, successorId: operation.successorId! };
  });
  const successorId = checkpoint!.successorId;
  await vi.waitFor(async () => {
    await expect(f.client.inspectAgentSeatRotationPolicy(f.predecessor.id)).resolves.toMatchObject({
      phase: "native_handoff",
    });
  });
  clients.splice(clients.indexOf(f.client), 1);
  daemons.splice(daemons.indexOf(f.daemon), 1);
  await f.client.close();
  await f.daemon.close();

  const restarted = await createTestPaseoDaemon({
    paseoHomeRoot: f.root,
    cleanup: false,
    enableNativeSeatRotation: true,
    seatRotationPolicy: {
      enabled: true,
      seats: [
        {
          seatId: "integration-seat",
          repositoryPath: f.repoPath,
          handoverRoot: f.handoverRoot,
          checkpointPath: f.checkpointPath,
          progressWitnessPath: f.witnessPath,
          resumePrompt: "Read the checkpoint and continue.",
          goalContinuation: "checkpoint_only",
        },
      ],
    },
    agentClients: { codex: f.provider },
  });
  daemons.push(restarted);
  const client = new DaemonClient({ url: `ws://127.0.0.1:${restarted.port}/ws` });
  clients.push(client);
  await client.connect();
  await client.fetchAgents({ subscribe: { subscriptionId: "policy-restart" } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await client.refreshAgent(successorId);
  await vi.waitFor(() =>
    expect(restarted.daemon.agentManager.getAgent(successorId)).not.toBeNull(),
  );
  await client.sendMessage(successorId, "continue current work");
  await vi.waitFor(() =>
    expect(restarted.daemon.agentManager.getAgent(successorId)?.lifecycle).toBe("running"),
  );
  const activeSession = f.provider.sessions.find((session) => session.hasActiveTurn());
  expect(activeSession).toBeDefined();
  await activeSession!.emitUsage(41, 100);
  await vi.waitFor(() =>
    expect(
      restarted.daemon.agentManager.getAgent(successorId)?.lastUsage?.contextWindowObservation
        ?.usedTokens,
    ).toBe(41),
  );
  expect(
    restarted.daemon.agentManager.getAgent(successorId)?.lastUsage?.contextWindowObservation
      ?.sessionId,
  ).toBe(restarted.daemon.agentManager.getAgent(successorId)?.runtimeInfo?.sessionId);
  expect(
    restarted.daemon.agentManager.getAgent(successorId)?.lastUsage?.contextWindowObservation
      ?.turnId,
  ).toBe(restarted.daemon.agentManager.getAgent(successorId)?.activeForegroundTurnId);
  await activeSession!.complete();
  await vi.waitFor(async () => {
    await expect(client.inspectAgentSeatRotationPolicy(successorId)).resolves.toMatchObject({
      phase: "blocked",
      reason: "no_progress_immediate_retrigger",
    });
  });
  expect(f.provider.preparationPrompts).toHaveLength(1);
});

const capabilities: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
};

class ControlledClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = capabilities;
  readonly sessions: ControlledSession[] = [];
  readonly preparationPrompts: string[] = [];

  constructor(
    private readonly checkpoint: { checkpointPath: string; repoPath: string; revision: string },
    private readonly options: { earlySuccessorUsage?: boolean } = {},
  ) {}

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const session = new ControlledSession(config, this, this.options);
    this.sessions.push(session);
    return session;
  }

  async resumeSession(
    _handle: AgentPersistenceHandle,
    config?: Partial<AgentSessionConfig>,
  ): Promise<AgentSession> {
    return await this.createSession({
      provider: "codex",
      cwd: config?.cwd ?? this.checkpoint.repoPath,
    });
  }

  async fetchCatalog() {
    return { models: [], modes: [] };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async prepare(prompt: string, sessionId: string): Promise<void> {
    this.preparationPrompts.push(prompt);
    const operationId = /operationId ([a-f0-9-]{36})/.exec(prompt)?.[1];
    const generation = Number(/generation (\d+)/.exec(prompt)?.[1]);
    if (!operationId || !Number.isInteger(generation))
      throw new Error("policy preparation prompt missing identity");
    await writeFile(
      this.checkpoint.checkpointPath,
      JSON.stringify({
        operationId,
        generation,
        sessionId,
        repoPath: this.checkpoint.repoPath,
        sourceRevision: this.checkpoint.revision,
        timelineRevision: 0,
        dirtyDisposition: "clean",
        nextAction: "continue",
      }),
    );
  }
}

class ControlledSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly id = crypto.randomUUID();
  readonly capabilities = capabilities;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private activeTurnId: string | null = null;
  private nextTurn = 0;

  constructor(
    private readonly config: AgentSessionConfig,
    private readonly client: ControlledClient,
    private readonly options: { earlySuccessorUsage?: boolean },
  ) {}

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    const turnId = `turn-${++this.nextTurn}`;
    this.activeTurnId = turnId;
    this.emit({ type: "turn_started", provider: this.provider, turnId });
    if (typeof prompt === "string" && prompt.startsWith("Prepare the repository")) {
      await this.client.prepare(prompt, this.id);
      queueMicrotask(() => void this.complete());
    }
    if (typeof prompt === "string" && prompt.startsWith("Read the checkpoint")) {
      if (this.options.earlySuccessorUsage) await this.emitUsage(41, 100);
      queueMicrotask(() => void this.complete());
    }
    return { turnId };
  }

  async emitUsage(
    usedTokens: number,
    maxTokens: number,
    contextWindowSource: "provider-confirmed" | "catalog-fallback" = "provider-confirmed",
  ): Promise<void> {
    if (!this.activeTurnId) throw new Error("no active turn");
    this.emit({
      type: "usage_updated",
      provider: this.provider,
      usage: {
        contextWindowObservation: {
          sessionId: this.id,
          turnId: this.activeTurnId,
          observedAt: new Date().toISOString(),
          contextWindowSource,
          usedTokens,
          maxTokens,
        },
      },
    });
  }

  async complete(): Promise<void> {
    if (!this.activeTurnId) return;
    const turnId = this.activeTurnId;
    this.activeTurnId = null;
    this.emit({ type: "turn_completed", provider: this.provider, turnId });
  }

  hasActiveTurn(): boolean {
    return this.activeTurnId !== null;
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}
  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id, model: null, modeId: null };
  }
  async getAvailableModes() {
    return [];
  }
  async getCurrentMode() {
    return null;
  }
  async setMode(): Promise<void> {}
  getPendingPermissions() {
    return [];
  }
  async respondToPermission(): Promise<void> {}
  describePersistence() {
    return { provider: this.provider, sessionId: this.id };
  }
  async interrupt(): Promise<void> {
    await this.complete();
  }
  async close(): Promise<void> {}

  private emit(event: AgentStreamEvent): void {
    for (const subscriber of this.subscribers) subscriber(event);
  }
}
