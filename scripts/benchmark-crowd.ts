import * as THREE from 'three';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  CrowdSystem,
  estimateCrowdLodMix,
  generateWallyAdjacentOutfits,
} from '../src/assets/CrowdSystem';
import { createCityWorld, type Aabb2 } from '../src/assets/CityWorld';
import { CollisionSystem } from '../src/systems/CollisionSystem';
import { CrowdPushSystem } from '../src/systems/CrowdPushSystem';
import { LocalizedCrowdPushSystem } from '../src/systems/LocalizedCrowdPushSystem';
import { findCrowdHit, findCrowdHitDistance } from '../src/systems/CrowdPicker';
import { CrowdSpatialIndex } from '../src/systems/CrowdSpatialIndex';

const SEED = 7_331;
const INTERACTION_RANGE = 10.5;
const SELECTION_RADIUS = 0.3;
const SELECTION_HEIGHTS = [1.08, 1.48] as const;
const EPSILON = 0.08;
const SPAWN_CLEAR_RADIUS = 0.85;
const WALLY_CLEAR_RADIUS = 0.42;
const CROWD_RUNTIME_REPORT = JSON.parse(
  readFileSync(path.resolve('artifacts/crowd/CharacterCrowdRuntime_export.json'), 'utf8'),
) as {
  runtime_triangles_per_character: { High: number; Medium: number; Low: number };
};

type ReservedZone = { position: THREE.Vector3; radius: number };

function distance2d(position: THREE.Vector3, x: number, z: number): number {
  return Math.hypot(x - position.x, z - position.z);
}

function isInsidePaddedBlocker(x: number, z: number, blockers: readonly Aabb2[]): boolean {
  const padding = 0.24;
  return blockers.some(
    (blocker) =>
      x >= blocker.minX - padding &&
      x <= blocker.maxX + padding &&
      z >= blocker.minZ - padding &&
      z <= blocker.maxZ + padding,
  );
}

function getFacing(spotIndex: number): number {
  let value = (SEED ^ Math.imul(spotIndex + 1, 0x45d9f3b)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b) >>> 0;
  return (value / 4_294_967_296) * Math.PI * 2;
}

function verifyTestVantage(
  positions: Float32Array,
  count: number,
  world: ReturnType<typeof createCityWorld>,
): Record<string, unknown> {
  const spotIndex = SEED % world.wallySpots.length;
  const spot = world.wallySpots[spotIndex];
  const collision = new CollisionSystem();
  const raycaster = new THREE.Raycaster();
  raycaster.far = INTERACTION_RANGE;

  const wallyRoot = new THREE.Group();
  wallyRoot.position.copy(spot);
  wallyRoot.rotation.y = getFacing(spotIndex);
  const proxy = new THREE.Mesh(
    new THREE.BoxGeometry(0.68, 1.82, 0.58),
    new THREE.MeshBasicMaterial(),
  );
  proxy.position.y = 0.91;
  wallyRoot.add(proxy);
  const scene = new THREE.Scene();
  scene.add(wallyRoot);
  for (const occluder of world.interactionOccluders) scene.add(occluder.parent ?? occluder);
  scene.updateMatrixWorld(true);

  const chest = new THREE.Vector3(0, 1.28, 0).applyMatrix4(wallyRoot.matrixWorld);
  const candidate = new THREE.Vector3();
  let result: Record<string, unknown> | null = null;
  const distances = [0.5, 0.62, 0.78, 0.96, 1.18] as const;

  outer: for (const distance of distances) {
    for (let sample = 0; sample < 16; sample += 1) {
      const angle = (sample / 16) * Math.PI * 2;
      candidate.set(
        spot.x + Math.sin(angle) * distance,
        world.spawn.y,
        spot.z + Math.cos(angle) * distance,
      );
      if (!collision.canOccupy(candidate, 0.31, world.bounds, world.blockers)) continue;

      const origin = candidate.clone().add(new THREE.Vector3(0, 1.67, 0));
      const direction = chest.clone().sub(origin).normalize();
      raycaster.ray.set(origin, direction);
      const wallyDistance = raycaster.intersectObject(proxy, false)[0]?.distance ?? null;
      const crowdDistance = findCrowdHitDistance(
        positions,
        count,
        raycaster.ray,
        INTERACTION_RANGE,
        SELECTION_RADIUS,
        SELECTION_HEIGHTS,
      );
      const worldDistance = raycaster.intersectObjects(world.interactionOccluders, false)[0]?.distance ?? null;
      const crowdClear =
        wallyDistance !== null &&
        (crowdDistance === null || wallyDistance + EPSILON < crowdDistance);
      const worldClear =
        wallyDistance !== null &&
        (worldDistance === null || wallyDistance + EPSILON < worldDistance);
      if (!crowdClear || !worldClear) continue;

      result = {
        pass: true,
        spotIndex,
        distance,
        radialSample: sample,
        wallyDistance,
        crowdDistance,
        worldDistance,
      };
      break outer;
    }
  }

  proxy.geometry.dispose();
  (proxy.material as THREE.Material).dispose();
  return result ?? { pass: false, spotIndex };
}

