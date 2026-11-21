# Changelog

## Unreleased

### Security

- Validate session files and probe processes without a shell
- Render agent labels as text
- Restrict the API to loopback, with Host and Origin checks, minimal fields and opaque IDs
- Update Vite to 8.3.8 and refresh vulnerable dependency resolutions
- See `docs/security-validation.md`
- herdr plugin: opt-in focus action (`AGENTS_OFFICE_HERDR_FOCUS=1`), the first write route, with token, Origin, rate limit and audit log

### Fixes

- The isometric view's pan and zoom limits now follow the building as it grows or shrinks and the window is resized, without ever jumping the camera: one goal pose every input (wheel, drag, cursor zoom, a selection, a bounds change) edits, and one damped follower that eases the live camera toward it every frame, with no tween to go stale when the goal changes again mid-chase
- Each session reads its own transcript; sessions in the same folder no longer share one activity
- Subagents show once, under the session that started them
- Agents without a free seat of their type stand on an overflow spot instead of piling up at the origin or taking a seat of another type
- Long transcript lines and lines across read-chunk edges are parsed
- Sessions in folders with a dot in the path are found
- One poll at a time, with a 5 s limit
- Arm and head rotations reset between poses
- Docs match the code (22 stations, no mock fallback, test commands)
- GitHub plugin: issue cards move from the hand to the shoulders and upper arms, like badges. They stay upright, turn to the camera, read `<repo>#N` and take the issue label color as border. All cards draw in one call. The floating label shows the issue IDs, also in the overview
- A small waiting queue stands mirrored around the center instead of one agent dead center and the next offset to a side

### Changes

- War rooms widen to fit 6-8 desks (up from 4): the door-wall extent grows (`WAR_ROOM_WIDTH`), the meeting table, tombstone strip and far wall keep their exact old placement (issue #193)
- First person: room, hall and war-room walls stop the camera; doors stay open, and sliding along a wall feels natural instead of sticking (issue #194)

- Use the session file status: waiting shows "Waiting for you" at the meeting table, idle shows a break, busy while thinking shows planning
- Better tool mapping: AskUserQuestion, Skill, ToolSearch, MCP tools, and shell commands classified by the programs they run
- Subagents stay visible during a long tool call (up to 10 minutes)
- Stable agent colors from a hash of the agent ID
- Labels show the same friendly activity text as the side panel
- The side panel updates in place, so an open menu stays open
- README explains how status, stations, poses and identity work
- Test suite: `pnpm test`
- Label detail: full labels only for waiting, selected, hovered or near agents; compact labels (color dot and name) for the others. Key V or `#labels=all` shows all full labels
- Attention age bands: only a wait under 15 min gets the beacon, the raised hand and the tab count. A wait up to 24 h stays in the queue. An older wait moves to a collapsed "Cold" group. The thresholds are one constant
- Agent card: a click on a figure or a triage row opens a card left of the triage panel with name, activity, attention band and wait, workspace, provider, personas, subagents and up to 10 linked issues. Esc or the close button closes it. The camera keeps the figure clear of the card. The herdr "Focus in herdr" button moved into the card, and `pnpm dev:fork` turns herdr focus on

- The library moves south-east, right after your office (issue #120). If you already have a saved building of 3 or more rooms, this is a one-time move: the room that used to sit south-east (whatever you rented third) now sits north-east instead, since each room's position comes from the order it was rented, not its kind. Nothing about that room itself changed.
- Wayfinding (building layout): a name label above each room, numbered lounges, door frames in the room floor color, walls cut away in the overview, and mission room signs only when you zoom in or point at the room
- Navigation: the building layout opens in the overview, the last view comes back after a reload (`#view=` wins), Shift+L with a confirmation switches the layout (one L does nothing), and the panel header shows the layout and the view. First person has no bounding box: you can walk into every room and fly above the building. The ceiling hides above 6 m and in the overview. Fly-to in first person keeps the camera inside the figure's room
- Honest states: "Loading agents…" until the first answer, a panel footer with "Updated N s ago" that turns amber after 2 failed polls and red with "Server not reachable" after 5, a "?" legend for the signs, bands, rooms and keys, and "Done" instead of "Taking a break" for a finished subagent

## 1.1.0

### Changes

- Removed mock agent fallback — office stays empty when no Claude Code sessions are running

## 1.0.0

### Features

- **3D office visualization** of running Claude Code sessions as toon-shaded stick figures
- **Real-time agent detection** from `~/.claude/sessions/` with PID validation
- **Language-agnostic activity inference** from transcript tool_use blocks (Read/Grep -> researching, Edit/Write -> implementing, Bash -> testing/deploying/debugging, etc.)
- **Subagent detection** from `~/.claude/projects/.../subagents/` with 30s activity threshold, shown with `>>` prefix
- **Walking animation** when agents move between stations (leg/arm swing, body bounce)
- **Station-based layout**: 23 stations across 7 types (implementing, planning, researching, testing, reviewing, idle, meeting)
- **Smart station assignment**: agents stay at the same desk when switching between activities that share a station type (e.g. implementing -> debugging)
- **Free camera** with pointer lock, WASD movement, and shift for speed
- **CLI support**: run with `npx agents-office`
