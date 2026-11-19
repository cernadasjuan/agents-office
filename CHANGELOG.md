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

- Each session reads its own transcript; sessions in the same folder no longer share one activity
- Subagents show once, under the session that started them
- Agents without a free seat of their type stand on an overflow spot instead of piling up at the origin or taking a seat of another type
- Long transcript lines and lines across read-chunk edges are parsed
- Sessions in folders with a dot in the path are found
- One poll at a time, with a 5 s limit
- Arm and head rotations reset between poses
- Docs match the code (22 stations, no mock fallback, test commands)
- GitHub plugin: issue cards move from the hand to the shoulders and upper arms, like badges. They stay upright, turn to the camera, read `<repo>#N` and take the issue label color as border. All cards draw in one call. The floating label shows the issue IDs, also in the overview

### Changes

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
- Wayfinding (building layout): a name label above each room, numbered lounges, door frames in the room floor color, walls cut away in the overview, and mission room signs only when you zoom in or point at the room

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
