import * as THREE from 'three';

export const PORTRAIT_NAME = 'office-portrait';
/** World size of the framed portrait (width, height). */
export const PORTRAIT_SIZE = { width: 0.8, height: 1.0 } as const;

const CANVAS = { width: 256, height: 320 } as const;
const FRAME = 18;
const MAT = 6;

function drawFrame(context: CanvasRenderingContext2D): void {
  context.fillStyle = '#6b4a2b';
  context.fillRect(0, 0, CANVAS.width, CANVAS.height);
  context.fillStyle = '#c9a45c';
  context.fillRect(FRAME - MAT, FRAME - MAT, CANVAS.width - 2 * (FRAME - MAT), CANVAS.height - 2 * (FRAME - MAT));
}

const inner = { x: FRAME, y: FRAME, width: CANVAS.width - 2 * FRAME, height: CANVAS.height - 2 * FRAME };

/** A neutral silhouette: no name, no photo, nothing personal. */
function drawPlaceholder(context: CanvasRenderingContext2D): void {
  context.fillStyle = '#3d4a5c';
  context.fillRect(inner.x, inner.y, inner.width, inner.height);
  context.fillStyle = '#8c9bb0';
  const cx = CANVAS.width / 2;
  context.beginPath();
  context.arc(cx, inner.y + inner.height * 0.38, inner.width * 0.2, 0, Math.PI * 2);
  context.fill();
  context.beginPath();
  context.ellipse(cx, inner.y + inner.height, inner.width * 0.4, inner.height * 0.32, 0, Math.PI, Math.PI * 2);
  context.fill();
}

/** Draw the image to cover the picture area, cropped at the center. */
function drawCover(context: CanvasRenderingContext2D, image: CanvasImageSource & { width: number; height: number }): void {
  const scale = Math.max(inner.width / image.width, inner.height / image.height);
  const width = inner.width / scale;
  const height = inner.height / scale;
  context.drawImage(image, (image.width - width) / 2, (image.height - height) / 2, width, height, inner.x, inner.y, inner.width, inner.height);
}

/**
 * The framed portrait over the office door: one sprite with a canvas texture, so
 * it reads from the hall and from the overview and costs one draw call. It starts
 * with a neutral silhouette; `applyPortraitImage` draws a picture in it.
 */
export function createPortrait(): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS.width;
  canvas.height = CANVAS.height;
  const context = canvas.getContext('2d');
  if (context) {
    drawFrame(context);
    drawPlaceholder(context);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture }));
  sprite.name = PORTRAIT_NAME;
  sprite.scale.set(PORTRAIT_SIZE.width, PORTRAIT_SIZE.height, 1);
  sprite.userData.portraitState = 'placeholder';
  sprite.userData.portraitCanvas = canvas;
  return sprite;
}

/** Draw a picture into every portrait under `root`. */
export function applyPortraitImage(root: THREE.Object3D, image: CanvasImageSource): void {
  root.traverse((object) => {
    if (object.name !== PORTRAIT_NAME || !(object instanceof THREE.Sprite)) return;
    const canvas = object.userData.portraitCanvas as HTMLCanvasElement;
    const context = canvas.getContext('2d');
    if (context) {
      drawFrame(context);
      drawCover(context, image as CanvasImageSource & { width: number; height: number });
    }
    if (object.material.map) object.material.map.needsUpdate = true;
    object.userData.portraitState = 'image';
  });
}
