import { officeSelection, type SelectionState } from '../scene/Selection.js';
import type { WorldLibrary, WorldLibraryEntry, WorldLibrarySection } from '../extensions.js';

/**
 * Library card (issue #221 AC2): a click on a shelf entry or a section label opens a small
 * card, the same look and dock spot as the agent, tombstone and mission-issues cards. Three
 * things it can show, keyed by the selected id's own prefix (the same pattern
 * `MissionIssuesCard`'s `issues:` prefix already uses):
 *
 * - an entry (`lib-entry:`): the document card the spike asked for — title, summary,
 *   archived flag, last-changed, and an "Open on GitHub" link (never a local path, only
 *   `server/seam.ts`'s own built URL).
 * - a section (`lib-section:`): the section card the spike asked for — every file the
 *   section carries (not just the few the shared room physically shows), each one clickable
 *   into its own entry card.
 * - an index (`lib-index:`): every section the library carries (not just the few the shared
 *   room physically shows), each one clickable into its own section card. This is the
 *   "visible physical sign that more exists" for an overflowing library (issue #221 AC1) —
 *   `plugins/floor-library/client.ts`'s own "+N more" sign opens this rather than hide the rest.
 */

export const LIBRARY_CARD_GAP_PX = 8;
export const LIBRARY_CARD_WIDTH_PX = 360;
export const LIBRARY_ENTRY_PREFIX = 'lib-entry:';
export const LIBRARY_SECTION_PREFIX = 'lib-section:';
export const LIBRARY_INDEX_PREFIX = 'lib-index:';

/** The id a shelf entry's own pick target reports, and this card's own key back into the
 * world data for it: a library id (the server's own hashed public id, stable for this library
 * across polls), a section index and an entry index — positional, not a second identity. */
export function libraryEntryId(libraryId: string, sectionIndex: number, entryIndex: number): string {
  return `${LIBRARY_ENTRY_PREFIX}${libraryId}:${sectionIndex}:${entryIndex}`;
}

export function librarySectionId(libraryId: string, sectionIndex: number): string {
  return `${LIBRARY_SECTION_PREFIX}${libraryId}:${sectionIndex}`;
}

export function libraryIndexId(libraryId: string): string {
  return `${LIBRARY_INDEX_PREFIX}${libraryId}`;
}

type ResolvedTarget =
  | { kind: 'entry'; title: string; entry: WorldLibraryEntry }
  | { kind: 'section'; title: string; section: WorldLibrarySection; libraryId: string; sectionIndex: number }
  | { kind: 'index'; title: string; library: WorldLibrary };

function splitRest(id: string, prefix: string): string[] {
  return id.slice(prefix.length).split(':');
}

function resolveTarget(libraries: WorldLibrary[], id: string): ResolvedTarget | undefined {
  if (id.startsWith(LIBRARY_ENTRY_PREFIX)) {
    const [libraryId, sectionIndexText, entryIndexText] = splitRest(id, LIBRARY_ENTRY_PREFIX);
    const section = libraries.find((library) => library.id === libraryId)?.sections[Number(sectionIndexText)];
    const entry = section?.entries[Number(entryIndexText)];
    return entry ? { kind: 'entry', title: entry.title, entry } : undefined;
  }
  if (id.startsWith(LIBRARY_SECTION_PREFIX)) {
    const [libraryId, sectionIndexText] = splitRest(id, LIBRARY_SECTION_PREFIX);
    const sectionIndex = Number(sectionIndexText);
    const section = libraries.find((library) => library.id === libraryId)?.sections[sectionIndex];
    return section ? { kind: 'section', title: section.name, section, libraryId, sectionIndex } : undefined;
  }
  if (id.startsWith(LIBRARY_INDEX_PREFIX)) {
    const libraryId = id.slice(LIBRARY_INDEX_PREFIX.length);
    const library = libraries.find((candidate) => candidate.id === libraryId);
    return library ? { kind: 'index', title: 'Library index', library } : undefined;
  }
  return undefined;
}

export interface LibraryCardOptions {
  /** The same anchor the agent card docks against, so the cards never overlap. */
  anchor: HTMLElement;
  selection?: SelectionState;
}

export class LibraryCard {
  private readonly root: HTMLElement;
  private readonly name: HTMLElement;
  private readonly body: HTMLElement;
  private readonly selection: SelectionState;
  private libraries: WorldLibrary[] = [];
  private shownKey = '';

  constructor(parent: HTMLElement, private readonly options: LibraryCardOptions) {
    this.selection = options.selection ?? officeSelection();
    const doc = parent.ownerDocument;
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) => {
      const node = doc.createElement(tag);
      node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };

    this.root = el('aside', 'agent-inspector');
    this.root.id = 'library-inspector';
    this.root.hidden = true;
    this.root.setAttribute('aria-label', 'Library card');
    this.root.style.width = `${LIBRARY_CARD_WIDTH_PX}px`;

