# Seat rotation transition core

The reference core under `scripts/seat-rotation/` remains fixture proof. The
daemon-owned operation is `packages/server/src/server/agent/native-seat-rotation.ts`.
It has no watcher, schedule or automatic threshold policy.

## Client continuity

The feature-gated client API is `DaemonClient.rotateAgentSeat`,
`cancelAgentSeatRotation`, and `inspectAgentSeatRotation`. Persist the operation
ID before asking for a rotation. On reconnect, call `inspectAgentSeatRotation`
with that ID even when the predecessor is archived or no longer visible.

Inspect returns a monotonic receipt `revision`, `phase`, `successorId`,
`workspaceId`, `sourceRevision`, and safe `failureCode`. A `succeeded` phase
means the successor is durable and can replace the predecessor tab; the app
must wait for its normal agent snapshot before retargeting. `pending` and
`failed` keep the predecessor target. The daemon, not the app, archives the
predecessor. No labels, archive calls, checkpoint contents or provider session
identifiers are client inputs to this continuity path.

Native rotation is disabled unless `daemon.enableNativeSeatRotation` is true.
The daemon advertises the capability only when that setting is enabled. The
separate `inspectAgentSeatRotationPredecessor(predecessorId)` client method is
for callers that retained the predecessor identity rather than an operation
ID. Its snapshot links `operationId`, `phase`, `successorId`, `workspaceId`,
`sourceRevision`, `revision`, and `failureCode`; it is not a replacement for
the operation-ID receipt during an active transition.

The daemon prepares and validates an idle successor before it archives the
predecessor. Preparation failure leaves the predecessor live. After archive,
the daemon rechecks the checkpoint and clean repository before it sends the
resume prompt; a failed recheck closes the prepared successor without prompting
it. Normal Stop latches the durable operation through the pre-journal window,
so a queued different generation cannot hide that intent.

## Contract

`SeatRotationCore` accepts an injected backend with these operations:

1. `preflight` establishes the exact predecessor session, repository, source
   revision, runtime configuration, no writers/permissions/children/external
   operations/queued goal writers, and positive restart capacity.
2. `createPreparedSuccessor` accepts the operation ID as its idempotency key.
   It must create a non-writer successor.
3. `readSuccessorReadiness` proves a distinct session has read the checkpoint
   and has the exact repository, source revision, checkpoint hash and runtime.
4. `fencePredecessor` must establish an atomic writer fence. A read-idle result
   followed by archive is not an implementation of this operation.
5. `archivePredecessor` confirms the fenced predecessor's closure/archive.
   Uncertain closure does not activate the successor.
6. `activateSuccessor` must return established liveness only after verified old
   closure. Unknown liveness does not activate the transition.
7. `reconcile` reads an uncertain operation; the core never blind-recreates it.

The checkpoint is an existing regular file below an existing non-symlink
handover root. Its SHA-256, operation ID, generation, session, canonical repo
path and source revision must match the request. It carries only an opaque next
action string; command and shell checkpoint fields are refused and nothing from
the checkpoint is executed.

Operations use a durable real-filesystem JSON journal plus a per-predecessor
generation mkdir admission lock. The temporary file is fsynced before rename
and the containing directory is fsynced after rename. A second operation ID
for the same predecessor generation is refused. Create, readiness, fence,
activation and archive uncertainty retain recoverable journal state. Stop is a
durable latch: after fencing it interrupts or closes the successor and retains
a recoverable idle state rather than silently continuing.

Usage samples must be finite, fresh, session-matching occupancy values. The
strict condition is `used / limit > 0.4`; exactly 40% does not latch. Latches
are scoped to seat, successor generation and successor session. An above-40%
fresh successor sample with zero recorded completed actions marks the operation
`blocked` as `no_progress_immediate_retrigger`; it does not create another seat
and leaves the prepared/activated successor available. Old-seat telemetry is
inactive. This does not change context settings or repository instructions.

## Evidence

Fixture proof uses the real filesystem and an injected deterministic backend;
it does not prove installed Paseo lifecycle behaviour or the backend's atomic
writer fence. Serena and Context7 were unavailable in this environment; no Go
files changed, so gopls is not applicable. The native audit at
`.arch/receipts/seat-rotation-20260919/adapter-design/REPORT.md` confirms that
installed 0.8.0 cannot provide the required fence externally: production reuse
belongs in the daemon-owned receipt-backed rotate operation, not this script.

| Command                                                                                                                           | Exit | Result                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------- | ---: | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `node --test scripts/seat-rotation/core.test.mjs` before `core.mjs` existed                                                       |    1 | RED: missing module                                                                                                                         |
| `node --test --test-reporter=spec scripts/seat-rotation/core.test.mjs`                                                            |    0 | 10 targeted deterministic fixture cases passed                                                                                              |
| `node --check scripts/seat-rotation/core.mjs`                                                                                     |    0 | Applicable type/syntax check for stdlib `.mjs`                                                                                              |
| `npm run format:files -- scripts/seat-rotation/core.mjs scripts/seat-rotation/core.test.mjs docs/seat-rotation/IMPLEMENTATION.md` |    0 | Required formatter                                                                                                                          |
| `npm run lint -- scripts/seat-rotation/core.mjs scripts/seat-rotation/core.test.mjs`                                              |    0 | Targeted lint; two documented complexity suppressions retain explicit ordered failure states                                                |
| `npm run typecheck` via repository pre-commit                                                                                     |    2 | Existing Expo base declaration absence and unrelated plugin/CLI type incompatibilities; stdlib `.mjs` has no TypeScript compilation surface |
| `semgrep --config auto scripts/seat-rotation`                                                                                     |    0 | 200 rules, 2 relevant JS targets, 0 findings                                                                                                |
| `gitleaks detect --no-git --source scripts/seat-rotation --verbose`                                                               |    0 | 30,457 bytes scanned, 0 leaks                                                                                                               |
| `npx vitest run packages/server/src/server/agent/native-seat-rotation.actual.e2e.test.ts --bail=1`                                |    0 | 10 in-process daemon cases: restart receipts, cancellation, admission races, default-off, permission and managed-child refusal              |

`package-lock.json` was unchanged before implementation; final dependency
evidence is recorded with the verification run.