function benchmarkPicker(positions: Float32Array, count: number): Record<string, number> {
  const ray = new THREE.Ray();
  const origin = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const samples: number[] = [];
  let randomState = 0x3a71c55d;
  const random = () => {
    randomState |= 0;
    randomState = (randomState + 0x6d2b79f5) | 0;
    let value = Math.imul(randomState ^ (randomState >>> 15), 1 | randomState);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };

  for (let iteration = 0; iteration < 1_100; iteration += 1) {
    origin.set(-12 + random() * 24, 1.71, -8.8 + random() * 17.6);
    direction.set(random() - 0.5, (random() - 0.5) * 0.18, random() - 0.5).normalize();
    ray.set(origin, direction);
    const started = performance.now();
    findCrowdHitDistance(
      positions,
      count,
      ray,
      INTERACTION_RANGE,
      SELECTION_RADIUS,
      SELECTION_HEIGHTS,
    );
    const duration = performance.now() - started;
    if (iteration >= 100) samples.push(duration);
  }

  samples.sort((a, b) => a - b);
  return {
    samples: samples.length,
    meanMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    p95Ms: samples[Math.floor(samples.length * 0.95)],
    maxMs: samples[samples.length - 1],
  };
}

function verifyCrowdAimPicker(): Record<string, unknown> {
  const positions = new Float32Array([
    0, 0.025, -4,
    0.06, 0.025, -2,
    1.2, 0.025, -2,
  ]);
  const ray = new THREE.Ray(
    new THREE.Vector3(0, 1.48, 0),
    new THREE.Vector3(0, 0, -1),
  );
  const hit = findCrowdHit(
    positions,
    3,
    ray,
    INTERACTION_RANGE,
    SELECTION_RADIUS,
    SELECTION_HEIGHTS,
  );
  const miss = findCrowdHit(
    positions,
    3,
    new THREE.Ray(new THREE.Vector3(0, 1.48, 0), new THREE.Vector3(1, 0, 0)),
    INTERACTION_RANGE,
    SELECTION_RADIUS,
    SELECTION_HEIGHTS,
  );
  return {
    pass: hit?.characterIndex === 1 && hit.distance > 0 && miss === null,
    selectedCharacterIndex: hit?.characterIndex ?? null,
    selectedDistance: hit?.distance ?? null,
    miss: miss === null,
  };
}

