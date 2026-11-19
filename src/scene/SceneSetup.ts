import * as THREE from 'three';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { Colors } from '../utils/Colors.js';
import { initFreeCamera } from './FreeCamera.js';
import { createCeilingLampWithLight } from '../furniture/CeilingLamp.js';

export function createScene() {
  // Scene
  const scene = new THREE.Scene();
  scene.background = Colors.sky;

  // Camera
  const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.1,
    100
  );
  camera.position.set(-12, 5.5, 11);
  const lookAtTarget = new THREE.Vector3(2, 1, -2);

  // WebGL Renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  // three r183 draws PCFSoftShadowMap as PCFShadowMap (with a warning): same look, said plainly
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // Shadows are static: the frame loop sets `needsUpdate` when a caster moves or the scene changes
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  document.body.appendChild(renderer.domElement);

  // CSS2D Renderer for labels
  const labelRenderer = new CSS2DRenderer();
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
  labelRenderer.domElement.style.position = 'absolute';
  labelRenderer.domElement.style.top = '0';
  labelRenderer.domElement.style.pointerEvents = 'none';
  document.body.appendChild(labelRenderer.domElement);

  // Free camera (pointer lock + WASD)
  initFreeCamera(camera, renderer.domElement, lookAtTarget);

  addLighting(scene);

  // Resize handler
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    labelRenderer.setSize(window.innerWidth, window.innerHeight);
  });

  return { scene, camera, renderer, labelRenderer };
}

/** Ambient and sky light, plus 3 ceiling lamps with shadow-casting spotlights over the hall. */
export function addLighting(scene: THREE.Scene): void {
  // Ambient light (soft fill for the whole room)
  const ambientLight = new THREE.AmbientLight(0x9999bb, 1.0);
  scene.add(ambientLight);

  // Hemisphere light (sky/ground bounce)
  const hemiLight = new THREE.HemisphereLight(0xdddde8, 0x998866, 0.6);
  hemiLight.position.set(0, 10, 0);
  scene.add(hemiLight);

  // 3 ceiling lamps with spotlights
  const lampPositions: [number, number][] = [
    [0, -7],   // back area (desks/whiteboards)
    [0, 0],    // center
    [0, 7],    // front area (coffee/meeting)
  ];

  for (const [x, z] of lampPositions) {
    const { lampGroup, light } = createCeilingLampWithLight(x, z);
    scene.add(lampGroup);
    scene.add(light);
    scene.add(light.target);
  }
}
