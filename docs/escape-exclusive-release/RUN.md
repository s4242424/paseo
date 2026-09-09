# Exclusive provider release — Escape dependency

- Run type: implementation.
- Repo: /Users/clean/dev/paseo-escape-exclusive-release-20260909.
- Base branch: fix/dual-provider-usage, 3bbb9d79ad249791db304b3da9acb91c9a14788e.
- New branch: fix/escape-exclusive-provider-release.
- Objective: close and confirm release of the old provider before resuming the same native conversation; reject unknown release and keep unrelated agents independent.
- Current main truth: local origin/main da8c1b5c94e752b01d451645e5fa52aba2c1b2f0; refresh at final Git gate. Prior usage work is retained, not re-authored.
- Source order: Rob's active full Escape convergence goal; installed/source fault evidence PC-001 in task-ui; this source's provider and lifecycle contracts; deterministic tests; model challenge last.
- Frozen truths: native conversation identity/history; existing account credentials and services; isolated candidate only. No active user provider session or shared daemon is stopped or replaced by this run.
- Hard rules: one confirmed writer, no resume after timeout/error, no blind duplicate operation, bounded owned cleanup, no model claim overriding failing proof, continuous commits and pushes.
- Execution strategy: lifecycle and transport repair; adversarial timeout/error/late/concurrent tests; isolated candidate native smoke; required build/type/lint/scanner checks; challenge; source/adoption receipt in the Escape review packet.
- Grounding: Serena TypeScript symbol navigation; existing source and PC-001 memory; gopls is installed but no Go changes. Separate codebase-memory and Context7 tools are unavailable (recorded tooling gap, reduced external grounding trust). No repo AGENTS.md or ancestor override was found.
- Required outputs: exact source diff, deterministic regression logs, candidate build and runtime evidence, scanner coverage, challenge and Git receipts.
- Deterministic checks: provider/manager/tree-kill tests; affected server build and typecheck; lint/format; Semgrep non-zero source coverage, Trivy, Gitleaks; isolated native continuation with provider release evidence. Go checks are inapplicable to TypeScript-only changes.
- Success: close/exit proof precedes resume, failed release causes zero successor launch, concurrent lifecycle calls cannot create overlapping writers, exact native candidate continues the same provider conversation.
- End-of-run Git protocol: current branch/status; stage and bounded commits; push origin branch; separately verify status, local/upstream/remote SHA, fetch main and branch, main SHA, diff stat and name-status. No auto-merge or active-service adoption.
- Final response: include repo, branch, local/remote/upstream/main SHAs, clean state, grounding, changed/proved/unproved, scanner coverage, evidence refs, diff stat, branch decision and autonomous next action. This dependency feeds the still-active Escape convergence run.
