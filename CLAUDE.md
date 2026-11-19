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

`plugins/herdr/` (enricher, `pnpm dev:fork`, plus the opt-in focus write action below): reads only the three `HERDR_*_ID` variables from one batched `ps eww` for new session PIDs, then `herdr tab list` and `herdr workspace list` (cached 10 s, `execFile`, 1.5 s timeout); sets a main session name to its tab label and the workspace as group for the session and its subagents; any failure changes nothing. The command runner is injectable for tests.

### Write actions (server/actions.ts)

S7 keeps the API read-only by default. A write action exists only when a loaded plugin offers it in `OfficePlugin.actions` behind its own opt-in. Today there is one: `focus` from `plugins/herdr/` with `AGENTS_OFFICE_HERDR_FOCUS=1`. Without an offered action, `vitePlugin.ts` mounts no POST route, serves no token and adds no header. Rules for every write action:

- The action name is in the closed enum `ACTION_NAMES` (`server/seam.ts`). The route is `POST /api/actions/<name>`, the body exactly `{ "agent": "<public id>" }` (`parseActionBody`). Never a raw ID, a path, text or a command from the browser.
- `admit(..., 'POST')`: loopback, local Host, `Origin` required and equal to the server origin, `Sec-Fetch-Site` same-origin when present. Then `WriteActions.handle`: `X-Agents-Office-Token` (random 32 bytes per server start, from `GET /api/actions/token`, SHA-256 then `timingSafeEqual`) → 403, `Content-Type: application/json` → 415, 10 per minute → 429, body over 1 KB → 413, bad shape → 400, unknown agent or agent without the action → 404.
- The public id resolves to the observation from the last `/api/agents` answer (a server-side map). The agent must advertise the action in `display.actions`. `projectAgents` copies `actions` only for names in `ACTION_NAMES` that the server enabled.
- `OfficeAction.run(observation)` re-checks its target right before it acts and returns `done` (200), `gone` (409) or `failed` (502). Subprocess only through `execFile` with fixed argv, a strict ID pattern and a timeout.
- One audit line per attempt (`time`, `action`, public `agent`, `result`) to `AGENTS_OFFICE_AUDIT_LOG` or `os.tmpdir()/agents-office-audit.jsonl`, mode 0600. Never the token, a raw ID or the body.
- With an action on, every response gets `X-Frame-Options: DENY` and `frame-ancestors 'none'`.
- Tests inject the command runner and the audit path (`auditLogPath` option). Never run a real write command in a test.

