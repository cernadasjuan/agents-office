import * as THREE from 'three';
import { StickFigure } from '../characters/StickFigure.js';
import { AgentInfo, ACTIVITY_STATION_MAP } from './AgentData.js';
import { Activity } from './ActivityAnimations.js';
import { Station } from '../scene/Office.js';
import { Colors } from '../utils/Colors.js';

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
  };
}

// FNV-1a hash of the agent ID, so an agent keeps its color across polls and reloads
function accentColorFor(agentId: string): THREE.Color {
  let hash = 0x811c9dc5;
  for (let i = 0; i < agentId.length; i++) {
    hash ^= agentId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return Colors.accents[(hash >>> 0) % Colors.accents.length];
}

interface ManagedAgent {
  info: AgentInfo;
  figure: StickFigure;
  stationKey: string | null;
}

export class AgentManager {
  private agents = new Map<string, ManagedAgent>();
  private stations: Map<string, Station>;
  private scene: THREE.Scene;
  private overflowCount = 0;

  constructor(scene: THREE.Scene, stations: Map<string, Station>) {
    this.scene = scene;
    this.stations = stations;
  }

  addAgent(info: AgentInfo): StickFigure {
    const figure = new StickFigure(info.name, accentColorFor(info.id));

    const managed: ManagedAgent = {
      info,
      figure,
      stationKey: null,
    };
    this.agents.set(info.id, managed);
    this.scene.add(figure.group);

    // Assign to station (teleport immediately, no walk animation)
    this.assignStation(managed, info.activity, true);

    return figure;
  }

  setActivity(agentId: string, activity: Activity): void {
    const managed = this.agents.get(agentId);
    if (!managed) return;

    const newStationType = ACTIVITY_STATION_MAP[activity];
    const oldStationType = ACTIVITY_STATION_MAP[managed.info.activity];

    // If station type is the same, stay at current station (don't move desks)
    if (newStationType === oldStationType && managed.stationKey) {
      managed.info.activity = activity;
      managed.figure.setActivity(activity);
      return;
    }

    // Release current station
    if (managed.stationKey) {
      const station = this.stations.get(managed.stationKey);
      if (station) station.occupied = false;
      managed.stationKey = null;
    }

    managed.info.activity = activity;
    managed.figure.setActivity(activity);
    this.assignStation(managed, activity);
  }

  update(elapsed: number, delta: number): void {
    for (const managed of this.agents.values()) {
      managed.figure.update(elapsed, delta);
    }
  }

  removeAgent(agentId: string): void {
    const managed = this.agents.get(agentId);
    if (!managed) return;

    // Release station
    if (managed.stationKey) {
      const station = this.stations.get(managed.stationKey);
      if (station) station.occupied = false;
    }

    // Remove from scene
    this.scene.remove(managed.figure.group);
    managed.figure.dispose();

    this.agents.delete(agentId);
  }

  getAgents(): ManagedAgent[] {
    return Array.from(this.agents.values());
  }

  private assignStation(managed: ManagedAgent, activity: Activity, teleport = false): void {
    const stationType = ACTIVITY_STATION_MAP[activity];

    const placeAt = (key: string, station: Station) => {
      station.occupied = true;
      managed.stationKey = key;
      if (teleport) {
        managed.figure.teleportTo(station.position, station.lookAt);
      } else {
        managed.figure.moveTo(station.position, station.lookAt);
      }
      managed.figure.setActivity(activity);
    };

    // Find an unoccupied station of the right type
    for (const [key, station] of this.stations) {
      if (station.type === stationType && !station.occupied) {
        placeAt(key, station);
        return;
      }
    }

    // Fallback: a free overflow spot. A seat of another type would show the wrong status.
    for (const [key, station] of this.stations) {
      if (station.type === 'overflow' && !station.occupied) {
        placeAt(key, station);
        return;
      }
    }

    // Every spot is taken: open a new overflow spot so no two agents overlap
    const overflowIndex = this.overflowCount++;
    const key = `overflow_${overflowIndex}`;
    const station = overflowStation(overflowIndex);
    this.stations.set(key, station);
    placeAt(key, station);
  }
}
