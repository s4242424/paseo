# Durable agent retirement — verified source candidate

23 September 2026. Run type: implementation. Branch decision: **carry-forward**.
This supersedes candidate 3's unsafe history-purpose approach. It is not a release,
installation or completed automatic-rotation claim.

## Result

The host now persists an immutable retirement fence before closing an idle agent.
Retirement is separate from reversible archive. Interactive loading, explicit
identity reuse, prompts, unarchive and other provider entry points refuse a retired
identity even when its requesting plugin is absent. A failed close retains the
fence; same-operation retries complete cleanup without clearing it.

The same atomic record write freezes the projected conversation, epoch and sequence
window. Timeline fetch, search, prompt indexing and fork context use this snapshot
without creating or resuming a provider. A cold agent whose history is not loaded
cannot be newly retired. Storage failure leaves the live agent unfenced and usable.
Frozen history survives restart and preserves pagination. Record size scales with
conversation length; existing atomic rename semantics do not claim power-loss fsync.

The client exposes `PaseoAgentHandle.retire` and gates it on
`server_info.features.agentDurableRetirement`. Unsupported hosts fail explicitly;
there is no archive fallback. Permission checks require workspace write access.

## Verification

All builds and runtime checks used copied source in Docker, with no host mounts,
credentials, ports or socket. Runtime containers were non-root, network-disabled,
read-only and capability-restricted. No installed daemon was operated or changed.

- Production build, server-stack typecheck, targeted lint and formatting pass.
- Manager: 195 tests; loader: 4; storage: 22; timeline store: 8; lifecycle: 11;
  authorisation: 9; client: 140 — 389 targeted tests pass across retained runs.
- Actual compiled plugin SDK retirement: input rejection and retained conversation
  pass with plugin running, disabled, and after fixture daemon restart.
- Search, prompt index, fork context and stable pagination pass after restart.
- Instrumented mock provider: ordinary control records create/resume/start calls;
  retired rejection plus all history RPCs add zero calls.
- Ordinary archive/send control passes.
- Disconnecting core storage-read retirement wiring makes the **same positive
  oracle fail** because the forbidden prompt is accepted. This is the required
  negative control, not an expected-reopen success assertion.
- Semgrep 1.176.1: 74 rules, 13 changed production files, zero findings; partial
  parsing warning over 43 unchanged session.ts lines, zero changed-line overlap.
- Gitleaks: no findings over changed files (1.91 MB final scan).
- Trivy: one unchanged npm lockfile, 289 existing vulnerabilities (7 critical,
  142 high, 121 medium, 19 low), zero secrets. This is **not a clean dependency
  scan**; no dependency manifest or lockfile was changed by this patch.

## Remaining gates

Independent challenge and exact-commit CI have not passed. The complete monorepo
typecheck remains a CI gate; the isolated server/client/protocol/relay/CLI stack
passed. Host Git hooks execute npm locally, so they are disabled only for source
protection under the no-host-runtime instruction; this is not a waiver of CI. Existing dependency
findings remain. The separate rotation plugin still needs capability consumption
and complete orchestration. macOS/real-provider/UI/production behaviour is unproved.
No production deployment, account substitution or shared-daemon action follows.

Grounding: current repo docs and instructions, direct source, source-linked prior
receipts and Serena references were used. Context7 is unavailable; gopls is not
applicable to this TypeScript change. No separate codebase memory existed here.

Full commands, true exits, source manifests, Docker identities and SDK proof logs
are retained in Escape's existing task evidence home:
`/Users/clean/dev/escape/.arch/receipts/seat-rotation-20260919/plugin-architecture-20260922/durable-proof-20260923/`.
Production files match candidate 5; candidate 6 adds two manager tests and corrects
admission documentation only. Git publication status belongs in the delivery
receipt after commit/push verification.
