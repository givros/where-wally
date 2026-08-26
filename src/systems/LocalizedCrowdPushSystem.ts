import type {
  CrowdPushAabb2,
  CrowdPushDiagnostics,
  CrowdPushPoint2,
  CrowdPushStepResult,
  CrowdPushSystemOptions,
} from './CrowdPushSystem';
import { CrowdSpatialIndex } from './CrowdSpatialIndex';

type LocalizedCrowdPushSystemOptions = CrowdPushSystemOptions & {
  spatialIndex: CrowdSpatialIndex;
};

export type LocalizedCrowdPushDiagnostics = CrowdPushDiagnostics & {
  simulationMode: 'localized-persistent-grid';
  activeBodies: number;
  movedBodies: number;
  maximumDisplacement: number;
};

const DEFAULT_NPC_RADIUS = 0.195;
const MAX_FRAME_SECONDS = 0.05;
const MAX_TRAVEL_PER_SUBSTEP = 0.075;
const MAX_SUBSTEPS = 16;
const SOLVER_ITERATIONS = 6;
const NPC_DAMPING = 8;
const MAX_NPC_SPEED = 2.8;
const PLAYER_INVERSE_MASS = 0.25;
const NPC_INVERSE_MASS = 1;
const PLAYER_PUSH_TRANSFER = 0.6;
const CONTACT_SLOP = 0.0005;
const POSITION_EPSILON = 0.00001;
const OVERLAP_EPSILON = 0.000001;
const STATIC_PROJECTION_PASSES = 3;

/**
 * Sparse crowd solver used for million-character worlds.
 *
 * All one million seeded circles remain collidable. Only the small contact
 * island around the player is promoted to dynamic state, and the shared static
 * index keeps every lookup proportional to nearby candidates rather than N.
 */
export class LocalizedCrowdPushSystem {
  readonly count: number;
  readonly positions: Float32Array;
  readonly radii: Float32Array;
  readonly velocitiesXZ: Float32Array;

  private readonly initialPositions: Float32Array;
  private readonly bounds: CrowdPushAabb2;
  private readonly blockers: readonly CrowdPushAabb2[];
  private readonly spatialIndex: CrowdSpatialIndex;
  private readonly maximumDisplacement: number;
  private readonly maxNpcRadius: number;
  private readonly minNpcRadius: number;
  private readonly movedFlags: Uint8Array;
  private readonly pushedFlags: Uint8Array;
  private readonly playerContactFlags: Uint8Array;
  private readonly workFlags: Uint8Array;
  private readonly activeFlags: Uint8Array;
  private readonly everMovedFlags: Uint8Array;
  private readonly movedIndices: number[] = [];
  private readonly pushedIndices: number[] = [];
  private readonly playerContactIndices: number[] = [];
  private readonly workIndices: number[] = [];
  private readonly activeIndices: number[] = [];
  private readonly everMovedIndices: number[] = [];
  private readonly stepResult: CrowdPushStepResult = {
    collided: false,
    blocked: false,
    playerContacts: 0,
    npcContacts: 0,
    pushedNpcCount: 0,
    movedNpcCount: 0,
    physicsSteps: 0,
    maxPenetration: 0,
    appliedX: 0,
    appliedZ: 0,
  };

  private stepCalls = 0;
  private totalPhysicsSteps = 0;
  private totalPushEvents = 0;
  private totalPlayerContacts = 0;
  private totalNpcContacts = 0;
  private lastMinimumSeparation = 0;