function verifyCollisionResolution(
  world: ReturnType<typeof createCityWorld>,
): Record<string, unknown> {
  const collision = new CollisionSystem();
  const testBounds: Aabb2 = { minX: 0, maxX: 6, minZ: -3, maxZ: 3 };
  const radius = 0.31;

  const boundaryPosition = new THREE.Vector3(1, 0, 0);
  collision.moveCircle(
    boundaryPosition,
    new THREE.Vector3(-2, 0, 0),
    radius,
    testBounds,
    [],
  );

  const blocker = { minX: 2, maxX: 3, minZ: -1, maxZ: 1 };
  const blockerPosition = new THREE.Vector3(1.6, 0, 0);
  collision.moveCircle(
    blockerPosition,
    new THREE.Vector3(0.2, 0, 0),
    radius,
    testBounds,
    [blocker],
  );

  const sweepPosition = new THREE.Vector3(0.5, 0, 0);
  collision.moveCircle(
    sweepPosition,
    new THREE.Vector3(5, 0, 0),
    radius,
    testBounds,
    [blocker],
  );

  const lampMesh = world.interactionOccluders.find(
    (object): object is THREE.InstancedMesh =>
      object.name === 'festival-lamp-posts' && object instanceof THREE.InstancedMesh,
  );
  const matrix = new THREE.Matrix4();
  const lampPosition = new THREE.Vector3();
  let blockedLamps = 0;
  if (lampMesh) {
    for (let index = 0; index < lampMesh.count; index += 1) {
      lampMesh.getMatrixAt(index, matrix);
      lampPosition.setFromMatrixPosition(matrix);
      if (!collision.canOccupy(lampPosition, radius, world.bounds, world.blockers)) {
        blockedLamps += 1;
      }
    }
  }

  const boundaryResolved = Math.abs(boundaryPosition.x - radius) < 0.001;
  const blockerResolved = Math.abs(blockerPosition.x - (blocker.minX - radius)) < 0.001;
  const noTunnelling = Math.abs(sweepPosition.x - (blocker.minX - radius)) < 0.001;
  const allLampsBlocked = lampMesh !== undefined && blockedLamps === lampMesh.count;
  return {
    pass: boundaryResolved && blockerResolved && noTunnelling && allLampsBlocked,
    boundaryX: boundaryPosition.x,
    blockerContactX: blockerPosition.x,
    largeSweepX: sweepPosition.x,
    lampCount: lampMesh?.count ?? 0,
    blockedLamps,
  };
}

function verifyUniqueOutfits(): Record<string, unknown> {
  const count = 10_000;
  const outfits = generateWallyAdjacentOutfits(count, SEED);
  const replay = generateWallyAdjacentOutfits(count, SEED);
  const otherSeed = generateWallyAdjacentOutfits(count, SEED + 1);
  const signatures = outfits.map((outfit) => outfit.signature);
  const replaySignatures = replay.map((outfit) => outfit.signature);
  const otherSeedSignatures = otherSeed.map((outfit) => outfit.signature);
  const uniqueSignatures = new Set(signatures).size;
  const perceptualSignatures = new Set(
    outfits.map((outfit) => [
      outfit.stripeColor,
      outfit.stripeLight,
      outfit.pantsColor,
      outfit.stripeHeight.toFixed(3),
    ].join('|')),
  ).size;
  const deterministic = signatures.every(
    (signature, index) => signature === replaySignatures[index],
  );
  const changedForOtherSeed = signatures.reduce(
    (changed, signature, index) => changed + Number(signature !== otherSeedSignatures[index]),
    0,
  );
  const exactWallyOutfits = outfits.filter(
    (outfit) =>
      outfit.stripeColor.toLowerCase() === '#e83030' &&
      outfit.stripeLight.toLowerCase() === '#f8f8f8' &&
      outfit.pantsColor.toLowerCase() === '#00a0e0',
  ).length;

  return {
    pass:
      outfits.length === count &&
      uniqueSignatures === count &&
      perceptualSignatures === count &&
      deterministic &&
      changedForOtherSeed >= Math.floor(count * 0.99) &&
      exactWallyOutfits === 0,
    count,
    uniqueSignatures,
    perceptualSignatures,
    deterministic,
    changedForOtherSeed,
    exactWallyOutfits,
  };
}

