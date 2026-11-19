import { registerLayout } from '../layout/registry.js';
import { BuildingLayout } from './building/BuildingLayout.js';

// Fork add-on: the growing building with home desks, trips and the user's office.
// It is the default layout in this fork; `?layout=activity` or key L returns to the original.
registerLayout('building', (scene, stations) => new BuildingLayout(scene, stations, {
  storage: typeof window !== 'undefined' ? window.localStorage : undefined,
}), { makeDefault: true });
