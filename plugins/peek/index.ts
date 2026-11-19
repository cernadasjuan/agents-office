import type { OfficePlugin } from '../../server/seam.js';
import { parseJiraSites, PeekReader } from './transcript.js';

/**
 * Peek plugin (opt-in). It offers the `peek` view: for the one agent the card
 * asks for, the last lines of its transcript (masked and capped), the links it
 * touched in tool calls (assets) and the skills and repos it used (equipment).
 * Nothing goes into `/api/agents` or `/api/world`.
 */
export function createPeekPlugin(reader = new PeekReader({ jiraSites: parseJiraSites(process.env.AGENTS_OFFICE_PEEK_JIRA) })): OfficePlugin {
  return { name: 'peek', views: [{ name: 'peek', read: (agent) => reader.read(agent) }] };
}

export default createPeekPlugin();
