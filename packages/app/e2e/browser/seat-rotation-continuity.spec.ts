import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";
import { test } from "../support/fixtures";
import {
  clickSessionRow,
  createMockIdleAgent,
  expectArchivedAgentFocused,
  expectSessionRowVisible,
  expectWorkspaceTabHidden,
  expectWorkspaceTabVisible,
  openSessions,
  openWorkspaceWithAgents,
  reloadWorkspace,
} from "../support/helpers/archive-tab";
import { expectAgentTabActive, getTabTestIds } from "../support/helpers/launcher";
import { getServerId } from "../support/helpers/server-id";
import { createTempGitRepo } from "../support/helpers/workspace";
import { waitForWorkspaceInSidebar } from "../support/helpers/workspace-ui";

test.use({ e2eDaemonConfig: { version: 1, daemon: { enableNativeSeatRotation: true } } });

interface RotationClient {
  fetchAgents(): Promise<{
    entries: Array<{ agent: { id: string; persistence: { sessionId: string } | null } }>;
  }>;
  fetchAgentTimeline(
    agentId: string,
    options: { direction: "tail"; projection: "canonical"; limit: number },
  ): Promise<{ window: { maxSeq: number } }>;
  fetchAgentHistory(options: {
    page: { limit: number };
  }): Promise<{ entries: Array<{ agent: { id: string; workspaceId?: string | null } }> }>;
  fetchWorkspaces(): Promise<{ entries: Array<{ id: string }> }>;
  rotateAgentSeat(input: {
    operationId: string;
    predecessorId: string;
    generation: number;
    handoverRoot: string;
    checkpointPath: string;
    resumePrompt: string;
  }): Promise<{ successorId: string | null }>;
}

test.describe("Seat rotation continuity", () => {
  test.describe.configure({ timeout: 300_000 });

  test("retargets one visible tab after a durable native successor, including its later idle state", async ({
    page,
    e2eWorkerClient,
  }) => {
    const repo = await createTempGitRepo("seat-rotation-browser-");
    const client = e2eWorkerClient as unknown as RotationClient & typeof e2eWorkerClient;
    const created = await client.createWorkspace({
      source: { kind: "directory", path: repo.path },
    });
    if (!created.workspace)
      throw new Error(created.error ?? "Could not create seat-rotation workspace.");
    const workspace = created.workspace;
    const predecessor = await createMockIdleAgent(client, {
      cwd: repo.path,
      workspaceId: workspace.id,
      title: "rotating-predecessor",
    });
    const control = await createMockIdleAgent(client, {
      cwd: repo.path,
      workspaceId: workspace.id,
      title: "rotation-control",
    });
    const historicalPrompt = "Keep this predecessor history readable.";

    try {
      await openWorkspaceWithAgents(page, [control, predecessor]);
      await expectAgentTabActive(page, predecessor.id);
      await client.sendAgentMessage(predecessor.id, historicalPrompt);
      await client.waitForFinish(predecessor.id, 30_000);

      const successorId = await rotateFromBrowserFixture(client, predecessor.id, repo.path);
      await expectWorkspaceTabVisible(page, successorId);
      await expectAgentTabActive(page, successorId);
      await expectWorkspaceTabHidden(page, predecessor.id);

      const tabIds = await getTabTestIds(page);
      expect(tabIds.filter((id) => id === `workspace-tab-agent_${successorId}`)).toHaveLength(1);
      expect(tabIds.filter((id) => id === `workspace-tab-agent_${predecessor.id}`)).toHaveLength(0);

      await reloadWorkspace(page, workspace.id);
      await waitForWorkspaceInSidebar(page, {
        serverId: getServerId(),
        workspaceId: workspace.id,
      });
      await expectWorkspaceTabVisible(page, successorId);
      await expectAgentTabActive(page, successorId);
      await expectWorkspaceTabHidden(page, predecessor.id);
      await openSessions(page);
      // The successor keeps the predecessor's title (same logical seat,
      // continued), so both rows are titled "rotating-predecessor" here —
      // disambiguate by the predecessor's own agent id, not title text alone.
      await expectSessionRowVisible(page, predecessor.title, predecessor.id);
      const history = await client.fetchAgentHistory({ page: { limit: 200 } });
      expect(
        history.entries.find((entry) => entry.agent.id === predecessor.id)?.agent.workspaceId,
      ).toBe(workspace.id);
      expect(
        (await client.fetchWorkspaces()).entries.some((entry) => entry.id === workspace.id),
      ).toBe(true);
      await clickSessionRow(page, predecessor.title, predecessor.id);
      await expectWorkspaceTabVisible(page, predecessor.id);
      await expectAgentTabActive(page, predecessor.id);
      await expectArchivedAgentFocused(page, predecessor.id);
      await expect(
        page.getByTestId("user-message").filter({ hasText: historicalPrompt }),
      ).toBeVisible({ timeout: 30_000 });

      // Opening an archived session from ordinary History is deliberate
      // historical navigation, not a second logical seat. It survives a
      // reconnect/reload beside the successor without being retargeted again.
      await reloadWorkspace(page, workspace.id);
      await expectWorkspaceTabVisible(page, successorId);
      await expectWorkspaceTabVisible(page, predecessor.id);
      await expectAgentTabActive(page, predecessor.id);
      await expectArchivedAgentFocused(page, predecessor.id);
      await expect(
        page.getByTestId("user-message").filter({ hasText: historicalPrompt }),
      ).toBeVisible();

      // Native finishes with another idle agent_state after it durably updates
      // the receipt. The app must read that event by its monotonic updatedAt,
      // not by status/archive fields or a timer.
      await expect(page.getByTestId("seat-rotation-pending")).toHaveCount(0);
    } finally {
      await e2eWorkerClient.removeProject(created.workspace.projectId).catch(() => undefined);
      await repo.cleanup();
    }
  });

  test("keeps blocked policy status visible and Stop cancels a preparation through the normal native route", async ({
    page,
    e2eWorkerClient,
  }) => {
    const repo = await createTempGitRepo("seat-rotation-policy-browser-");
    const created = await e2eWorkerClient.createWorkspace({
      source: { kind: "directory", path: repo.path },
    });
    if (!created.workspace) throw new Error(created.error ?? "Could not create policy workspace.");
    const agent = await createMockIdleAgent(e2eWorkerClient, {
      cwd: repo.path,
      workspaceId: created.workspace.id,
      title: "policy-predecessor",
    });
    const control = await createMockIdleAgent(e2eWorkerClient, {
      cwd: repo.path,
      workspaceId: created.workspace.id,
      title: "policy-control",
    });

    try {
      await writePolicyJournal(agent.id, {
        state: "preparing",
        reason: "checkpoint_pending",
      });
      await openWorkspaceWithAgents(page, [control, agent]);
      await expect(page.getByTestId("seat-rotation-preparing")).toBeVisible();
      await page.getByTestId("seat-rotation-cancel").click();
      await expect(page.getByTestId("seat-rotation-policy-recoverable")).toContainText(
        "cancelled_by_user",
      );
    } finally {
      await e2eWorkerClient.removeProject(created.workspace.projectId).catch(() => undefined);
      await repo.cleanup();
    }
  });
});

