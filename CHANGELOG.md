# Changelog

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
- **Mock agent fallback** when no real Claude Code sessions are detected
- **CLI support**: run with `npx agents-office`
