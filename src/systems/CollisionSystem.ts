import * as THREE from 'three';
import type { Aabb2 } from '../assets/CityWorld';

export type CollisionMoveResult = {
  collided: boolean;
  contacts: number;
};

export class CollisionSystem {
  private readonly step = new THREE.Vector3();
  private readonly candidate = new THREE.Vector3();
  private readonly result: CollisionMoveResult = { collided: false, contacts: 0 };

  moveCircle(
    position: THREE.Vector3,
    movement: THREE.Vector3,
    radius: number,
    bounds: Aabb2,
    blockers: readonly Aabb2[],
  ): CollisionMoveResult {
    this.result.collided = false;
    this.result.contacts = 0;

    const movementLength = movement.length();
    if (!Number.isFinite(movementLength)) {
      this.result.collided = true;
      this.result.contacts = 1;
      return this.result;
    }
    const substeps = Math.max(1, Math.ceil(movementLength / Math.max(0.08, radius * 0.45)));
    this.step.copy(movement).multiplyScalar(1 / substeps);

    for (let stepIndex = 0; stepIndex < substeps; stepIndex += 1) {
      this.moveAxis(position, this.step.x, true, radius, bounds, blockers);
      this.moveAxis(position, this.step.z, false, radius, bounds, blockers);
    }

    return this.result;
  }

  canOccupy(
    position: THREE.Vector3,
    radius: number,
    bounds: Aabb2,
    blockers: readonly Aabb2[],
  ): boolean {
    if (
      position.x < bounds.minX + radius ||
      position.x > bounds.maxX - radius ||
      position.z < bounds.minZ + radius ||
      position.z > bounds.maxZ - radius
    ) {
      return false;
    }

    return !this.overlapsBlocker(position.x, position.z, radius, blockers);
  }

  private moveAxis(
    position: THREE.Vector3,
    amount: number,
    moveX: boolean,
    radius: number,
    bounds: Aabb2,
    blockers: readonly Aabb2[],
  ): void {
    if (Math.abs(amount) < Number.EPSILON) return;

    this.candidate.copy(position);
    if (moveX) {
      this.candidate.x = THREE.MathUtils.clamp(
        position.x + amount,
        bounds.minX + radius,
        bounds.maxX - radius,
      );
    } else {
      this.candidate.z = THREE.MathUtils.clamp(
        position.z + amount,
        bounds.minZ + radius,
        bounds.maxZ - radius,
      );
    }

    const targetCoordinate = moveX ? this.candidate.x : this.candidate.z;
    const clippedByBoundary = moveX
      ? Math.abs(this.candidate.x - (position.x + amount)) > 0.0001
      : Math.abs(this.candidate.z - (position.z + amount)) > 0.0001;

    if (this.overlapsBlocker(this.candidate.x, this.candidate.z, radius, blockers)) {
      const originCoordinate = moveX ? position.x : position.z;
      let clearFraction = 0;
      let blockedFraction = 1;
      for (let iteration = 0; iteration < 14; iteration += 1) {
        const fraction = (clearFraction + blockedFraction) * 0.5;
        const coordinate = originCoordinate + (targetCoordinate - originCoordinate) * fraction;
        if (moveX) this.candidate.set(coordinate, position.y, position.z);
        else this.candidate.set(position.x, position.y, coordinate);
        if (this.overlapsBlocker(this.candidate.x, this.candidate.z, radius, blockers)) {
          blockedFraction = fraction;
        } else {
          clearFraction = fraction;
        }
      }
      const resolvedCoordinate =
        originCoordinate + (targetCoordinate - originCoordinate) * clearFraction;
      if (moveX) position.x = resolvedCoordinate;
      else position.z = resolvedCoordinate;
      this.result.collided = true;
      this.result.contacts += 1;
      return;
    }

    if (clippedByBoundary) {
      this.result.collided = true;
      this.result.contacts += 1;
    }
    position.copy(this.candidate);
  }

  private overlapsBlocker(
    x: number,
    z: number,
    radius: number,
    blockers: readonly Aabb2[],
  ): boolean {
    for (const blocker of blockers) {
      const closestX = THREE.MathUtils.clamp(x, blocker.minX, blocker.maxX);
      const closestZ = THREE.MathUtils.clamp(z, blocker.minZ, blocker.maxZ);
      const deltaX = x - closestX;
      const deltaZ = z - closestZ;
      if (deltaX * deltaX + deltaZ * deltaZ < radius * radius) return true;
    }
    return false;
  }
}