async function rotateFromBrowserFixture(
  client: RotationClient,
  predecessorId: string,
  repoPath: string,
): Promise<string> {
  const snapshot = await client.fetchAgents();
  const sessionId = snapshot.entries.find((entry) => entry.agent.id === predecessorId)?.agent
    .persistence?.sessionId;
  if (!sessionId) throw new Error("Fixture predecessor has no durable session.");
  const timeline = await client.fetchAgentTimeline(predecessorId, {
    direction: "tail",
    projection: "canonical",
    limit: 1,
  });
  const operationId = randomUUID();
  const handoverRoot = path.join(repoPath, ".handover");
  const checkpointPath = path.join(handoverRoot, `${operationId}.json`);
  await mkdir(handoverRoot, { recursive: true });
  await writeFile(
    checkpointPath,
    `${JSON.stringify({
      operationId,
      generation: 1,
      sessionId,
      repoPath,
      sourceRevision: execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      timelineRevision: timeline.window.maxSeq,
      dirtyDisposition: "clean",
      nextAction: "continue",
    })}\n`,
  );
  const result = await client.rotateAgentSeat({
    operationId,
    predecessorId,
    generation: 1,
    handoverRoot,
    checkpointPath,
    resumePrompt: "Read the checkpoint and continue exactly once.",
  });
  if (!result.successorId) throw new Error("Native rotation accepted without a successor ID.");
  return result.successorId;
}

async function writePolicyJournal(
  predecessorId: string,
  input: { state: "preparing" | "blocked" | "failed" | "cancelled"; reason: string },
): Promise<void> {
  const paseoHome = process.env.E2E_PASEO_HOME;
  if (!paseoHome) throw new Error("E2E_PASEO_HOME is not available to the browser fixture.");
  const directory = path.join(paseoHome, "seat-rotation-policy", "operations");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, `${predecessorId}.json`),
    `${JSON.stringify({
      operationId: randomUUID(),
      predecessorId,
      generation: 1,
      repositoryPath: "fixture",
      sessionId: "fixture",
      observedTurnId: "fixture",
      state: input.state,
      reason: input.reason,
      observedAt: new Date().toISOString(),
      lastUserMessageAt: null,
      updatedAt: new Date().toISOString(),
    })}\n`,
  );
}
