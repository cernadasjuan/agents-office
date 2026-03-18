import * as THREE from 'three';

type ColorInput = THREE.Color | number;

const cache = new Map<string, THREE.MeshToonMaterial>();

const gradientTexture = (() => {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 1;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#444';
  ctx.fillRect(0, 0, 1, 1);
  ctx.fillStyle = '#888';
  ctx.fillRect(1, 0, 1, 1);
  ctx.fillStyle = '#ccc';
  ctx.fillRect(2, 0, 1, 1);
  ctx.fillStyle = '#fff';
  ctx.fillRect(3, 0, 1, 1);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  return tex;
})();

export function getToonMaterial(color: ColorInput): THREE.MeshToonMaterial {
  const hex = color instanceof THREE.Color ? color.getHexString() : new THREE.Color(color).getHexString();
  const key = hex;

  if (cache.has(key)) return cache.get(key)!;

  const mat = new THREE.MeshToonMaterial({
    color,
    gradientMap: gradientTexture,
  });

  cache.set(key, mat);
  return mat;
}

export function getEmissiveMaterial(color: ColorInput, emissiveColor: ColorInput, intensity = 0.5): THREE.MeshToonMaterial {
  const hex = (color instanceof THREE.Color ? color : new THREE.Color(color)).getHexString();
  const eHex = (emissiveColor instanceof THREE.Color ? emissiveColor : new THREE.Color(emissiveColor)).getHexString();
  const key = `emissive_${hex}_${eHex}_${intensity}`;

  if (cache.has(key)) return cache.get(key)!;

  const mat = new THREE.MeshToonMaterial({
    color,
    emissive: emissiveColor,
    emissiveIntensity: intensity,
    gradientMap: gradientTexture,
  });

  cache.set(key, mat);
  return mat;
}