  constructor(options: LocalizedCrowdPushSystemOptions) {
    if (options.positions.length % 3 !== 0) {
      throw new Error('LocalizedCrowdPushSystem positions must contain complete xyz triples.');
    }
    this.positions = options.positions;
    this.count = options.positions.length / 3;
    this.bounds = { ...options.bounds };
    this.blockers = options.blockers;
    this.spatialIndex = options.spatialIndex;
    this.maximumDisplacement = options.spatialIndex.maximumDisplacement;
    this.initialPositions = options.positions.slice();
    this.velocitiesXZ = new Float32Array(this.count * 2);
    this.radii = options.radii?.length === this.count
      ? options.radii
      : new Float32Array(this.count);
    this.movedFlags = new Uint8Array(this.count);
    this.pushedFlags = new Uint8Array(this.count);
    this.playerContactFlags = new Uint8Array(this.count);
    this.workFlags = new Uint8Array(this.count);
    this.activeFlags = new Uint8Array(this.count);
    this.everMovedFlags = new Uint8Array(this.count);

    const fallbackRadius = finitePositive(options.defaultRadius, DEFAULT_NPC_RADIUS);
    let minimumRadius = Number.POSITIVE_INFINITY;
    let maximumRadius = fallbackRadius;
    if (options.radii?.length === this.count) {
      for (let index = 0; index < this.count; index += 1) {
        const radius = finitePositive(this.radii[index], fallbackRadius);
        minimumRadius = Math.min(minimumRadius, radius);
        maximumRadius = Math.max(maximumRadius, radius);
      }
    } else {
      this.radii.fill(fallbackRadius);
      minimumRadius = fallbackRadius;
    }
    this.minNpcRadius = Number.isFinite(minimumRadius) ? minimumRadius : fallbackRadius;
    this.maxNpcRadius = maximumRadius;
  }

  step(
    deltaSeconds: number,
    playerPosition: CrowdPushPoint2,
    previousPlayerPosition: Readonly<CrowdPushPoint2>,
    playerVelocity: Readonly<CrowdPushPoint2>,
    playerRadius: number,
  ): CrowdPushStepResult {
    const startX = finiteOr(previousPlayerPosition.x, finiteOr(playerPosition.x, 0));
    const startZ = finiteOr(previousPlayerPosition.z, finiteOr(playerPosition.z, 0));
    const targetX = finiteOr(playerPosition.x, startX);
    const targetZ = finiteOr(playerPosition.z, startZ);
    const safeRadius = finitePositive(playerRadius, DEFAULT_NPC_RADIUS);
    const safeDelta = clamp(finiteOr(deltaSeconds, 0), 0, MAX_FRAME_SECONDS);
    const velocityX = finiteOr(playerVelocity.x, 0);
    const velocityZ = finiteOr(playerVelocity.z, 0);

    this.clearStepState();
    this.stepCalls += 1;
    playerPosition.x = startX;
    playerPosition.z = startZ;
    if (this.projectDiscOutOfStatics(playerPosition, safeRadius)) {
      this.stepResult.collided = true;
    }
    const resolvedStartX = playerPosition.x;
    const resolvedStartZ = playerPosition.z;
    const movementX = targetX - startX;
    const movementZ = targetZ - startZ;
    const movementLength = Math.hypot(movementX, movementZ);
    if (movementLength <= POSITION_EPSILON && this.activeIndices.length === 0) {
      this.finishStep(playerPosition, targetX, targetZ, resolvedStartX, resolvedStartZ, 0);
      return this.stepResult;
    }

    const movementSteps = Math.ceil(movementLength / Math.max(
      0.035,
      Math.min(MAX_TRAVEL_PER_SUBSTEP, this.minNpcRadius * 0.38),
    ));
    const timeSteps = Math.ceil(safeDelta / (1 / 60));
    const substeps = clampInteger(Math.max(1, movementSteps, timeSteps), 1, MAX_SUBSTEPS);
    const movementStepX = movementX / substeps;
    const movementStepZ = movementZ / substeps;
    const substepSeconds = substeps > 0 ? safeDelta / substeps : 0;

    for (let substep = 0; substep < substeps; substep += 1) {
      this.clearWorkSet();
      this.integrateActiveNpcs(substepSeconds);
      playerPosition.x += movementStepX;
      playerPosition.z += movementStepZ;
      if (this.projectDiscOutOfStatics(playerPosition, safeRadius)) {
        this.stepResult.collided = true;
      }

      this.solvePlayerContacts(playerPosition, safeRadius, velocityX, velocityZ);
      for (let iteration = 0; iteration < SOLVER_ITERATIONS; iteration += 1) {
        const contactsBefore = this.stepResult.playerContacts + this.stepResult.npcContacts;
        this.solveWorkPairs();
        this.constrainMovedNpcsToWorld();
        this.solvePlayerContacts(playerPosition, safeRadius, velocityX, velocityZ);
        if (this.projectDiscOutOfStatics(playerPosition, safeRadius)) {
          this.stepResult.collided = true;
        }
        const contactsAfter = this.stepResult.playerContacts + this.stepResult.npcContacts;
        if (contactsAfter === contactsBefore) break;
      }
      for (let pass = 0; pass < SOLVER_ITERATIONS; pass += 1) {
        if (!this.projectPlayerOutOfCrowd(playerPosition, safeRadius)) break;
        this.stepResult.collided = true;
        this.projectDiscOutOfStatics(playerPosition, safeRadius);
      }
    }

    this.constrainMovedNpcsToWorld();
    this.finishStep(
      playerPosition,
      targetX,
      targetZ,
      resolvedStartX,
      resolvedStartZ,
      substeps,
    );
    return this.stepResult;
  }

