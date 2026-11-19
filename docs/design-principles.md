# Design principles

This page records the design rules of Agents Office. Every change must keep them, or say which rule it bends and how it limits the effect. The roadmap (`docs/roadmap.md`) uses the IDs below.

Two sources:

- **P rules** come from the original author's code, docs and commits (upstream `88a04ae`).
- **S rules** come from the security work in this fork.

## Upstream principles

| ID | Principle | Evidence |
|---|---|---|
| P1 | **Place shows activity.** An agent walks to a station of the type of its current work. | `README.md`, `ACTIVITY_STATION_MAP` in `src/agents/AgentData.ts`, `assignStation` in `src/agents/AgentManager.ts` |
| P2 | **Avoid needless movement.** If the new activity uses the same station type, the agent stays where it is. | Commit `6912016` ("prevents unnecessary desk-hopping"), `setActivity` in `AgentManager.ts` |
| P3 | **Motion means change.** A new agent appears at its seat. A changed agent walks. | Commits `9739709`, `a124ff8` |
| P4 | **Infer from what the agent does, not from what the user says.** Activity comes from tool calls, not from prompt text. | Comment in `server/agentDetector.ts`, `CHANGELOG.md` 1.0.0 |
| P5 | **Zero config.** `npx agents-office` and go. The only option is the port. | `bin/cli.mjs`, no config file |
| P6 | **Local files only.** Read `~/.claude`. No network, no external service, no daemon. Two runtime dependencies. | `server/agentDetector.ts`, `package.json` |
| P7 | **Claude Code only.** A scope choice, not a design rule: nothing in the client is Claude-specific. | `README.md`, `package.json` description |
| P8 | **One shared office.** One room, fixed furniture, 22 seats. | `src/scene/Office.ts` |
| P9 | **Playful and toon.** Stick figures, toon shading, one pose per activity, a celebration jump. | `src/utils/Materials.ts`, `src/agents/ActivityAnimations.ts` |
| P10 | **Subagents are peers.** Own transcript, own activity, own station. Only a `>>` prefix marks them. | `CHANGELOG.md` 1.0.0, `AgentPoller.ts` |
| P11 | **Truth over demo.** No mock agents. An empty office means no sessions. | Commit `88a04ae` |
| P12 | **Simple, stateless pipeline.** Each 3 s poll recomputes everything. The server keeps no state. | `server/vitePlugin.ts`, `src/agents/AgentPoller.ts` |
| P13 | **First-person exploration.** Pointer lock and WASD. | `src/scene/FreeCamera.ts` |
| P14 | **Manual activity control.** A menu per agent in the side panel. A leftover from the prototype, live polls overwrite it. | Commit `4203c99`, `src/ui/AgentPanel.ts` |
| P15 | **Small commits with a why.** One concern per commit, a reason in the body. | `git log` of upstream |

## Fork principles (security)

| ID | Principle | What a new feature must do |
|---|---|---|
| S1 | **Loopback only.** | Add no listener and no tunnel. Every new endpoint goes through the checks in `server/vitePlugin.ts`. |
| S2 | **No shell.** | Run no shell. If a subprocess is necessary (for example `herdr`), use `execFile` with fixed arguments, a timeout and an opt-in switch. |
| S3 | **Opaque IDs.** | Group, pane and provider IDs never leave the server raw. They change when the server restarts. |
| S4 | **Minimal API fields.** | Add only display enums and short display text. Never paths, PIDs, prompts, question text or tool input. |
| S5 | **Text, not HTML.** | Render every name, persona and label with `textContent`. |
| S6 | **Validate input files.** | Every new reader checks the shape and caps the size of what it reads. |
| S7 | **Read-only toward the machine.** | The API answers GET only, except opt-in write actions that follow the write-action rules in CLAUDE.md. |
| S8 | **Tests for every change.** | Add fixture tests. One test must show that a missing new field gives the old behavior. |

## Rules for every change

1. One concern per pull request, with the reason in the description.
2. The default behavior does not change, unless the change fixes a bug. The description says so.
3. A feature appears only when its data exists (graceful degradation, from P11). Without the data, the old behavior stays.
4. Update `README.md` and `CLAUDE.md` in the same pull request.
5. Name the principles that a change bends, and its mitigation, in the description. The mitigations are, in order of preference:
   - **Degrade gracefully:** show the feature only when its data exists.
   - **Opt in:** a key, a URL parameter or a plugin turns it on. Zero config stays the default.
   - **Support both:** keep the old behavior as one mode and add the new one as another.
   - **Override:** change the rule only when it is already broken in practice, and show the evidence.
6. Upstream pull requests do not name personal tools or setups (herdr, BMAD, a specific project).
