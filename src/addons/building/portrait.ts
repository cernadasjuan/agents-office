import type * as THREE from 'three';
import { applyPortraitImage } from '../../furniture/Portrait.js';

/**
 * The picture over the office door comes from this server only (`GET /api/portrait`,
 * opt-in with AGENTS_OFFICE_PORTRAIT). A 204 means no picture: the frame keeps its
 * placeholder and nothing is logged. The office makes no other network call for it.
 */
export const PORTRAIT_URL = '/api/portrait';

export interface PortraitLoaderOptions {
  fetch?: (url: string) => Promise<Response>;
  /** Decodes the image bytes. Default: `createImageBitmap`. */
  decode?: (blob: Blob) => Promise<CanvasImageSource>;
}

let loaded: CanvasImageSource | null = null;

/** Fetch the picture once and draw it in every portrait of the scene. Never throws. */
export async function loadPortrait(scene: THREE.Object3D, options: PortraitLoaderOptions = {}): Promise<boolean> {
  const fetchPortrait = options.fetch ?? ((url: string) => fetch(url, { cache: 'no-store' }));
  const decode = options.decode ?? ((blob: Blob) => createImageBitmap(blob));
  try {
    const response = await fetchPortrait(PORTRAIT_URL);
    if (response.status !== 200 || !(response.headers.get('content-type') ?? '').startsWith('image/')) return false;
    loaded = await decode(await response.blob());
    applyPortraitImage(scene, loaded);
    return true;
  } catch {
    return false;
  }
}

/** Draw the loaded picture, if any, in the portraits of a room built later. */
export function showLoadedPortrait(root: THREE.Object3D): void {
  if (loaded) applyPortraitImage(root, loaded);
}

/** Tests: forget the loaded picture. */
export function resetLoadedPortrait(): void {
  loaded = null;
}
