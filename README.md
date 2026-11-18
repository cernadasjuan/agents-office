# Agents Office

A 3D office visualization that shows your running [Claude Code](https://claude.ai/code) agents as animated stick figures. Each agent's real-time activity is detected from session data and mapped to a physical station in the office — coding at a desk, reading at the bookshelf, writing on the whiteboard, and more.

![agents-office](assets/screenshot.png)

## Test the security branch locally

Use the fork's security branch. The upstream `npx agents-office` package does not
contain these fixes.

```bash
git clone --branch feature/security-hardening https://github.com/gabriel-amyot/agents-office.git
cd agents-office
pnpm install --frozen-lockfile --ignore-scripts
pnpm audit --audit-level=low
pnpm test
pnpm typecheck
pnpm build
```

Run the dashboard only after these security checks pass:

```bash
pnpm dev
```

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

## How It Works

The app detects running Claude Code sessions by reading `~/.claude/sessions/` on your machine. For each live session, it reads the conversation transcript to determine what the agent is currently doing based on the tools it's using — completely language-agnostic.

It also detects **subagents** (spawned via the Agent tool) and shows them alongside the parent session with a `>>` prefix in their name.

| Most recent tool call | Activity shown |
|---|---|
| Read, Grep, Glob, WebSearch, WebFetch, Agent | Researching (reading at bookshelf) |
| Edit, Write (code files), NotebookEdit | Implementing (typing at desk) |
| Edit, Write (.md, .rst, .txt, README, docs/) | Writing docs (writing at review desk) |
| Bash with test commands | Testing (at test station) |
| Bash with git commit/push, deploy, terraform apply | Deploying (celebrating at desk) |
| Bash with git diff/log/show/blame, gh pr view | Reviewing (at review desk) |
| Bash with curl, wget, lsof, gdb and similar | Debugging (at desk) |
| EnterPlanMode, ExitPlanMode, TaskCreate, TaskUpdate | Planning (at whiteboard) |
| Any other tool or Bash command | Implementing (typing at desk) |
| Last assistant message is text only | Idle (at coffee machine) |

When every station of the right type is taken, the agent stands on an overflow spot on open floor.

When an agent switches tasks, it walks to the corresponding station with a walk animation.

## Controls

- **Click** to engage camera
- **W/A/S/D** or **Arrow keys** to move
- **Space/Q** to go up/down
- **Shift** to move faster
- **Mouse** to look around
- **Esc** to release camera

## Architecture

```
~/.claude/sessions/*.json → Vite middleware → GET /api/agents → Browser polls every 3s → 3D scene updates
```

- **Server**: Vite plugin reads Claude session files, validates PIDs, infers activity from transcript tool calls, detects active subagents
- **Client**: Three.js scene with toon-shaded stick figures, station-based layout, walking animations, and per-activity poses

## Requirements

- Node.js 22.12+
- One or more running Claude Code sessions to visualize
