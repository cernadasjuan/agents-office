import { ACTIVITIES, ACTIVITY_LABELS, AgentInfo } from '../agents/AgentData.js';
import type { Activity } from '../agents/ActivityAnimations.js';

interface PanelCard {
  card: HTMLElement;
  name: HTMLElement;
  menu: HTMLSelectElement;
}

/**
 * Side panel with one card per agent. Cards are created when agents arrive and
 * removed when they leave. An activity change updates the card in place, so a
 * menu the user has open is not replaced under the cursor.
 */
export class AgentPanel {
  private cards = new Map<string, PanelCard>();
  private selectedId: string | null = null;

  constructor(
    private list: HTMLElement,
    private onPick: (agentId: string, activity: Activity) => void,
    private onSelect?: (agentId: string) => void,
  ) {}

  /** Mark the card of the selected agent, or none. */
  setSelected(agentId: string | null): void {
    this.selectedId = agentId;
    for (const [id, entry] of this.cards) entry.card.classList.toggle('selected', id === agentId);
  }

  render(agents: AgentInfo[]): void {
    const present = new Set(agents.map((agent) => agent.id));
    for (const [id, entry] of this.cards) {
      if (present.has(id)) continue;
      entry.card.remove();
      this.cards.delete(id);
    }

    for (const agent of agents) {
      const entry = this.cards.get(agent.id) ?? this.addCard(agent);
      entry.name.textContent = agent.name;
      if (entry.menu !== document.activeElement) entry.menu.value = agent.activity;
    }
  }

  private addCard(agent: AgentInfo): PanelCard {
    const card = document.createElement('div');
    card.className = 'agent-card';

    const name = document.createElement('div');
    name.className = 'agent-name';
    const onSelect = this.onSelect;
    if (onSelect) {
      name.classList.add('selectable');
      name.title = 'Select and fly to this agent';
      name.addEventListener('click', () => onSelect(agent.id));
    }
    card.classList.toggle('selected', agent.id === this.selectedId);
    card.appendChild(name);

    const menu = document.createElement('select');
    for (const activity of ACTIVITIES) {
      const option = document.createElement('option');
      option.value = activity;
      option.textContent = ACTIVITY_LABELS[activity];
      menu.appendChild(option);
    }
    menu.addEventListener('change', () => this.onPick(agent.id, menu.value as Activity));
    card.appendChild(menu);

    this.list.appendChild(card);
    const entry = { card, name, menu };
    this.cards.set(agent.id, entry);
    return entry;
  }
}
