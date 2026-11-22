import * as THREE from 'three';
import { registerExtension } from '../../src/extensions.js';
import { getToonMaterial } from '../../src/utils/Materials.js';
import type { ManagedAgent } from '../../src/agents/AgentManager.js';

const BOOK = 'librarian-book';
/**
 * Issue #253 review: broadening who gets `role: 'librarian'` (any persona-badged agent, not
 * only a librarian subagent) also broadened who gets this book — at real scale (dozens of
 * concurrent librarian-persona sessions) one unbatched `Mesh` per agent would have pushed the
 * office past its draw-call budget on its own. The same fix `plugins/bmad/hats.ts` already
 * uses for its own per-figure prop (a hat): one shared geometry instance, reused by every
 * book, marked `userData.figurePart` so `FigureBatch.sync()` (which re-walks every figure root
 * looking for that flag, "so that parts attached later join") folds every book into the same
 * instanced-mesh bucket it already draws the figure's own body parts through — one draw call
 * for however many librarians are carrying one, not one each. `getToonMaterial` is already
 * cached by color, so only the geometry needed hoisting to stay a stable, shared instance.
 */
const BOOK_GEOMETRY = new THREE.BoxGeometry(0.16, 0.22, 0.05);

/** A book in the right hand of each librarian: the nugget it carries between the Library and its agent. */
export function syncBooks(agents: ManagedAgent[]): void {
  for (const { info, figure } of agents) {
    const hand = figure.joints.rightHand;
    const book = hand.getObjectByName(BOOK);
    const isLibrarian = info.extras?.role === 'librarian';
    if (isLibrarian && !book) {
      const mesh = new THREE.Mesh(BOOK_GEOMETRY, getToonMaterial(0x8e3b2e));
      mesh.name = BOOK;
      mesh.position.set(0, -0.08, 0.06);
      mesh.userData.figurePart = true;
      hand.add(mesh);
    } else if (!isLibrarian && book) {
      // Never dispose: `BOOK_GEOMETRY` is shared by every librarian's own book, not owned by
      // this one (the same reasoning a hat's own shared shape is never disposed on removal).
      hand.remove(book);
    }
  }
}

registerExtension({ id: 'library-books', plugin: 'library', agentsChanged: syncBooks });
