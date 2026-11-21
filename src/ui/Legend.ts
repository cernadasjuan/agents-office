import { ATTENTION_BANDS, STUCK_AFTER_MINUTES, formatWait } from './attention.js';
import { DONE_LABEL, STUCK_LABEL } from '../agents/AgentData.js';

export interface LegendEntry {
  sign: string;
  meaning: string;
  /** Shown only while this server plugin is active. */
  plugin?: string;
  /** Shown only in this layout. */
  layout?: string;
}

export interface LegendSection {
  title: string;
  entries: LegendEntry[];
}

const FRESH = formatWait(ATTENTION_BANDS.freshUnderMinutes);
const COLD = formatWait(ATTENTION_BANDS.coldFromMinutes);
const STUCK_AFTER = formatWait(STUCK_AFTER_MINUTES);

const SECTIONS: LegendSection[] = [
  {
    title: 'Signs on a figure',
    entries: [
      { sign: 'Beacon', meaning: `An orange diamond over the head. The agent waits for you, and the wait is shorter than ${FRESH}.` },
      { sign: 'Raised hand', meaning: 'The same fresh wait. The agent asks for you now.' },
      { sign: 'Hands on hips', meaning: 'The agent finished its own turn, but a subagent of its own is still running. Not asking for you.' },
      { sign: 'Small figure', meaning: 'A subagent. It has the color of its main agent.' },
      { sign: DONE_LABEL, meaning: 'A subagent that finished its task.' },
      { sign: 'Cards', meaning: 'GitHub issues of the agent, on the shoulders and arms. The border has the color of the issue label.', plugin: 'github' },
      { sign: 'Hats', meaning: 'One hat for each BMAD persona that the agent uses.', plugin: 'bmad' },
    ],
  },
  {
    title: 'Attention bands',
    entries: [
      { sign: 'Fresh wait', meaning: `Shorter than ${FRESH}. Beacon, raised hand, and a count in the tab title.` },
      { sign: 'Aging wait', meaning: `From ${FRESH} to ${COLD}. The agent stays in your queue, without a beacon.` },
      { sign: 'Cold wait', meaning: `${COLD} or longer. The agent moves to the Cold group.` },
      { sign: 'Needs you', meaning: 'The agent is blocked on you, for example on a permission.' },
      { sign: 'Your turn', meaning: 'The agent finished its turn and waits for your next prompt.' },
      { sign: STUCK_LABEL, meaning: `A busy agent with no transcript write for ${STUCK_AFTER}. Check the session.` },
    ],
  },
  {
    title: 'Rooms',
    entries: [
      { sign: 'Your office', meaning: 'Agents that wait for you stand in line in front of your desk. A "Waiting room" gives the line more space.', layout: 'building' },
      { sign: 'Desks', meaning: 'Each session has a home desk. The room label names the workspace.', layout: 'building' },
      { sign: 'Lounge', meaning: 'Agents at rest, and extra seats when a room is full.', layout: 'building' },
      { sign: 'Tombstones', meaning: 'In a mission room, one tombstone for each finished session of the mission. Click or hover one to see which session it was.', plugin: 'missions' },
    ],
  },
  {
    title: 'Keys',
    entries: [
      { sign: 'Click', meaning: 'Select a figure or a row. In first person, a click elsewhere engages the camera. In the isometric view, double-click a room to enter it.' },
      { sign: 'W A S D', meaning: 'Walk or pan. Double-tap W to run. Shift crouches (first person) or pans faster (isometric). Space jumps.' },
      { sign: 'I', meaning: 'Switch between first person and the isometric view.' },
      { sign: 'H', meaning: 'Jump to the desk view: a fixed camera at your own desk. The office also settles here on its own after a while with no camera input.', layout: 'building' },
      { sign: 'V', meaning: 'Switch the labels between smart and all.' },
      { sign: 'Shift+L', meaning: 'Switch the layout.' },
      { sign: 'N', meaning: 'Select the next agent that needs you, in queue order.' },
      { sign: 'F', meaning: 'Focus the selected agent in herdr, no click needed. Recenters the camera too.' },
      { sign: '/', meaning: 'Give the panel’s filter field the focus, so typing shows only the matching rows.' },
      { sign: 'Esc', meaning: 'Release the camera, then clear the selection. While this legend is open, Esc closes only the legend.' },
      { sign: '?', meaning: 'Open or close this legend.' },
    ],
  },
];

