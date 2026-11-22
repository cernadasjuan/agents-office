# Agents Office

A 3D office visualization that shows your running [Claude Code](https://claude.ai/code) agents as animated stick figures. Each agent's real-time activity is detected from session data and mapped to a physical station in the office — coding at a desk, reading at the bookshelf, writing on the whiteboard, and more.

![agents-office](assets/screenshot.png)

## Quick start

```bash
npx agents-office          # opens http://127.0.0.1:5173
npx agents-office 5180     # another port
```

From source, run the checks first:

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm audit --audit-level=low
pnpm test
pnpm typecheck
pnpm build
pnpm dev
```

`pnpm smoke` is a separate, opt-in check (issue #89): it starts the dev server against a
fixture agent list on an OS-assigned free port (never a fixed one, never 5173), opens it in
one headless Chromium page (`playwright` is a dev dependency, never a runtime one, P6), and
fails on any page error. It never runs as part of `pnpm test`.

`pnpm install` does not fetch Chromium for this `playwright` version; run this once, on a
fresh clone or after a `playwright` upgrade:

```bash
npx playwright install chromium
```

`pnpm smoke` checks Chromium is installed before it starts anything, and prints this exact
command if it is missing.

## macOS launcher (this fork)

A fork-only launcher app so the office opens from Spotlight or Applications instead of a
terminal. Install it once from a clone of this fork:

```bash
scripts/install-launcher.sh
```

This builds `Agents Office.app` into `~/Applications` (pass a folder as the one argument to
install somewhere else) and, on the first run, creates a config file at
`~/Library/Application Support/AgentsOffice/launcher.env` for your mission roots, library
roots, GitHub repos and office portrait (see the file's own comments). Rerun the command
after a `git pull` or after moving the clone, so the launcher keeps pointing at the right path.

Opening "Agents Office":
- **Cold start** (nothing answers the port): starts the dev server with this fork's plugins
  (`herdr,github,bmad,missions,library,peek,skills,floor-library`, the same set as
  `pnpm dev:fork`) in the background, then opens the office in your default browser.
- **Warm start** (the office already answers the port): opens the office in your browser
  only; it never starts a second server.
- **Port busy with another app**: something else answers the port, but it is not this office.
  The launcher never opens a browser or starts a server in this case. It logs it and shows a
  macOS notification instead, so you know to close that other app first.
- **Server lifetime**: the server keeps running after you close the browser. Quit it the same
  way you would any other local dev server (find its `vite` process, or restart your machine).

Logs: `~/Library/Logs/agents-office/launcher.log`. This bends [P6](docs/design-principles.md)
(no daemon): the launcher lives in `scripts/`, outside the published npm package (see
`package.json`'s `files`), and the server it starts still binds `127.0.0.1` only (S1).

The app icon (issue #205) is `scripts/launcher/icon.svg`, a procedurally drawn office/building
motif (no downloaded brand assets), packed into `scripts/launcher/AgentsOffice.icns` with
`iconutil` and committed. `scripts/build-launcher-app.sh` only copies the committed `.icns`
into the bundle; it never rasterizes anything itself, so installing the launcher never needs
Chromium. To change the icon: edit `icon.svg`, then regenerate the `.icns` with
`node scripts/launcher/generate-icon.mjs` (needs the `playwright` dev dependency and its
Chromium download, the same one-time step `pnpm smoke` already documents) and commit both
files. A checkout missing the `.icns` still builds the app, just without an icon.

## Local security boundary

The dashboard is for local use. Both launch paths bind to `127.0.0.1`; attempts to
use a network-wide host such as `--host 0.0.0.0` are rejected. The agent API accepts
only loopback clients, and browser requests must come from the dashboard's own
origin. Do not expose it through a public tunnel, reverse proxy, or port forward.

The API returns only display names, activities, and opaque IDs that change when
the server restarts. It does not return working-directory paths, PIDs, start times,
or raw session IDs. Display names can still contain project or task context, and
other software running on your computer can access the local dashboard without a
login. Run it only on a trusted machine.

The API is read-only by default: it answers GET only. The one exception is an
opt-in write action, see [herdr focus (write action)](#herdr-focus-write-action).

`GET /api/portrait` has the same checks. It serves one local picture only when you
set `AGENTS_OFFICE_PORTRAIT`, see [Your portrait](#your-portrait).

## How It Works

The app reads the Claude Code session files in `~/.claude/sessions/` on your machine. For each live session it reads that session's own transcript and the status that Claude Code writes in the session file. From those it computes one value, the **activity**. Everything you see derives from it: where the agent stands, how it moves, and what its label says.

```
~/.claude/sessions/*.json   one file per running session (pid, sessionId, cwd, status)
        │  server: keep valid sessions whose process is alive
        ▼
  activity = session status + newest tool call in the session's own transcript
        │  + subagents of that session (active in the last 30 s, or in a long tool call)
        ▼  GET /api/agents  →  [{ id, name, activity, parentId? }]
  browser, every 3 s: add, update or remove figures
        ▼
  activity → station type → free seat of that type (or an overflow spot) → walk there → pose
```

### Status: how the activity is computed

The session status comes first. The transcript tells what kind of work the agent does.

| Session status | Activity |
|---|---|
| waiting (for a permission or an answer) | In a meeting (meeting table); reads "Waiting for you" wherever attention shows, see below |
| idle | Taking a break (coffee machine) |
| busy, and the newest message is text | Planning (whiteboard): the agent is thinking |
| busy with a tool call, or no status in the file | From the newest tool call, below |

| Newest tool call | Activity |
|---|---|
| Read, Grep, Glob, WebSearch, WebFetch, Agent, Skill, ToolSearch | Researching (bookshelf) |
| MCP tool whose name holds get, list, search, read, fetch, query, find, view, lookup or describe | Researching (bookshelf) |
| Edit or Write on `.md`, `.rst`, `.txt`, README or `docs/` | Writing docs (review desk) |
| Edit, Write, NotebookEdit on other files, other MCP tools | Implementing (desk) |
| EnterPlanMode, ExitPlanMode, TaskCreate, TaskUpdate | Planning (whiteboard) |
| AskUserQuestion | In a meeting (meeting table) |
| Bash, see below | depends on the programs it runs |
| Text only, no tool call | Taking a break (coffee machine) |

"In a meeting" is the `meeting` activity's own label: a pose about what the agent is doing right
now, not about whether Gabriel is needed. It is a different signal from "Waiting for you" / "Your
turn" (see Attention below), which always wins when it applies, on the card, the panel row and
the floating label alike. Before this, both read "Waiting for you," which made two different
animations (a one-armed wave versus a two-armed gesture) look like the same state (issue #169).

Shell commands are split into simple commands (`&&`, `;`, `|`). The first rule that matches any of them wins:

| Programs | Activity |
|---|---|
| Test runners: `pnpm test`, `npm test`, `jest`, `vitest`, `pytest`, `cargo test`, `go test`, `node --test` | Testing (test station) |
| `git commit`, `git push`, `docker push`, `kubectl apply`, `terraform apply`, `npm run deploy`, `deploy.sh` | Deploying (celebrating) |
| `git diff`, `git log`, `git show`, `git blame`, `gh pr view` | Reviewing (review desk) |
| `curl`, `wget`, `lsof`, `gdb`, `lldb`, `strace`, `node --inspect` | Debugging (desk) |
| Only read-only programs: `ls`, `cat`, `rg`, `grep`, `find`, `git status`... | Researching (bookshelf) |
| Anything else | Implementing (desk) |

### Codex agents

If a Codex home exists (`CODEX_HOME`, else `~/.codex`), the app also shows Codex threads. It reads only the rollout files in `sessions/YYYY/MM/DD/rollout-*.jsonl`. It does not read `auth.json`, `config.toml`, `history.jsonl` or the memory files. Without a Codex home, nothing changes.

- **Presence:** a thread is shown when its rollout file changed in the last 10 minutes. This is recent activity, not proof of a running process. A long silent command, or an open thread that waits for you, can disappear. A closed thread can stay for up to 10 minutes.
- **Activity:** from the newest record in the last 256 KB of the rollout. Shell commands use the Bash rules above. A file change is implementing, a read-only MCP call or a web search is researching, a plan or subagent step is planning, and a question for you is waiting. A completed or aborted turn, or a final assistant message, is taking a break. A wrapped script (`exec`) is implementing; the app never runs or evaluates it.
- **Name and parent:** the folder name of the thread's working directory, else `codex`. A spawned child links to its parent only when the parent is also shown. Records that a child copies from its parent are ignored.
- **Label:** the floating label adds `· codex` after the activity.
- Tested against the rollout layout of Codex 0.169.0. Unknown records are skipped. Symlinks inside the sessions folder are not followed.

### Who needs you

- **Blocked:** a session that waits for your permission or answer raises its right hand, shows an amber marker over its head, and reads "Waiting for you · 12 min" in its card, its panel row and its floating label alike.
- **Your turn:** a session that finished its turn reads "Your turn · 5 min" the same way everywhere, with no marker, *unless* it is still orchestrating its own subagent — see below.
- **Orchestrating:** a session that finished its own turn but still has a subagent of its own running never raises a hand and shows no marker: it is not blocked on you. It stands with hands on hips instead. Its text still reads "Your turn · N min"; only the pose and the signal differ.
- **Tab title:** `(2) +5 · Agents Office` means 2 blocked and 5 waiting for your next prompt.

Only a fresh wait calls for you. Each wait falls in an age band:

| Band | Wait | What you see |
|---|---|---|
| Fresh | under 15 min | Raised hand and amber marker (blocked or your turn), a spot in the queue, counted in the tab title |
| Aging | 15 min to under 24 h | The label only, and a spot in the queue. No marker, no tab count |
| Cold | 24 h or more | The label only, in the collapsed "Cold" group of the side panel. Not in the queue, not in the tab count |

The two thresholds are one constant, `ATTENTION_BANDS` in `src/ui/attention.ts`. A session without a wait time keeps the old behavior: a block has the marker and the queue spot, and every wait counts in the tab title.

Subagents never ask; their parent does. Without a status in the session file, nothing changes.

### Stuck sessions

A session can stay busy with no progress; today it looks the same as a session that is actually working. A busy session with no transcript write for 60 min shows "Stuck?" in its label and in its panel row, in place of the activity. A long tool call still counts as progress: only the transcript's write time matters, not how long the call runs. The mark clears on its own on the next poll once the session writes again. The threshold is one constant, `STUCK_AFTER_MINUTES` in `src/ui/attention.ts`, next to `ATTENTION_BANDS`. Subagents never get this mark; their parent does. A session without a status, a transcript, or a known write time keeps the old behavior. Like a fresh wait, a stuck mark always gets the full floating label, so it shows even on a figure far from the camera and not selected.

### Triage list

The side panel lists the agents by what you must do:

1. **Needs you:** blocked agents, fresh waits first, then aging waits, the longest wait first inside each band. Each row shows the name, the wait ("12 min") and the activity.
2. **Your turn:** agents that wait for your next prompt, in the same order. The group starts collapsed when it has more than 5 agents.
3. **Working:** busy agents. Subagents are indented under their parent. A stuck one (no transcript write for 60 min) reads "Stuck?" instead of its activity.
4. **Idle:** the rest. The group starts collapsed.
5. **Cold:** blocked or your-turn agents that waited 24 h or more, the longest wait first. The group starts collapsed and shows its count, so a cold wait never vanishes.

The chips at the top count each group ("2 need you · 22 your turn · 9 working · 8 idle"). Click a chip to open its group. Click the "Needs you" chip itself and the camera also flies to the oldest fresh wait, so you can jump straight to the agent that has waited longest. Click a group title to open or close it. Click a row to select the agent: the camera flies to it. Codex agents show a `codex` tag. Persona badges from a plugin show as small text chips. The button in the panel header hides the list so the room stays visible. The browser remembers this choice.

### Off-screen marker

An arrow at the screen edge points at each agent with a fresh wait (under 15 min) that is outside the frame, in every camera mode (first person, overview, isometric). An aging or cold wait never gets a marker. Click the arrow to fly to the agent and select it, the same as clicking its row in the triage list; this works even when that agent is already selected. Markers never sit under the side panel. Two or more that would land on top of each other merge into one marker with a count; click it to fly to the oldest fresh wait among them.

Without a status in the session file, every agent is in Working or Idle. `?demo=1` in the URL adds the prototype activity menu to each row. It previews an activity until the next update.

The panel tells you how fresh its data is:

- Before the first answer of the server, the list shows "Loading agents…". After that, an empty list means that no agent runs.
- The footer shows "Updated N s ago". It counts up between polls.
- After 2 failed polls in a row (no answer, an HTTP error or bad JSON), the footer turns amber and adds "retrying". After 5, it turns red and says "Server not reachable". The scene keeps the last known agents. The next good answer clears the warning.
- A subagent at rest gave its final answer, so its label reads "Done", not "Taking a break". A main session at rest keeps "Taking a break".

The **?** button in the panel header, or the **?** key, opens a legend. It explains the beacon, the raised hand, hands on hips, the attention bands, the "Done" label, the "Stuck?" mark, the rooms (building layout only) and the keys. Tombstones, issue cards and hats appear in the legend only while their plugin is active. Esc or the close button closes it. The beacon's meaning is also reachable without opening the legend. The selected agent's card shows the same explanation on its own line whenever its beacon is on. Hovering a figure while its beacon is on shows a small tooltip near the cursor with the same text.

### Location: stations

| Station | Where | Seats | Activities |
|---|---|---|---|
| Coding desks | Two rows in the center | 8 | Implementing, Debugging, Deploying |
| Review desks | Front row | 3 | Reviewing, Writing docs |
| Whiteboards | Back wall | 2 | Planning |
| Bookshelves | Left wall | 2 | Researching |
| Test stations | Right side | 2 | Testing |
| Coffee machine | Front left | 2 | Taking a break (standing) |
| Lounge sofas | Front left | 6 | Taking a break (seated) |
| Meeting table | Front right | 3 | Waiting for you |

- A new agent appears directly at its seat. When its activity changes, it walks to a seat of the new type.
- If the new activity uses the same station type (implementing to debugging), the agent stays where it is and only changes its pose.
- One agent per seat. When no seat of the right type is free, the agent stands on an overflow spot on open floor. It never takes a seat of another type, so the place always matches the activity.

### Position: poses

| Activity | Pose |
|---|---|
| Implementing | Seated, typing |
| Debugging | Seated, scratching the head |
| Reviewing | Seated, hand on chin |
| Writing docs | Seated, writing on paper |
| Planning | Standing, writing on the whiteboard |
| Researching | Standing, reaching for a book |
| Testing | Standing, arms crossed |
| Waiting for you | Standing, gesturing |
| Taking a break | Standing, holding a coffee cup |
| Deploying | Jumping, both hands up |

### Identity: name, color, label

- **Look:** every agent is a chunky, toy-like figure (bigger head, a rounded torso that reaches all the way up to the head, square hands, a thinner forearm than upper arm, slim legs) with two eyes and a mouth that changes shape with the agent's state: neutral at idle, a small "o" while working, and a smile the moment it waits for you. A seeded hair style (tufts, spiky, bun, or none) and a touch of per-agent body width keep a crowd from looking like copies of one mold; both are picked from the agent's own name, so they never change between reloads. A BMAD persona hat (below) still sits on top of the head. Seated on a sofa, a desk chair, or a stool, the figure rests on the seat, not into it.
- **Name:** the session name from the Claude Code session file, when Claude Code or you set it (an automatic `<folder>-xx` name does not count). Otherwise the folder name of the session. Subagents show `>>` followed by their name from the meta file, else their task description, else their type. A name must have 1 to 80 characters after trimming.
- **Color:** one of 8 shirt colors, from a hash of the agent ID, so an agent keeps its color across reloads. A subagent wears its parent's color and stands at 85% of the height. An agent of a mission (issue #125) wears that mission's own pair of colors instead — shirt and hands — picked from the same 8, seeded by the mission's own id, so the pair is the same on every reload and never orange (that color already means "waits for you").
- **Label detail:** with many agents, full labels overlap. By default (mode `smart`) a label is full only when it matters: it is selected, the pointer is on it (in first person with the camera engaged, the screen center), it is within 8 units of the camera in first person, or the agent has a fresh wait for you (under 15 min, in every view). In the overview and the isometric view, an aging or cold wait is not forced full either (its activity line just was not calling for you long enough to earn one), so a real queue of 14 or more waiting agents stays mostly compact there; all labels also become full when you zoom in close (camera distance 14 or less). First person keeps its original rule instead: any wait that is not cold still forces a full label, since its own queue spacing can already overlap on screen and a nearby waiting agent must not lose its activity line. "Your turn" alone does not make a label full, because most idle sessions have it.
- **Declutter:** in the overview and the isometric view only (first person never hides a label), a compact label still has a fixed on-screen size (unlike a room label, which shrinks with distance), so a tight cluster, like a real queue, can still overlap. When two or more labels overlap on screen, only the one that matters most stays: selected, then hovered, then a fresh wait, a stuck mark, an aging wait, a cold wait, any other busy agent, then an idle one (a tie goes to the longer wait). The overlap check uses each label's own rendered size, so a long name cannot escape it; an agent behind the camera is never in the running, so it cannot wrongly outrank one actually on screen. The rest hide and return as soon as the overlap clears, with no flicker or memory of the last pass; the "N waiting" sign over your door still shows the real count. Key **V** or `#labels=all` turns this off too (the original behavior, nothing ever hides). The side panel header shows the mode.

- **Label:** the name and the activity text float over each figure. The side panel lists the same agents (see [Triage list](#triage-list)).

## Fork layout: the growing building

This fork adds a second layout, `building`, and makes it the default. It opens in the overview when the URL and the saved view say nothing. `?layout=activity` or **Shift+L** (then Enter in the confirmation box) returns to the original layout. One L alone does nothing.

- **Your office:** the first room, east of the hall. Agents with a fresh or aging wait (blocked or your turn) walk in and queue in front of your desk: fresh waits first, then aging waits, the longest wait first inside each band. A cold wait leaves the queue for the lounge. When one leaves, the line moves up. The queue has 23 spots in five staggered rows (2.3 m between the spots of a row), so queued agents and their labels stand apart; a 24th wait opens a second waiting room. The office is furnished: a rug under the desk, a credenza and a display shelf behind it, a floor lamp, wall art, a lounge corner (a sofa, two armchairs and a low table) in the front corner away from the door, and eight plants. Nothing stands on a queue spot or in a door path. Over the door of your office (not a second waiting room), on the hall side, hangs your portrait, with "N waiting" under it when agents wait for you.
- **Lounges:** three sofas, a coffee machine and ten plants, tall and small, in the corners and between the sofas.
- **Home desks:** each session gets its own desk for its whole life, from one shared pool (the hall desks, then a rented desk room when those run out). Coding, debugging, deploying, planning, reviewing and writing docs happen there. A mission agent with a war room does those at that room's furniture instead (see "missions: war rooms" below). With the herdr plugin, sessions of one herdr workspace sit at neighboring desks; the building no longer rents a separate room per workspace.
- **Trips:** tests go to a test station, breaks to a sofa or the coffee machine. A main session's own research stays at its desk, no trip at all (issue #128): only the Librarian persona (Prospero, see "bmad: persona hats" below) fetches from the Library shelves. The agent walks back home when desk work starts again. A trip starts only when the new activity lasts 4 seconds, so short tool calls do not make agents walk.
- **Subagents** stand around their parent's desk, researching included; a war room's own subagent stays in that room instead.
- **Library:** the building opens a Library room south-east of the hall, right after your office (issue #120). Rooms are remembered by the order you rent them, not by kind, so for an existing saved building of 3 or more rooms this is a one-time move: the room that used to sit south-east (whichever one you rented third) now sits north-east instead, with nothing about that room itself changed. Its shelves render white, to tell library knowledge apart from any other bookshelf (issue #128). Only an agent running the Librarian persona (the hat plugin's own `librarian` badge, see "bmad: persona hats" below) fetches from them, main session or subagent; everyone else keeps its desk or, inside a war room, that room's own furniture. With the `library` plugin, librarian subagents (types in `AGENTS_OFFICE_LIBRARIAN_TYPES`, default `bibliotheque-librarian`) also carry a book while they research.
- **Growth:** when a kind of station runs out, the building adds a room of that kind next to the others: desks, library, test lab, lounge, or another waiting room. Rooms are never removed, and the browser remembers them.
- **Wayfinding:** each room has a name label above its center ("LIBRARY", "LOUNGE 2"). In the overview the label keeps a readable size on screen and draws on top, with short lines ("DESKS" / "WS10"); zoom in or point at the room for the full name. A line too long for the compact face cuts in the middle, not the front (`middleEllipsis` in `src/addons/building/roomLabels.ts`), so two names that share a long prefix still read differently (issue #87). In first person it is a small plate high in the room: walls hide it, and the label of the room you stand in hides. Lounges are numbered in the order the building adds them. Each door has a frame (two posts and a lintel) in the room's floor color.
- **Furniture library:** code builds every piece; nothing is loaded from a file. `src/furniture/index.ts` lists each piece (`PIECES`), and `src/addons/building/furnishing.ts` holds one plan per room kind with the pieces and their positions.
- **Cut-away walls:** in the overview and the isometric view, the room and hall walls drop to 0.5 m and the door frames to 1.2 m, so you see each room floor, the figures in it and the doors. First person keeps the full walls.

### Your portrait

A framed picture hangs over your office door. Without a picture it shows a neutral silhouette.

```bash
AGENTS_OFFICE_PORTRAIT=/path/to/me.png pnpm dev:fork
```

- **One manual step:** save your picture (for example your Slack photo) to a local file once. The office makes no network call for it: the browser asks only this server (`GET /api/portrait`), and the server reads only that file.
- The file must be a PNG, JPEG, WebP or GIF of at most 2 MB, and its first bytes must match its extension. SVG is never served. Any other file, a folder or a missing file gives the placeholder (the route answers 204).
- Do not commit a personal picture to the repository.

### Floors (issue #118, step one)

Each session's floor is resolved from its own working directory, server-side: the git repository that holds it (a worktree resolves to its main repository), named from its own `origin` remote when it has one (`owner/repo` for GitHub, the last group and the repo name for a GitLab URL at any subgroup depth), else its directory name qualified by its parent directory when that fits the whitelist too (`org/repo`, so two repos that share a leaf folder name under different organizations, for example two separate `project-management` checkouts, resolve to two different floors). A session with no resolvable repository lands on the shared `general` floor.

The default view, on a fresh page load and whenever nothing else is chosen, is **All floors**: every agent shows, exactly as before this feature existed — the one shared building, the one shared room list, no filter at all. This is deliberate: a fresh page load has not polled any agent yet, so there is nothing to pick a specific floor's room list from before the first poll answers, and the one place meant to catch every waiting agent must never silently narrow to one repo by default. A floor switch menu in the panel header lists **All floors** first, then every floor with a tracked session right now, plus the focused one, plus every floor with its own stored room list even with zero live agents on it right now — a quiet floor (one you already grew, or one a renamed repo left behind) is never dropped from the menu, so you can always leave it yourself, and the office never forces a reload off it on your behalf. Choosing a specific floor remembers it and reloads the page focused there, the same "the page reloads" pattern **Shift+L** already uses for a layout switch. `#floor=<name>` in the URL opens directly on that floor (`#floor=all` for the default); otherwise the last floor you visited, else All floors. Once a specific floor is focused, an agent on any other floor is not added to the scene at all — except one that is waiting on you (issue #192): it still shows, in your office's own queue and in the triage panel, tagged with its own floor name, without its floor's rooms or any other session on it ever rendering. Every other floor's room list stays as saved state (its own `localStorage` key) until you switch to it. All floors itself keeps using the same room-list key the building always used before this feature, so choosing it back costs no migration and loses no data.

A focused floor also narrows the mission war rooms and the GitHub kanban boards (issue #191, step two of three) to that floor's own repo: a mission's own repo comes from the GitHub issue it is tied to, or failing that its own mission-record directory; a kanban board is already one per configured repository. All floors keeps showing every war room and every board, unchanged. A room or board whose own repo cannot be resolved at all shows only on All floors, never guessed onto one. Two repos that share a leaf name under different owners (or different GitLab groups) still land on their own floor: the match compares the full owner/repo whenever both sides know one, not just the repo name. The legacy single-building room list becomes the first specific floor you ever focus, once, so nothing you already grew is lost.

The library's own per-floor index (also part of issue #191) is a later step, not built yet. Gabriel's one personal office and its cross-floor waiting queue (issue #192, step three) are built: see "The lobby" below.

### The lobby and the cross-floor waiting queue (issue #192, step three)

Gabriel has one office, not one per floor. It is room 0 of whichever floor's building is on screen — always the same physical spot, and always built first, even from an empty or malformed stored room list — so switching floors never rebuilds "your office" differently from one floor to the next, only the rooms around it. An agent waiting on you from another floor queues there too: it is kept in the scene (the one carve-out to the "other floors do not render" rule above), walks straight to a queue spot the same way a local agent does, and its triage panel row and the queue's own entries carry a small floor tag so it never reads as a local session. Selecting it opens its card the same way as any other agent, without changing the focused floor. The waiting-list desk monitor (issue #161) already mirrors the full triage queue, so it shows every floor's waiting agents regardless of which one is focused.

## Plugins

Optional plugins add data from other tools. None run by default.

```bash
AGENTS_OFFICE_PLUGINS=name1,name2 pnpm dev
npx agents-office --plugin name1 --plugin name2
```

A plugin is a folder `plugins/<name>/` with an `index.ts` (server: sources, enrichers, rooms and boards) and an optional `client.ts` (browser rendering). The server copies only whitelisted, cleaned fields to the browser.

`pnpm dev:fork` starts the office with the plugins of this fork (`herdr`, `github`, `bmad`, `missions`, `library`, `peek`, `skills`, `floor-library`) and turns on herdr focus (`AGENTS_OFFICE_HERDR_FOCUS=1`).

### bmad: persona hats

The `bmad` plugin shows which BMAD personas an agent plays. Each persona the agent loaded gets a toon hat on the figure's head. The hats stack in the order the agent loaded the personas: Sally wears a beret, Winston a hard hat, Amelia a beanie, Quinn a detective cap, John a top hat, Mary a graduation cap, Bob a baseball cap, Dexter a deerstalker, Leo a crown, Atlas a miner helmet, and Prospero (the Bibliothèque Librarian, issue #149) a small stack of books with a bookmark. Other personas get a colored party hat. The figure shows up to 4 hats and a `+N` marker for the others. The label adds the persona names to the activity line, for example "Researching · Sally, Winston".

Only tool calls count: a Bash call to `bmad.py agent <name>`, a Skill call for a persona (or `bmad` with the persona as the first word), or a subagent whose type is a persona. Text in prompts or answers never counts, and `bmad.py resolve` or `list` does not count. The plugin reads only the bytes that the transcript added since the last poll (at most 4 MB per poll). The API gets only the persona ids as badges.


### skills: used skills in the agent card

The `skills` plugin lists every skill an agent used at least once this session, next to its personas in the card's "Persona / Skills" row. Only a `Skill` tool call counts, read incrementally from the same transcript bytes `bmad` reads; a skill name in a prompt or an answer never counts. Without this plugin loaded, the row falls back to showing personas only.

**Equipment catalog v1 (issue #167):** the same plugin also equips a small held item in the right hand, for the single newest-introduced entry across both `extras.skills` and `extras.tools` (below), and an independent face item (glasses or headphones) tied to skill variety, not to the single newest one. The head stays the persona hat's slot — a skill or tool item never competes for it. Max 2 items show on the body at once (1 hand, 1 face); the full skill list still shows on the card, so nothing is lost, only trimmed from the body. This round covers 9 skill-triggered hand items (a wrench for `git`, a clipboard for `jira` or `klever-mr`, a gavel for `crit` or `adversarial-cascade`, a loupe for `code-review`/`pr-review`/`security-review`, a stamp for `bibliotheque-librarian` or `notion`, a small easel for `dataviz`, an open book for `research`, a magnifier for `investigate`, and a hashed-tint toolbox for any other skill), 3 more raw-tool-triggered hand items (below), and 2 face items (headphones for `klever-test`/`ui-probe`/`agent-browser`, glasses once an agent has used 2 or more skills). Every hand item is scaled up from its raw template so it reads at the default isometric distance, a transform on the clone, never a new geometry. The rest of the spike's catalog (roughly 15 more entries, the back slot, and the max-3-items rule with a back item) is a later round.

**Raw tool activity (`extras.tools`, issue #167 round 2):** `extras.skills` only ever carries a `Skill` tool's own slug, never a raw built-in tool name — the spike's own search/bash/edit items need a different kind of signal. The `skills` plugin's server half now also tracks a fixed allow-list of built-in tool calls (`Bash`, `Grep`, `Glob`, `Read`, `Edit`, `Write`, `WebSearch`, `WebFetch`, `Task`), newest-introduced last, the same convention as `skills`. 3 new hand items key on it: a small screen held up for `Bash`, a pencil for `Edit` or `Write`, and a globe for `WebSearch` or `WebFetch`. `Grep`/`Glob` reuse the existing magnifier (the same shape `investigate` already uses) and `Read` reuses the existing open book, tinted apart from `research`'s the same way `jira` and `klever-mr` already share one clipboard — neither spends a new bucket. `extras.lastEquipSource` (`'skill'` or `'tool'`) says which list had the more recently introduced entry, since the two lists carry no shared ordering of their own; without it (an older server), a named skill wins over an incidental tool call when both are present.

**Tool crib:** a small counter in the hall (`src/furniture/ToolCrib.ts`), with a wrench, a toolbox and a magnifier standing on it — the physical home the equipment catalog's items above come from. A static prop like the water cooler or the printer: no shadow, merged into the hall's one draw call per material. No trip yet: an agent's equipped item still appears the moment its skill list changes, with no walk to the crib first. A visit here (a dedicated trip, a short dwell before the item shows, the same shape as the existing trips to the test station or the coffee machine) would touch the activity/trip system, not just this plugin, and is a follow-up, not part of this round.


### GitHub: kanban board and issue cards

The `github` plugin hangs a kanban board for each repository on the office wall. An agent wears a card for each issue it works on, like a badge on its shoulders and upper arms.

```bash
AGENTS_OFFICE_GITHUB_REPOS=gabriel-amyot/agents-office pnpm dev:fork
AGENTS_OFFICE_GITHUB_REPOS=owner/one,owner/two npx agents-office --plugin github
```

- **Opt in twice:** the plugin must be loaded, and `AGENTS_OFFICE_GITHUB_REPOS` must name one or more `owner/name` repositories. Without the variable, the plugin adds nothing and runs nothing.
- **Data:** the plugin runs `gh issue list` (the [GitHub CLI](https://cli.github.com/)) with fixed arguments, a 5 s limit and no shell. gh handles the login, so Agents Office never reads a token. Results stay in a cache for 60 s per repository. The agents call fills a cold cache too, but waits at most 1.5 s for it. If gh is missing or fails, the board keeps the last good data, or does not appear.
- **Columns:** "To do" holds open issues with no assignee and no in-progress label. "In progress" holds open issues that have an assignee or an `in-progress` or `doing` label. "Done" holds up to 8 issues closed in the last 7 days. Each column is newest first.
- **Board:** up to 4 boards. The first hangs on the right part of the back wall, the next ones on the right wall (`KANBAN_BOARD_SLOTS` in `plugins/github/client.ts`).
- **Issue cards:** the plugin reads the agent's own tool calls, never the prompt text: `gh issue view|comment|edit N`, a git branch that starts with `N-` (`git switch -c`, `git checkout -b`, `git worktree add -b`), and `#N` or `owner/repo#N` in a `git commit` message. The agent wears the 5 most recent issues. The newest sits on the shoulder nearest the camera, the next on the other shoulder, then the upper arms. The hands stay free. A card shows `<repo>#N`, for example `agents-office#77`, when the issue belongs to a configured repository (found on its board, or named with `-R` or a URL). Otherwise it shows `#N`. The cards stay upright and turn to the camera in every pose: typing, walking, idle and with the hand raised.
- **IDs in the label:** a card is small from the overview, so the floating label of the agent adds one line with its issue IDs, for example `agents-office#77 · #79`. The repository shows once while it stays the same. The line shows at most 5 IDs and ends with `+N` when it is too long. Compact labels keep this line, so the overview shows the IDs.
- **Border color:** the color of the issue's label. With several labels, a `wayfinder:*` label wins, else the first label. An issue without labels gets a neutral border.
- **What leaves the server:** issue numbers, titles (60 to 80 characters), column names, the short repository name and the label color as `rrggbb`. Label names never leave the server.


### herdr plugin

For sessions that run in [herdr](https://herdr.dev) panes. Each Claude session shows the name of its herdr tab. The session and its subagents get a group: the herdr workspace. Subagents keep their own `>>` names.

What it reads:

- `ps eww -o pid=,command= -p <pids>` once for the session processes it has not seen yet. From that output it keeps only `HERDR_PANE_ID`, `HERDR_TAB_ID` and `HERDR_WORKSPACE_ID`. It keeps or logs no other variable.
- `herdr tab list` and `herdr workspace list`, at most once every 10 s.

These commands are read-only. They run through `execFile` with fixed arguments and a 1.5 s timeout, never through a shell. If herdr is not installed, a session is not in herdr, or a command fails, the session keeps its normal name and has no group. Raw herdr IDs stay on the server: the API sends only a hashed group ID and the cleaned labels.

Enable it:

```bash
AGENTS_OFFICE_PLUGINS=herdr pnpm dev   # or: pnpm dev:fork
```

### herdr focus (write action)

This is the only action in the office that changes something on your machine. It is off by default.

What it does: select an agent that runs in a herdr pane. The agent card shows a **Focus in herdr** button. For a subagent, the button focuses the pane of its parent session. A click moves the herdr focus to the pane of that agent (`herdr agent focus <pane>`). If herdr does not detect an agent in that pane, it focuses the tab (`herdr tab focus <tab>`). A short text message shows the result. The action does not type text, send keys or answer a prompt. It changes the focus inside the herdr window only. It does not bring the terminal window to the front.

Enable it:

```bash
AGENTS_OFFICE_PLUGINS=herdr AGENTS_OFFICE_HERDR_FOCUS=1 pnpm dev
```

`pnpm dev:fork` sets `AGENTS_OFFICE_HERDR_FOCUS=1`. The button still acts only on your click.

Without `AGENTS_OFFICE_HERDR_FOCUS=1`, or without the herdr plugin, the server has no write route, no token and no button. The API stays GET only.

Controls:

- **One route:** `POST /api/actions/focus` with the body `{ "agent": "<public id>" }` and nothing else. The browser never sends a pane ID, a path or a command.
- **Local only:** the same loopback and Host checks as the GET routes.
- **Same origin:** the `Origin` header is required and must equal the dashboard origin. A cross-site `Sec-Fetch-Site` is refused.
- **JSON only:** another `Content-Type` gets 415. A body over 1 KB gets 413.
- **Token:** the server makes a new random token at each start. The page reads it from `GET /api/actions/token` (same checks as the other GET routes) and sends it in the `X-Agents-Office-Token` header. The server compares it in constant time. A missing or wrong token gets 403.
- **Rate limit:** 10 requests per minute. More get 429.
- **Re-check:** the server maps the public ID to the pane on the server side. Before it acts, it reads the process environment again and asks `herdr pane get`. If the process left the pane, or the pane is gone or moved to another tab, the answer is 409 and herdr is not called.
- **No shell:** `execFile` with fixed arguments and a 1.5 s timeout. Pane and tab IDs must match a strict pattern.
- **No framing:** with the action on, every page has `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`.
- **Audit log:** one JSON line per attempt (time, action, public agent ID, result), in `AGENTS_OFFICE_AUDIT_LOG` or `agents-office-audit.jsonl` in the OS temp folder. The file has mode 0600. It never holds the token or a raw herdr ID.

### missions: war rooms

The `missions` plugin turns each mission record (`<root>/missions/<slug>/mission.yaml`) into a war room in the building's mission wing, north of the hall. Every war room's door opens directly onto the mission corridor running between the wing's two columns (issue #123): no room is reachable only by crossing another room's door, and the corridor itself grows north with no cap on how many war rooms the wing can hold.

```bash
AGENTS_OFFICE_MISSION_ROOTS=/path/to/project-management pnpm dev:fork
```

- **Who works there:** a session joins a mission's room when its own tool calls touch that mission (a `mission` script command with the slug, or a file under `missions/<slug>/`). Its subagents stand near it. A session that waits for you still goes to your office first. An idle session of the mission relaxes in the main room's own lounge instead (issue #209): a war room is a work space only, so it has no sofa to send it to.
- **Furniture:** every war room furnishes from one rule set (issue #125, revised #209): a base work set from the start, even with no agents yet — one workstation (desk), one debug station, a bookshelf and a whiteboard, no sofa and no coffee table — plus a water cooler once 4 or more live agents work there, a TV and an optional low divider once 6 or more do. Desks and debug stations grow with the peak number of agents actually implementing, reviewing, testing, debugging or writing docs there, up to 8 (issue #193: a war room is wider than a generic room, `WAR_ROOM_WIDTH` in `src/addons/building/warRoomFurnishing.ts`), and never shrink back when they leave. A debugging agent gets a green-screen debug station instead of a blue desk, sharing the same grid. The grid clears the room's real door lane and the room's own meeting table and standing ring. Placement is seeded by the mission id, so a reload furnishes the same room.
- **Walls:** the mission statement, the documents, the GitHub issues and a kanban of the mission's threads (needs you, open, done), on the far wall, never on the door frame.
- **Past sessions:** one small tombstone per finished session (up to 12), and a count. A session that returns removes its own tombstone, by id, not whichever is oldest. The stone carries the session's own name engraved near the bottom of its grey face: a texture decal flush with the stone, not a floating sign (issue #159) — no hover needed, no DOM element, visible whenever the stone itself is, one shared draw call for every tombstone's name in the whole office.
- **Tombstone story (issue #160):** a click on a tombstone opens a card (the same look as the agent card) with the session's story: when it ended, the personas it wore, its intent, a done/open/abandoned count plus its done list, its handoff file names, and the issues it is tied to. The story is read once, server-side, from the session's own archived record (`sessions/archive[/done|/abandoned]/<slug>/intent-tree.md` under `AGENTS_OFFICE_MISSION_ROOTS`) — never the live ledger, a transcript or a prompt. Free-text fields (the intent, the done list) have any path-like content redacted before they ever leave the server. An issue naming a repository but no owner still shows, as plain text, when its owner cannot be resolved (see `AGENTS_OFFICE_GITHUB_REPOS`/`AGENTS_OFFICE_GITHUB_OWNERS` just below); a session with no linked issue yet shows "No issue yet", not a blank row; a session with no archived record at all shows "No session record found."
- **GitHub owner resolution (issue #160 review):** a real archived record's own issue refs are usually a bare `repo#N`, with no owner at all. `AGENTS_OFFICE_GITHUB_REPOS` (comma-separated `owner/repo` pairs) resolves a bare ref to a link when exactly one configured repo has that name; `AGENTS_OFFICE_GITHUB_OWNERS` (comma-separated default owners) is the fallback when exactly one default owner is configured. Neither is required — without them, a bare ref still shows, just without a link.

  ```bash
  AGENTS_OFFICE_PLUGINS=missions AGENTS_OFFICE_MISSION_ROOTS=/path/to/project-management \
    AGENTS_OFFICE_GITHUB_REPOS=gabriel-amyot/agents-office pnpm dev:fork
  ```
- **Signs:** the room name is a large label above the room, like the other rooms. The small title sign shows only when you zoom in (overview camera distance 24 or less), come near it in first person (12 units), or point at the room. The past sessions count sign shows only when you point at it. `#labels=all` (key V) shows all signs. The "You" sign at your desk follows the same rule. (Each tombstone's own engraved name is not one of these signs: it is baked into the stone's own face, not a CSS2D detail sign, so it is not part of the smart/all label system at all.)
- **Closed missions:** the room locks, its door closes and no agent goes in. The room stays.
- Without `AGENTS_OFFICE_MISSION_ROOTS`, the plugin adds nothing. It reads files only, with a size cap.

### floor-library: a floor's own shelves (issue #191 AC1, #119)

The `floor-library` plugin reads one fixed path under each configured root — `documentation/bibliotheque/INDEX.md` — and, when it is there, shows that floor's own documentation as shelves in the library room.

```bash
AGENTS_OFFICE_PLUGINS=floor-library AGENTS_OFFICE_LIBRARY_ROOTS=/path/to/project-management pnpm dev:fork
```

- **One floor, one convention:** this never walks a repo looking for "a" documentation folder under any name or location. A root with no `documentation/bibliotheque/INDEX.md` gets no library room content at all (graceful degradation); a root that grows that structure later picks it up for free, with no code change.
- **Sections come from the index, not the folder (Prospero's rule, #119 review):** a section is a top-level `<name>/INDEX.md` the top index links to, never a raw directory walk — a working folder (an inbox, a drafts area) that the top index does not link never becomes a shelf. Entries come the same way, from that section's own `INDEX.md` table rows (`| [Title](link) | Description |`); a row whose title, description or link mentions "archived" or "superseded" keeps a visible `(archived)` mark rather than being dropped.
- **Per floor, never guessed:** each root is tagged with its own floor, the same `matchesFloor` rule `missions` and the GitHub kanban boards already use. On "all floors" (the default view every cold start lands on) there is no one focused floor to key "the focused floor's library" off: with exactly one library configured it shows anyway, rather than hiding the whole feature behind a floor switch; with more than one, every library's sections list together instead of guessing which floor matters most.
- The launcher config file (`~/Library/Application Support/AgentsOffice/launcher.env`) can also set `AGENTS_OFFICE_LIBRARY_ROOTS`, the same comma-separated shape, so the macOS launcher app picks it up without a terminal.
- **Shelves, not a canvas board:** the library room always exists (`BuildingLayout` rents it right after the office), so this is a self-contained extension that attaches to it, the same pattern `plugins/jira` already uses for the office's own wall board — no change to `RoomPlanner.ts`/`BuildingLayout.ts`. Each section gets a name plaque (visible near or zoomed in, like a room label) and an entry board (its own titles, visible on hover/pointed-at, like a mission room's detail signs) in the room's own clear far-wall gap. Both are `CSS2DObject` text, so they add zero draw calls.
- Capped: top-level sections (8), entries per section (6) and shown shelves (3), sizes capped at the server (names 32 characters, titles 80).

### peek: recent lines, assets and equipment in the agent card

The `peek` plugin adds three sections to the agent card: "Recent", "Assets" and "Equipment". It is off by default. `pnpm dev:fork` turns it on.

```bash
AGENTS_OFFICE_PLUGINS=peek pnpm dev
```

- **Recent:** the last 10 lines of the selected agent, newest at the bottom, each 200 characters or less. A line is assistant text or a tool call. A tool call shows only its name and a short summary (for example `Bash · git commit`, `Edit · app.ts`, `Skill · tdd`), never its input. Prompts and tool results never show. When the agent waits for you and its newest line is its own text, that line is pinned on top in an amber box.
- **Masking:** the server masks secret patterns before it cuts a line: GitHub, GitLab (also runner, deploy and trigger tokens), Slack (also webhook URLs), Anthropic, OpenAI, Stripe, npm, Hugging Face, AWS and Google tokens, JWTs and private key blocks. It also masks `key=value`, `key: value` and JSON `"key": "value"` secrets, `password:` phrases to the end of the line, command-line passwords (`-p…` for mysql, `sshpass -p`, `--password`), bearer tokens, the password in `scheme://user:password@host`, long hex runs, random-looking base64 runs (also with `/`, for example AWS secret keys) and emails. White space collapses before the cut, and a cut never splits a `[secret]` placeholder. Masking is a best effort, not a guarantee: a token split across two lines is masked only when its first part starts with a known prefix.
- **Assets:** up to 10 links found in the agent's tool calls, newest first: GitHub issues and pull requests, GitLab merge requests and Jira keys. A Jira key links only when its prefix has a site. The default map is `KTP` and `INS` to `https://beklever.atlassian.net/browse/` and `SPV` to `https://origin8cares.atlassian.net/browse/`. `AGENTS_OFFICE_PEEK_JIRA=ABC=https://example.atlassian.net/browse/,XYZ=...` replaces it.
- **Equipment:** the skills the agent used (Skill tool calls), its personas (badges) and the repositories it changed (Edit and Write calls, git commit, push and similar), as short repository names. A worktree shows the name of its main repository. Never a path.
- **Only on request:** the card asks `GET /api/views/peek?agent=<public id>` for the selected agent only: when you select it, then every 5 s while the card stays open. The refresh stops when the card closes. The route has the same loopback, Host and Origin checks as the other routes. It answers GET only (POST gets 405), 400 for a malformed ID, and 404 for an unknown agent or when the plugin is off. `/api/agents` and `/api/world` never carry transcript text.
- **Reads:** the plugin reads the end of the transcript (2 MB) the first time, then only the new bytes (at most 4 MB per request).
- **Screen sharing:** Recent shows file base names and web hosts, and Assets show internal hosts and Jira keys. A private mode (#91) can hide all peek sections through `setPeekTextHidden` in `plugins/peek/client.ts`.


### jira: personal sprint board in the CEO office

The `jira` plugin hangs a board in your own office listing your open-sprint tickets, key, summary, status and (when Jira has them) priority and assignee. It is off by default and read-only: it makes one `GET` call to the Jira Cloud search API per poll, at most every 2 minutes.

```bash
AGENTS_OFFICE_JIRA_BASE_URL=https://your-site.atlassian.net \
AGENTS_OFFICE_JIRA_EMAIL=you@example.com \
AGENTS_OFFICE_JIRA_TOKEN=your-api-token \
AGENTS_OFFICE_PLUGINS=jira pnpm dev
```

- **Opt in twice:** the plugin must be loaded, and it needs all three credentials. Without them, it adds nothing and calls nothing, the same as the GitHub plugin without a repository.
- **Credentials:** `AGENTS_OFFICE_JIRA_BASE_URL`, `AGENTS_OFFICE_JIRA_EMAIL` and `AGENTS_OFFICE_JIRA_TOKEN` ([an Atlassian API token](https://id.atlassian.com/manage-profile/security/api-tokens)), else a local JSON file `{"baseUrl", "email", "token"}` at `AGENTS_OFFICE_JIRA_CREDENTIALS_FILE`, else `~/.config/agents-office/jira.json`. The base URL must be `https://`, except a loopback host (`localhost`, `127.0.0.1`) for a local mock during development. The token never reaches the browser, a log, or this file.
- **Scope:** the open sprint, tickets assigned to the authenticated user (`sprint in openSprints() AND assignee = currentUser()`). Not configurable yet; the project's decision record leaves this as the default until there is a reason to widen it.
- **Board:** a plain canvas board, like the GitHub kanban boards, on a side wall of your office (the `building` layout's first room). Not a clickable list: making each row open its link would need a new DOM-over-3D interaction layer the office's other boards do not have, with real risk of swallowing clicks meant for a figure or the free-camera pointer lock. A future issue can revisit this once a plugin earns it.
- **Desk-view mirror (issue #161):** the desk view's right-hand monitor mirrors this board (key and status). It only mounts while there is Jira data; without it, the monitor is simply not there, the same graceful degradation as the wall board itself.
- **Links:** `<base URL>/browse/<KEY>`, built from the key only, computed on the server.
- **What leaves the server:** the key, the summary (80 characters), the status (32), and optional priority (16) and assignee (40), plus the link. Never the token, the email, or any other Jira field.
- **Ceremony boards:** a sprint board, a focus board and a retro board are a separate, lower-priority open question (issue #145's own tracker) until Gabriel gives content for at least one. Not built yet.

## Controls

- **Click** to engage camera
- **W/A/S/D** or **Arrow keys** to walk, on the ground, with gravity (issue #174: no flying). Double-tap **W** to run
- **Shift** to crouch: a lower eye height and a slower walk
- **Space** to jump; gravity brings the camera back down to its eye height, standing or crouched
- **Mouse** to look around
- **Esc** to release camera
- **L** to switch the layout, when more than one is installed (also `?layout=<id>` in the URL)
- **I** to switch to the isometric view, and **I** again to go back to first person. The isometric view shows the whole building from above with an orthographic camera at the classic isometric angle (35 degrees above the floor, 45 degrees to the walls), so far rooms are not smaller than near rooms. Drag or W/A/S/D to pan, the mouse wheel to zoom toward the pointer, a click on a figure to select it, a double-click on a room to enter it in first person, standing inside it facing its main wall (issue #175). There is no overview mode and no **O** key (#173): first person, the isometric view and the desk view (below) are the only views. The pan and zoom limits follow the building as it grows or shrinks (a room rented or a floor switched) and the window is resized, without a jump (issue #113): a wheel tick, a drag or a selection in flight all keep easing toward wherever they were headed, even while the limits themselves are changing underneath them.
- **H** jumps to the desk view: a fixed camera at your own desk, a little lower than a standing first-person pose so the desk and its two monitors stay in frame, with your waiting queue beyond them (issue #161). It uses a wider field of view than first person, and sits a little farther back, so every queue spot stays in frame even with the office full (issue #199); the wider lens applies only in this view and reverts on the way out. Two small monitors sit on the desk: one mirrors the triage panel's waiting list (always on), the other mirrors the personal Jira board (the `jira` plugin, only while it has data). The view never engages the pointer lock, so the cursor always stays free, and it never moves itself: no WASD, no mouse-look, no gravity. Click a figure to select it; a click that misses only clears the selection, the same as first person, and never engages the camera or switches view. The office also settles into this view on its own after a while with no camera input — any key, click, drag or scroll resets the clock. Press **H** again (or **I**) to leave. `#view=desk` in the URL starts here; without a desk to show (a layout with no rooms), the key, the URL hash and the idle timer are all a no-op and the view stays where it was.
- **Click a figure** to select it (in the isometric view, or in first person before you engage the camera). A click on a row in the triage list also selects it. The camera flies to the selected agent and a ring in its color marks it on the floor
- **N** selects the next agent in the triage queue (the fresh or aging attention bands, in the same order as the panel's needs-you/your-turn groups), cycling back to the first past the end. A cold start, or a current selection that left the queue, goes to the first agent in the queue
- **Esc** clears the selection (in first person it first releases the camera). A click that misses every figure clears it too, the same as Esc (a drag release never counts as that click; a click while the first-person camera is engaged looks around instead, per issue #133)
- **Agent card:** a selection opens a card left of the triage panel. It shows the name, a short stable id next to it, the activity (attention-overridden the same way as the panel row and the floating label — "Waiting for you" or "Your turn", never a raw activity like "Taking a break", while attention is set), the attention band and wait, the herdr workspace, the provider (a small logo mark next to the "Codex"/"Claude Code" text, a rounded square for Claude Code and a hexagon for Codex), a "Persona / Skills" row (every persona badge, then every skill the agent used this session — without the `skills` plugin the row falls back to personas only), the subagents (a click selects one) and up to 10 linked issues, newest first, or "No linked issues". An issue reads `<repo>#N` when the server knows its repository. With the github plugin, such an issue of a configured repository is a link to GitHub. An issue number alone never links. With the `peek` plugin, the card also shows Recent, Assets and Equipment (see the peek plugin). The card updates in place on each poll. A click on another agent changes the card content. Esc or the close button closes it. The camera puts the selected figure in the free area left of the card. The floating label over the agent's figure shows the same short id on its own line, hidden in compact labels
- **F** recenters the camera on the selected agent (or flies to the first agent in the queue when none is selected) and highlights the card's "Focus in herdr" button for about 1.5 s, without sending the request: a click on the button still does that, per the decision on issue #85 (AC2/AC3)
- **V** to switch the labels between `smart` (the default) and `all` full labels. `#labels=all` in the URL starts with all labels
- **/** gives the triage panel's filter field the focus, opening the panel first if it is collapsed. Typing hides rows whose name and activity do not match, case-insensitively; an empty filter shows every row again. Shift+/ (`?`) still opens the legend, not the filter
- **?** to open or close the legend (also the **?** button in the panel header). Esc closes it without a change to the selection

- `?dwell=<seconds>` in the URL (0 to 30, default 0) makes an agent in the original `activity` layout wait that long before it walks to a new station. A change back before the time cancels the walk. The figure shows the new activity at once.
- The office remembers the last view (first person, isometric or desk) in the browser and opens in it after a reload — including a desk view the idle timeout itself settled into. `#view=first-person`, `#view=iso` or `#view=desk` in the URL wins over the saved view. An unknown or no-longer-supported view name (`#view=overview`, for example) is treated like a missing hash: the saved view wins next, then the layout's own default (isometric for the building layout, first person otherwise), not first person outright. The side panel header shows the layout and the view.
- First person has no horizontal bounding box: you can walk through every doorway into a room. It no longer flies (issue #174): the camera walks the ground at a standing agent's own eye height, with gravity, and Space only jumps. There is no wall collision yet (no collision layer exists in this fork to stop against).
- Every room (your office, the library, a lounge, a war room, and the main room) has a ceiling and walls as tall as the main room's, in first person. The isometric view keeps no ceiling, so the rooms still read from above (issue #176).
- **Shift+L** switches the layout after a confirmation (the page reloads). The layout choice is saved too.
- `#view=iso` in the URL starts in the isometric view. `#select=<agent id>` (`#focus=`, its older name, still works) selects that agent when it appears (agent IDs change when the server restarts). `#zoom=<distance>` starts the view at that camera distance instead of its own default framing; the number is the same overview-equivalent distance the side panel's zoom reads (issue #89)
- `#room=office`, `#room=library` or `#room=<mission id>` frames that room instead, in whichever view you start in: the isometric view flies to the room's bounds, first person stands inside it facing its main wall. Useful for a screenshot of a room's boards without hunting for it by hand. Read-only, and ignored when the name matches no room (for example the fork's building layout is not active, or that room has not opened yet). `#room=office` always means your own office, never a later overflow waiting room (issue #89)

## Architecture

```
~/.claude/sessions/*.json → Vite middleware → GET /api/agents → Browser polls every 3s → 3D scene updates
```

- **Server**: Vite plugin reads Claude session files, validates PIDs, combines the session status with the newest tool call of the session's own transcript, and detects that session's active subagents
- **Client**: Three.js scene with toon-shaded stick figures, station-based layout, walking animations, and per-activity poses
- **Rendering**: static furniture draws merged (one mesh per material), figure parts and BMAD hats draw instanced, and shadow maps redraw only when a caster changes. No pose has a continuous sway (#163): idle, testing, debugging, deploying and meeting all hold still once settled. Idle, testing and planning each add one or more occasional canned clips on top of that still pose instead (#164: a stretch, a phone check or a look around while idle; praying while testing; sketching while planning) — short, rare per figure (seeded by the figure itself, so a room never moves in lockstep), and off while a figure sleeps, so the idle render rate stays close to the no-clip cadence on average. A figure that bobs a beacon in place (a fresh or stuck wait) still redraws the shadows at most twice per second; a walk redraws them on each frame. Figures out of view or far from the camera skip their steady-state animation update: they still walk, and they still show their activity pose and a raised hand at once. Frames render on demand, at most 30 per second, and once per second when nothing moves, a crowd of idle agents right in front of the camera included. The overview and the isometric view use at most 1.5 pixels per CSS pixel and hard shadows. At 25 rooms and 40 agents (20 with hats, 10 with cards) a frame takes about 306 draw calls in first person and 325 in the overview and the isometric view (shadow pass and room labels included) instead of about 10,000; a hat casts no shadow (#96, #98), so a persona hat or a party hat costs the main pass only. The worst case the budget test checks (200 GitHub cards, no camera culling) is 364. `pnpm measure` prints the count; `?debug=1` exposes `window.__officeStats` (renders, draw calls, render times, camera position, view mode)

## Requirements

- Node.js 22.12+
- One or more running Claude Code sessions to visualize

## License

MIT. See [LICENSE](LICENSE). The original Agents Office is by Juan Cernadas; this fork adds changes by Gabriel Amyot under the same license.
