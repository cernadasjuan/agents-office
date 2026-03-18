# Agents Office

A 3D office visualization that shows your running [Claude Code](https://claude.ai/code) agents as animated stick figures. Each agent's real-time activity is detected from session data and mapped to a physical station in the office — coding at a desk, reading at the bookshelf, writing on the whiteboard, and more.

![agents-office](assets/screenshot.png)

## Quick Start

```bash
npx agents-office
```

Or clone and run locally:

```bash
git clone https://github.com/cernadasjuan/agents-office.git
cd agents-office
pnpm install
pnpm dev
```

## How It Works

The app detects running Claude Code sessions by reading `~/.claude/sessions/` on your machine. For each live session, it reads the conversation transcript to determine what the agent is currently doing based on the tools it's using — completely language-agnostic.

It also detects **subagents** (spawned via the Agent tool) and shows them alongside the parent session with a `>>` prefix in their name.

| Tool being used | Activity shown |
|---|---|
| Read, Grep, Glob, WebSearch | Researching (reading at bookshelf) |
| Edit, Write (code files) | Implementing (typing at desk) |
| Edit, Write (.md, docs/) | Writing docs (writing at desk) |
| Bash with test commands | Testing (at test station) |
| Bash with git push/deploy | Deploying (celebrating) |
| Bash with git diff/blame | Reviewing (at review desk) |
| EnterPlanMode, TaskCreate | Planning (at whiteboard) |
| No recent tool use | Idle (at coffee machine) |

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

- Node.js 18+
- One or more running Claude Code sessions to visualize
