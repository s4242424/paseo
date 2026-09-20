# Seat rotation

Seat rotation is a daemon-owned, receipt-backed handover for one logical seat.
It is default-off. It is a candidate capability, not an installed or
portfolio-wide rollout.

The fixture reference core in `scripts/seat-rotation/` remains fixture-only
proof. The supported operation is
`packages/server/src/server/agent/native-seat-rotation.ts`; the threshold policy
in `packages/server/src/server/agent/seat-rotation-policy.ts` only decides when
to ask that operation to run. It does not own a second archive, fence, or
successor path.

## Enablement and seat binding

The persisted configuration entry point is `$PASEO_HOME/config.json` (normally
`~/.paseo/config.json`). `loadPersistedConfig()` reads that file and `loadConfig`
maps its `daemon` block into the daemon bootstrap configuration. Do not add a
second file or a command-line setup path for seat rotation.

This is the minimal validated nesting. `version` is optional to the parser but
is included to preserve the normal v1 config shape:

```json
{
  "version": 1,
  "daemon": {
    "enableNativeSeatRotation": true,
    "seatRotationPolicy": {
      "enabled": false,
      "seats": []
    }
  }
}
```

`daemon.enableNativeSeatRotation` controls native handover. When it is absent
or false, manual `rotateAgentSeat` requests are unavailable and a policy cannot
complete a native handover. `daemon.seatRotationPolicy.enabled` controls only
automatic threshold latching and preparation. When it is absent or false, it
does not disable an otherwise enabled manual native request. Automatic rotation
needs both settings enabled.

Each `daemon.seatRotationPolicy.seats` entry must have this exact shape:

```json
{
  "seatId": "build",
  "repositoryPath": "/absolute/path/to/repository",
  "handoverRoot": "/absolute/path/to/repository/.handover",
  "checkpointPath": "/absolute/path/to/repository/.handover/CURRENT.json",
  "progressWitnessPath": "/absolute/path/to/repository/.handover/progress.json",
  "resumePrompt": "Read the checked handover and continue the bounded task.",
  "goalContinuation": "checkpoint_only"
}
```

The running agent must carry the matching `paseo.seat-id` label and have the
same `cwd` as `repositoryPath`. One and only one live writer may match that
logical seat. Two configured seats may not share a repository checkpoint. These
checks intentionally refuse an ambiguous configuration instead of selecting a
writer.

The checkpoint and witness belong to the repository's existing handover home;
the daemon does not create a new portfolio registry or transcript store. The
handover root and checkpoint are resolved as real paths. The checkpoint must be
a regular, non-symlink file below that root. Preserve the repository's canonical
checkpoint owner and update protocol; configuration does not authorise a caller
to overwrite that file blindly.

## Checkpoint, boundary, and policy

The preparation turn writes a JSON envelope containing `operationId`,
`generation`, `sessionId`, `repoPath`, `sourceRevision`,
`dirtyDisposition: "clean"`, and an opaque `nextAction`. The daemon seals the
final `timelineRevision` after that turn completes. It then validates the
envelope, repository identity and clean disposition again before it archives the
predecessor or sends the explicit `resumePrompt`. Checkpoint text is data: it is
never executed as a command or shell input.

The policy latches only a finite, fresh, provider-confirmed context observation
for the live provider session and active turn where `used / limit > 0.4`.
Exactly 40% does not latch. A latch waits for an idle, permission-free boundary;
user work that changes that boundary blocks it. The witness file must exist and
change after a successor handover before a high-usage successor can rotate
again. It must represent real task progress, not a bootstrap, preparation-only,
timestamp-only, or other incidental update. The current gate compares file
hashes, so it proves that bytes changed, not that their meaning is task progress;
the canonical checkpoint owner is responsible for that semantic contract. A
missing or unchanged witness blocks the operation with a recorded reason,
leaving the successor available rather than making a no-progress chain.

The policy's durable journal records intent and preparation state. The native
receipt remains the authority for admission, atomic writer fencing, predecessor
archive, successor activation and cancellation. A normal operator Stop latches
the operation through the pre-journal window, cancels a prepared successor when
needed, and prevents a later queued generation from concealing that intent.

Native provider goals do not transfer. `goalContinuation` is always
`"checkpoint_only"`: put the next action in the repository checkpoint and use a
new explicit prompt. Pending permissions, active writers, child writes,
unfinished external work, a dirty checkpoint, malformed receipts, or uncertain
closure fail closed.

## Manual continuity and reconnect

The manual path has the same safety contract as the policy. It is not safe to
replace it with a direct archive/create sequence. The minimal client sequence
below assumes an already-connected, authorised `DaemonClient` and the
repository's existing canonical checkpoint owner. It does not install, start or
configure a daemon.

