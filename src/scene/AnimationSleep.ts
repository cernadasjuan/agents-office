import * as THREE from 'three';

/**
 * Figures out of view or far from the camera sleep: they skip their idle
 * animation (walking still runs), so an office where nothing walks counts as
 * idle and the frame loop drops to one render a second. The frame loop decides
 * before each tick; the agent manager reads the flag.
 */
export const ANIMATION_DISTANCE = 25;

const ASLEEP = 'animationAsleep';
/** A standing figure fits in this sphere around its middle. */
const FIGURE_REACH = new THREE.Sphere(new THREE.Vector3(), 1.6);
const cameraFrustum = new THREE.Frustum();
const projection = new THREE.Matrix4();
const cameraPosition = new THREE.Vector3();

export function isAnimationAsleep(root: THREE.Object3D): boolean {
  return root.userData[ASLEEP] === true;
}

export function setAnimationAsleep(root: THREE.Object3D, asleep: boolean): void {
  root.userData[ASLEEP] = asleep;
}

/** Put each figure to sleep or wake it: awake when it is in view and within `ANIMATION_DISTANCE`. */
export function sleepUnseenFigures(camera: THREE.Camera, figures: THREE.Object3D[]): void {
  camera.updateMatrixWorld();
  cameraFrustum.setFromProjectionMatrix(projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse), camera.coordinateSystem);
  cameraPosition.setFromMatrixPosition(camera.matrixWorld);
  for (const figure of figures) {
    figure.getWorldPosition(FIGURE_REACH.center);
    FIGURE_REACH.center.y += 1;
    const near = FIGURE_REACH.center.distanceTo(cameraPosition) <= ANIMATION_DISTANCE;
    setAnimationAsleep(figure, !(near && cameraFrustum.intersectsSphere(FIGURE_REACH)));
  }
}
