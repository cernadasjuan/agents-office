# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev        # Start Vite dev server (opens browser)
pnpm build      # Production build
pnpm preview    # Preview built output
npx tsc --noEmit  # Type check without emitting
```

No test framework is configured.

## Architecture

3D office visualization (Three.js + Vite) that shows running Claude Code agents as animated stick figures. Each agent's activity is detected from real session data and mapped to a physical station in the office.

### Data Flow

```
~/.claude/sessions/*.json → server/agentDetector.ts → GET /api/agents → AgentPoller (3s) → AgentManager → 3D Scene
```

1. **Server** (`server/`): Vite middleware plugin reads Claude session files, validates PIDs, and infers activity from transcript `.jsonl` tool_use blocks (language-agnostic)
2. **Polling** (`AgentPoller.ts`): Fetches `/api/agents`, reconciles with AgentManager (add/remove/update). Falls back to mock agents if API unavailable
3. **Agent Management** (`AgentManager.ts`): Creates StickFigures, assigns them to stations based on activity type, handles lifecycle
4. **Scene** (`Office.ts`): 23 stations across 7 types (implementing, planning, researching, testing, reviewing, idle, meeting). One agent per station

### Activity Inference (server/agentDetector.ts)

Activity is inferred from the **most recent tool_use** in the session transcript, not from user input text:
- Read/Grep/Glob/Agent/WebSearch → `researching`
- Edit/Write (code files) → `implementing`
- Edit/Write (.md/.rst/docs/) → `writing_docs`
- Bash with test commands → `testing`
- Bash with git push/deploy → `deploying`
- EnterPlanMode/TaskCreate → `planning`
- Last assistant message is text-only → `idle`

The detector reads the **most recently modified** `.jsonl` transcript for each project (not necessarily matching the sessionId, since Claude Code may rotate transcripts within a session).

### Key Patterns

- **Toon shading**: All meshes use `MeshToonMaterial` with a 4-step gradient map, cached in `Materials.ts`
- **Station occupancy**: `Station.occupied` flag prevents multiple agents at one location. On activity change, old station is released before new one is claimed
- **Teleport vs walk**: `addAgent()` teleports to station instantly; `setActivity()` walks smoothly (3 units/sec)
- **Skeleton animation**: Hierarchical joints (root→body→shoulders/hips→limbs) animated per-activity with sine waves and `approach()` easing
- **Colors**: Centralized palette in `Colors.ts` with 8 accent colors for agents

### Office Layout

30×26 unit room. Left wall: bookshelves (researching). Center: 8 desks in 2 rows (implementing). Right side: test stations, review desks. Back wall: whiteboards (planning). Front-right: meeting table. Front-left: coffee area (idle).

### Camera

Pointer lock + WASD free camera. Shift for speed. Clamped to office bounds.