```ts
import { randomUUID } from "node:crypto";
import type { DaemonClient } from "@getpaseo/client";

interface CanonicalCheckpointOwner {
  seal(input: {
    operationId: string;
    generation: number;
    sessionId: string;
    repoPath: string;
    sourceRevision: string;
    timelineRevision: number;
    nextAction: string;
  }): Promise<void>;
}

async function rotateAtCanonicalBoundary(input: {
  client: DaemonClient;
  checkpointOwner: CanonicalCheckpointOwner;
  predecessorId: string;
  predecessorSessionId: string;
  generation: number;
  repositoryPath: string;
  sourceRevision: string;
  handoverRoot: string;
  checkpointPath: string;
  resumePrompt: string;
  nextAction: string;
}) {
  const operationId = randomUUID();
  const before = await input.client.fetchAgentTimeline(input.predecessorId, {
    direction: "tail",
    projection: "canonical",
    limit: 1,
  });

  await input.checkpointOwner.seal({
    operationId,
    generation: input.generation,
    sessionId: input.predecessorSessionId,
    repoPath: input.repositoryPath,
    sourceRevision: input.sourceRevision,
    timelineRevision: before.window.maxSeq,
    nextAction: input.nextAction,
  });

  const after = await input.client.fetchAgentTimeline(input.predecessorId, {
    direction: "tail",
    projection: "canonical",
    limit: 1,
  });
  if (after.window.maxSeq !== before.window.maxSeq) {
    throw new Error("The predecessor advanced after the canonical checkpoint was sealed.");
  }

  const rotation = await input.client.rotateAgentSeat({
    operationId,
    predecessorId: input.predecessorId,
    generation: input.generation,
    handoverRoot: input.handoverRoot,
    checkpointPath: input.checkpointPath,
    resumePrompt: input.resumePrompt,
  });
  const policy = await input.client.inspectAgentSeatRotationPolicy(input.predecessorId);
  const receipt = await input.client.inspectAgentSeatRotation(operationId);
  return { rotation, policy, receipt };
}
```

`CanonicalCheckpointOwner.seal` stands for the repository's established,
atomic checkpoint-writing path. It must preserve the envelope fields shown and
write `dirtyDisposition: "clean"`; it is deliberately not a blind file write in
the client. The native operation independently reads the canonical timeline tail
and rejects a changed boundary. In the automatic policy path, the preparation
turn writes the envelope without guessing `timelineRevision`; the daemon seals
that field after the turn ends and then revalidates the boundary.

Use `inspectAgentSeatRotationPolicy(predecessorId)` to show policy state and
`cancelAgentSeatRotation(operationId, predecessorId)` for an operator Stop. The
cancel call returns the durable cancellation result; then inspect the operation
receipt rather than assuming a successor was stopped.

Persist the operation ID before requesting rotation. On reconnect, call
`inspectAgentSeatRotation(operationId)` even if the predecessor is archived or
not visible. Its monotonic receipt includes `revision`, `phase`, `successorId`,
`workspaceId`, `sourceRevision`, and a safe `failureCode`. Only `succeeded`
permits the app to retarget after the normal successor snapshot arrives;
`pending` and `failed` keep the predecessor target. A caller that retained only
the old ID can use `inspectAgentSeatRotationByPredecessor(predecessorId)` to
find the linked receipt, but it does not replace the operation-ID receipt during
an active transition.

The daemon archives the predecessor. Timeline rows and the durable receipt seal
the transition; old native history remains separate and is not injected into the
successor context.

Rotation and cancellation require the daemon's existing `workspace.write`
permission. Inspection requires `workspace.read`. These are daemon-wide
capabilities, not new per-agent resource grants; authenticated restricted-client
network qualification remains unproved.

Policy cancellation is durable and keyed by `predecessorId` at
`$PASEO_HOME/seat-rotation-policy/cancellations/<predecessorId>.json`. The
current source exposes no reset or clear operation. Toggling
`seatRotationPolicy.enabled`, sending ordinary work, or changing the witness
does not clear it, so re-enabling automatic rotation for that same predecessor
is unsupported. The supported recovery is an explicit manual native handover,
when native rotation is enabled and the complete canonical checkpoint contract
passes; its successor has a new predecessor ID. Do not delete a policy marker or
native admission receipt to force same-seat re-entry.

## Rollback and limits

To stop future policy-triggered handovers, set `seatRotationPolicy.enabled` to
`false`; to stop new native requests too, set `enableNativeSeatRotation` to
`false`. In this candidate version, durable native admission lookup stays
installed so existing receipts and writer fences remain effective while new
rotation is disabled. Do not treat a downgrade to an older binary as safe:
first resolve every pending handover and explicitly account for archived writers.

No shared daemon, port 6767, mobile application, account, or production setting
is changed by this capability or its tests. Deterministic and in-process daemon
tests prove bounded contracts only. The recorded actual-provider work did not
complete three consecutive Fable handovers, did not run Codex handovers, and did
not prove final live cleanup. Provider, host, version, browser, and rollout
coverage must therefore be reported from the exact later evidence rather than
inferred from these receipts.

## Evidence

The Phase 1 candidate retains focused native, policy, permission, telemetry and
opt-in live-harness coverage. Real-provider files use the explicit opt-in test
category and are not run as ordinary local gates. See the integration proof
report for exact commands, exits, scan coverage and the remaining Phase 2 UI and
live-provider evidence.
