# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev        # Start Vite dev server (opens browser)
pnpm build      # Production build
pnpm preview    # Preview built output
pnpm typecheck  # Type check without emitting
pnpm test       # node:test suites in tests/ (tsx)
```

## Design rules and roadmap

Read `docs/design-principles.md` before any feature change: it lists the design rules (P1 to P15, S1 to S8) and the rules for every change. `docs/roadmap.md` holds the tiers, the planned slices and the conflict matrix.

## Architecture

3D office visualization (Three.js + Vite) that shows running Claude Code agents as animated stick figures. Each agent's activity is detected from real session data and mapped to a physical station in the office.

### Data Flow

```
~/.claude/sessions/*.json → server/agentDetector.ts → GET /api/agents → AgentPoller (3s) → AgentManager → 3D Scene
```

1. **Server** (`server/`): Vite middleware plugin reads Claude session files, validates PIDs, infers activity from transcript `.jsonl` tool_use blocks (language-agnostic), and detects active subagents
2. **Polling** (`AgentPoller.ts`): Fetches `/api/agents` every 3 s, one request at a time with a 5 s limit, and reconciles with AgentManager (add/remove/update). If the API fails, the current scene stays. Subagents get a `>> ` prefix in their name
3. **Agent Management** (`AgentManager.ts`): Creates StickFigures and handles their lifecycle. Where a figure goes is the layout's decision (`src/layout/`): `LayoutStrategy.seatFor(agent, previousActivity)` returns a `Seat` (position, look-at, optional forced posture) or null to stay. `ActivityLayout` is the original behavior. `registry.ts` picks the layout from `?layout=`, then browser storage, then the default; key L cycles layouts. Optional fork add-ons in `src/addons/*.ts` register more layouts
4. **Scene** (`Office.ts`): 28 stations across 7 types (the 6 lounge sofa seats are seated idle seats) (implementing, planning, researching, testing, reviewing, idle, meeting). One agent per station. When no station of the right type is free, AgentManager opens an overflow spot on open floor; it never uses a station of another type

### Extension seam (server/seam.ts)

Detection runs as a pipeline: the core `claudeSource` (wraps `detectAgents`), then plugin sources, then enrichers in order, then world providers for rooms and boards. A failing or slow plugin step (2 s limit) drops only its own output; a core failure is a 500. `projectAgents` and `projectWorld` are the only exit: they copy whitelisted, cleaned fields and hash every key with the per-run HMAC. `/api/world` uses the same request checks as `/api/agents`. Plugins live in `plugins/<name>/index.ts` (default export `OfficePlugin`) and load through `server.ssrLoadModule` from `AGENTS_OFFICE_PLUGINS=a,b` or `agents-office --plugin a`. Their browser parts live in `plugins/<name>/client.ts` and register an `OfficeExtension` (`src/extensions.ts`) with `plugin: '<name>'`, so they run only while the server plugin is active.

Plugins in this fork: `plugins/bmad/` (persona hats). Its enricher reads the tool_use blocks of `internal.transcriptPath` incrementally (a per-file offset cache) and `internal.agentType`, and sets persona ids as `badges`. `client.ts` stacks one toon hat per badge on `figure.joints.head` (max 4, then a `+N` marker) and adds the persona names to the label activity line. `roster.ts` is the shared persona list. `pnpm dev:fork` loads the fork plugins.

- **`plugins/github/`**: opt-in with `AGENTS_OFFICE_GITHUB_REPOS=owner/name[,owner/name]`, else it adds nothing. `gh.ts` runs `gh issue list` via `execFile` (5 s, no shell, 60 s cache) and derives the columns. `transcript.ts` finds issue numbers in Bash tool calls. `client.ts` draws wall boards (`KANBAN_BOARD_SLOTS`) and cards in hand. `pnpm dev:fork` loads the fork plugins.

`plugins/herdr/` (enricher, `pnpm dev:fork`): reads only the three `HERDR_*_ID` variables from one batched `ps eww` for new session PIDs, then `herdr tab list` and `herdr workspace list` (cached 10 s, `execFile`, 1.5 s timeout); sets a main session name to its tab label and the workspace as group for the session and its subagents; any failure changes nothing. The command runner is injectable for tests.

### Attention (server/attention.ts, src/ui/attention.ts)

A built-in enricher sets `attention` for main sessions: status `waiting` → `waiting` (blocked), `idle` → `your-turn`, with `waitMinutes` from `statusUpdatedAt`. The figure raises its right hand (the arm overrides the activity pose; the rest stays) and shows an amber beacon while waiting. The label shows "Waiting for you · N min" or "Your turn · N min". The tab title counts both.

### Fork add-on: building layout (src/addons/building*)

`src/addons/building.ts` registers `BuildingLayout` as the default layout (fork only, tier T3). `RoomPlanner.ts` is pure geometry: 12x12 room slots around the 30x26 hall (first ring of 7, the office first at east-center; later rings shift outward and open toward the inner room), door gaps and wall pieces. `rooms.ts` builds a room in a local frame (`RoomFrame`: depth from the door wall, position along it): floor marked `userData.floor`, low walls named `room-walls`, a CSS2D sign, furniture and stations. `BuildingLayout.ts` keeps per-agent state (home desk, current seat, target, pending trip, queue time): desk work at home, trips to station types after `dwellMs` (4 s), main sessions with attention `waiting` or activity `meeting` go to `queue` spots at once and are reordered by `waitMinutes` in `update()`, subagents use pod spots around the parent desk. An exhausted station type adds a room (`ROOM_STATION_TYPE`), saved in `localStorage` (`agents-office.building.rooms`) and rebuilt on load. The hall side walls are hidden and replaced by `building-hall-walls` with a door per first-ring room.

### Activity Inference (server/agentDetector.ts)

The session file `status` comes first (`combineWithSessionStatus`): `waiting` → `meeting` (label "Waiting for you"), `idle` → `idle`, `busy` with a text-only tail → `planning`. Any other status, or none, uses the transcript alone.

From the transcript, activity is inferred from the **most recent tool_use**, not from user input text (`inferActivityFromTool`):
- Read/Grep/Glob/Agent/WebSearch/WebFetch/Skill/ToolSearch → `researching`
- MCP tools (`mcp__*`) → `researching` when the operation name holds a read word, else `implementing`
- Edit/Write (code files) → `implementing`; Edit/Write (.md/.rst/.txt/README/docs/) → `writing_docs`
- EnterPlanMode/ExitPlanMode/TaskCreate/TaskUpdate → `planning`; AskUserQuestion → `meeting`
- Bash is split into simple commands and classified by program (`inferBashActivity`): test runner → `testing`, commit/push/deploy step → `deploying`, git diff/log/show/blame → `reviewing`, curl/lsof/gdb → `debugging`, only read-only programs → `researching`, else `implementing`
- Last assistant message is text-only → `idle`

The detector reads the session's own `<project-dir>/<sessionId>.jsonl`. Many sessions can share one project directory, so the newest file there may belong to another session. A session without its own transcript shows `idle`. The project directory name is the cwd with every non-alphanumeric character replaced by `-`; older Claude Code versions kept the `.`, so that name is the fallback. Lines are read newest first and joined across 50 KB chunks, up to 4 MB.

### Codex source (server/codexSource.ts)

A built-in source registered in `vitePlugin.ts` with the plugin sources (not as `core`), so a Codex failure drops only Codex agents. It is active only when the Codex home exists (`CODEX_HOME`, else `os.homedir()/.codex`). The `codexHome` option overrides it, and `null` turns it off; tests always pass `null` or a fixture. It walks `sessions/YYYY/MM/DD/rollout-*.jsonl` without following symlinks (realpath containment) and keeps files changed within `RECENT_WINDOW_MS` (10 min), max 50. The first `session_meta` line is canonical: thread `id`, `cwd`, `parent_thread_id` (or `source.subagent.thread_spawn.parent_thread_id`), `subagent_history_start_ordinal`. Activity comes from the newest decisive record in the last 256 KB: shell calls and `CommandExecution` items use the exported `inferBashActivity`; `task_complete`, `turn_aborted` or an assistant message → `idle`. Records before the child history boundary are skipped. Observations use `provider: 'codex'`; the browser appends ` · codex` to the floating label (`StickFigure.setTag`). Presence means "the rollout changed recently", never "the process is alive".

### Subagent Detection

Subagents (spawned via the Agent tool) are detected only from the parent's own `~/.claude/projects/<encoded-cwd>/<sessionId>/subagents/`. Each subagent has a `.meta.json` (with `agentType` and `description`) and its own `.jsonl` transcript. A subagent is considered active if its transcript was modified within the last 30 seconds, or if its newest message is a tool call without a result (up to 10 minutes). Their activity is inferred from their own transcript, independently from the parent session.

### Key Patterns

- **Toon shading**: All meshes use `MeshToonMaterial` with a 4-step gradient map, cached in `Materials.ts`
- **Station occupancy**: `Station.occupied` flag prevents multiple agents at one location. On activity change, old station is released before new one is claimed
- **Teleport vs walk**: `addAgent()` teleports to station instantly; `setActivity()` triggers a walk animation (4.5 units/sec) with leg/arm swing
- **Dwell time (activity layout)**: `ActivityLayout` takes `{ dwellMs, now }` (default 0 = move at once). With `dwellMs > 0`, `seatFor` keeps the seat on a station type change and records a pending trip; `update()` returns the `LayoutMove` once the new type lasted `dwellMs`. A change back to the seat type cancels it, a third type restarts the timer, `release` drops it. `registry.ts` reads `?dwell=<seconds>` (`dwellMsFromSearch`, 0 to 30). The figure switches its activity pose at once; the building layout keeps its own dwell
- **Same-type station stickiness**: If an activity change maps to the same station type (e.g. implementing→debugging), the agent stays at its current desk
- **Skeleton animation**: Hierarchical joints (root→body→shoulders/hips→limbs) animated per-activity with sine waves and `approach()` easing
- **Colors**: Centralized palette in `Colors.ts` with 8 accent colors for agents; an agent's color comes from an FNV-1a hash of its ID
- **Side panel**: `src/ui/AgentPanel.ts` updates cards in place; it rebuilds nothing on an activity change. A click on a card name selects the agent; the selected card is marked

### Office Layout

30×26 unit room. Left wall: bookshelves (researching). Center: 8 desks in 2 rows (implementing). Right side: test stations, review desks. Back wall: whiteboards (planning). Front-right: meeting table. Front-left: coffee area (idle).

### Camera

Two modes, owned by `src/scene/ViewController.ts`. First person stays the default: pointer lock + WASD free camera (`FreeCamera.ts`), Shift for speed, clamped to office bounds. Key O switches to the overview (`OverviewCamera.ts`): a fixed angle from above, mouse wheel to zoom, drag or WASD to pan. The overview frames the box from `setOverviewBounds(box)` when a layout sets one, else the union of every object with `userData.floor`, else the fixed room. A layout that adds floor outside the room marks it with `userData.floor` or calls `setOverviewBounds`. Objects with `userData.overviewHidden` (the front and left walls, the ceiling lamps) are hidden while the overview is on. `#view=overview` starts in the overview.

### Selection

`src/scene/Selection.ts` holds the shared selection: `selectAgent(id)`, `clearSelection()`, `selectedAgentId()`, `onSelectionChange(cb)` (returns an unsubscribe function). Extensions and other UI (for example a triage list) use it. A click on a figure (raycast against the figure meshes) or on an agent name in the side panel selects; Esc clears; an agent that leaves is deselected. On a new selection the camera flies to the agent in 0.6 s and `SelectionMarker.ts` draws a ring in the agent's color under it. `#focus=<agent id>` selects that agent once it appears.
