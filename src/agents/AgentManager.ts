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

    // Assign to station
    this.assignStation(managed, info.activity);

    return figure;
  }

  setActivity(agentId: string, activity: Activity): void {
    const managed = this.agents.get(agentId);
    if (!managed) return;

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

  getAgents(): ManagedAgent[] {
    return Array.from(this.agents.values());
  }

  private assignStation(managed: ManagedAgent, activity: Activity): void {
    const stationType = ACTIVITY_STATION_MAP[activity];

    // Find an unoccupied station of the right type
    for (const [key, station] of this.stations) {
      if (station.type === stationType && !station.occupied) {
        station.occupied = true;
        managed.stationKey = key;
        managed.figure.moveTo(station.position, station.lookAt);
        managed.figure.setActivity(activity);
        return;
      }
    }

    // Fallback: find any station of similar type, or just stay
    // Try desk as fallback for most activities
    for (const [key, station] of this.stations) {
      if (!station.occupied) {
        station.occupied = true;
        managed.stationKey = key;
        managed.figure.moveTo(station.position, station.lookAt);
        managed.figure.setActivity(activity);
        return;
      }
    }
  }
}