  canOccupyPlayer(position: Readonly<CrowdPushPoint2>, playerRadius: number): boolean {
    const radius = finitePositive(playerRadius, DEFAULT_NPC_RADIUS);
    if (!Number.isFinite(position.x) || !Number.isFinite(position.z)) return false;
    if (!this.isDiscInsideBounds(position.x, position.z, radius)) return false;
    if (this.discOverlapsAnyBlocker(position.x, position.z, radius)) return false;
    let available = true;
    this.spatialIndex.forEachNearby(
      position.x,
      position.z,
      radius + this.maxNpcRadius,
      (characterIndex) => {
        if (!available) return;
        const offset = characterIndex * 3;
        const deltaX = this.positions[offset] - position.x;
        const deltaZ = this.positions[offset + 2] - position.z;
        const minimum = radius + this.radii[characterIndex] - CONTACT_SLOP;
        if (deltaX * deltaX + deltaZ * deltaZ < minimum * minimum) available = false;
      },
    );
    return available;
  }

  getMovedFlags(): Uint8Array {
    return this.movedFlags;
  }

  getMovedIndices(): readonly number[] {
    return this.movedIndices;
  }

  reset(): readonly number[] {
    this.clearStepState();
    for (const characterIndex of this.everMovedIndices) {
      const positionOffset = characterIndex * 3;
      this.positions[positionOffset] = this.initialPositions[positionOffset];
      this.positions[positionOffset + 1] = this.initialPositions[positionOffset + 1];
      this.positions[positionOffset + 2] = this.initialPositions[positionOffset + 2];
      const velocityOffset = characterIndex * 2;
      this.velocitiesXZ[velocityOffset] = 0;
      this.velocitiesXZ[velocityOffset + 1] = 0;
      this.movedFlags[characterIndex] = 1;
      this.movedIndices.push(characterIndex);
      this.everMovedFlags[characterIndex] = 0;
    }
    this.everMovedIndices.length = 0;
    for (const characterIndex of this.activeIndices) this.activeFlags[characterIndex] = 0;
    this.activeIndices.length = 0;
    this.stepCalls = 0;
    this.totalPhysicsSteps = 0;
    this.totalPushEvents = 0;
    this.totalPlayerContacts = 0;
    this.totalNpcContacts = 0;
    this.lastMinimumSeparation = 0;
    return this.movedIndices;
  }

