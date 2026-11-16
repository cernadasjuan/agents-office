# Security branch validation

Validated 2026-11-16 on `feature/security-hardening`, against upstream baseline `88a04aef8684cc2809a1a28156cc06db2dbc78eb`.

## Changes and tracking

- #1: Validate parsed session metadata, reject non-positive/unsafe/non-numeric PIDs, and use `process.kill(pid, 0)` without a shell. Valid live sessions remain discoverable; permission denial means the process exists.
- #2: Render names and activity labels with DOM creation and `textContent` in initial and update paths.
- #3: Bind launch paths to loopback, reject unsafe host overrides, restrict API socket/Host/Origin access, use minimal display records with per-server opaque identities, and avoid caching or internal exception disclosure.
- #5: Upgrade Vite from 8.0.0 to 8.3.8 and refresh affected dependency resolutions. The initial complete-lockfile audit reported 21 advisories (10 high, 10 moderate, 1 low). The final audit reports zero.

These fixes are integrated only into the feature branch. Main is unchanged. Codex support (#4) remains design-only and is optional for the first Claude-only test.

## Security gate results

Environment: macOS, Node.js 26.3.0, pnpm 10.34.9, Vite 8.3.8.

| Check | Result |
| --- | --- |
| Frozen lockfile installation with lifecycle scripts disabled | PASS |
| Complete dependency audit, including development dependencies | PASS: zero reported vulnerabilities |
| PID validation and shell-injection regression tests | PASS: 5 tests |
| Initial/update label XSS regression tests | PASS: 7 tests |
| Actual Vite HTTP access/privacy regression tests | PASS: 9 tests |
| Strict TypeScript checks, including server and tests | PASS |
| Production client build | PASS (existing bundle size warning) |
| Diff whitespace check and manual source review of changed security paths | PASS |

The injection and label regression suites were observed failing against the original vulnerable implementation before passing against the fixes. The API projection test also failed when deliberately changed back to returning raw detector records.

All automated tests use synthetic metadata or an injected detector. The default-config binding test starts a local server without requesting the real detector route. No dashboard acceptance test against real user sessions has run. The label tests use jsdom and real Three.js label objects; they are not full browser acceptance tests.

The additional automated adversarial review was blocked by its tooling with a possible-cybersecurity-risk message; it did not pass or produce review findings. Manual source review and the checks above completed.

## Local acceptance test

Use the README instructions from this branch and re-run every listed gate before `pnpm dev`. Do not use the upstream published `npx agents-office` package; it does not contain this branch. Do not expose the dashboard through a public tunnel or port forward. Local software can still access it, and visible agent names can contain private project/task context.