function makePushPositions(points: ReadonlyArray<readonly [number, number]>): Float32Array {
  const positions = new Float32Array(points.length * 3);
  points.forEach(([x, z], index) => {
    positions[index * 3] = x;
    positions[index * 3 + 2] = z;
  });
  return positions;
}

function isFiniteDiagnostics(diagnostics: Record<string, unknown>): boolean {
  return Object.values(diagnostics).every(
    (value) => typeof value !== 'number' || Number.isFinite(value),
  );
}

function verifyCrowdPushSystem(): Record<string, unknown> {
  const openBounds = { minX: -5, maxX: 5, minZ: -3, maxZ: 3 };
  const playerRadius = 0.3;
  const npcRadius = 0.29;

  const frontalPositions = makePushPositions([[0, 0]]);
  const frontalInitial = frontalPositions.slice();
  const frontal = new CrowdPushSystem({
    positions: frontalPositions,
    bounds: openBounds,
    blockers: [],
    defaultRadius: npcRadius,
  });
  const frontalPlayer = { x: -0.08, z: 0 };
  const frontalResult = { ...frontal.step(
    1 / 30,
    frontalPlayer,
    { x: -1.1, z: 0 },
    { x: 4.2, z: 0 },
    playerRadius,
  ) };
  const frontalSeparation = Math.hypot(
    frontalPositions[0] - frontalPlayer.x,
    frontalPositions[2] - frontalPlayer.z,
  );
  const frontalPush = {
    pass:
      frontalResult.collided &&
      frontalResult.pushedNpcCount === 1 &&
      frontalPositions[0] > frontalInitial[0] + 0.01,
    npcDeltaX: frontalPositions[0] - frontalInitial[0],
    playerContacts: frontalResult.playerContacts,
    pushedNpcCount: frontalResult.pushedNpcCount,
  };
  const noTraversal = {
    pass:
      frontalPlayer.x < frontalPositions[0] &&
      frontalSeparation >= playerRadius + npcRadius - 0.0015 &&
      frontal.canOccupyPlayer(frontalPlayer, playerRadius),
    playerX: frontalPlayer.x,
    npcX: frontalPositions[0],
    separation: frontalSeparation,
    requiredSeparation: playerRadius + npcRadius,
  };

  const chainInitial = makePushPositions([[0, 0], [0.58, 0], [1.16, 0]]);
  const chainPositions = chainInitial.slice();
  const chain = new CrowdPushSystem({
    positions: chainPositions,
    bounds: openBounds,
    blockers: [],
    defaultRadius: npcRadius,
  });
  const chainPlayer = { x: 0.12, z: 0 };
  const chainResult = { ...chain.step(
    1 / 30,
    chainPlayer,
    { x: -0.95, z: 0 },
    { x: 4.8, z: 0 },
    playerRadius,
  ) };
  const chainDiagnostics = chain.getDiagnostics();
  const chainPush = {
    pass:
      chainResult.collided &&
      chainResult.npcContacts > 0 &&
      chainResult.movedNpcCount === 3 &&
      chainPositions[6] > chainInitial[6] + 0.002 &&
      chainDiagnostics.playerOverlapCount === 0,
    npcContacts: chainResult.npcContacts,
    movedNpcCount: chainResult.movedNpcCount,
    lastNpcDeltaX: chainPositions[6] - chainInitial[6],
    minNpcSeparation: chainDiagnostics.minNpcSeparation,
  };

  frontal.reset();
  const resetDiagnostics = frontal.getDiagnostics();
  const reset = {
    pass:
      frontalPositions.every((value, index) => value === frontalInitial[index]) &&
      frontal.velocitiesXZ.every((value) => value === 0) &&
      resetDiagnostics.stepCalls === 0 &&
      resetDiagnostics.physicsSteps === 0 &&
      resetDiagnostics.pushEvents === 0,
    positionsRestored: frontalPositions.every(
      (value, index) => value === frontalInitial[index],
    ),
    velocitiesCleared: frontal.velocitiesXZ.every((value) => value === 0),
    diagnostics: resetDiagnostics,
  };

  const constrainedBounds = { minX: -2, maxX: 2, minZ: -2, maxZ: 2 };
  const boundaryPositions = makePushPositions([[1.66, -1.1]]);
  const boundary = new CrowdPushSystem({
    positions: boundaryPositions,
    bounds: constrainedBounds,
    blockers: [],
    defaultRadius: npcRadius,
  });
  const boundaryPlayer = { x: 1.86, z: -1.1 };
  boundary.step(
    1 / 30,
    boundaryPlayer,
    { x: 0.9, z: -1.1 },
    { x: 4.2, z: 0 },
    playerRadius,
  );
  const boundaryDiagnostics = boundary.getDiagnostics();

  const blocker = { minX: 0.45, maxX: 0.9, minZ: -0.55, maxZ: 0.55 };
  const blockerPositions = makePushPositions([[0, 0]]);
  const blockerSystem = new CrowdPushSystem({
    positions: blockerPositions,
    bounds: constrainedBounds,
    blockers: [blocker],
    defaultRadius: npcRadius,
  });
  const blockerPlayer = { x: 0.25, z: 0 };
  blockerSystem.step(
    1 / 30,
    blockerPlayer,
    { x: -0.9, z: 0 },
    { x: 4.2, z: 0 },
    playerRadius,
  );
  const blockerDiagnostics = blockerSystem.getDiagnostics();
  const worldConstraints = {
    pass:
      boundaryPositions[0] <= constrainedBounds.maxX - npcRadius + 0.001 &&
      boundaryDiagnostics.outOfBounds === 0 &&
      boundaryDiagnostics.playerOverlapCount === 0 &&
      blockerDiagnostics.blockerOverlaps === 0 &&
      blockerDiagnostics.outOfBounds === 0 &&
      blockerDiagnostics.playerOverlapCount === 0,
    boundaryNpcX: boundaryPositions[0],
    boundaryLimitX: constrainedBounds.maxX - npcRadius,
    boundaryDiagnostics,
    blockerNpc: { x: blockerPositions[0], z: blockerPositions[2] },
    blockerDiagnostics,
  };

  const verifyRemoval = (mode: 'dense' | 'localized') => {
    const positions = makePushPositions([[0, 0]]);
    const removedFlags = new Uint8Array(1);
    const spatialIndex = new CrowdSpatialIndex({
      positions,
      bounds: openBounds,
      cellSize: 1,
      maximumDisplacement: 0.75,
    });
    const system = mode === 'localized'
      ? new LocalizedCrowdPushSystem({
          positions,
          removedFlags,
          bounds: openBounds,
          blockers: [],
          defaultRadius: npcRadius,
          spatialIndex,
        })
      : new CrowdPushSystem({
          positions,
          removedFlags,
          bounds: openBounds,
          blockers: [],
          defaultRadius: npcRadius,
        });
    const blockedBeforeRemoval = !system.canOccupyPlayer({ x: 0, z: 0 }, playerRadius);
    removedFlags[0] = 1;
    const clearAfterRemoval = system.canOccupyPlayer({ x: 0, z: 0 }, playerRadius);
    const crossingPlayer = { x: 1, z: 0 };
    const crossingResult = { ...system.step(
      1 / 60,
      crossingPlayer,
      { x: -1, z: 0 },
      { x: 2, z: 0 },
      playerRadius,
    ) };
    removedFlags[0] = 0;
    const blockedAfterRestore = !system.canOccupyPlayer({ x: 0, z: 0 }, playerRadius);
    return {
      pass:
        blockedBeforeRemoval &&
        clearAfterRemoval &&
        crossingResult.playerContacts === 0 &&
        crossingPlayer.x >= 0.99 &&
        blockedAfterRestore,
      blockedBeforeRemoval,
      clearAfterRemoval,
      contactsAfterRemoval: crossingResult.playerContacts,
      crossingPlayerX: crossingPlayer.x,
      blockedAfterRestore,
    };
  };
  const removal = {
    dense: verifyRemoval('dense'),
    localized: verifyRemoval('localized'),
  };

  const diagnostics = [
    chainDiagnostics,
    resetDiagnostics,
    boundaryDiagnostics,
    blockerDiagnostics,
  ];
  const finiteDiagnostics = {
    pass: diagnostics.every((entry) => isFiniteDiagnostics(entry)),
    snapshots: diagnostics.length,
  };

  return {
    pass:
      frontalPush.pass &&
      noTraversal.pass &&
      chainPush.pass &&
      reset.pass &&
      worldConstraints.pass &&
      removal.dense.pass &&
      removal.localized.pass &&
      finiteDiagnostics.pass,
    frontalPush,
    noTraversal,
    chainPush,
    reset,
    worldConstraints,
    removal,
    finiteDiagnostics,
  };
}

