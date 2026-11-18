# Security validation

Baseline: upstream `88a04aef8684cc2809a1a28156cc06db2dbc78eb`. First validation on 2026-11-16. Audit update on 2026-11-18.

## Changes

- **Session metadata and process probe.** The server validates each parsed session file before use. It rejects PIDs that are not positive safe integers. It probes a process with `process.kill(pid, 0)`, without a shell. Valid live sessions stay discoverable, and a permission denial means the process exists.
- **Labels as text.** Names and activity labels are built with DOM creation and `textContent`, on creation and on update.
- **Local API only.** Both launch paths bind to loopback and reject a network-wide host. The API accepts only loopback sockets with a matching Host and Origin. It returns minimal display records with opaque IDs that change when the server restarts. It sends no cache headers and no internal error text.
- **Dependencies.** Vite moves from 8.0.0 to 8.3.8, with refreshed resolutions. The complete-lockfile audit went from 21 advisories (10 high, 10 moderate, 1 low) to zero on 2026-11-16.
- **Transcript paths.** A session ID that is not a plain file name never selects a transcript or a subagent folder.

## Gate results

Environment: macOS, Node.js 26.3.0, pnpm 10.34.9, Vite 8.3.8.

| Check | Result |
| --- | --- |
| Frozen lockfile installation with lifecycle scripts disabled | PASS |
| Complete dependency audit, including development dependencies | 2026-11-16: zero advisories. 2026-11-18: 1 high, see below |
| PID validation and shell-injection regression tests | PASS |
| Initial and update label XSS regression tests | PASS |
| Vite HTTP access and privacy regression tests | PASS |
| Strict TypeScript checks, including server and tests | PASS |
| Production client build | PASS (existing bundle size warning) |

The injection and label regression suites failed against the original implementation before they passed against the fixes. The API projection test also failed when it was changed back to return raw detector records.

All automated tests use synthetic metadata or an injected detector. The label tests use jsdom and real Three.js label objects. They are not full browser acceptance tests.

## Open advisory (2026-11-18)

The audit reports [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf), a regular expression denial of service in `picomatch` 4.0.7 and earlier. The path is `vite > tinyglobby > picomatch`. The advisory lists no patched version. An attacker must supply a crafted glob pattern. In this project only the Vite configuration supplies patterns, and the server accepts loopback connections only, so the local risk is low. Update the resolution when a fixed version exists.

## Limits

The dashboard has no login. Other software on the same computer can read it, and agent names can contain project or task context. Do not expose it through a public tunnel, a reverse proxy or a port forward.
