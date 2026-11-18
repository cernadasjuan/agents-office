import * as THREE from 'three';
import { ACTIVITY_STATION_MAP } from '../agents/AgentData.js';
import type { Activity } from '../agents/ActivityAnimations.js';
import type { Station } from '../scene/Office.js';
import type { LayoutAgent, LayoutStrategy, Seat } from './LayoutStrategy.js';

// Open floor rows (aisle between desk rows, lounge front, space behind the desks).
const OVERFLOW_ROWS_Z = [0.8, 1.9, 6.4, 7.5, -8, -9.2];
const OVERFLOW_FIRST_X = -9;
const OVERFLOW_SPACING = 1.2;
const OVERFLOW_COLUMNS = 16;

function overflowStation(index: number): Station {
  const slotsPerLayer = OVERFLOW_ROWS_Z.length * OVERFLOW_COLUMNS;
  const layerOffset = Math.floor(index / slotsPerLayer) * (OVERFLOW_SPACING / 3);
  const slot = index % slotsPerLayer;
  const x = OVERFLOW_FIRST_X + (slot % OVERFLOW_COLUMNS) * OVERFLOW_SPACING + layerOffset;
  const z = OVERFLOW_ROWS_Z[Math.floor(slot / OVERFLOW_COLUMNS)] + layerOffset;
  return {
    type: 'overflow',
    position: new THREE.Vector3(x, 0, z),
    lookAt: new THREE.Vector3(x, 1.2, z + 1),
    occupied: false,
    posture: 'standing',
  };
}

/**
 * The original layout: place shows activity. An agent takes the first free
 * station of its activity's type. If the new activity uses the same station
 * type, it stays where it is. When no station of the type is free, it stands
 * on an overflow spot on open floor.
 */
export class ActivityLayout implements LayoutStrategy {
  readonly id = 'activity';
  private seatOf = new Map<string, string>();
  private overflowCount = 0;

  constructor(private stations: Map<string, Station>) {}

  seatFor(agent: LayoutAgent, previous: Activity | null): Seat | null {
    const current = this.seatOf.get(agent.id);
    const sameStationType = previous !== null
      && ACTIVITY_STATION_MAP[previous] === ACTIVITY_STATION_MAP[agent.activity];
    if (current && sameStationType) return null;

    this.release(agent.id);
    const key = this.freeStationKey(ACTIVITY_STATION_MAP[agent.activity]);
    const station = this.stations.get(key)!;
    station.occupied = true;
    this.seatOf.set(agent.id, key);
    return { key, position: station.position, lookAt: station.lookAt, posture: station.posture };
  }

  release(agentId: string): void {
    const key = this.seatOf.get(agentId);
    if (!key) return;
    const station = this.stations.get(key);
    if (station) station.occupied = false;
    this.seatOf.delete(agentId);
  }

  private freeStationKey(stationType: string): string {
    for (const [key, station] of this.stations) {
      if (station.type === stationType && !station.occupied) return key;
    }
    // A seat of another type would show the wrong status, so only overflow spots remain.
    for (const [key, station] of this.stations) {
      if (station.type === 'overflow' && !station.occupied) return key;
    }
    const key = `overflow_${this.overflowCount}`;
    this.stations.set(key, overflowStation(this.overflowCount++));
    return key;
  }
}
