import type { Observation, OfficePlugin } from '../../server/seam.js';
import { BubbleTailReader, parseJiraSites, PeekReader } from './transcript.js';

/**
 * Peek plugin (opt-in). It offers the `peek` view: for the one agent the card
 * asks for, the last lines of its transcript (masked and capped), the links it
 * touched in tool calls (assets) and the skills and repos it used (equipment).
 * It also offers a `bubbles` source (issue #81): a short speech-bubble event
 * for any agent that wrote something new since it was last asked, read for
 * every known agent at once through `/api/bubbles`. Nothing goes into
 * `/api/agents` or `/api/world`.
 *
 * `bubbleReader` is a separate `BubbleTailReader`, not `reader` (review: the all-agent
 * `/api/bubbles` poll and the one-selected-agent card have very different access patterns;
 * sharing `reader`'s own 20-file cache between them thrashed it past ~20 live agents).
 */
export function createPeekPlugin(reader = new PeekReader({ jiraSites: parseJiraSites(process.env.AGENTS_OFFICE_PEEK_JIRA) }), bubbleReader = new BubbleTailReader()): OfficePlugin {
  return {
    name: 'peek',
    views: [{ name: 'peek', read: (agent, maxLines) => reader.read(agent, maxLines) }],
    bubbles: {
      read: (agent) => bubbleReader.read(agent),
      forget: (liveAgents: Observation[]) => bubbleReader.forget(new Set(
        liveAgents.flatMap((agent) => (typeof agent.internal.transcriptPath === 'string' ? [agent.internal.transcriptPath] : [])),
      )),
    },
  };
}

export default createPeekPlugin();
