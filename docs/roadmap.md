# Roadmap

This fork extends Agents Office without breaking its design. Every item names the principles it keeps or bends (`docs/design-principles.md`) and its tier. GitHub issues track each slice.

## 1. Tiers

| Tier | What | Where it goes |
|---|---|---|
| **T0: upstream now** | Security, accuracy fixes, obvious gaps. Low risk, no new concepts. | One upstream pull request (branch `security-and-accuracy-fixes`) |
| **T1: upstream later** | Synergistic, low risk, generic. Keeps the default behavior. Example: Codex support, a raised hand for "needs you". | Fork first. Offer upstream one by one, after T0 lands. |
| **T2: plugin** | Depends on another tool: herdr, BMAD, GitHub. | Plugin in `plugins/<name>/`, loaded through the extension seam. Never upstream core. |
| **T3: fork add-on** | Highly custom or experimental: home desks, procedural building, library, CEO office, reply from the office. | Fork only, installed on top of the core. Promote to T1 only if it proves generic. |

Dependency rule: T1 code never depends on T2 or T3 code. T2 and T3 build on the seams in T1.

## 2. Location model: home base and trips

Movement tells the story of the work. You see an agent walk to the whiteboard to plan, to the library to research, to the test lab to test. That stays (P1, P3). The fork adds a home base, so you can also find an agent.

| Rule | Detail |
|---|---|
| Home desk | A new agent gets its own desk. It keeps that desk for the life of its session. |
| Desk work at home | Implementing, debugging and deploying happen at the home desk. The agent does not change desk (P2, extended). |
| Trips for other work | Planning → whiteboard. Researching → library. Testing → test lab. Writing docs → writing desk. Waiting for you → your office. Idle → coffee. After the trip the agent walks home. |
| Motion budget | A trip starts only when the new activity lasts at least a dwell time (default 5 s). A quick tool call does not make the agent walk. |
| Upstream default | The current activity layout stays the default upstream. Home base is a layout mode (`?layout=home`), on by default in this fork. |

Principles: keeps P1, P3, P9. Extends P2. Bends P8 (see capacity). Mitigation: a layout mode, so both behaviors exist.

## 3. Capacity: a building that grows

The office is a building that rents adjacent rooms as the need comes. It never gives rooms back.

- When no seat of a type is free, the building adds a room of that type next to the existing ones: a desk room, a library annex, a planning room, a test lab.
- Rooms stay while the server runs. The layout seed is stored in the browser, so a reload shows the same building.
- A small team uses whatever already exists. Two agents in a 40-desk building pick seats near each other.
- Upstream keeps the fixed room with overflow spots. The growing building is a T3 add-on.

Principles: breaks P8 (one fixed office). Mitigation: a fork add-on on top of the layout seam. The fixed room stays the upstream default.

## 4. Use case: agents waiting for you (human in the loop)

| Level | Feature | Tier | Data |
|---|---|---|---|
| Basic | A waiting session shows "Waiting for you" at the meeting table. | T0, done | Session `status: waiting` |
| Basic+ | One raised hand, a wait timer and a count in the browser tab title. "Your turn" (idle after a reply) is shown apart from "blocked" (waiting for a permission or an answer). | T1 | Session `status`, `statusUpdatedAt` |
| Nice | Your office (the CEO office). Waiting agents walk to your door and stand in a queue, the longest wait first. | T3 | Same, plus the layout seam |
| Complex | Answer an agent from the office. | T3 after a spike | See below |

**Reply from the office: feasibility.** Two channels exist on this machine (2026-11-18):

- Each live Claude session file has a `messagingSocketPath` (protocol 1, features `notify_idle`, `reply_across_default_dirs`). All 36 live sessions had a live socket.
- herdr has `pane send-text` and `pane send-keys` for the pane of a session.

Both are write actions. They break S7 and need a separate security design: a local token, no cross-site requests, an explicit opt-in, and a confirmation step. A spike must first show which states can be answered (a permission prompt, an AskUserQuestion choice, free text) before any build.

## 5. Use case: a kanban board in the office

- A board on a wall shows the issues of a GitHub Project, by column.
- An agent holds the cards of the issues it works on, with the issue number. It can hold several. Several agents can hold the same card.
- Issue detection uses tool calls only (P4): `gh issue view N`, a branch name that starts with `N-`, a commit message with `#N`.
- Tier T2 (GitHub plugin). It needs the network and a token, so it breaks P6. Mitigation: opt-in plugin, token from `gh auth token` through `execFile`, a cache, and nothing leaves the server except issue number, title and column.

## 5b. Use case: mission war rooms

A mission is a long goal that spans several sessions. In the office, each mission gets a war room.

- **Agents:** sessions that work on the mission go to its room. Several sessions can work at the same time, or one after another.
- **Past sessions:** a finished session leaves a trace in the room: a bed with a sleeping agent. You can count how many sessions the mission took.
- **Walls:** the mission statement, the generated documents, the issue tracker and a kanban board of the mission's issues. Here the kanban makes sense, because the mission owns a known set of issues.
- **Closed mission:** the room locks. No agent goes in. The room stays in the building as a locked room, so the history stays visible.
- **Data:** the mission record and the session ledger of the user's harness. A session joins a room when the harness links it to the mission.
- Tier T2 (harness plugin). It depends on the user's own mission and session tooling. It builds on the growing building (rooms) and the source and enricher seam.

## 6. Conflict matrix

K keeps, B bends (mitigated), X breaks (opt-in, plugin or justified override). Blank: not touched.

