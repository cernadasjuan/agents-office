import { registerLayout } from '../layout/registry.js';
import { registerExtension } from '../extensions.js';
import { BuildingLayout } from './building/BuildingLayout.js';
import { loadPortrait } from './building/portrait.js';
import { focusedFloor } from '../floors/floorState.js';
// Issue #161: registers itself (two small monitors on the user's own desk) as a side effect.
import './building/deskMonitors.js';

// Fork add-on: the growing building with home desks, trips and the user's office.
// It is the default layout in this fork and opens in the isometric view (#173); `?layout=activity` or Shift+L returns to the original.
let activeBuilding: BuildingLayout | null = null;

registerLayout('building', (scene, stations) => {
  activeBuilding = new BuildingLayout(scene, stations, {
    storage: typeof window !== 'undefined' ? window.localStorage : undefined,
    // Issue #118: each floor keeps its own room-kind list. The office (room 0, the lobby) is
    // always built either way; only the room list a floor switch restores changes.
    floor: focusedFloor(),
  });
  // The picture over your office door, from this server only; without one the frame keeps its placeholder
  void loadPortrait(scene);
  return activeBuilding;
}, { makeDefault: true, defaultView: 'isometric' });

// Rooms from server plugins (mission war rooms) become rooms of the building.
registerExtension({
  id: 'building-world-rooms',
  worldChanged: (world) => { activeBuilding?.syncWorldRooms(world.rooms); },
  // A war room's tombstones (issue #127) and issue board (issue #146), pickable by a click.
  pickTargets: () => [...(activeBuilding?.tombstonePickTargets() ?? []), ...(activeBuilding?.issuesBoardPickTargets() ?? [])],
});
