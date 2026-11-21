import * as THREE from 'three';
import { canvasBoard } from './missionRooms.js';

/**
 * The missions board (issue #144): one small wall board near the mission
 * corridor, listing every mission, running or closed, with a timer. Display
 * only, no interaction. Reuses the same canvas-board factory the war rooms'
 * own statement/docs/issues/kanban boards use, so it costs the same one
 * (unmergeable, but already-accounted-for) draw call as any of those.
 */

export interface MissionBoardEntry {
  title: string;
  state: 'open' | 'locked';
  /** ISO timestamps. A running mission has `createdAt` only; a closed one has both. */
  createdAt?: string;
  closedAt?: string;
}

/** "2h 15m", "3d 4h", "45m" — coarse enough for a wall board, not a stopwatch. */
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

/** One line per mission: its name, state, and the elapsed or final running time. */
export function missionBoardLines(missions: MissionBoardEntry[], now: number): string[] {
  return missions.map((mission) => {
    const created = mission.createdAt ? Date.parse(mission.createdAt) : NaN;
    if (mission.state === 'locked') {
      const closed = mission.closedAt ? Date.parse(mission.closedAt) : NaN;
      const ran = Number.isFinite(created) && Number.isFinite(closed) ? formatDuration(closed - created) : 'unknown';
      return `✓ ${mission.title} — closed, ran ${ran}`;
    }
    const elapsed = Number.isFinite(created) ? formatDuration(now - created) : 'unknown';
    return `○ ${mission.title} — running ${elapsed}`;
  });
}

export function createMissionsBoard(): { mesh: THREE.Mesh; draw: (missions: MissionBoardEntry[], now: number) => void } {
  const board = canvasBoard(2.6, 1.8);
  board.mesh.name = 'missions-board';
  return {
    mesh: board.mesh,
    draw: (missions, now) => {
      board.draw('Missions', missions.length > 0 ? missionBoardLines(missions, now) : ['No missions yet']);
    },
  };
}

/** Mounted on the hall's own north wall, between the two mission-wing doors, facing into the hall. */
export function placeMissionsBoard(mesh: THREE.Mesh, scene: THREE.Scene): void {
  mesh.position.set(-5, 1.7, -12.94);
  scene.add(mesh);
}
