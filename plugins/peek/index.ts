import type { OfficePlugin } from '../../server/seam.js';
import { parseJiraSites, PeekReader } from './transcript.js';

/**
 * Peek plugin (opt-in). It offers the `peek` view: for the one agent the card
 * asks for, the last lines of its transcript (masked and capped), the links it
 * touched in tool calls (assets) and the skills and repos it used (equipment).
 * It also offers a `bubbles` source (issue #81): a short speech-bubble event
 * for any agent that wrote something new since it was last asked, read for
 * every known agent at once through `/api/bubbles`. Nothing goes into
 * `/api/agents` or `/api/world`.
 */
export function createPeekPlugin(reader = new PeekReader({ jiraSites: parseJiraSites(process.env.AGENTS_OFFICE_PEEK_JIRA) })): OfficePlugin {
  return {
    name: 'peek',
    views: [{ name: 'peek', read: (agent, maxLines) => reader.read(agent, maxLines) }],
    bubbles: { read: (agent) => reader.bubble(agent) },
  };
}

export default createPeekPlugin();
