import * as THREE from 'three';

const FLOOR_OFFSET = 0.03;
const PULSE = 0.06;

/** A thin ring on the floor under the selected figure, in the agent's color. */
export class SelectionMarker {
  readonly mesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;

  constructor(scene: THREE.Scene) {
    this.mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 0.68, 48),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.renderOrder = 1;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  show(color: THREE.Color): void {
    this.mesh.material.color.copy(color);
    this.mesh.visible = true;
  }

  hide(): void {
    this.mesh.visible = false;
  }

  follow(position: THREE.Vector3, elapsed: number): void {
    this.mesh.position.set(position.x, FLOOR_OFFSET, position.z);
    this.mesh.scale.setScalar(1 + PULSE * Math.sin(elapsed * 4));
  }
}
