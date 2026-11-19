import { detectAgents, type DetectedAgent } from './agentDetector.js';
import type { AgentSource, Observation } from './seam.js';

function toObservation(agent: DetectedAgent): Observation {
  return {
    id: agent.id,
    ...(agent.parentId ? { parentId: agent.parentId } : {}),
    provider: 'claude',
    name: agent.name,
    activity: agent.activity,
    ...(agent.status ? { status: agent.status } : {}),
    ...(agent.statusSince ? { statusSince: agent.statusSince } : {}),
    internal: { pid: agent.pid, cwd: agent.cwd, sessionId: agent.parentId ? undefined : agent.id },
    display: {},
  };
}

/** The built-in source: Claude Code sessions and their subagents. */
export function claudeSource(detect: () => DetectedAgent[] = detectAgents): AgentSource {
  return { id: 'claude', scan: () => detect().map(toObservation) };
}