function runCrowdCase(count: number): Record<string, unknown> {
  const scene = new THREE.Scene();
  const world = createCityWorld(scene);
  const reservedZones: ReservedZone[] = [
    { position: world.spawn, radius: SPAWN_CLEAR_RADIUS },
    ...world.wallySpots.map((position) => ({ position, radius: WALLY_CLEAR_RADIUS })),
  ];
  const started = performance.now();
  const crowd = new CrowdSystem(scene, {
    count,
    bounds: world.bounds,
    blockers: world.blockers,
    seed: SEED,
    reservedZones,
  });
  const buildMs = performance.now() - started;
  const diagnostics = crowd.getDiagnostics();
  const accessoryTriangles = 0;
  const triangleCeiling =
    count * CROWD_RUNTIME_REPORT.runtime_triangles_per_character.High;
  const viewerSamples = [world.spawn.clone()];
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      viewerSamples.push(
        new THREE.Vector3(
          world.bounds.minX + ((column + 0.5) / 4) * (world.bounds.maxX - world.bounds.minX),
          world.spawn.y,
          world.bounds.minZ + ((row + 0.5) / 3) * (world.bounds.maxZ - world.bounds.minZ),
        ),
      );
    }
  }
  const lodSamples = viewerSamples.map((viewer) => {
    const mix = estimateCrowdLodMix(crowd.positions, count, world.bounds, viewer);
    const characterTriangles =
      mix.high * CROWD_RUNTIME_REPORT.runtime_triangles_per_character.High +
      mix.medium * CROWD_RUNTIME_REPORT.runtime_triangles_per_character.Medium +
      mix.low * CROWD_RUNTIME_REPORT.runtime_triangles_per_character.Low;
    return {
      viewer: { x: viewer.x, z: viewer.z },
      ...mix,
      characterTriangles,
      totalTriangles: characterTriangles + accessoryTriangles,
    };
  });
  const lodMix = lodSamples[0];
  const worstLodSample = lodSamples.reduce((worst, sample) =>
    sample.totalTriangles > worst.totalTriangles ? sample : worst,
  );
  const lodBudget = {
    pass:
      lodMix.high + lodMix.medium + lodMix.low === count &&
      lodMix.high === count &&
      lodMix.medium === 0 &&
      lodMix.low === 0 &&
      worstLodSample.totalTriangles <= triangleCeiling,
    ...lodMix,
    accessoryTriangles,
    triangleCeiling,
    sampleCount: lodSamples.length,
    worstLodSample,
  };
  const uniquePositions = new Set<string>();
  let outsideBounds = 0;
  let blockerViolations = 0;
  let reservedViolations = 0;
  let nearestSpawn = Number.POSITIVE_INFINITY;
  const nearestWally = world.wallySpots.map(() => Number.POSITIVE_INFINITY);

  for (let index = 0; index < count; index += 1) {
    const x = crowd.positions[index * 3];
    const z = crowd.positions[index * 3 + 2];
    uniquePositions.add(`${x},${z}`);
    if (
      x < world.bounds.minX + 0.3 ||
      x > world.bounds.maxX - 0.3 ||
      z < world.bounds.minZ + 0.3 ||
      z > world.bounds.maxZ - 0.3
    ) {
      outsideBounds += 1;
    }
    if (isInsidePaddedBlocker(x, z, world.blockers)) blockerViolations += 1;
    nearestSpawn = Math.min(nearestSpawn, distance2d(world.spawn, x, z));
    world.wallySpots.forEach((spot, spotIndex) => {
      nearestWally[spotIndex] = Math.min(nearestWally[spotIndex], distance2d(spot, x, z));
    });
    if (reservedZones.some((zone) => distance2d(zone.position, x, z) < zone.radius)) {
      reservedViolations += 1;
    }
  }

  const testVantage = verifyTestVantage(crowd.positions, count, world);
  const collisionVerification = verifyCollisionResolution(world);
  const initialCrowdPhysics = count === 1_000 || count === 10_000
    ? new CrowdPushSystem({
        positions: crowd.positions,
        radii: crowd.radii,
        bounds: world.bounds,
        blockers: world.blockers,
      }).getDiagnostics()
    : null;
  const initialCrowdPhysicsPass = initialCrowdPhysics === null || (
    initialCrowdPhysics.minNpcSeparation >= -0.001 &&
    initialCrowdPhysics.blockerOverlaps === 0 &&
    initialCrowdPhysics.outOfBounds === 0
  );
  const picker = count === 10_000 ? benchmarkPicker(crowd.positions, count) : null;
  const pass =
    uniquePositions.size === count &&
    outsideBounds === 0 &&
    blockerViolations === 0 &&
    reservedViolations === 0 &&
    diagnostics.duplicatedFallbacks === 0 &&
    diagnostics.wallyLikeCharacters === 0 &&
    lodBudget.pass === true &&
    testVantage.pass === true &&
    collisionVerification.pass === true &&
    initialCrowdPhysicsPass;

  const result = {
    pass,
    count,
    buildMs,
    uniquePositions: uniquePositions.size,
    outsideBounds,
    blockerViolations,
    reservedViolations,
    nearestSpawn,
    nearestWally,
    diagnostics,
    lodBudget,
    testVantage,
    collisionVerification,
    initialCrowdPhysicsPass,
    initialCrowdPhysics,
    picker,
  };
  crowd.dispose();
  world.dispose();
  return result;
}

const hundred = runCrowdCase(100);
const oneThousand = runCrowdCase(1_000);
const tenThousand = runCrowdCase(10_000);
const uniqueOutfits = verifyUniqueOutfits();
const crowdPush = verifyCrowdPushSystem();
const crowdAimPicker = verifyCrowdAimPicker();
const output = {
  generatedAt: new Date().toISOString(),
  scope: 'CPU construction, placement invariants, 10,000 perceptibly unique outfits, analytical picking, deterministic test vantage, and spatial-grid crowd push physics; no GPU/browser FPS measurement.',
  activeCrowdCount: 10_000,
  pass:
    hundred.pass === true &&
    oneThousand.pass === true &&
    tenThousand.pass === true &&
    uniqueOutfits.pass === true &&
    crowdPush.pass === true &&
    crowdAimPicker.pass === true,
  hundred,
  oneThousand,
  tenThousand,
  uniqueOutfits,
  crowdPush,
  crowdAimPicker,
};

writeFileSync(
  path.resolve('artifacts/verification/crowd-benchmark.json'),
  JSON.stringify(output, null, 2) + '\n',
);
console.log(JSON.stringify(output, null, 2));
if (!output.pass) process.exitCode = 1;