herdr focus: the enricher keeps `focusTargets` (observation id → pid, pane id, tab id; a subagent uses its parent's pane) and sets `display.actions = ['focus']`. `run` re-reads `ps eww` for the pid and `herdr pane get <pane>` (same pane and tab), then `herdr agent focus <pane>`, else `herdr tab focus <tab>` when the pane has no detected agent or agent focus fails. `plugins/herdr/client.ts` shows a "Focus in herdr" card for the selected agent when `extras.actions` holds `focus`; `FocusClient` fetches the token (once more after a 403) and shows the result in a text toast.

### Attention (server/attention.ts, src/ui/attention.ts)

A built-in enricher sets `attention` for main sessions: status `waiting` → `waiting` (blocked), `idle` → `your-turn`, with `waitMinutes` from `statusUpdatedAt`. The browser puts each wait in an age band (`attentionBand`, thresholds in the one constant `ATTENTION_BANDS`: fresh under 15 min, aging under 24 h, cold from 24 h). `callsForYou` (fresh) drives the raised right hand (the arm overrides the activity pose; the rest stays) and the amber beacon, for both attentions. `queuesForYou` (fresh or aging) drives the building queue, `countsInTab` (fresh) the tab title (`tabTitleFor`), `compareWaits` the order (fresh before aging, the longest wait first). Without `waitMinutes` each helper keeps the old behavior: beacon and queue for `waiting` only, tab count for both. The label always shows "Waiting for you · N min" or "Your turn · N min".

### Fork add-on: building layout (src/addons/building*)

`src/addons/building.ts` registers `BuildingLayout` as the default layout (fork only, tier T3). `RoomPlanner.ts` is pure geometry: 12x12 room slots around the 30x26 hall (first ring of 7, the office first at east-center; later rings shift outward and open toward the inner room), door gaps and wall pieces. `rooms.ts` builds a room in a local frame (`RoomFrame`: depth from the door wall, position along it): floor marked `userData.floor`, low walls named `room-walls`, a `door-frame` group (two `door-post` meshes and a `door-lintel` in the floor color, `doorFrame`), a room label (`roomLabel`: a canvas `THREE.Sprite` at the room center, `ROOM_LABEL_Y` 1.55, below the 2.6 wall top so walls hide it in first person, text in `userData.roomLabel`, room in `userData.roomRect`), furniture and stations. `markCutaway` puts the walls, the door frame (and a mission room's closed door) in the `room-walls` static zone with `overviewLower: WALL_HEIGHT`; the hall walls use the `hall-walls` zone with `overviewLower: OFFICE.height`. `roomTitle(kind, earlierKinds, tag)` names a room: lounges are numbered (`Lounge N`), workspace desk rooms are `Desks · <tag>`. `BuildingLayout.ts` keeps per-agent state (home desk, current seat, target, pending trip, queue time): desk work at home, trips to station types after `dwellMs` (4 s), main sessions that `queuesForYou` (or with activity `meeting` and no cold wait) go to `queue` spots at once and are reordered by `compareWaits` in `update()`; a cold wait leaves after the dwell time, subagents use pod spots around the parent desk. An exhausted station type adds a room (`ROOM_STATION_TYPE`), saved in `localStorage` (`agents-office.building.rooms`) and rebuilt on load. The hall side walls are hidden and replaced by `building-hall-walls` with a door per first-ring room.

### Mission war rooms (plugins/missions, src/addons/building/missionRooms.ts)

`plugins/missions/index.ts` reads `mission.yaml` records (via the `yaml` package, 1 MB cap, 30 s cache) from `AGENTS_OFFICE_MISSION_ROOTS` and provides world rooms (`mission:<slug>`, open unless done or abandoned) with walls (destination, artifact titles, GitHub members, thread kanban) and `sleepers` (journey sessions). Its enricher scans each session transcript incrementally for tool calls that touch `missions/<slug>/` or a `mission <cmd> <slug>` command and sets `roomKey` for the session and its subagents. The building add-on registers a `building-world-rooms` extension: `BuildingLayout.syncWorldRooms` builds any world room in the mission wing (`missionSlot`: two columns north of the hall back wall, rows further north), updates walls each poll, and seats agents whose `extras.room` matches (queue still wins). Locked rooms close their door and take no agents. Each war room has a door frame and a room label with the mission title (`setRoomLabelText` on update); its CSS2D signs carry `data-sign="mission"` and `userData.detailSign` (title and lock sign by zoom or hover, past sessions by hover only).

### Workspace desk rooms

`BuildingLayout.homeOf` gives a main session with `extras.group` (herdr workspace) a desk in a `desks` room tagged with the group label (rented when needed, sign "Desks · <label>"); sessions without a group use untagged desks (hall first). Tags persist by label as `desks@<label>` in the room list, because public group IDs change per server run. `needsRehome` moves a session once when its group appears after it got an untagged desk.

### Library and librarians (plugins/library)

The projection whitelist has a `role` token (`DisplayExtras.role`, cleaned like badges). `plugins/library` sets `role: 'librarian'` for subagents whose server-side `agentType` is in `AGENTS_OFFICE_LIBRARIAN_TYPES` (default `bibliotheque-librarian`); its client puts a book in their right hand. `BuildingLayout` adds a `library` room after the office when missing, prefers room shelves for `researching`, and sends a librarian subagent to the Library while it researches and to its parent's pod otherwise.

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

### Agent names (server/agentDetector.ts)

`sessionName`: a main session uses the session file `name` when `nameSource` is a string other than `derived` (seen: `auto`; `derived` is an automatic `<folder>-xx` name). Otherwise, or when the name is not 1 to 80 characters after trimming, it uses `path.basename(cwd)`. `subagentName`: the meta `name` (Claude Code writes it for team agents), else `description`, else `agentType`, else `subagent`. The herdr enricher runs later and can still replace a main session name with its tab label. `projectAgents` caps the name at 60 characters.

### Rendering budget (src/scene/FrameLoop.ts)

`FrameLoop` runs the logic at most 30 times a second (`RenderScheduler`) and renders only when something moved: a figure part (`FigureBatch.sync`), the camera, a static batch, the view mode, a selection (the ring pulses), or `sceneChanged()` (after each poll and world update). Without motion it renders once per second. `scene.matrixWorldAutoUpdate` is false: the loop updates world matrices once per tick.

- **Static merge** (`src/scene/StaticMerge.ts`): `markStatic(root, { zone, castShadow, overviewLower })` marks furniture that does not move (the hall, each room, each mission room, the hall walls, each lamp in place). `StaticBatch.update` merges its `MeshToonMaterial` meshes into one mesh per material and shadow flags. Sources stay in the graph on `STATIC_SOURCE_LAYER` (31), so names, `visible` and wall rebuilds keep working; a batch rebuilds when a source is added, removed or hidden. Not merged: other materials (canvas boards), transparent meshes, and meshes under `userData.dynamic` or `userData.overviewHidden`. Rooms and mission rooms cast no shadow: they lie outside the cone of the three hall lamps. A mark inside a marked root starts its own zone (the walls inside a room).
- **Cutaway** (`src/scene/Cutaway.ts`): a zone marked with `overviewLower: <full height>` carries that height on its container. `applyCutaway(scene, overview)` runs in the loop right after the static merge: in the overview it scales those containers on y down to `OVERVIEW_WALL_HEIGHT` (0.5), in first person back to 1, and asks for a render and a shadow redraw when it changed something. A batch rebuilt while lowered builds its geometry at full height. New add-on walls and door frames go in such a zone (never `userData.dynamic`), so the budget holds.
- **Figure batch** (`src/characters/FigureBatch.ts`): parts made in `StickFigureParts.ts` (`userData.figurePart`, shared geometries) draw as one `InstancedMesh` per shape and material. The parts move to `FIGURE_PART_LAYER` (30); `pickAgent` enables it on its ray. Meshes attached to a part (hats, a book) stay on layer 0.
- **Shadows**: `shadowMap.autoUpdate = false`. `needsUpdate` is set on a batch rebuild, a view mode change, a figure set change, new shadow casters (`casterSignature`), or a moving figure inside a shadow light's frustum.
- **Overview**: `renderQuality` sets the pixel ratio to at most 1.5 and `BasicShadowMap`; first person keeps 2 and `PCFShadowMap`.
- **Labels**: `renderOnScreenLabels` hides labels outside the screen during the CSS2D pass only.
- **Budget test**: `tests/render-budget.test.ts` builds the office at the real size (`tests/real-size-office.ts`) and fails above `DRAW_CALL_BUDGET` (500), counting camera calls (a sprite such as a room label is one) plus shadow casters times shadow lights. About 370 at the real size. `pnpm measure` prints the numbers; `?debug=1` exposes `window.__officeStats`.

### Key Patterns

- **Toon shading**: All meshes use `MeshToonMaterial` with a 4-step gradient map, cached in `Materials.ts`
- **Station occupancy**: `Station.occupied` flag prevents multiple agents at one location. On activity change, old station is released before new one is claimed
- **Teleport vs walk**: `addAgent()` teleports to station instantly; `setActivity()` triggers a walk animation (4.5 units/sec) with leg/arm swing
- **Dwell time (activity layout)**: `ActivityLayout` takes `{ dwellMs, now }` (default 0 = move at once). With `dwellMs > 0`, `seatFor` keeps the seat on a station type change and records a pending trip; `update()` returns the `LayoutMove` once the new type lasted `dwellMs`. A change back to the seat type cancels it, a third type restarts the timer, `release` drops it. `registry.ts` reads `?dwell=<seconds>` (`dwellMsFromSearch`, 0 to 30). The figure switches its activity pose at once; the building layout keeps its own dwell
- **Same-type station stickiness**: If an activity change maps to the same station type (e.g. implementing→debugging), the agent stays at its current desk
- **Skeleton animation**: Hierarchical joints (root→body→shoulders/hips→limbs) animated per-activity with sine waves and `approach()` easing
- **Colors**: Centralized palette in `Colors.ts` with 8 accent colors for agents; an agent's color comes from an FNV-1a hash of its ID
- **Triage list (side panel)**: `src/ui/AgentPanel.ts` groups agents into Needs you (attention `waiting`), Your turn (attention `your-turn`), Working (subagents nested under `extras.parentId`), Idle and Cold (any attention in the cold band, always starts collapsed), with count chips on top. Needs you, Your turn and Cold sort by `compareWaits`. Rows are created once per agent and moved or edited in place on each poll; the scroll position, the groups the user opened or closed and a focused menu survive. Your turn starts collapsed above 5 rows, Idle always starts collapsed. A click on a row calls `selectAgent`; the selected row is marked. The activity menu (P14) appears only with `?demo=1` (`isDemoMode`). `setupPanelCollapse` hides the panel body and stores the choice in localStorage (`agents-office.panel-collapsed`). All text goes through `textContent`

### Office Layout

30×26 unit room. Left wall: bookshelves (researching). Center: 8 desks in 2 rows (implementing). Right side: test stations, review desks. Back wall: whiteboards (planning). Front-right: meeting table. Front-left: coffee area (idle).

### Camera

Two modes, owned by `src/scene/ViewController.ts`. First person stays the default: pointer lock + WASD free camera (`FreeCamera.ts`), Shift for speed, clamped to office bounds. Key O switches to the overview (`OverviewCamera.ts`): a fixed angle from above, mouse wheel to zoom, drag or WASD to pan. The overview frames the box from `setOverviewBounds(box)` when a layout sets one, else the union of every object with `userData.floor`, else the fixed room. A layout that adds floor outside the room marks it with `userData.floor` or calls `setOverviewBounds`. Objects with `userData.overviewHidden` (the front and left walls, the ceiling lamps) are hidden while the overview is on. The building walls drop in the overview through cutaway zones (see Rendering budget, Cutaway); the activity layout has none. `#view=overview` starts in the overview.

### Selection

`src/scene/Selection.ts` holds the shared selection: `selectAgent(id)`, `clearSelection()`, `selectedAgentId()`, `onSelectionChange(cb)` (returns an unsubscribe function). Extensions and other UI (for example a triage list) use it. A click on a figure (raycast against the figure meshes) or on an agent name in the side panel selects; Esc clears; an agent that leaves is deselected. On a new selection the camera flies to the agent in 0.6 s and `SelectionMarker.ts` draws a ring in the agent's color under it. `#focus=<agent id>` selects that agent once it appears.

### Label detail (src/ui/LabelDetail.ts)

`labelDetail(facts, view)` is pure: mode `all` → full; attention `waiting`, selected or hovered → full; overview → full when `zoomDistance <= OVERVIEW_FULL_LABEL_ZOOM` (14), else compact; first person → full within `FIRST_PERSON_FULL_LABEL_DISTANCE` (8) of the camera, else compact. `LabelDetailController` recomputes every `LABEL_DETAIL_INTERVAL_MS` (150 ms), on a selection change and after each poll. It only toggles the `compact` class on the label element (`applyLabelDetail`), so the label text, the BMAD persona names and the Codex tag stay as they are; the CSS hides `.activity` and shows a dot from `--agent-color` (set by `StickFigure`). Hover reuses `ViewController.pickAt` at the last pointer position, or the canvas center while the pointer is locked. The zoom comes from `ViewController.zoomDistance`. Key V cycles `smart` → `all` → `smart`; `#labels=all` starts in `all`; `#label-mode` in the side panel header shows the mode. With the `scene` option, the controller also shows or hides detail signs: CSS2D objects with `userData.detailSign = { rect, hoverOnly }` (war room title, lock and past sessions signs, the "You" sign). `signVisible`: mode `all` or pointer over the rect (floor raycast) → shown; `hoverOnly` → hidden otherwise; overview → shown at `zoomDistance <= OVERVIEW_SIGN_ZOOM` (24); first person → within `FIRST_PERSON_SIGN_DISTANCE` (12). It sets `style.visibility`, which CSS2DRenderer does not touch. Room labels (sprites with `userData.roomRect`) follow `roomLabelVisible`: hidden in first person while the camera stands in their room, shown otherwise; it sets `visible`.

`src/scene/Selection.ts` holds the shared selection: `selectAgent(id)`, `clearSelection()`, `selectedAgentId()`, `onSelectionChange(cb)` (returns an unsubscribe function). Extensions and other UI (for example a triage list) use it. A click on a figure (raycast against the figure meshes) or on a row in the triage list selects; Esc clears; an agent that leaves is deselected. On a new selection the camera flies to the agent in 0.6 s and `SelectionMarker.ts` draws a ring in the agent's color under it. `#focus=<agent id>` selects that agent once it appears.