  getDiagnostics(): LocalizedCrowdPushDiagnostics {
    return {
      engine: 'custom-2d-disc',
      simulationMode: 'localized-persistent-grid',
      bodyCount: this.count,
      solverIterations: SOLVER_ITERATIONS,
      gridCells: this.spatialIndex.getDiagnostics().gridCells,
      stepCalls: this.stepCalls,
      physicsSteps: this.totalPhysicsSteps,
      pushEvents: this.totalPushEvents,
      playerContacts: this.totalPlayerContacts,
      npcContacts: this.totalNpcContacts,
      lastPushedNpcCount: this.stepResult.pushedNpcCount,
      lastMovedNpcCount: this.stepResult.movedNpcCount,
      lastMaxPenetration: this.stepResult.maxPenetration,
      minNpcSeparation: this.lastMinimumSeparation,
      playerOverlapCount: 0,
      blockerOverlaps: 0,
      outOfBounds: 0,
      activeBodies: this.activeIndices.length,
      movedBodies: this.movedIndices.length,
      maximumDisplacement: this.maximumDisplacement,
    };
  }

  private clearStepState(): void {
    clearSparseFlags(this.movedFlags, this.movedIndices);
    clearSparseFlags(this.pushedFlags, this.pushedIndices);
    clearSparseFlags(this.playerContactFlags, this.playerContactIndices);
    this.clearWorkSet();
    this.stepResult.collided = false;
    this.stepResult.blocked = false;
    this.stepResult.playerContacts = 0;
    this.stepResult.npcContacts = 0;
    this.stepResult.pushedNpcCount = 0;
    this.stepResult.movedNpcCount = 0;
    this.stepResult.physicsSteps = 0;
    this.stepResult.maxPenetration = 0;
    this.stepResult.appliedX = 0;
    this.stepResult.appliedZ = 0;
    this.lastMinimumSeparation = Number.POSITIVE_INFINITY;
  }

  private clearWorkSet(): void {
    clearSparseFlags(this.workFlags, this.workIndices);
  }

  private finishStep(
    player: CrowdPushPoint2,
    targetX: number,
    targetZ: number,
    resolvedStartX: number,
    resolvedStartZ: number,
    substeps: number,
  ): void {
    this.stepResult.appliedX = player.x - resolvedStartX;
    this.stepResult.appliedZ = player.z - resolvedStartZ;
    this.stepResult.blocked = Math.hypot(targetX - player.x, targetZ - player.z) > 0.002;
    this.stepResult.movedNpcCount = this.movedIndices.length;
    this.stepResult.pushedNpcCount = this.pushedIndices.length;
    this.stepResult.physicsSteps = substeps;
    this.stepResult.collided ||= this.stepResult.playerContacts > 0;
    this.totalPhysicsSteps += substeps;
    this.totalPushEvents += this.stepResult.pushedNpcCount;
    this.totalPlayerContacts += this.stepResult.playerContacts;
    this.totalNpcContacts += this.stepResult.npcContacts;
    if (!Number.isFinite(this.lastMinimumSeparation)) this.lastMinimumSeparation = 0;
  }

  private integrateActiveNpcs(deltaSeconds: number): void {
    const damping = Math.exp(-NPC_DAMPING * Math.max(0, deltaSeconds));
    let writeIndex = 0;
    for (let listIndex = 0; listIndex < this.activeIndices.length; listIndex += 1) {
      const characterIndex = this.activeIndices[listIndex];
      const velocityOffset = characterIndex * 2;
      let velocityX = this.velocitiesXZ[velocityOffset] * damping;
      let velocityZ = this.velocitiesXZ[velocityOffset + 1] * damping;
      const speed = Math.hypot(velocityX, velocityZ);
      if (speed > MAX_NPC_SPEED) {
        const scale = MAX_NPC_SPEED / speed;
        velocityX *= scale;
        velocityZ *= scale;
      }
      if (Math.abs(velocityX) < 0.0005) velocityX = 0;
      if (Math.abs(velocityZ) < 0.0005) velocityZ = 0;
      this.velocitiesXZ[velocityOffset] = velocityX;
      this.velocitiesXZ[velocityOffset + 1] = velocityZ;
      if (velocityX === 0 && velocityZ === 0) {
        this.activeFlags[characterIndex] = 0;
        continue;
      }
      this.activeIndices[writeIndex] = characterIndex;
      writeIndex += 1;
      const positionOffset = characterIndex * 3;
      this.positions[positionOffset] += velocityX * deltaSeconds;
      this.positions[positionOffset + 2] += velocityZ * deltaSeconds;
      this.clampNpcToAnchor(characterIndex);
      this.markMoved(characterIndex);
      this.markWork(characterIndex);
    }
    this.activeIndices.length = writeIndex;
  }

