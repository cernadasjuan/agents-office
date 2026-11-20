import { viewModeFromName, type ViewMode } from './Selection.js';

/** Browser storage key of the last view mode. Browser state, not a config file. */
export const VIEW_STORAGE_KEY = 'agents-office.view';

export const VIEW_NAMES: Record<ViewMode, string> = {
  'first-person': 'First person',
  isometric: 'Isometric',
};

const asViewMode = viewModeFromName;

/** `#view=first-person` or `#view=iso` in the URL hash, else null. */
export function viewFromHash(hash: string): ViewMode | null {
  return asViewMode(new URLSearchParams(hash.replace(/^#/, '')).get('view'));
}

/** The start view: the `#view=` hash, then the last saved view, then the layout default. */
export function chooseViewMode(hash: string, storage: Pick<Storage, 'getItem'> | undefined, fallback: ViewMode): ViewMode {
  const fromHash = viewFromHash(hash);
  if (fromHash) return fromHash;
  try {
    return asViewMode(storage?.getItem(VIEW_STORAGE_KEY)) ?? fallback;
  } catch {
    return fallback;
  }
}

export function rememberViewMode(mode: ViewMode, storage: Pick<Storage, 'setItem'> | undefined): void {
  try {
    storage?.setItem(VIEW_STORAGE_KEY, mode);
  } catch {
    // Storage full or blocked: the view still works for this page
  }
}

/** The panel header line, for example "Building layout · Overview". */
export function viewStatusText(layoutName: string, mode: ViewMode): string {
  return `${layoutName} layout · ${VIEW_NAMES[mode]}`;
}
