import { registerLayout } from '../layout/registry.js';
import { registerExtension } from '../extensions.js';
import { BuildingLayout } from './building/BuildingLayout.js';
import { loadPortrait } from './building/portrait.js';

// Fork add-on: the growing building with home desks, trips and the user's office.
// It is the default layout in this fork and opens in the overview; `?layout=activity` or Shift+L returns to the original.
let activeBuilding: BuildingLayout | null = null;

registerLayout('building', (scene, stations) => {
  activeBuilding = new BuildingLayout(scene, stations, {
    storage: typeof window !== 'undefined' ? window.localStorage : undefined,
  });
  // The picture over your office door, from this server only; without one the frame keeps its placeholder
  void loadPortrait(scene);
  return activeBuilding;
}, { makeDefault: true, defaultView: 'overview' });

// Rooms from server plugins (mission war rooms) become rooms of the building.
registerExtension({
  id: 'building-world-rooms',
  worldChanged: (world) => { activeBuilding?.syncWorldRooms(world.rooms); },
  // A war room's tombstones (issue #127), so a click or hover can pick one.
  pickTargets: () => activeBuilding?.tombstonePickTargets() ?? [],
});
