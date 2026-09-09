# Account popover — locked look and function
Canonical surface: packages/app/src/components/context-window-meter.tsx (React Native, deployed in Electron desktop). Existing Paseo beta theme and component kit are authoritative. This file precedes implementation.

Persona: Rob, existing user managing Claude and Codex conversations across hosts; grounded in his explicit request, not a population user study. Job: see allowance and current host login quickly, change login deliberately, keep the main conversation clear.

Authority ledger: accepted Escape docs/escape-supervision/PASEO-08-DIRECTION.md records both providers' full available allowance figures, reset times, observed login identities and change-login buttons; hover with click/keyboard fallback; login dialogues; no permanent account toolbar. Prior 3bbb9d7 supplies the reviewed dual-provider wheel shape and real scrolling proof. This port preserves the beta kit and extends those behaviours only.

| ID | Requirement / story | Verification | Initial state |
|---|---|---|---|
| AP1 | Existing context-circle footprint and context percentage remain context occupancy | Component data/geometry assertions; native comparison | Pending |
| AP2 | Hover, click and keyboard open the same interactive details; crossing the pointer gap preserves it | Real pointer and keyboard browser tests, negative dismissal fixture | Pending |
| AP3 | Claude and Codex both visible, plus any distinct active provider, no duplicates | Pure helper and rendered component tests | Pending |
| AP4 | Every supplied allowance window/reset/balance/detail remains reachable by scrolling | Multiwindow fixture, small viewport scroll and bounds checks | Pending |
| AP5 | Unknown/error/loading never becomes zero or success; quota and login provenance distinct | Error/unknown/host-switch controls | Pending |
| AP6 | Observed host identity and check time, never claimed per-conversation identity | Guarded RPC schema and rendered copy | Pending |
| AP7 | Each change-login action opens a dialogue using existing guarded account panel | Real compiled plugin integration fixture and native read-only opening | Pending |
| AP8 | No mutation on hover/open; pending sign-in survives detail dismissal | RPC spy and modal lifecycle controls | Pending |
| AP9 | Offline/missing/incompatible host plugin disables controls with clear reason | Failure fixtures; registry checks | Pending |
| AP10 | Details live only in popover/dialogue; no new permanent toolbar | Full composer DOM/screenshot comparison | Pending |
| AP11 | Escape closes, focus returns, small viewport scroll works and no overflow | Keyboard and bounds tests; native observation | Pending |
| AP12 | Host/workspace/agent scope verified before rendering account panel; no stale cross-host identity | Session switch and invalid-context fixtures | Pending |

Anatomy/tokens: existing ring geometry, theme colours/type/spacing and provider-card primitives. Popover uses the existing floating surface, bounded width min(360px, viewport minus margins), bounded height with scroll. Dialogue uses AdaptiveModalSheet and existing plugin panels; no duplicate credential implementation. Context unavailable is labelled as such while host allowance access remains usable. Existing per-provider panels may include guarded recovery actions; no automatic action is added.

State: closed, hover-open, pinned-open, account-dialogue; reads occur only while requested. Error/unknown remain distinct. Pointer movement into content must not dismiss it. Clicking a login button closes the popover but keeps the dialogue mounted independently. Native/modal lifecycle and login continuity must be proved rather than inferred. No appearance or operational completion claim before exact native capture.
