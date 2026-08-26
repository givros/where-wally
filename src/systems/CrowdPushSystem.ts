/**
 * Allocation-light, deterministic 2D disc solver for a pushable crowd.
 *
 * Crowd positions use the same xyz Float32Array consumed by rendering and
 * picking. Only x/z are simulated; y is preserved. The player is represented
 * by mutable objects with x/z properties, so this module has no Three.js or
 * DOM dependency and can be exercised directly by logic tests.
 */

export type CrowdPushPoint2 = {
  x: number;
  z: number;
};

export type CrowdPushAabb2 = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

export type CrowdPushSystemOptions = {
  /** Mutable xyz positions shared with the crowd renderer and picker. */
  positions: Float32Array;
  /** One collision radius per character. Defaults to `defaultRadius`. */
  radii?: Float32Array;
  bounds: CrowdPushAabb2;
  blockers: readonly CrowdPushAabb2[];
  defaultRadius?: number;
};

export type CrowdPushStepResult = {
  collided: boolean;
  blocked: boolean;
  playerContacts: number;
  npcContacts: number;
  pushedNpcCount: number;
  movedNpcCount: number;
  physicsSteps: number;
  maxPenetration: number;
  appliedX: number;
  appliedZ: number;
};

export type CrowdPushDiagnostics = {
  engine: 'custom-2d-disc';
  bodyCount: number;
  solverIterations: number;
  gridCells: number;
  stepCalls: number;
  physicsSteps: number;
  pushEvents: number;
  playerContacts: number;
  npcContacts: number;
  lastPushedNpcCount: number;
  lastMovedNpcCount: number;
  lastMaxPenetration: number;
  minNpcSeparation: number;
  playerOverlapCount: number;
  blockerOverlaps: number;
  outOfBounds: number;
};

const DEFAULT_NPC_RADIUS = 0.29;
const MAX_FRAME_SECONDS = 0.05;
const TARGET_STEP_SECONDS = 1 / 60;
const SOLVER_ITERATIONS = 8;
const MAX_SUBSTEPS = 96;
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
 * The returned step result is reused on subsequent calls. Read or copy it
 * before invoking `step` again if it needs to be retained.
 */
export class CrowdPushSystem {
  readonly count: number;
  readonly positions: Float32Array;
  readonly radii: Float32Array;
  readonly velocitiesXZ: Float32Array;

  private readonly initialPositions: Float32Array;
  private readonly bounds: CrowdPushAabb2;
  private readonly blockers: readonly CrowdPushAabb2[];
  private readonly gridHeads: Int32Array;
  private readonly gridNext: Int32Array;
  private readonly movedFlags: Uint8Array;
  private readonly pushedFlags: Uint8Array;
  private readonly playerContactFlags: Uint8Array;
  private readonly gridColumns: number;
  private readonly gridRows: number;
  private readonly gridCellSize: number;
  private readonly maxNpcRadius: number;
  private readonly minNpcRadius: number;
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
  private activeVelocityCount = 0;
  private lastPlayerX = Number.NaN;
  private lastPlayerZ = Number.NaN;
  private lastPlayerRadius = 0;

  constructor(options: CrowdPushSystemOptions) {
    if (options.positions.length % 3 !== 0) {
      throw new Error('CrowdPushSystem positions must contain complete xyz triples.');
    }

    this.positions = options.positions;
    this.count = options.positions.length / 3;
    this.bounds = options.bounds;
    this.blockers = options.blockers;
    this.initialPositions = options.positions.slice();
    this.velocitiesXZ = new Float32Array(this.count * 2);
    this.radii = new Float32Array(this.count);
    this.movedFlags = new Uint8Array(this.count);
    this.pushedFlags = new Uint8Array(this.count);
    this.playerContactFlags = new Uint8Array(this.count);

    const fallbackRadius = finitePositive(options.defaultRadius, DEFAULT_NPC_RADIUS);
    let maxRadius = fallbackRadius;
    let minRadius = fallbackRadius;
    for (let index = 0; index < this.count; index += 1) {
      const supplied = options.radii?.[index];
      const radius = finitePositive(supplied, fallbackRadius);
      this.radii[index] = radius;
      maxRadius = Math.max(maxRadius, radius);
      minRadius = Math.min(minRadius, radius);
    }
    this.maxNpcRadius = maxRadius;
    this.minNpcRadius = minRadius;

    this.gridCellSize = Math.max(0.32, maxRadius * 2 + 0.04);
    const width = Math.max(this.gridCellSize, options.bounds.maxX - options.bounds.minX);
    const depth = Math.max(this.gridCellSize, options.bounds.maxZ - options.bounds.minZ);
    this.gridColumns = Math.max(1, Math.ceil(width / this.gridCellSize));
    this.gridRows = Math.max(1, Math.ceil(depth / this.gridCellSize));
    this.gridHeads = new Int32Array(this.gridColumns * this.gridRows);
    this.gridNext = new Int32Array(this.count);
    this.gridHeads.fill(-1);
    this.gridNext.fill(-1);
  }

