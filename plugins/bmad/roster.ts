/**
 * BMAD persona roster (from `bmad.py list`). Shared by the server enricher and
 * the browser part. The badge is the persona id; the aliases are what an agent
 * may pass to `bmad.py agent <name>`, a Skill name or a subagent type.
 */
export interface Persona {
  id: string;
  name: string;
  aliases: string[];
}

export const PERSONAS: Persona[] = [
  { id: 'bmad-master', name: 'BMad Master', aliases: [] },
  { id: 'analyst', name: 'Mary', aliases: ['mary'] },
  { id: 'architect', name: 'Winston', aliases: ['winston'] },
  { id: 'dev', name: 'Amelia', aliases: ['amelia'] },
  { id: 'pm', name: 'John', aliases: ['john'] },
  { id: 'qa', name: 'Quinn', aliases: ['quinn'] },
  { id: 'quick-flow-solo-dev', name: 'Barry', aliases: ['barry'] },
  { id: 'sm', name: 'Bob', aliases: ['bob'] },
  { id: 'tech-writer', name: 'Paige', aliases: ['paige'] },
  { id: 'ux-designer', name: 'Sally', aliases: ['sally'] },
  { id: 'brainstorming-coach', name: 'Carson', aliases: ['carson'] },
  { id: 'creative-problem-solver', name: 'Dr. Quinn', aliases: ['dr-quinn', 'dr.quinn'] },
  { id: 'design-thinking-coach', name: 'Maya', aliases: ['maya'] },
  { id: 'innovation-strategist', name: 'Victor', aliases: ['victor'] },
  { id: 'presentation-master', name: 'Caravaggio', aliases: ['caravaggio'] },
  { id: 'storyteller', name: 'Sophia', aliases: ['sophia'] },
  { id: 'tea', name: 'Murat', aliases: ['murat'] },
  { id: 'data-engineer', name: 'Atlas', aliases: ['atlas'] },
  { id: 'spec-coach', name: 'Leo', aliases: ['leo'] },
  { id: 'debugger', name: 'Dexter', aliases: ['dexter'] },
  { id: 'agent-builder', name: 'Agent Builder', aliases: [] },
  { id: 'workflow-builder', name: 'Workflow Builder', aliases: [] },
  { id: 'module-builder', name: 'Module Builder', aliases: [] },
  { id: 'eval-runner', name: 'Eval Runner', aliases: [] },
];

const byAlias = new Map<string, Persona>();
for (const persona of PERSONAS) {
  for (const alias of [persona.id, ...persona.aliases]) byAlias.set(alias, persona);
}

/** The persona id for a name, id or alias (case-insensitive), or undefined. */
export function personaIdFor(raw: string): string | undefined {
  const name = raw.trim().toLowerCase();
  return byAlias.get(name)?.id;
}

/** The display name for a badge: the persona's first name, or the badge itself. */
export function personaName(badge: string): string {
  return PERSONAS.find((persona) => persona.id === badge)?.name ?? badge;
}
