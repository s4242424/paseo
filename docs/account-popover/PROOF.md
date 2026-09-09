# Account popover proof checkpoint

Decision: carry-forward. Native candidate operation and remaining security gates are unproved.

2026-09-09: app typecheck passed; focused provider-usage tests passed (16 tests in three files); real headless Chrome browser tests passed (six tests). Browser coverage includes hover, pointer movement and scroll, click pinning, unknown context, offline controls, keyboard traversal through both account actions, and dialogue dismissal returning focus. The embedded account panel is a fixture: this does not prove real sign-in or native operation. Actual account hooks are separately tested for closed/offline behaviour, host switching, cancelled requests and failed refresh without stale identity.

Keyboard fixes explicitly bridge the portalled popover to the surrounding toolbar and return focus after dialogue dismissal. The shared test theme now includes the zinc colour required by the real adaptive dialogue. Browser test configuration supports an explicitly selected installed browser, avoiding reliance on a missing downloaded executable.

Commands: `npm run typecheck --workspace=@getpaseo/app`; `npm run test --workspace=@getpaseo/app -- src/provider-usage`; `PASEO_TEST_BROWSER_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:browser --workspace=@getpaseo/app -- src/components/context-window-meter.browser.test.tsx`. All exited zero. Changed-file formatting and lint passed; `git diff --check` passed. Electron web export, server build and desktop build passed. The first desktop compile preceded its server dependency and failed; rerunning after the server build passed. Ad-hoc native packaging and strict deep codesign verification passed. Candidate: packages/desktop/release/mac-arm64/Paseo.app; bundle ID sh.paseo.desktop.accountpreview; app.asar SHA256 cc6b68e3f3e9f5d374aa96d1ad18c382df5971dbe5761cc5648f7eaf8eeaa4ad. No native launch has occurred.

Pending: exact native build and runtime smoke with the real extension; complete acceptance registry; resolution or explicit assessment of baseline dependency findings; final packet and end-of-run Git verification. No Go files changed; Go checks do not apply. Grounding limitations remain as recorded in RUN.md. This checkpoint does not establish broader Escape completion.

Scanner coverage is recorded in SCANNERS.json; independent review in CHALLENGE.md. Native visual smoke is queued in .arch/popup-queue.jsonl under the no-popup discipline.
