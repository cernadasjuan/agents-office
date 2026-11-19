import type * as THREE from 'three';
import type { Station } from '../scene/Office.js';
import type { ViewMode } from '../scene/Selection.js';
import { ActivityLayout } from './ActivityLayout.js';
import type { LayoutStrategy } from './LayoutStrategy.js';

export type LayoutFactory = (scene: THREE.Scene, stations: Map<string, Station>) => LayoutStrategy;

const STORAGE_KEY = 'agents-office.layout';
const MAX_DWELL_SECONDS = 30;

/** `?dwell=<seconds>` for the activity layout, clamped to 0 to 30 s. Missing or not a number: 0. */
export function dwellMsFromSearch(search: string): number {
  const seconds = Number(new URLSearchParams(search).get('dwell') ?? 0);
  if (!Number.isFinite(seconds)) return 0;
  return Math.min(MAX_DWELL_SECONDS, Math.max(0, seconds)) * 1000;
}

const factories = new Map<string, LayoutFactory>([[
  'activity',
  (_scene, stations) => new ActivityLayout(stations, { dwellMs: dwellMsFromSearch(globalThis.location?.search ?? '') }),
]]);
let defaultLayoutId = 'activity';
const defaultViews = new Map<string, ViewMode>();

/**
 * Add a layout. An add-on can also make it the default when the user chose none,
 * and name the view it opens in when the URL and the saved view say nothing.
 */
export function registerLayout(id: string, factory: LayoutFactory, options: { makeDefault?: boolean; defaultView?: ViewMode } = {}): void {
  factories.set(id, factory);
  if (options.makeDefault) defaultLayoutId = id;
  if (options.defaultView) defaultViews.set(id, options.defaultView);
}

/** The view a layout opens in by default. First person unless the layout asks for another. */
export function defaultViewFor(id: string): ViewMode {
  return defaultViews.get(id) ?? 'first-person';
}

/** A readable layout name for the panel header and the switch question. */
export function layoutName(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

type SwitchKey = Pick<KeyboardEvent, 'code' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey' | 'target'>;

function isFormField(target: EventTarget | null): boolean {
  const tag = (target as Element | null)?.tagName;
  return tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA';
}

/** Shift+L switches the layout. One stray L does nothing. */
export function isLayoutSwitchKey(event: SwitchKey): boolean {
  if (event.code !== 'KeyL' || !event.shiftKey) return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  return !isFormField(event.target);
}

/** Ask before a switch (the page reloads). The next layout ID when the user confirms, else null. */
export function confirmLayoutSwitch(current: string, confirm: (question: string) => boolean): string | null {
  const ids = layoutIds();
  const next = ids[(ids.indexOf(current) + 1) % ids.length];
  if (next === undefined || next === current) return null;
  return confirm(`Switch to the ${layoutName(next)} layout? The page reloads.`) ? next : null;
}

export function layoutIds(): string[] {
  return Array.from(factories.keys());
}

/**
 * The layout to use: `?layout=` in the URL, then the last choice stored in the
 * browser, then the default. An unknown ID falls back to the default.
 */
export function chooseLayoutId(search: string, storage: Pick<Storage, 'getItem'> | undefined): string {
  const fromUrl = new URLSearchParams(search).get('layout');
  if (fromUrl && factories.has(fromUrl)) return fromUrl;
  const stored = storage?.getItem(STORAGE_KEY);
  if (stored && factories.has(stored)) return stored;
  return defaultLayoutId;
}

export function rememberLayoutId(id: string, storage: Pick<Storage, 'setItem'> | undefined): void {
  storage?.setItem(STORAGE_KEY, id);
}

export function createLayout(id: string, scene: THREE.Scene, stations: Map<string, Station>): LayoutStrategy {
  return (factories.get(id) ?? factories.get('activity')!)(scene, stations);
}
