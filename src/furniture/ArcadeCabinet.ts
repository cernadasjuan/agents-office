import * as THREE from 'three';
import { getToonMaterial } from '../utils/Materials.js';

/** The main room's play zone (issue #122): a stand-up video game cabinet. */

// The same dark color as a desk monitor (`Colors.monitor`), cast-only: joins that existing batch.
const CABINET_DARK = 0x2a2a3e;
const SCREEN_GLOW = 0x2a5a2a;

export function createArcadeCabinet(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'arcade-cabinet';

  const bodyGeo = new THREE.BoxGeometry(0.7, 1.8, 0.7);
  const body = new THREE.Mesh(bodyGeo, getToonMaterial(CABINET_DARK));
  body.position.y = 0.9;
  body.castShadow = true;
  group.add(body);

  const screenGeo = new THREE.PlaneGeometry(0.45, 0.4);
  const screen = new THREE.Mesh(screenGeo, getToonMaterial(SCREEN_GLOW));
  screen.position.set(0, 1.35, 0.36);
  group.add(screen);

  // The marquee cap, the same dark color and flags as the body: no new batch.
  const marqueeGeo = new THREE.BoxGeometry(0.72, 0.25, 0.1);
  const marquee = new THREE.Mesh(marqueeGeo, getToonMaterial(CABINET_DARK));
  marquee.position.set(0, 1.92, 0.3);
  marquee.castShadow = true;
  group.add(marquee);

  return group;
}
