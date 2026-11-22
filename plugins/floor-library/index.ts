import path from 'node:path';
import { FloorResolver, GENERAL_FLOOR } from '../../server/floor.js';
import type { LibraryInput, OfficePlugin, WorldProvider } from '../../server/seam.js';
import { readBibliotheque } from './bibliotheque.js';

/**
 * Floor libraries (issue #191 AC1, #119). Opt-in with `AGENTS_OFFICE_LIBRARY_ROOTS` (a comma
 * list of absolute repo roots, the same shape `AGENTS_OFFICE_MISSION_ROOTS` already uses),
 * else this plugin's world provider finds nothing and adds no `libraries` at all. Each root
 * that holds a `documentation/bibliotheque/INDEX.md` (`bibliotheque.ts`'s `readBibliotheque`)
 * becomes one `LibraryInput`, tagged with that root's own floor so the client shows it only on
 * its own floor (`src/floors/FloorRegistry.ts`'s `matchesFloor`, the same rule
 * `plugins/missions` already uses for a war room's repo tag).
 */

const CACHE_MS = 30_000;

export function parseRoots(list: string | undefined): string[] {
  return (list ?? '').split(',').map((root) => root.trim()).filter((root) => path.isAbsolute(root) && !root.includes('\0'));
}

/** One root's own library input, or nothing without a `documentation/bibliotheque/` there, or
 * with one that resolved to zero usable sections. `resolver` is injectable for tests, the same
 * narrow shape `plugins/missions` would use if it needed one of its own. `remoteRepo` (issue
 * #221 review) is resolved separately from `repo`: the latter is `resolve()`'s own floor name
 * (a directory-name fallback when there is no git remote), the former is only ever a real git
 * remote's own `owner/repo` — `server/seam.ts` builds a GitHub link from `remoteRepo` alone,
 * never `repo`, so the fallback can never be mistaken for a real GitHub repo. */
export function readLibraries(roots: string[], resolver: Pick<FloorResolver, 'resolve' | 'resolveRemoteOwnerRepo'>): LibraryInput[] {
  return roots.flatMap((root) => {
    const read = readBibliotheque(root);
    if (!read || read.sections.length === 0) return [];
    const floor = resolver.resolve(root);
    const remoteRepo = resolver.resolveRemoteOwnerRepo(root);
    return [{
      key: root,
      sections: read.sections,
      ...(floor !== GENERAL_FLOOR ? { repo: floor } : {}),
      ...(remoteRepo ? { remoteRepo } : {}),
    }];
  });
}

export function floorLibraryPlugin(roots: string[], now: () => number = Date.now): OfficePlugin {
  const resolver = new FloorResolver();
  let cached: { at: number; libraries: LibraryInput[] } | null = null;

  const libraries = (): LibraryInput[] => {
    if (!cached || now() - cached.at > CACHE_MS) cached = { at: now(), libraries: readLibraries(roots, resolver) };
    return cached.libraries;
  };

  const provider: WorldProvider = {
    id: 'floor-library',
    world: () => (libraries().length > 0 ? { libraries: libraries() } : {}),
  };

  return { name: 'floor-library', world: [provider] };
}

export default floorLibraryPlugin(parseRoots(process.env.AGENTS_OFFICE_LIBRARY_ROOTS));