| Slice | P1 | P2 | P4 | P5 | P6 | P7 | P8 | S2 | S4 | S7 | Mitigation | Tier |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Raised hand, wait timer | K | | B | K | K | K | | K | B | K | Enum only, transcript fallback | T1 |
| Names from session file and subagent meta | | | K | K | K | K | | K | K | K | Fallback chain | T1 |
| Parent color, smaller subagents | K | | | K | K | K | | | K | | None needed | T1 |
| Triage list, menu behind `?demo=1` | | | | K | | | | | | | Old menu kept as a mode | T1 |
| Overview camera, click to select | | | | K | | | | | | | First person stays default | T1 |
| Label level of detail | | | | K | | | | | | | Toggle restores all labels | T1 |
| Dwell time before a trip | K | K | | K | | | | | | | Upstream default keeps the current timing | T1 |
| Codex source | | | K | K | K | X | | K | B | K | Source seam, honest presence | T1 (ask first) |
| herdr names and workspace groups | | | | B | X | X | | B | K | K | Plugin, `execFile`, timeout | T2 |
| herdr focus pane | | | | B | X | X | | B | K | X | Plugin, opt-in action | T2 |
| BMAD persona hats | | | B | K | K | X | | | B | | Plugin, tool calls only, max 2 hats shown | T2 |
| GitHub kanban and issue cards | | | K | B | X | | | B | B | K | Plugin, opt-in, cache | T2 |
| Home base and trips | K | K | | K | K | | B | | K | | Layout mode | T3 |
| Growing building | | | | K | K | | X | | K | | Layout add-on | T3 |
| Pods (subagents and orchestrated agents near the parent) | B | K | | K | K | | B | | K | | Home layout only | T3 |
| Library room and librarian trips | K | | K | K | K | X | X | | K | | Add-on, configurable agent types | T3 |
| CEO office and waiting queue | K | | | K | K | | X | | K | | Add-on | T3 |
| Reply from the office | | | | X | K | | | X | | X | Spike, opt-in, security review | T3 |
| Mission war rooms, sleeping past sessions | B | | | B | K | X | X | | B | K | Harness plugin, room add-on | T2 |

## 7. Extension seam

One server seam carries every integration. The browser gets no plugin code. It renders a fixed, sanitized vocabulary, so the security boundary stays in `server/vitePlugin.ts`.

```ts
interface AgentSource   { id: string; scan(): Promise<Observation[]> }            // claude (built in), codex
interface Enricher      { id: string; enrich(obs: Observation[]): Promise<void> } // name, group, badges, attention, issues
interface ActionHandler { id: string; run(agentId: string, input?: unknown): Promise<void> } // opt-in writes only

// Public API: the only exit, a whitelist
{ id, parentId?, name, activity, attention?, waitMinutes?, provider?, group?: { id, label }, badges?, issues?, actions? }
```

- Built-in sources run with no setting (P5).
- Plugins load from the Vite plugin options, or from an optional `--plugin <module>` flag.
- Each source and enricher has a timeout and its own error handling. One failure drops only its fields.
- Client modes (layout, camera, labels, demo) live in the URL and the browser storage. No config file.

## 8. Pull request slices

Each slice is one issue and one pull request into the fork `main`. Order follows the dependencies.

| # | Slice | Tier | Depends on |
|---|---|---|---|
| 0 | Security, accuracy fixes and gaps | T0 | none |
| 1 | Layout strategy seam (refactor, no behavior change) | T1 | 0 |
| 2 | Source and enricher seam, API whitelist, plugin loading (refactor) | T1 | 0 |
| 3 | Raised hand, wait timer, tab title count, "your turn" apart from "blocked" | T1 | 0 |
| 4 | Names from the session file and subagent meta | T1 | 2 |
| 5 | Parent color and smaller subagents | T1 | 0 |
| 6 | Triage list, menu behind `?demo=1` | T1 | 3 |
| 7 | Overview camera, click to select and fly to | T1 | none |
| 8 | Label level of detail | T1 | 3 |
| 9 | Dwell time before a trip | T1 | 1 |
| 10 | Codex source | T1 | 2 |
| 11 | herdr plugin: names from tabs, groups by workspace | T2 | 2 |
| 12 | herdr plugin: focus pane action | T2 | 11 |
| 13 | BMAD plugin: persona hats that stack | T2 | 2 |
| 14 | GitHub plugin: kanban board and issue cards | T2 | 2 |
| 15 | Home base and trips layout | T3 | 1, 9 |
| 16 | Growing building | T3 | 15 |
| 17 | Pods around the parent | T3 | 5, 15 |
| 18 | Library room and librarian trips | T3 | 16 |
| 19 | CEO office and waiting queue | T3 | 3, 16 |
| 20 | ~~Rooms by herdr workspace~~ — replaced by #118 (floors per repo); retired in #138 | T3 | 11, 16 |
| 21 | Reply spike, then reply from the office | T3 | 19 |
| 22 | Harness plugin: mission war rooms with past-session beds, walls and a locked room when closed | T2 | 2, 16 |

## 9. Workflow

- Fork `main` is the integration line. Each slice branches from `main` as `<issue>-<short-name>` and merges back through a pull request.
- Each issue has a tier label: `tier:upstream-now`, `tier:upstream-later`, `tier:plugin`, `tier:fork-only`.
- A T1 branch must apply to upstream `main` plus T0, with no T2 or T3 code. That keeps it ready to offer upstream.
- Before any T1 offer upstream, open one discussion issue upstream: the 22-seat limit with numbers, the layout mode idea, and the Codex scope question.

## 10. Open questions

1. herdr join: read the pane ID from the Claude process environment (`ps eww` through `execFile`), or ask herdr to report it?
2. Persona signal for hats: the `bmad.py agent` call, a Skill call, a subagent type, or all three?
3. Which agent types count as librarians?
4. Codex v1: is "recently active" (not proven running) good enough?
5. If upstream stays silent for about two weeks: publish the fork under your own npm scope, or keep it clone-only?