  /**
   * Resolves one proposed player movement and advances crowd inertia.
   *
   * `previousPlayerPosition` is the position before the caller's movement;
   * `playerPosition` is the proposed end position and is overwritten with the
   * resolved end position. `playerVelocity` is used to transfer shove impulse.
   */
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
    const safePlayerRadius = finitePositive(playerRadius, DEFAULT_NPC_RADIUS);
    const safeDelta = clamp(finiteOr(deltaSeconds, 0), 0, MAX_FRAME_SECONDS);
    const velocityX = finiteOr(playerVelocity.x, 0);
    const velocityZ = finiteOr(playerVelocity.z, 0);

    this.clearStepState();
    this.stepCalls += 1;

    playerPosition.x = startX;
    playerPosition.z = startZ;
    if (this.projectDiscOutOfStatics(playerPosition, safePlayerRadius)) {
      this.stepResult.collided = true;
    }
    const resolvedStartX = playerPosition.x;
    const resolvedStartZ = playerPosition.z;
    const movementX = targetX - startX;
    const movementZ = targetZ - startZ;
    const movementLength = Math.hypot(movementX, movementZ);
    if (movementLength <= POSITION_EPSILON && this.activeVelocityCount === 0) {
      this.stepResult.appliedX = playerPosition.x - resolvedStartX;
      this.stepResult.appliedZ = playerPosition.z - resolvedStartZ;
      this.lastPlayerX = playerPosition.x;
      this.lastPlayerZ = playerPosition.z;
      this.lastPlayerRadius = safePlayerRadius;
      return this.stepResult;
    }
    const smallestRadius = Math.max(0.08, Math.min(safePlayerRadius, this.minNpcRadius));
    const maxTravelPerStep = Math.max(0.035, smallestRadius * 0.35);
    const movementSteps = Math.ceil(movementLength / maxTravelPerStep);
    const timeSteps = Math.ceil(safeDelta / TARGET_STEP_SECONDS);
    const substeps = clampInteger(Math.max(1, movementSteps, timeSteps), 1, MAX_SUBSTEPS);
    const movementStepX = movementX / substeps;
    const movementStepZ = movementZ / substeps;
    const substepSeconds = substeps > 0 ? safeDelta / substeps : 0;

    for (let substep = 0; substep < substeps; substep += 1) {
      this.integrateNpcVelocities(substepSeconds);

      playerPosition.x += movementStepX;
      playerPosition.z += movementStepZ;
      if (this.projectDiscOutOfStatics(playerPosition, safePlayerRadius)) {
        this.stepResult.collided = true;
      }

      for (let iteration = 0; iteration < SOLVER_ITERATIONS; iteration += 1) {
        const contactsBefore = this.stepResult.playerContacts + this.stepResult.npcContacts;
        this.constrainMovedNpcsToWorld();
        this.rebuildGrid();
        this.solveNpcPairs();
        this.rebuildGrid();
        this.solvePlayerContacts(
          playerPosition,
          safePlayerRadius,
          velocityX,
          velocityZ,
        );
        if (this.projectDiscOutOfStatics(playerPosition, safePlayerRadius)) {
          this.stepResult.collided = true;
        }
        const contactsAfter = this.stepResult.playerContacts + this.stepResult.npcContacts;
        if (contactsAfter === contactsBefore && this.activeVelocityCount === 0) break;
      }

      // A final player-only projection makes wall-pinned NPCs solid even when
      // the inverse-mass solver could not distribute all penetration.
      this.rebuildGrid();
      for (let pass = 0; pass < SOLVER_ITERATIONS; pass += 1) {
        if (!this.projectPlayerOutOfCrowd(playerPosition, safePlayerRadius)) break;
        this.stepResult.collided = true;
        this.projectDiscOutOfStatics(playerPosition, safePlayerRadius);
        this.rebuildGrid();
      }
    }