/** The legend for this layout and these active plugins: a sign appears only when the office can show it. */
export function legendSections(layout: string, plugins: string[]): LegendSection[] {
  return SECTIONS.map((section) => ({
    title: section.title,
    entries: section.entries.filter((entry) => (!entry.plugin || plugins.includes(entry.plugin)) && (!entry.layout || entry.layout === layout)),
  })).filter((section) => section.entries.length > 0);
}

function isFormField(target: EventTarget | null): boolean {
  const tag = (target as Element | null)?.tagName;
  return tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA';
}

export interface LegendOptions {
  parent: HTMLElement;
  /** The "?" button: a click toggles the overlay. */
  button: HTMLElement;
  /** Where key presses arrive (the window). */
  keys: EventTarget;
  layout: string;
  /** The active server plugins, read when the overlay opens. */
  plugins: () => string[];
}

/**
 * The "?" overlay. It explains the signs, the bands, the rooms and the keys.
 * The content is built from text each time it opens, so plugin signs follow the
 * active plugins. Key "?" or the button toggles it. Esc closes it.
 */
export class Legend {
  private root: HTMLElement;
  private body: HTMLElement;

  constructor(private options: LegendOptions) {
    const document = options.parent.ownerDocument;
    this.root = document.createElement('div');
    this.root.id = 'legend';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Legend');
    this.root.hidden = true;

    const header = document.createElement('div');
    header.className = 'legend-header';
    const title = document.createElement('h3');
    title.textContent = 'Legend';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'legend-close';
    close.title = 'Close the legend';
    close.textContent = '×';
    close.addEventListener('click', () => this.close());
    header.append(title, close);

    this.body = document.createElement('div');
    this.body.className = 'legend-body';
    this.root.append(header, this.body);
    options.parent.appendChild(this.root);

    options.button.setAttribute('aria-controls', 'legend');
    options.button.setAttribute('aria-expanded', 'false');
    options.button.title = 'Legend (?)';
    options.button.addEventListener('click', () => this.toggle());
    // Capture phase: Esc that closes the legend must not also clear the selection.
    options.keys.addEventListener('keydown', (event) => {
      const key = (event as KeyboardEvent).key;
      if (isFormField(event.target)) return;
      if (key === '?') this.toggle();
      else if (key === 'Escape' && this.isOpen) {
        event.stopImmediatePropagation();
        this.close();
      }
    }, { capture: true });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  open(): void {
    this.fill();
    this.root.hidden = false;
    this.options.button.setAttribute('aria-expanded', 'true');
    // Pointer lock traps the mouse on the canvas; release it so the close
    // button (and the rest of the overlay) is reachable by mouse.
    const document = this.root.ownerDocument;
    if (document.pointerLockElement) document.exitPointerLock?.();
  }

  close(): void {
    this.root.hidden = true;
    this.options.button.setAttribute('aria-expanded', 'false');
  }

  private fill(): void {
    const document = this.root.ownerDocument;
    const sections = legendSections(this.options.layout, this.options.plugins()).map((section) => {
      const element = document.createElement('section');
      const title = document.createElement('h4');
      title.textContent = section.title;
      const list = document.createElement('dl');
      for (const entry of section.entries) {
        const sign = document.createElement('dt');
        sign.textContent = entry.sign;
        const meaning = document.createElement('dd');
        meaning.textContent = entry.meaning;
        list.append(sign, meaning);
      }
      element.append(title, list);
      return element;
    });
    this.body.replaceChildren(...sections);
  }
}