  private solvePlayerContacts(
    player: CrowdPushPoint2,
    playerRadius: number,
    playerVelocityX: number,
    playerVelocityZ: number,
  ): void {
    this.spatialIndex.forEachNearby(
      player.x,
      player.z,
      playerRadius + this.maxNpcRadius + CONTACT_SLOP,
      (characterIndex) => {
        this.solvePlayerContact(
          player,
          playerRadius,
          playerVelocityX,
          playerVelocityZ,
          characterIndex,
        );
      },
    );
  }

  private solvePlayerContact(
    player: CrowdPushPoint2,
    playerRadius: number,
    playerVelocityX: number,
    playerVelocityZ: number,
    characterIndex: number,
  ): void {
    const positionOffset = characterIndex * 3;
    let deltaX = this.positions[positionOffset] - player.x;
    let deltaZ = this.positions[positionOffset + 2] - player.z;
    const minimumDistance = playerRadius + this.radii[characterIndex];
    const distanceSquared = deltaX * deltaX + deltaZ * deltaZ;
    if (distanceSquared >= (minimumDistance - CONTACT_SLOP) ** 2) return;

    let distance = Math.sqrt(Math.max(0, distanceSquared));
    if (distance <= OVERLAP_EPSILON) {
      deterministicNormal(-1, characterIndex, this.normalScratch);
      deltaX = this.normalScratch.x;
      deltaZ = this.normalScratch.z;
      distance = 0;
    } else {
      deltaX /= distance;
      deltaZ /= distance;
    }
    const penetration = Math.max(0, minimumDistance - distance + CONTACT_SLOP);
    const inverseMassSum = PLAYER_INVERSE_MASS + NPC_INVERSE_MASS;
    player.x -= deltaX * penetration * (PLAYER_INVERSE_MASS / inverseMassSum);
    player.z -= deltaZ * penetration * (PLAYER_INVERSE_MASS / inverseMassSum);
    this.positions[positionOffset] += deltaX * penetration * (NPC_INVERSE_MASS / inverseMassSum);
    this.positions[positionOffset + 2] += deltaZ * penetration * (NPC_INVERSE_MASS / inverseMassSum);
    this.clampNpcToAnchor(characterIndex);
    this.markMoved(characterIndex);
    this.markWork(characterIndex);
    this.stepResult.collided = true;
    this.stepResult.maxPenetration = Math.max(this.stepResult.maxPenetration, penetration);
    if (this.playerContactFlags[characterIndex] === 0) {
      this.playerContactFlags[characterIndex] = 1;
      this.playerContactIndices.push(characterIndex);
      this.stepResult.playerContacts += 1;
    }

    const velocityOffset = characterIndex * 2;
    const closingVelocity =
      (playerVelocityX - this.velocitiesXZ[velocityOffset]) * deltaX +
      (playerVelocityZ - this.velocitiesXZ[velocityOffset + 1]) * deltaZ;
    if (closingVelocity > 0) {
      this.velocitiesXZ[velocityOffset] += deltaX * closingVelocity * PLAYER_PUSH_TRANSFER;
      this.velocitiesXZ[velocityOffset + 1] += deltaZ * closingVelocity * PLAYER_PUSH_TRANSFER;
      this.limitNpcVelocity(characterIndex);
      this.markActive(characterIndex);
      if (this.pushedFlags[characterIndex] === 0) {
        this.pushedFlags[characterIndex] = 1;
        this.pushedIndices.push(characterIndex);
      }
    }
  }