    this.constrainMovedNpcsToWorld();
    this.rebuildGrid();
    for (let pass = 0; pass < SOLVER_ITERATIONS; pass += 1) {
      if (!this.projectPlayerOutOfCrowd(playerPosition, safePlayerRadius)) break;
      this.stepResult.collided = true;
      this.projectDiscOutOfStatics(playerPosition, safePlayerRadius);
      this.rebuildGrid();
    }

    this.stepResult.appliedX = playerPosition.x - resolvedStartX;
    this.stepResult.appliedZ = playerPosition.z - resolvedStartZ;
    this.stepResult.blocked = Math.hypot(targetX - playerPosition.x, targetZ - playerPosition.z) > 0.002;
    this.stepResult.movedNpcCount = countFlags(this.movedFlags);
    this.stepResult.pushedNpcCount = countFlags(this.pushedFlags);
    this.stepResult.physicsSteps = substeps;
    this.stepResult.collided ||= this.stepResult.playerContacts > 0;

    this.lastPlayerX = playerPosition.x;
    this.lastPlayerZ = playerPosition.z;
    this.lastPlayerRadius = safePlayerRadius;
    this.totalPhysicsSteps += substeps;
    this.totalPushEvents += this.stepResult.pushedNpcCount;
    this.totalPlayerContacts += this.stepResult.playerContacts;
    this.totalNpcContacts += this.stepResult.npcContacts;
    return this.stepResult;
  }

  /** True only when the player disc is clear of the world and every NPC. */
  canOccupyPlayer(position: Readonly<CrowdPushPoint2>, playerRadius: number): boolean {
    const radius = finitePositive(playerRadius, DEFAULT_NPC_RADIUS);
    const x = position.x;
    const z = position.z;
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    if (!this.isDiscInsideBounds(x, z, radius)) return false;
    if (this.discOverlapsAnyBlocker(x, z, radius)) return false;

    for (let index = 0; index < this.count; index += 1) {
      const offset = index * 3;
      const dx = this.positions[offset] - x;
      const dz = this.positions[offset + 2] - z;
      const minimumDistance = radius + this.radii[index] - CONTACT_SLOP;
      if (dx * dx + dz * dz < minimumDistance * minimumDistance) return false;
    }
    return true;
  }

  /** Read-only-by-convention view consumed by the instanced renderer. */
  getMovedFlags(): Uint8Array {
    return this.movedFlags;
  }

  /** Restores exact seeded positions and clears all crowd inertia/counters. */
  reset(): void {
    this.positions.set(this.initialPositions);
    this.velocitiesXZ.fill(0);
    this.movedFlags.fill(0);
    this.pushedFlags.fill(0);
    this.playerContactFlags.fill(0);
    this.gridHeads.fill(-1);
    this.gridNext.fill(-1);
    this.stepCalls = 0;
    this.totalPhysicsSteps = 0;
    this.totalPushEvents = 0;
    this.totalPlayerContacts = 0;
    this.totalNpcContacts = 0;
    this.activeVelocityCount = 0;
    this.lastPlayerX = Number.NaN;
    this.lastPlayerZ = Number.NaN;
    this.lastPlayerRadius = 0;
    this.clearStepState();
  }

  /** Returns a fresh audit snapshot using the same near-linear spatial grid. */
  getDiagnostics(): CrowdPushDiagnostics {
    let minimumSeparation = Number.POSITIVE_INFINITY;
    let blockerOverlaps = 0;
    let outOfBounds = 0;
    let playerOverlapCount = 0;

    for (let left = 0; left < this.count; left += 1) {
      const leftOffset = left * 3;
      const leftX = this.positions[leftOffset];
      const leftZ = this.positions[leftOffset + 2];
      if (!this.isDiscInsideBounds(leftX, leftZ, this.radii[left])) outOfBounds += 1;
      if (this.discOverlapsAnyBlocker(leftX, leftZ, this.radii[left])) blockerOverlaps += 1;

      if (Number.isFinite(this.lastPlayerX)) {
        const playerDx = leftX - this.lastPlayerX;
        const playerDz = leftZ - this.lastPlayerZ;
        const playerMinimum = this.radii[left] + this.lastPlayerRadius - CONTACT_SLOP;
        if (playerDx * playerDx + playerDz * playerDz < playerMinimum * playerMinimum) {
          playerOverlapCount += 1;
        }
      }

    }

    this.rebuildGrid();
    for (let left = 0; left < this.count; left += 1) {
      const leftOffset = left * 3;
      const leftX = this.positions[leftOffset];
      const leftZ = this.positions[leftOffset + 2];
      const cellX = this.getGridX(leftX);
      const cellZ = this.getGridZ(leftZ);
      for (let dzCell = -1; dzCell <= 1; dzCell += 1) {
        const neighborZ = cellZ + dzCell;
        if (neighborZ < 0 || neighborZ >= this.gridRows) continue;
        for (let dxCell = -1; dxCell <= 1; dxCell += 1) {
          const neighborX = cellX + dxCell;
          if (neighborX < 0 || neighborX >= this.gridColumns) continue;
          let right = this.gridHeads[neighborZ * this.gridColumns + neighborX];
          while (right >= 0) {
            if (right > left) {
              const rightOffset = right * 3;
              const dx = this.positions[rightOffset] - leftX;
              const dz = this.positions[rightOffset + 2] - leftZ;
              const separation = Math.hypot(dx, dz) - this.radii[left] - this.radii[right];
              minimumSeparation = Math.min(minimumSeparation, separation);
            }
            right = this.gridNext[right];
          }
        }
      }
    }

    return {
      engine: 'custom-2d-disc',
      bodyCount: this.count,
      solverIterations: SOLVER_ITERATIONS,
      gridCells: this.gridHeads.length,
      stepCalls: this.stepCalls,
      physicsSteps: this.totalPhysicsSteps,
      pushEvents: this.totalPushEvents,
      playerContacts: this.totalPlayerContacts,
      npcContacts: this.totalNpcContacts,
      lastPushedNpcCount: this.stepResult.pushedNpcCount,
      lastMovedNpcCount: this.stepResult.movedNpcCount,
      lastMaxPenetration: this.stepResult.maxPenetration,
      minNpcSeparation: Number.isFinite(minimumSeparation) ? minimumSeparation : 0,
      playerOverlapCount,
      blockerOverlaps,
      outOfBounds,
    };
  }

  private clearStepState(): void {
    this.movedFlags.fill(0);
    this.pushedFlags.fill(0);
    this.playerContactFlags.fill(0);
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
  }

  private integrateNpcVelocities(deltaSeconds: number): void {
    if (deltaSeconds <= 0) return;
    const damping = Math.exp(-NPC_DAMPING * deltaSeconds);
    let activeVelocityCount = 0;
    for (let index = 0; index < this.count; index += 1) {
      const velocityOffset = index * 2;
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
      if (velocityX === 0 && velocityZ === 0) continue;
      activeVelocityCount += 1;

      const positionOffset = index * 3;
      this.positions[positionOffset] += velocityX * deltaSeconds;
      this.positions[positionOffset + 2] += velocityZ * deltaSeconds;
      this.movedFlags[index] = 1;
    }
    this.activeVelocityCount = activeVelocityCount;
  }

  private constrainMovedNpcsToWorld(): void {
    for (let index = 0; index < this.count; index += 1) {
      if (this.movedFlags[index] === 0) continue;
      const offset = index * 3;
      const beforeX = this.positions[offset];
      const beforeZ = this.positions[offset + 2];
      const point = this.getScratchNpcPoint(index);
      if (!this.projectDiscOutOfStatics(point, this.radii[index])) continue;
      this.positions[offset] = point.x;
      this.positions[offset + 2] = point.z;
      this.movedFlags[index] = 1;
      const velocityOffset = index * 2;
      if (Math.abs(point.x - beforeX) > POSITION_EPSILON) this.velocitiesXZ[velocityOffset] = 0;
      if (Math.abs(point.z - beforeZ) > POSITION_EPSILON) this.velocitiesXZ[velocityOffset + 1] = 0;
    }
  }

  private rebuildGrid(): void {
    this.gridHeads.fill(-1);
    for (let index = 0; index < this.count; index += 1) {
      const offset = index * 3;
      const cell = this.getGridCell(this.positions[offset], this.positions[offset + 2]);
      this.gridNext[index] = this.gridHeads[cell];
      this.gridHeads[cell] = index;
    }
  }

  private solveNpcPairs(): void {
    for (let left = 0; left < this.count; left += 1) {
      if (this.movedFlags[left] === 0) continue;
      const leftOffset = left * 3;
      const leftX = this.positions[leftOffset];
      const leftZ = this.positions[leftOffset + 2];
      const cellX = this.getGridX(leftX);
      const cellZ = this.getGridZ(leftZ);

      for (let dzCell = -1; dzCell <= 1; dzCell += 1) {
        const neighborZ = cellZ + dzCell;
        if (neighborZ < 0 || neighborZ >= this.gridRows) continue;
        for (let dxCell = -1; dxCell <= 1; dxCell += 1) {
          const neighborX = cellX + dxCell;
          if (neighborX < 0 || neighborX >= this.gridColumns) continue;
          let right = this.gridHeads[neighborZ * this.gridColumns + neighborX];
          while (right >= 0) {
            if (
              right !== left &&
              (right > left || this.movedFlags[right] === 0)
            ) {
              this.solveNpcPair(left, right);
            }
            right = this.gridNext[right];
          }
        }
      }
    }
  }

  private solveNpcPair(left: number, right: number): void {
    const leftOffset = left * 3;
    const rightOffset = right * 3;
    let dx = this.positions[rightOffset] - this.positions[leftOffset];
    let dz = this.positions[rightOffset + 2] - this.positions[leftOffset + 2];
    const minimumDistance = this.radii[left] + this.radii[right];
    const distanceSquared = dx * dx + dz * dz;
    if (distanceSquared >= (minimumDistance - CONTACT_SLOP) ** 2) return;

    let distance = Math.sqrt(Math.max(0, distanceSquared));
    if (distance <= OVERLAP_EPSILON) {
      deterministicNormal(left, right, this.normalScratch);
      dx = this.normalScratch.x;
      dz = this.normalScratch.z;
      distance = 0;
    } else {
      dx /= distance;
      dz /= distance;
    }
    const penetration = Math.max(0, minimumDistance - distance + CONTACT_SLOP);
    const correction = penetration * 0.5;
    this.positions[leftOffset] -= dx * correction;
    this.positions[leftOffset + 2] -= dz * correction;
    this.positions[rightOffset] += dx * correction;
    this.positions[rightOffset + 2] += dz * correction;
    this.movedFlags[left] = 1;
    this.movedFlags[right] = 1;
    this.stepResult.npcContacts += 1;
    this.stepResult.maxPenetration = Math.max(this.stepResult.maxPenetration, penetration);

    const leftVelocityOffset = left * 2;
    const rightVelocityOffset = right * 2;
    const closingVelocity =
      (this.velocitiesXZ[leftVelocityOffset] - this.velocitiesXZ[rightVelocityOffset]) * dx +
      (this.velocitiesXZ[leftVelocityOffset + 1] - this.velocitiesXZ[rightVelocityOffset + 1]) * dz;
    if (closingVelocity > 0) {
      const impulse = closingVelocity * 0.5;
      this.velocitiesXZ[leftVelocityOffset] -= dx * impulse;
      this.velocitiesXZ[leftVelocityOffset + 1] -= dz * impulse;
      this.velocitiesXZ[rightVelocityOffset] += dx * impulse;
      this.velocitiesXZ[rightVelocityOffset + 1] += dz * impulse;
    }
  }

  private solvePlayerContacts(
    player: CrowdPushPoint2,
    playerRadius: number,
    playerVelocityX: number,
    playerVelocityZ: number,
  ): void {
    const range = Math.max(1, Math.ceil((playerRadius + this.maxNpcRadius) / this.gridCellSize));
    const centerX = this.getGridX(player.x);
    const centerZ = this.getGridZ(player.z);

    for (let dzCell = -range; dzCell <= range; dzCell += 1) {
      const cellZ = centerZ + dzCell;
      if (cellZ < 0 || cellZ >= this.gridRows) continue;
      for (let dxCell = -range; dxCell <= range; dxCell += 1) {
        const cellX = centerX + dxCell;
        if (cellX < 0 || cellX >= this.gridColumns) continue;
        let index = this.gridHeads[cellZ * this.gridColumns + cellX];
        while (index >= 0) {
          this.solvePlayerContact(
            player,
            playerRadius,
            playerVelocityX,
            playerVelocityZ,
            index,
          );
          index = this.gridNext[index];
        }
      }
    }
  }

  private solvePlayerContact(
    player: CrowdPushPoint2,
    playerRadius: number,
    playerVelocityX: number,
    playerVelocityZ: number,
    index: number,
  ): void {
    const positionOffset = index * 3;
    let dx = this.positions[positionOffset] - player.x;
    let dz = this.positions[positionOffset + 2] - player.z;
    const minimumDistance = playerRadius + this.radii[index];
    const distanceSquared = dx * dx + dz * dz;
    if (distanceSquared >= (minimumDistance - CONTACT_SLOP) ** 2) return;

    let distance = Math.sqrt(Math.max(0, distanceSquared));
    if (distance <= OVERLAP_EPSILON) {
      deterministicNormal(-1, index, this.normalScratch);
      dx = this.normalScratch.x;
      dz = this.normalScratch.z;
      distance = 0;
    } else {
      dx /= distance;
      dz /= distance;
    }
    const penetration = Math.max(0, minimumDistance - distance + CONTACT_SLOP);
    const inverseMassSum = PLAYER_INVERSE_MASS + NPC_INVERSE_MASS;
    const playerCorrection = penetration * (PLAYER_INVERSE_MASS / inverseMassSum);
    const npcCorrection = penetration * (NPC_INVERSE_MASS / inverseMassSum);
    player.x -= dx * playerCorrection;
    player.z -= dz * playerCorrection;
    this.positions[positionOffset] += dx * npcCorrection;
    this.positions[positionOffset + 2] += dz * npcCorrection;
    this.movedFlags[index] = 1;
    this.stepResult.collided = true;
    this.stepResult.maxPenetration = Math.max(this.stepResult.maxPenetration, penetration);
    if (this.playerContactFlags[index] === 0) {
      this.playerContactFlags[index] = 1;
      this.stepResult.playerContacts += 1;
    }

    const velocityOffset = index * 2;
    const closingVelocity =
      (playerVelocityX - this.velocitiesXZ[velocityOffset]) * dx +
      (playerVelocityZ - this.velocitiesXZ[velocityOffset + 1]) * dz;
    if (closingVelocity > 0) {
      this.velocitiesXZ[velocityOffset] += dx * closingVelocity * PLAYER_PUSH_TRANSFER;
      this.velocitiesXZ[velocityOffset + 1] += dz * closingVelocity * PLAYER_PUSH_TRANSFER;
      this.limitNpcVelocity(index);
      this.activeVelocityCount = Math.max(1, this.activeVelocityCount);
      if (this.pushedFlags[index] === 0) this.pushedFlags[index] = 1;
    }
  }

  private projectPlayerOutOfCrowd(player: CrowdPushPoint2, playerRadius: number): boolean {
    let projected = false;
    const range = Math.max(1, Math.ceil((playerRadius + this.maxNpcRadius) / this.gridCellSize));
    const centerX = this.getGridX(player.x);
    const centerZ = this.getGridZ(player.z);

    for (let dzCell = -range; dzCell <= range; dzCell += 1) {
      const cellZ = centerZ + dzCell;
      if (cellZ < 0 || cellZ >= this.gridRows) continue;
      for (let dxCell = -range; dxCell <= range; dxCell += 1) {
        const cellX = centerX + dxCell;
        if (cellX < 0 || cellX >= this.gridColumns) continue;
        let index = this.gridHeads[cellZ * this.gridColumns + cellX];
        while (index >= 0) {
          const offset = index * 3;
          let dx = this.positions[offset] - player.x;
          let dz = this.positions[offset + 2] - player.z;
          const minimumDistance = playerRadius + this.radii[index] + CONTACT_SLOP;
          const distanceSquared = dx * dx + dz * dz;
          if (distanceSquared < minimumDistance * minimumDistance) {
            let distance = Math.sqrt(Math.max(0, distanceSquared));
            if (distance <= OVERLAP_EPSILON) {
              deterministicNormal(-1, index, this.normalScratch);
              dx = this.normalScratch.x;
              dz = this.normalScratch.z;
              distance = 0;
            } else {
              dx /= distance;
              dz /= distance;
            }
            const correction = minimumDistance - distance;
            player.x -= dx * correction;
            player.z -= dz * correction;
            projected = true;
            if (this.playerContactFlags[index] === 0) {
              this.playerContactFlags[index] = 1;
              this.stepResult.playerContacts += 1;
            }
          }
          index = this.gridNext[index];
        }
      }
    }
    return projected;
  }

  private limitNpcVelocity(index: number): void {
    const offset = index * 2;
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
      let changedThisPass = false;
      const clampedX = clamp(point.x, this.bounds.minX + radius, this.bounds.maxX - radius);
      const clampedZ = clamp(point.z, this.bounds.minZ + radius, this.bounds.maxZ - radius);
      if (Math.abs(clampedX - point.x) > POSITION_EPSILON) {
        point.x = clampedX;
        changedThisPass = true;
      }
      if (Math.abs(clampedZ - point.z) > POSITION_EPSILON) {
        point.z = clampedZ;
        changedThisPass = true;
      }

      for (let blockerIndex = 0; blockerIndex < this.blockers.length; blockerIndex += 1) {
        if (projectDiscOutOfAabb(point, radius, this.blockers[blockerIndex])) {
          changedThisPass = true;
        }
      }
      projected ||= changedThisPass;
      if (!changedThisPass) break;
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
    for (let blockerIndex = 0; blockerIndex < this.blockers.length; blockerIndex += 1) {
      const blocker = this.blockers[blockerIndex];
      const closestX = clamp(x, blocker.minX, blocker.maxX);
      const closestZ = clamp(z, blocker.minZ, blocker.maxZ);
      const dx = x - closestX;
      const dz = z - closestZ;
      if (dx * dx + dz * dz < (radius - CONTACT_SLOP) ** 2) return true;
    }
    return false;
  }

  private getGridCell(x: number, z: number): number {
    return this.getGridZ(z) * this.gridColumns + this.getGridX(x);
  }

  private getGridX(x: number): number {
    return clampInteger(
      Math.floor((x - this.bounds.minX) / this.gridCellSize),
      0,
      this.gridColumns - 1,
    );
  }

  private getGridZ(z: number): number {
    return clampInteger(
      Math.floor((z - this.bounds.minZ) / this.gridCellSize),
      0,
      this.gridRows - 1,
    );
  }

  private readonly scratchNpcPoint: CrowdPushPoint2 = { x: 0, z: 0 };
  private readonly normalScratch: CrowdPushPoint2 = { x: 1, z: 0 };

  private getScratchNpcPoint(index: number): CrowdPushPoint2 {
    const offset = index * 3;
    this.scratchNpcPoint.x = this.positions[offset];
    this.scratchNpcPoint.z = this.positions[offset + 2];
    return this.scratchNpcPoint;
  }
}

function projectDiscOutOfAabb(
  point: CrowdPushPoint2,
  radius: number,
  blocker: CrowdPushAabb2,
): boolean {
  const closestX = clamp(point.x, blocker.minX, blocker.maxX);
  const closestZ = clamp(point.z, blocker.minZ, blocker.maxZ);
  let dx = point.x - closestX;
  let dz = point.z - closestZ;
  const distanceSquared = dx * dx + dz * dz;
  if (distanceSquared >= radius * radius) return false;

  if (distanceSquared > OVERLAP_EPSILON * OVERLAP_EPSILON) {
    const distance = Math.sqrt(distanceSquared);
    const correction = radius - distance + CONTACT_SLOP;
    dx /= distance;
    dz /= distance;
    point.x += dx * correction;
    point.z += dz * correction;
    return true;
  }

  // The centre is inside/on the box. Pick the closest expanded face with a
  // deterministic tie order so seed replays remain identical.
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

function countFlags(flags: Uint8Array): number {
  let total = 0;
  for (let index = 0; index < flags.length; index += 1) total += flags[index];
  return total;
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
