import * as THREE from 'three';
import { ACTIVITY_STATION_MAP } from '../agents/AgentData.js';
import type { Activity } from '../agents/ActivityAnimations.js';
import type { Station } from '../scene/Office.js';
import type { LayoutAgent, LayoutMove, LayoutStrategy, Seat } from './LayoutStrategy.js';

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

export interface ActivityLayoutOptions {
  /**
   * How long a new activity must last before the agent walks to its station, in
   * ms. 0 (the default) moves at once. A change back before the time cancels the trip.
   */
  dwellMs?: number;
  /** The clock, in ms. Tests inject one. */
  now?: () => number;
}

interface PendingTrip {
  stationType: string;
  since: number;
}

/**
 * The original layout: place shows activity. An agent takes the first free
 * station of its activity's type. If the new activity uses the same station
 * type, it stays where it is. When no station of the type is free, it stands
 * on an overflow spot on open floor. With a dwell time, a station change waits
 * until the new activity lasted that long; `update()` then returns the move.
 */
export class ActivityLayout implements LayoutStrategy {
  readonly id = 'activity';
  private seatOf = new Map<string, string>();
  /** The station type each agent's seat was chosen for (an overflow spot keeps the wanted type). */
  private seatTypeOf = new Map<string, string>();
  private pending = new Map<string, PendingTrip>();
  private overflowCount = 0;
  private dwellMs: number;
  private now: () => number;

  constructor(private stations: Map<string, Station>, options: ActivityLayoutOptions = {}) {
    this.dwellMs = Math.max(0, options.dwellMs ?? 0);
    this.now = options.now ?? (() => performance.now());
  }

  seatFor(agent: LayoutAgent, previous: Activity | null): Seat | null {
    const current = this.seatOf.get(agent.id);
    if (this.dwellMs > 0 && current && previous !== null) return this.waitForDwell(agent);

    const sameStationType = previous !== null
      && ACTIVITY_STATION_MAP[previous] === ACTIVITY_STATION_MAP[agent.activity];
    if (current && sameStationType) return null;
    return this.claimSeat(agent.id, ACTIVITY_STATION_MAP[agent.activity]);
  }

  update(): LayoutMove[] {
    if (this.pending.size === 0) return [];
    const now = this.now();
    const moves: LayoutMove[] = [];
    for (const [agentId, trip] of this.pending) {
      if (now - trip.since < this.dwellMs) continue;
      this.pending.delete(agentId);
      moves.push({ agentId, seat: this.claimSeat(agentId, trip.stationType) });
    }
    return moves;
  }

  /** Keep the seat; start, keep or cancel the trip to the new station type. */
  private waitForDwell(agent: LayoutAgent): null {
    const stationType = ACTIVITY_STATION_MAP[agent.activity];
    if (stationType === this.seatTypeOf.get(agent.id)) {
      this.pending.delete(agent.id);
    } else if (this.pending.get(agent.id)?.stationType !== stationType) {
      this.pending.set(agent.id, { stationType, since: this.now() });
    }
    return null;
  }

  private claimSeat(agentId: string, stationType: string): Seat {
    this.release(agentId);
    const key = this.freeStationKey(stationType);
    const station = this.stations.get(key)!;
    station.occupied = true;
    this.seatOf.set(agentId, key);
    this.seatTypeOf.set(agentId, stationType);
    return { key, position: station.position, lookAt: station.lookAt, posture: station.posture };
  }

  release(agentId: string): void {
    const key = this.seatOf.get(agentId);
    if (!key) return;
    const station = this.stations.get(key);
    if (station) station.occupied = false;
    this.seatOf.delete(agentId);
    this.seatTypeOf.delete(agentId);
    this.pending.delete(agentId);
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