  private solveWorkPairs(): void {
    for (let workIndex = 0; workIndex < this.workIndices.length; workIndex += 1) {
      const left = this.workIndices[workIndex];
      const leftOffset = left * 3;
      this.spatialIndex.forEachNearby(
        this.positions[leftOffset],
        this.positions[leftOffset + 2],
        this.radii[left] + this.maxNpcRadius + CONTACT_SLOP,
        (right) => {
          if (right === left) return;
          if (right < left && this.workFlags[right] !== 0) return;
          this.solveNpcPair(left, right);
        },
      );
    }
  }

  private solveNpcPair(left: number, right: number): void {
    const leftOffset = left * 3;
    const rightOffset = right * 3;
    let deltaX = this.positions[rightOffset] - this.positions[leftOffset];
    let deltaZ = this.positions[rightOffset + 2] - this.positions[leftOffset + 2];
    const minimumDistance = this.radii[left] + this.radii[right];
    const distanceSquared = deltaX * deltaX + deltaZ * deltaZ;
    const separation = Math.sqrt(Math.max(0, distanceSquared)) - minimumDistance;
    this.lastMinimumSeparation = Math.min(this.lastMinimumSeparation, separation);
    if (distanceSquared >= (minimumDistance - CONTACT_SLOP) ** 2) return;

    let distance = Math.sqrt(Math.max(0, distanceSquared));
    if (distance <= OVERLAP_EPSILON) {
      deterministicNormal(left, right, this.normalScratch);
      deltaX = this.normalScratch.x;
      deltaZ = this.normalScratch.z;
      distance = 0;
    } else {
      deltaX /= distance;
      deltaZ /= distance;
    }
    const penetration = Math.max(0, minimumDistance - distance + CONTACT_SLOP);
    const correction = penetration * 0.5;
    this.positions[leftOffset] -= deltaX * correction;
    this.positions[leftOffset + 2] -= deltaZ * correction;
    this.positions[rightOffset] += deltaX * correction;
    this.positions[rightOffset + 2] += deltaZ * correction;
    this.clampNpcToAnchor(left);
    this.clampNpcToAnchor(right);
    this.markMoved(left);
    this.markMoved(right);
    this.markWork(right);
    this.stepResult.npcContacts += 1;
    this.stepResult.maxPenetration = Math.max(this.stepResult.maxPenetration, penetration);

    const leftVelocityOffset = left * 2;
    const rightVelocityOffset = right * 2;
    const closingVelocity =
      (this.velocitiesXZ[leftVelocityOffset] - this.velocitiesXZ[rightVelocityOffset]) * deltaX +
      (this.velocitiesXZ[leftVelocityOffset + 1] - this.velocitiesXZ[rightVelocityOffset + 1]) * deltaZ;
    if (closingVelocity > 0) {
      const impulse = closingVelocity * 0.5;
      this.velocitiesXZ[leftVelocityOffset] -= deltaX * impulse;
      this.velocitiesXZ[leftVelocityOffset + 1] -= deltaZ * impulse;
      this.velocitiesXZ[rightVelocityOffset] += deltaX * impulse;
      this.velocitiesXZ[rightVelocityOffset + 1] += deltaZ * impulse;
      this.markActive(left);
      this.markActive(right);
    }
  }

