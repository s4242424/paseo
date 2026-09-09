# Exclusive provider release proof

Run type: implementation. Repo: /Users/clean/dev/paseo-escape-exclusive-release-20260909. Branch: fix/escape-exclusive-provider-release. Base fix/dual-provider-usage at 3bbb9d79ad249791db304b3da9acb91c9a14788e. Compared main da8c1b5c94e752b01d451645e5fa52aba2c1b2f0. Branch decision: carry-forward.

## Changed behaviour

Reload confirms old provider exit before replacement resume. Managed-ID and native-handle ownership lanes cover reload/resume/import. Failed release fences execution and preserves the original owner; late exit permits explicit retry. Failed replacement cleanup retains the native writer for explicit retry and shutdown. Daemon stop closes independent services then reports unconfirmed writer release. Transport disposal coalesces calls and rejects kill timeout; late-spawned children remain owned until confirmed exit.

## Proof

- Server build: `npm run build --workspace=@getpaseo/server`, exit 0.
- Server type check: `npm run typecheck --workspace=@getpaseo/server`, exit 0.
- Core: from packages/server, `node_modules/.bin/vitest run --maxWorkers=1 src/server/agent/agent-manager.test.ts src/server/agent/providers/codex-app-server-agent.test.ts src/server/agent/providers/codex-app-server-agent.process-exit.test.ts src/server/agent/providers/codex/app-server-transport.test.ts`, 341 passed, exit 0.
- Native: `node_modules/.bin/vitest run --maxWorkers=1 src/server/agent/providers/codex-app-server-agent.local.e2e.test.ts`, 2 passed, exit 0. Real installed Codex app-server, private CODEX_HOME/workspace, loopback mock Responses server. Actual previous child exit checked before next child launch; same conversation ID, retained first user/assistant messages, second turn succeeds, all owned children exit. No live account or existing user daemon touched. Account exhaustion/live Astra continuation remains downstream app proof.
- Bootstrap: `node_modules/.bin/vitest run --maxWorkers=1 src/server/bootstrap.smoke.test.ts`, 22 passed, exit 0. Includes actual private daemon stop failure plus closed listener.
- Wider agent regression: `node_modules/.bin/vitest run --maxWorkers=1 --exclude '**/*.e2e.test.ts' src/server/agent`, exit 1: 2033 passed, 21 skipped, 1 failed Windows Microsoft Store discovery test. Same single test reproduced failing on unchanged base checkout (baseline-availability.log). Class: tooling_environment; retained proof limitation, no clean full-suite claim.
- Oxlint on all touched TypeScript files: exit 0. Git diff whitespace check: exit 0. Scanner JSON parsed successfully.
- Go gates (build/tests/race/vet/staticcheck/golangci/gopls check) not applicable: no Go files changed. Serena semantic grounding used; gopls installed but not applicable; codebase memory and Context7 unavailable in this tool session (trust downgrade).

## Scanner truth

All scanners exit 0, but that alone is not a clean security result. Exact invocations below were run from repository root.

`semgrep scan --config p/typescript --metrics off --disable-version-check --exclude node_modules --exclude .tmp --exclude .git --exclude .worktrees --exclude dist --json --output .tmp/exclusive-semgrep.json packages/server/src/server/agent`

312 relevant targets; zero findings; 48 timeout errors. Broad coverage degraded. Follow-up on the three changed provider logic files with `--jobs 1 --timeout 30 --timeout-threshold 3` scanned all three with 74 rules and zero findings/errors. Separate same-config bootstrap scan (one relevant file, --jobs 1 --timeout 30) reported one inherited CORS finding at unchanged line 736. No exclusions in these four explicitly targeted files. This supports changed-code trust with an inherited unresolved CORS limitation, not a repo security pass.

`trivy fs --scanners vuln,misconfig --skip-dirs node_modules --skip-dirs .git --skip-dirs .tmp --skip-dirs .worktrees --skip-dirs dist --format json --output .tmp/exclusive-trivy.json .`

Four npm lockfiles and one Dockerfile scanned. Existing vulnerabilities include high/critical findings; one Dockerfile misconfiguration. These files and dependency versions are unchanged from base. No development-dependency coverage; no security-clean claim. Detailed severity counts in scanner-coverage.json. Class: proof_gap; inherited dependency/CORS remediation outside this bounded repair remains required before a clean repo security claim.

`gitleaks git . --log-opts='3bbb9d79ad249791db304b3da9acb91c9a14788e..HEAD' --redact --report-format json --report-path .tmp/exclusive-gitleaks.json`

Initial two implementation commits: 27,399 bytes, no leaks, exit 0. Final rerun at run end includes remaining implementation/proof commits. Git-diff coverage excludes untracked caches, .git contents, node_modules and unrelated history by construction. Supports changed-commit secret scanning, not whole-history scanning.

## Packet decision

carry-forward. Native release repair is functionally proved in isolation and may be used for private Escape integration. No merge, deployment, universal provider/account recovery or app-level closure claimed. Keep inherited deterministic and security limitations visible. Next action: complete final Git verification, then continue the existing Escape app objective using this private build.
