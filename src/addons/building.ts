import { registerLayout } from '../layout/registry.js';
import { registerExtension } from '../extensions.js';
import { BuildingLayout } from './building/BuildingLayout.js';

// Fork add-on: the growing building with home desks, trips and the user's office.
// It is the default layout in this fork; `?layout=activity` or key L returns to the original.
let activeBuilding: BuildingLayout | null = null;

registerLayout('building', (scene, stations) => {
  activeBuilding = new BuildingLayout(scene, stations, {
    storage: typeof window !== 'undefined' ? window.localStorage : undefined,
  });
  return activeBuilding;
}, { makeDefault: true });

// Rooms from server plugins (mission war rooms) become rooms of the building.
registerExtension({
  id: 'building-world-rooms',
  worldChanged: (world) => { activeBuilding?.syncWorldRooms(world.rooms); },
});