    const header = el('div', 'inspector-header');
    this.name = el('h3', 'inspector-name', 'Library');
    const close = el('button', 'inspector-close', '×');
    close.type = 'button';
    close.title = 'Close (Esc)';
    close.setAttribute('aria-label', 'Close the library card');
    close.addEventListener('click', () => this.selection.clear());
    header.append(this.name, close);

    this.body = el('div', 'inspector-section');
    this.root.append(header, this.body);
    parent.appendChild(this.root);

    this.selection.onChange(() => this.refresh());
    const Observer = doc.defaultView?.ResizeObserver;
    if (Observer) new Observer(() => this.redock()).observe(options.anchor);
  }

  /** Call after each world poll: the latest known libraries, so an open card updates if its data changes. */
  render(libraries: WorldLibrary[]): void {
    this.libraries = libraries;
    this.refresh();
  }

  redock(): void {
    if (!this.root.hidden) this.dock();
  }

  private refresh(): void {
    const id = this.selection.selected;
    const target = id ? resolveTarget(this.libraries, id) : undefined;
    if (!target) {
      this.root.hidden = true;
      this.shownKey = '';
      return;
    }
    this.dock();
    const key = JSON.stringify(target);
    if (key !== this.shownKey) {
      this.shownKey = key;
      this.name.textContent = target.title;
      if (target.kind === 'entry') this.fillEntry(target.entry);
      else if (target.kind === 'section') this.fillSection(target.libraryId, target.sectionIndex, target.section);
      else this.fillIndex(target.library);
    }
    this.root.hidden = false;
  }

  private fillEntry(entry: WorldLibraryEntry): void {
    const nodes: HTMLElement[] = [];
    if (entry.archived) nodes.push(this.text('p', 'Archived'));
    nodes.push(this.text('p', entry.summary || 'No summary yet.'));
    if (entry.lastChanged) nodes.push(this.text('p', `Last changed ${entry.lastChanged}`));
    if (entry.githubUrl) {
      const p = this.text('p', '');
      const link = this.link(entry.githubUrl, 'Open on GitHub');
      if (link) p.appendChild(link);
      nodes.push(p);
    }
    this.body.replaceChildren(...nodes);
  }

  private fillSection(libraryId: string, sectionIndex: number, section: WorldLibrarySection): void {
    if (section.entries.length === 0) {
      this.body.replaceChildren(this.text('p', 'No files yet.'));
      return;
    }
    const list = this.root.ownerDocument.createElement('ul');
    list.append(...section.entries.map((entry, entryIndex) => {
      const item = this.root.ownerDocument.createElement('li');
      item.appendChild(this.selectButton(libraryEntryId(libraryId, sectionIndex, entryIndex), entry.archived ? `${entry.title} (archived)` : entry.title));
      return item;
    }));
    const nodes: HTMLElement[] = [list];
    if (section.truncated) nodes.push(this.text('p', 'More files exist in this section than fit here yet.'));
    this.body.replaceChildren(...nodes);
  }

  private fillIndex(library: WorldLibrary): void {
    if (library.sections.length === 0) {
      this.body.replaceChildren(this.text('p', 'No sections yet.'));
      return;
    }
    const list = this.root.ownerDocument.createElement('ul');
    list.append(...library.sections.map((section, sectionIndex) => {
      const item = this.root.ownerDocument.createElement('li');
      item.appendChild(this.selectButton(librarySectionId(library.id, sectionIndex), `${section.name} (${section.entries.length})`));
      return item;
    }));
    this.body.replaceChildren(list);
  }

  private selectButton(id: string, label: string): HTMLButtonElement {
    const button = this.root.ownerDocument.createElement('button') as HTMLButtonElement;
    button.type = 'button';
    button.className = 'inspector-link';
    button.textContent = label;
    button.addEventListener('click', () => this.selection.select(id));
    return button;
  }

  /** Review (defect belt-and-suspenders): `server/seam.ts` already only ever builds a
   * `https://github.com/...` URL here, but the card still refuses anything else before it
   * ever becomes a link, the same way `MissionIssuesCard`'s own issue link does. */
  private link(url: string, label: string): HTMLAnchorElement | null {
    try {
      if (new URL(url).protocol !== 'https:') return null;
    } catch {
      return null;
    }
    const link = this.root.ownerDocument.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = label;
    return link;
  }

  private text(tag: string, text: string): HTMLElement {
    const node = this.root.ownerDocument.createElement(tag);
    node.textContent = text;
    return node;
  }

  private dock(): void {
    const view = this.root.ownerDocument.defaultView;
    const rect = this.options.anchor.getBoundingClientRect();
    if (!view || rect.width === 0) return;
    this.root.style.right = `${Math.round(view.innerWidth - rect.left + LIBRARY_CARD_GAP_PX)}px`;
    this.root.style.top = `${Math.round(rect.top)}px`;
  }
}