  private projectPlayerOutOfCrowd(player: CrowdPushPoint2, playerRadius: number): boolean {
    let projected = false;
    this.spatialIndex.forEachNearby(
      player.x,
      player.z,
      playerRadius + this.maxNpcRadius + CONTACT_SLOP,
      (characterIndex) => {
        const offset = characterIndex * 3;
        let deltaX = this.positions[offset] - player.x;
        let deltaZ = this.positions[offset + 2] - player.z;
        const minimumDistance = playerRadius + this.radii[characterIndex] + CONTACT_SLOP;
        const distanceSquared = deltaX * deltaX + deltaZ * deltaZ;
        if (distanceSquared >= minimumDistance * minimumDistance) return;
        let distance = Math.sqrt(Math.max(0, distanceSquared));
        if (distance <= OVERLAP_EPSILON) {
          deterministicNormal(-1, characterIndex, this.normalScratch);
          deltaX = this.normalScratch.x;
          deltaZ = this.normalScratch.z;
          distance = 0;
        } else {
          deltaX /= distance;
          deltaZ /= distance;
        }
        const correction = minimumDistance - distance;
        player.x -= deltaX * correction;
        player.z -= deltaZ * correction;
        projected = true;
        if (this.playerContactFlags[characterIndex] === 0) {
          this.playerContactFlags[characterIndex] = 1;
          this.playerContactIndices.push(characterIndex);
          this.stepResult.playerContacts += 1;
        }
      },
    );
    return projected;
  }

  private constrainMovedNpcsToWorld(): void {
    for (const characterIndex of this.movedIndices) {
      const offset = characterIndex * 3;
      this.scratchNpcPoint.x = this.positions[offset];
      this.scratchNpcPoint.z = this.positions[offset + 2];
      if (this.projectDiscOutOfStatics(this.scratchNpcPoint, this.radii[characterIndex])) {
        this.positions[offset] = this.scratchNpcPoint.x;
        this.positions[offset + 2] = this.scratchNpcPoint.z;
        this.clampNpcToAnchor(characterIndex);
      }
    }
  }

  private clampNpcToAnchor(characterIndex: number): void {
    const offset = characterIndex * 3;
    const deltaX = this.positions[offset] - this.initialPositions[offset];
    const deltaZ = this.positions[offset + 2] - this.initialPositions[offset + 2];
    const distance = Math.hypot(deltaX, deltaZ);
    if (distance <= this.maximumDisplacement || distance <= 0) return;
    const scale = this.maximumDisplacement / distance;
    this.positions[offset] = this.initialPositions[offset] + deltaX * scale;
    this.positions[offset + 2] = this.initialPositions[offset + 2] + deltaZ * scale;
  }

  private markMoved(characterIndex: number): void {
    if (this.movedFlags[characterIndex] === 0) {
      this.movedFlags[characterIndex] = 1;
      this.movedIndices.push(characterIndex);
    }
    if (this.everMovedFlags[characterIndex] === 0) {
      this.everMovedFlags[characterIndex] = 1;
      this.everMovedIndices.push(characterIndex);
    }
  }

  private markWork(characterIndex: number): void {
    if (this.workFlags[characterIndex] !== 0) return;
    this.workFlags[characterIndex] = 1;
    this.workIndices.push(characterIndex);
  }

  private markActive(characterIndex: number): void {
    if (this.activeFlags[characterIndex] !== 0) return;
    this.activeFlags[characterIndex] = 1;
    this.activeIndices.push(characterIndex);
  }

  private limitNpcVelocity(characterIndex: number): void {
    const offset = characterIndex * 2;
    const velocityX = this.velocitiesXZ[offset];
    const velocityZ = this.velocitiesXZ[offset + 1];
    const speed = Math.hypot(velocityX, velocityZ);
    if (speed <= MAX_NPC_SPEED || speed <= 0) return;
    const scale = MAX_NPC_SPEED / speed;
    this.velocitiesXZ[offset] *= scale;
    this.velocitiesXZ[offset + 1] *= scale;
  }

