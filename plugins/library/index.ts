import type { OfficePlugin } from '../../server/seam.js';

const DEFAULT_LIBRARIAN_TYPES = ['bibliotheque-librarian'];

/** Subagent types that count as librarians, from AGENTS_OFFICE_LIBRARIAN_TYPES (comma list). */
export function parseLibrarianTypes(list: string | undefined): string[] {
  const types = (list ?? '').split(',').map((type) => type.trim()).filter((type) => /^[A-Za-z0-9_-]{1,64}$/.test(type));
  return types.length > 0 ? types : DEFAULT_LIBRARIAN_TYPES;
}

/**
 * Librarians: knowledge-base subagents. They get the role 'librarian', so the
 * building sends them to the Library while they research and back to the agent
 * they serve with what they found.
 */
export function libraryPlugin(types: string[]): OfficePlugin {
  const librarianTypes = new Set(types);
  return {
    name: 'library',
    enrichers: [{
      id: 'librarians',
      enrich(observations) {
        for (const agent of observations) {
          if (agent.parentId && agent.internal.agentType && librarianTypes.has(agent.internal.agentType)) {
            agent.display.role = 'librarian';
          }
        }
      },
    }],
  };
}

export default libraryPlugin(parseLibrarianTypes(process.env.AGENTS_OFFICE_LIBRARIAN_TYPES));
