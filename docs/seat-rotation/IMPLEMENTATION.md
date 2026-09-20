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

Native handover is available only when `enableNativeSeatRotation` is `true`.
Automatic threshold preparation additionally requires
`seatRotationPolicy.enabled: true`. With either setting absent or false, no new
native rotation or policy latch starts.

Each configured policy seat must have this exact shape:

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
a regular, non-symlink file below that root.

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
again. A missing or unchanged witness blocks the operation with a recorded
reason, leaving the successor available rather than making a no-progress chain.

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

The manual path has the same safety contract as the policy: create the
repository checkpoint at a safe boundary, retain an operation ID, then call
`DaemonClient.rotateAgentSeat` with the matching predecessor, generation,
handover root, checkpoint and explicit resume prompt. It is not safe to replace
this with a direct archive/create sequence.

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
