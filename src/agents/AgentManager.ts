import * as THREE from 'three';
import { StickFigure } from '../characters/StickFigure.js';
import { AgentInfo, ACTIVITY_STATION_MAP } from './AgentData.js';
import { Activity } from './ActivityAnimations.js';
import { Station } from '../scene/Office.js';
import { Colors } from '../utils/Colors.js';

interface ManagedAgent {
  info: AgentInfo;
  figure: StickFigure;
  stationKey: string | null;
}

export class AgentManager {
  private agents = new Map<string, ManagedAgent>();
  private stations: Map<string, Station>;
  private scene: THREE.Scene;

  constructor(scene: THREE.Scene, stations: Map<string, Station>) {
    this.scene = scene;
    this.stations = stations;
  }

  addAgent(info: AgentInfo): StickFigure {
    const colorIndex = this.agents.size % Colors.accents.length;
    const figure = new StickFigure(info.name, Colors.accents[colorIndex]);

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

    // Fallback: any unoccupied station
    for (const [key, station] of this.stations) {
      if (!station.occupied) {
        placeAt(key, station);
        return;
      }
    }
  }
}