  private projectDiscOutOfStatics(point: CrowdPushPoint2, radius: number): boolean {
    let projected = false;
    for (let pass = 0; pass < STATIC_PROJECTION_PASSES; pass += 1) {
      let changed = false;
      const clampedX = clamp(point.x, this.bounds.minX + radius, this.bounds.maxX - radius);
      const clampedZ = clamp(point.z, this.bounds.minZ + radius, this.bounds.maxZ - radius);
      if (Math.abs(clampedX - point.x) > POSITION_EPSILON) {
        point.x = clampedX;
        changed = true;
      }
      if (Math.abs(clampedZ - point.z) > POSITION_EPSILON) {
        point.z = clampedZ;
        changed = true;
      }
      for (const blocker of this.blockers) {
        if (projectDiscOutOfAabb(point, radius, blocker)) changed = true;
      }
      projected ||= changed;
      if (!changed) break;
    }
    return projected;
  }

  private isDiscInsideBounds(x: number, z: number, radius: number): boolean {
    return x >= this.bounds.minX + radius - CONTACT_SLOP &&
      x <= this.bounds.maxX - radius + CONTACT_SLOP &&
      z >= this.bounds.minZ + radius - CONTACT_SLOP &&
      z <= this.bounds.maxZ - radius + CONTACT_SLOP;
  }

  private discOverlapsAnyBlocker(x: number, z: number, radius: number): boolean {
    for (const blocker of this.blockers) {
      const closestX = clamp(x, blocker.minX, blocker.maxX);
      const closestZ = clamp(z, blocker.minZ, blocker.maxZ);
      const deltaX = x - closestX;
      const deltaZ = z - closestZ;
      if (deltaX * deltaX + deltaZ * deltaZ < (radius - CONTACT_SLOP) ** 2) return true;
    }
    return false;
  }

  private readonly scratchNpcPoint: CrowdPushPoint2 = { x: 0, z: 0 };
  private readonly normalScratch: CrowdPushPoint2 = { x: 1, z: 0 };
}

function clearSparseFlags(flags: Uint8Array, indices: number[]): void {
  for (const characterIndex of indices) flags[characterIndex] = 0;
  indices.length = 0;
}

function projectDiscOutOfAabb(
  point: CrowdPushPoint2,
  radius: number,
  blocker: CrowdPushAabb2,
): boolean {
  const closestX = clamp(point.x, blocker.minX, blocker.maxX);
  const closestZ = clamp(point.z, blocker.minZ, blocker.maxZ);
  let deltaX = point.x - closestX;
  let deltaZ = point.z - closestZ;
  const distanceSquared = deltaX * deltaX + deltaZ * deltaZ;
  if (distanceSquared >= radius * radius) return false;
  if (distanceSquared > OVERLAP_EPSILON * OVERLAP_EPSILON) {
    const distance = Math.sqrt(distanceSquared);
    const correction = radius - distance + CONTACT_SLOP;
    deltaX /= distance;
    deltaZ /= distance;
    point.x += deltaX * correction;
    point.z += deltaZ * correction;
    return true;
  }
  const left = Math.abs(point.x - (blocker.minX - radius));
  const right = Math.abs(blocker.maxX + radius - point.x);
  const top = Math.abs(point.z - (blocker.minZ - radius));
  const bottom = Math.abs(blocker.maxZ + radius - point.z);
  const minimum = Math.min(left, right, top, bottom);
  if (minimum === left) point.x = blocker.minX - radius - CONTACT_SLOP;
  else if (minimum === right) point.x = blocker.maxX + radius + CONTACT_SLOP;
  else if (minimum === top) point.z = blocker.minZ - radius - CONTACT_SLOP;
  else point.z = blocker.maxZ + radius + CONTACT_SLOP;
  return true;
}

function deterministicNormal(left: number, right: number, target: CrowdPushPoint2): void {
  let value = Math.imul(left + 2, 0x45d9f3b) ^ Math.imul(right + 3, 0x119de1f3);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  const angle = ((value >>> 0) / 4_294_967_296) * Math.PI * 2;
  target.x = Math.cos(angle);
  target.z = Math.sin(angle);
}

function finitePositive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? value as number : fallback;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}
