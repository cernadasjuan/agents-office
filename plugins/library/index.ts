import type { OfficePlugin } from '../../server/seam.js';

const DEFAULT_LIBRARIAN_TYPES = ['bibliotheque-librarian'];

/** Subagent types that count as librarians, from AGENTS_OFFICE_LIBRARIAN_TYPES (comma list). */
export function parseLibrarianTypes(list: string | undefined): string[] {
  const types = (list ?? '').split(',').map((type) => type.trim()).filter((type) => /^[A-Za-z0-9_-]{1,64}$/.test(type));
  return types.length > 0 ? types : DEFAULT_LIBRARIAN_TYPES;
}

/**
 * Librarians: knowledge-base agents. They get the role 'librarian', so the building sends
 * them to the Library while they research, back to the agent they serve with what they found
 * (a subagent), and now the library's own scene (issue #248) seats a visible figure for them
 * at the librarian desk and shows a book in their hand.
 *
 * Issue #248 review: a top-level session running as Prospero (`bmad.py agent librarian`, not
 * a subagent at all) used to get none of this — only a *subagent* of a configured agent type
 * ever got the role. `src/addons/building/BuildingLayout.ts`'s own room-routing already settled
 * this the right way for issue #128 (`isLibrarian`, the bmad persona badge
 * `plugins/bmad/roster.ts` reports, `extras.badges.includes('librarian')`, never a name or
 * agent-type match) — the role badge here now uses the exact same signal, broadened to any
 * agent carrying it, so routing, the book prop and the library scene's own desk never
 * disagree about who is a librarian. The agent-type match stays as a second, narrower path
 * (AGENTS_OFFICE_LIBRARIAN_TYPES): a subagent whose own persona never ran a `bmad.py agent`
 * call but whose type is still configured as a librarian type still counts.
 */
export function libraryPlugin(types: string[]): OfficePlugin {
  const librarianTypes = new Set(types);
  return {
    name: 'library',
    enrichers: [{
      id: 'librarians',
      enrich(observations) {
        for (const agent of observations) {
          const hasLibrarianBadge = Array.isArray(agent.display.badges) && agent.display.badges.includes('librarian');
          const isLibrarianSubagentType = Boolean(agent.parentId && agent.internal.agentType && librarianTypes.has(agent.internal.agentType));
          if (hasLibrarianBadge || isLibrarianSubagentType) agent.display.role = 'librarian';
        }
      },
    }],
  };
}

export default libraryPlugin(parseLibrarianTypes(process.env.AGENTS_OFFICE_LIBRARIAN_TYPES));
