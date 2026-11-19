import * as THREE from 'three';
import { registerExtension } from '../../src/extensions.js';
import { getToonMaterial } from '../../src/utils/Materials.js';
import type { ManagedAgent } from '../../src/agents/AgentManager.js';

const BOOK = 'librarian-book';

/** A book in the right hand of each librarian: the nugget it carries between the Library and its agent. */
export function syncBooks(agents: ManagedAgent[]): void {
  for (const { info, figure } of agents) {
    const hand = figure.joints.rightHand;
    const book = hand.getObjectByName(BOOK);
    const isLibrarian = info.extras?.role === 'librarian';
    if (isLibrarian && !book) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.22, 0.05), getToonMaterial(0x8e3b2e));
      mesh.name = BOOK;
      mesh.position.set(0, -0.08, 0.06);
      hand.add(mesh);
    } else if (!isLibrarian && book) {
      hand.remove(book);
      (book as THREE.Mesh).geometry.dispose();
    }
  }
}

registerExtension({ id: 'library-books', plugin: 'library', agentsChanged: syncBooks });
