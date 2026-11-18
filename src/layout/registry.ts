import type * as THREE from 'three';
import type { Station } from '../scene/Office.js';
import { ActivityLayout } from './ActivityLayout.js';
import type { LayoutStrategy } from './LayoutStrategy.js';

export type LayoutFactory = (scene: THREE.Scene, stations: Map<string, Station>) => LayoutStrategy;

const STORAGE_KEY = 'agents-office.layout';
const factories = new Map<string, LayoutFactory>([['activity', (_scene, stations) => new ActivityLayout(stations)]]);
let defaultLayoutId = 'activity';

/** Add a layout. An add-on can also make it the default when the user chose none. */
export function registerLayout(id: string, factory: LayoutFactory, options: { makeDefault?: boolean } = {}): void {
  factories.set(id, factory);
  if (options.makeDefault) defaultLayoutId = id;
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
