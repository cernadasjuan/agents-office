import * as THREE from 'three';
import { hexRoomFrame, type HexRoomGeometry } from './HexRoomPlanner.js';

/**
 * A hex room's own local frame (issue #259): the same shape `rooms.ts`'s `RoomFrame` already
 * gives a rect room (`point(a, d, y)`, `faceDoor`, `faceAway`, `doorAlong`), built instead from
 * `HexRoomPlanner.hexRoomFrame`'s door-wall math (`doorMid`/`inward`/`along`). A caller that
 * already knows how to furnish a `RoomFrame` (`warRoomFurnishing.ts`'s plan, `missionRooms.ts`'s
 * own board/sign/tombstone placements) furnishes a `HexFrame` the exact same way, no branching
 * on room shape needed at any call site.
 *
 * `doorAlong` is always 0: `hexRoomFrame`'s own `doorMid` already IS the door (a hex room's one
 * open edge, never off-center the way a rect room's door can sit along a wider wall) — unlike
 * `RoomFrame.doorAlong`, which has to measure how far off-center the door is from its own
 * door-wall midpoint.
 */
export class HexFrame {
  readonly inward: THREE.Vector3;
  readonly along: THREE.Vector3;
  readonly doorAlong = 0;
  private readonly doorMid: THREE.Vector3;

  constructor(room: HexRoomGeometry, openEdgeIndex: number) {
    const frame = hexRoomFrame(room, openEdgeIndex);
    this.doorMid = new THREE.Vector3(frame.doorMid.x, 0, frame.doorMid.z);
    this.inward = new THREE.Vector3(frame.inward.x, 0, frame.inward.z);
    this.along = new THREE.Vector3(frame.along.x, 0, frame.along.z);
  }

  point(a: number, d: number, y = 0): THREE.Vector3 {
    return this.doorMid.clone().addScaledVector(this.along, a).addScaledVector(this.inward, d).setY(y);
  }

  /** Rotation that makes a piece of furniture face the door (its front looks along -inward). */
  get faceDoor(): number {
    return Math.atan2(-this.inward.x, -this.inward.z);
  }

  /** Rotation that makes a piece of furniture face away from the door. */
  get faceAway(): number {
    return Math.atan2(this.inward.x, this.inward.z);
  }
}
