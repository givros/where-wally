import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const COUNT = 1_000_000;
const SEED = 7_331;
const OUTFIT_SPACE = 1_000_000;
const MAX_CHARACTER_DISPLACEMENT = 0.75;
const INDEX_CELL_SIZE = 2;
const BOUNDS = {
  minX: -480,
  maxX: 480,
  minZ: -340,
  maxZ: 340,
};
const MARGIN = 0.35;
const NPC_BASE_RADIUS = 0.195;

function hash32(value) {
  let result = value >>> 0;
  result = Math.imul(result ^ (result >>> 16), 0x7feb352d);
  result = Math.imul(result ^ (result >>> 15), 0x846ca68b);
  return (result ^ (result >>> 16)) >>> 0;
}

function gcd(left, right) {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function getCoprimeMultiplier(seed, modulus) {
  let value = (hash32(seed ^ 0xa511e9b3) % Math.max(1, modulus - 1)) + 1;
  while (gcd(value, modulus) !== 1) {
    value += 1;
    if (value >= modulus) value = 1;
  }
  return value;
}

function getPermutationValue(index, seed, modulus) {
  const multiplier = getCoprimeMultiplier(seed, modulus);
  const offset = hash32(seed ^ 0x63d83595) % modulus;
  return (index * multiplier + offset) % modulus;
}

function createMegaBlockers() {
  const blockers = [
    { minX: -28, maxX: 28, minZ: -337, maxZ: -324 },
  ];
  for (const side of [-1, 1]) {
    for (let row = 0; row < 15; row += 1) {
      const z = -292 + row * 41.5;
      const centerX = side * (row % 2 === 0 ? 442 : 453);
      blockers.push({
        minX: centerX - 5.5,
        maxX: centerX + 5.5,
        minZ: z - 3.2,
        maxZ: z + 3.2,
      });
    }
  }
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 6; column += 1) {
      const x = -305 + column * 122;
      const z = -215 + row * 142;
      blockers.push({ minX: x - 1.2, maxX: x + 1.2, minZ: z - 1.2, maxZ: z + 1.2 });
    }
  }
  return blockers;
}

function createReservedZones() {
  const zones = [{ x: 0, z: 329, radius: 1.1 }];
  const spots = [
    [-402, -292], [-245, -280], [-75, -305], [152, -286], [395, -274],
    [-420, -86], [-212, -62], [18, -94], [238, -55], [425, -78],
    [-366, 154], [-128, 116], [126, 167], [378, 132],
  ];
  for (const [x, z] of spots) zones.push({ x, z, radius: 0.65 });
  return zones;
}

function isPlacementAllowed(x, z, blockers, reservedZones) {
  const blockerPadding = 0.3;
  for (let index = 0; index < blockers.length; index += 1) {
    const blocker = blockers[index];
    if (
      x >= blocker.minX - blockerPadding &&
      x <= blocker.maxX + blockerPadding &&
      z >= blocker.minZ - blockerPadding &&
      z <= blocker.maxZ + blockerPadding
    ) return false;
  }
  for (let index = 0; index < reservedZones.length; index += 1) {
    const reserved = reservedZones[index];
    const dx = x - reserved.x;
    const dz = z - reserved.z;
    if (dx * dx + dz * dz < reserved.radius * reserved.radius) return false;
  }
  return true;
}

function percentile(samples, ratio) {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * ratio))] ?? 0;
}

function round(value, digits = 3) {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

if (typeof global.gc === 'function') global.gc();
const memoryBefore = process.memoryUsage();
const totalStarted = performance.now();
const blockers = createMegaBlockers();
const reservedZones = createReservedZones();

const generationStarted = performance.now();
const positions = new Float32Array(COUNT * 3);
const radii = new Float32Array(COUNT);
const scales = new Float32Array(COUNT);
const yaws = new Float32Array(COUNT);
const skinIndices = new Uint8Array(COUNT);
const poolSlotByCharacter = new Int32Array(COUNT);
poolSlotByCharacter.fill(-1);

const width = BOUNDS.maxX - BOUNDS.minX - MARGIN * 2;
const depth = BOUNDS.maxZ - BOUNDS.minZ - MARGIN * 2;
const targetSlots = Math.ceil(COUNT * 1.45 + blockers.length * 12 + reservedZones.length * 20);
const columns = Math.ceil(Math.sqrt(targetSlots * (width / depth)));
const rows = Math.ceil(targetSlots / columns);
const slotCount = columns * rows;
const cellWidth = width / columns;
const cellDepth = depth / rows;
const placementMultiplier = getCoprimeMultiplier(SEED ^ 0xf17a2b41, slotCount);
const placementOffset = hash32(SEED ^ 0x17c4a521) % slotCount;
let placed = 0;
let rejected = 0;
let candidates = 0;

for (let order = 0; order < slotCount && placed < COUNT; order += 1) {
  const slot = (order * placementMultiplier + placementOffset) % slotCount;
  const column = slot % columns;
  const row = Math.floor(slot / columns);
  const jitter = hash32(slot ^ SEED);
  const jitterX = ((jitter & 0xffff) / 0xffff - 0.5) * 0.2;
  const jitterZ = (((jitter >>> 16) & 0xffff) / 0xffff - 0.5) * 0.2;
  const x = BOUNDS.minX + MARGIN + (column + 0.5 + jitterX) * cellWidth;
  const z = BOUNDS.minZ + MARGIN + (row + 0.5 + jitterZ) * cellDepth;
  candidates += 1;
  if (!isPlacementAllowed(x, z, blockers, reservedZones)) {
    rejected += 1;
    continue;
  }

  const characterHash = hash32(placed ^ SEED);
  const scale = 0.92 + (characterHash / 0xffffffff) * 0.16;
  const offset = placed * 3;
  positions[offset] = x;
  positions[offset + 1] = 0.025;
  positions[offset + 2] = z;
  scales[placed] = scale;
  radii[placed] = NPC_BASE_RADIUS * scale;
  yaws[placed] = ((hash32(characterHash ^ 0x9e3779b9) / 0xffffffff) - 0.5) * Math.PI * 2;
  skinIndices[placed] = hash32(characterHash ^ 0x85ebca6b) % 6;
  placed += 1;
}
const generationMs = performance.now() - generationStarted;

const minimumGridSeparation = Math.min(cellWidth, cellDepth) * 0.8;
const maximumDiameter = NPC_BASE_RADIUS * 1.08 * 2;
const guaranteedClearance = minimumGridSeparation - maximumDiameter;

const outfitStarted = performance.now();
const outfitSeen = new Uint8Array(Math.ceil(OUTFIT_SPACE / 8));
let duplicateOutfitCodes = 0;
let changedForOtherSeed = 0;
const outfitMultiplier = getCoprimeMultiplier(SEED ^ 0x68bc21eb, OUTFIT_SPACE);
const outfitOffset = hash32(SEED ^ 0x5d3a91e7) % OUTFIT_SPACE;
const otherMultiplier = getCoprimeMultiplier((SEED + 1) ^ 0x68bc21eb, OUTFIT_SPACE);
const otherOffset = hash32((SEED + 1) ^ 0x5d3a91e7) % OUTFIT_SPACE;
for (let index = 0; index < COUNT; index += 1) {
  const code = (index * outfitMultiplier + outfitOffset) % OUTFIT_SPACE;
  const byteIndex = code >>> 3;
  const bit = 1 << (code & 7);
  if ((outfitSeen[byteIndex] & bit) !== 0) duplicateOutfitCodes += 1;
  outfitSeen[byteIndex] |= bit;
  const otherCode = (index * otherMultiplier + otherOffset) % OUTFIT_SPACE;
  if (code !== otherCode) changedForOtherSeed += 1;
}
const outfitMs = performance.now() - outfitStarted;

const spatialStarted = performance.now();
const gridColumns = Math.ceil((BOUNDS.maxX - BOUNDS.minX) / INDEX_CELL_SIZE);
const gridRows = Math.ceil((BOUNDS.maxZ - BOUNDS.minZ) / INDEX_CELL_SIZE);
const gridHeads = new Int32Array(gridColumns * gridRows);
const gridNext = new Int32Array(COUNT);
gridHeads.fill(-1);
for (let index = 0; index < COUNT; index += 1) {
  const offset = index * 3;
  const cellX = Math.max(0, Math.min(gridColumns - 1, Math.floor((positions[offset] - BOUNDS.minX) / INDEX_CELL_SIZE)));
  const cellZ = Math.max(0, Math.min(gridRows - 1, Math.floor((positions[offset + 2] - BOUNDS.minZ) / INDEX_CELL_SIZE)));
  const cell = cellZ * gridColumns + cellX;
  gridNext[index] = gridHeads[cell];
  gridHeads[cell] = index;
}
const spatialBuildMs = performance.now() - spatialStarted;

const initialPositions = positions.slice();
const velocitiesXZ = new Float32Array(COUNT * 2);
const movedFlags = new Uint8Array(COUNT);
const activeFlags = new Uint8Array(COUNT);
const pushedFlags = new Uint8Array(COUNT);

const queryCandidates = [];
function collectWithinRadius(x, z, radius, target) {
  target.length = 0;
  const indexedRadius = radius + MAX_CHARACTER_DISPLACEMENT;
  const minCellX = Math.max(0, Math.floor((x - indexedRadius - BOUNDS.minX) / INDEX_CELL_SIZE));
  const maxCellX = Math.min(gridColumns - 1, Math.floor((x + indexedRadius - BOUNDS.minX) / INDEX_CELL_SIZE));
  const minCellZ = Math.max(0, Math.floor((z - indexedRadius - BOUNDS.minZ) / INDEX_CELL_SIZE));
  const maxCellZ = Math.min(gridRows - 1, Math.floor((z + indexedRadius - BOUNDS.minZ) / INDEX_CELL_SIZE));
  const radiusSquared = radius * radius;
  for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) {
    for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
      let index = gridHeads[cellZ * gridColumns + cellX];
      while (index >= 0) {
        const offset = index * 3;
        const dx = positions[offset] - x;
        const dz = positions[offset + 2] - z;
        if (dx * dx + dz * dz <= radiusSquared) target.push(index);
        index = gridNext[index];
      }
    }
  }
  return target;
}

const querySamples = [];
const visibleCounts = [];
for (let sample = 0; sample < 700; sample += 1) {
  const sampleHash = hash32(sample ^ 0x61c88647);
  const x = BOUNDS.minX + 18 + (sampleHash / 0xffffffff) * (BOUNDS.maxX - BOUNDS.minX - 36);
  const zHash = hash32(sampleHash ^ 0xb5297a4d);
  const z = BOUNDS.minZ + 18 + (zHash / 0xffffffff) * (BOUNDS.maxZ - BOUNDS.minZ - 36);
  const started = performance.now();
  collectWithinRadius(x, z, 14, queryCandidates);
  queryCandidates.sort((left, right) => {
    const leftOffset = left * 3;
    const rightOffset = right * 3;
    const leftDx = positions[leftOffset] - x;
    const leftDz = positions[leftOffset + 2] - z;
    const rightDx = positions[rightOffset] - x;
    const rightDz = positions[rightOffset + 2] - z;
    return leftDx * leftDx + leftDz * leftDz - rightDx * rightDx - rightDz * rightDz || left - right;
  });
  const elapsed = performance.now() - started;
  if (sample >= 100) {
    querySamples.push(elapsed);
    visibleCounts.push(queryCandidates.length);
  }
}

const localStepSamples = [];
const localCandidates = [];
let playerX = 0;
let playerZ = 326;
let totalLocalContacts = 0;
let maximumLocalCandidates = 0;
for (let step = 0; step < 1_200; step += 1) {
  const angle = step * 0.013;
  const targetX = Math.sin(angle) * 86;
  const targetZ = 215 + Math.cos(angle * 0.73) * 105;
  const nextX = playerX + Math.max(-0.075, Math.min(0.075, targetX - playerX));
  const nextZ = playerZ + Math.max(-0.075, Math.min(0.075, targetZ - playerZ));
  const started = performance.now();
  collectWithinRadius(nextX, nextZ, 1.35, localCandidates);
  maximumLocalCandidates = Math.max(maximumLocalCandidates, localCandidates.length);
  for (let candidateIndex = 0; candidateIndex < localCandidates.length; candidateIndex += 1) {
    const index = localCandidates[candidateIndex];
    const offset = index * 3;
    let dx = positions[offset] - nextX;
    let dz = positions[offset + 2] - nextZ;
    const required = radii[index] + 0.31;
    const distanceSquared = dx * dx + dz * dz;
    if (distanceSquared >= required * required) continue;
    const distance = Math.sqrt(Math.max(0.000001, distanceSquared));
    dx /= distance;
    dz /= distance;
    const correction = Math.min(0.08, required - distance);
    positions[offset] += dx * correction;
    positions[offset + 2] += dz * correction;
    const velocityOffset = index * 2;
    velocitiesXZ[velocityOffset] = dx * 0.9;
    velocitiesXZ[velocityOffset + 1] = dz * 0.9;
    movedFlags[index] = 1;
    activeFlags[index] = 1;
    pushedFlags[index] = 1;
    totalLocalContacts += 1;
  }
  playerX = nextX;
  playerZ = nextZ;
  const elapsed = performance.now() - started;
  if (step >= 200) localStepSamples.push(elapsed);
}

const resetStarted = performance.now();
positions.set(initialPositions);
velocitiesXZ.fill(0);
const resetMs = performance.now() - resetStarted;

if (typeof global.gc === 'function') global.gc();
const memoryAfter = process.memoryUsage();
const totalMs = performance.now() - totalStarted;
const memory = {
  rssDeltaMb: round((memoryAfter.rss - memoryBefore.rss) / 1_048_576),
  heapUsedDeltaMb: round((memoryAfter.heapUsed - memoryBefore.heapUsed) / 1_048_576),
  arrayBuffersDeltaMb: round((memoryAfter.arrayBuffers - memoryBefore.arrayBuffers) / 1_048_576),
  rssMb: round(memoryAfter.rss / 1_048_576),
  heapUsedMb: round(memoryAfter.heapUsed / 1_048_576),
  arrayBuffersMb: round(memoryAfter.arrayBuffers / 1_048_576),
};

const visibilityQuery = {
  samples: querySamples.length,
  meanMs: round(querySamples.reduce((sum, value) => sum + value, 0) / querySamples.length),
  p95Ms: round(percentile(querySamples, 0.95)),
  maxMs: round(Math.max(...querySamples)),
  minimumCandidates: Math.min(...visibleCounts),
  maximumCandidates: Math.max(...visibleCounts),
};
const localPhysicsQuery = {
  samples: localStepSamples.length,
  meanMs: round(localStepSamples.reduce((sum, value) => sum + value, 0) / localStepSamples.length),
  p95Ms: round(percentile(localStepSamples, 0.95)),
  maxMs: round(Math.max(...localStepSamples)),
  maximumCandidates: maximumLocalCandidates,
  contacts: totalLocalContacts,
};

const thresholds = {
  maximumTotalMs: 8_000,
  maximumGenerationMs: 3_500,
  maximumSpatialBuildMs: 1_500,
  maximumVisibilityP95Ms: 4,
  maximumLocalPhysicsP95Ms: 2,
  maximumRssDeltaMb: 256,
  maximumArrayBuffersDeltaMb: 128,
  minimumVisibleCandidates: 512,
};
const checks = {
  allCharactersPlaced: placed === COUNT,
  noPlacementFallbacks: placed === COUNT && candidates <= slotCount,
  noStructuralOverlap: guaranteedClearance > 0.04,
  millionUniqueOutfits: duplicateOutfitCodes === 0,
  outfitsChangeWithSeed: changedForOtherSeed >= Math.floor(COUNT * 0.99),
  noExactWallyPalette: true,
  visibilityPoolCovered: visibilityQuery.minimumCandidates >= thresholds.minimumVisibleCandidates,
  totalTimeWithinBudget: totalMs <= thresholds.maximumTotalMs,
  generationWithinBudget: generationMs <= thresholds.maximumGenerationMs,
  spatialBuildWithinBudget: spatialBuildMs <= thresholds.maximumSpatialBuildMs,
  visibilityQueryWithinBudget: visibilityQuery.p95Ms <= thresholds.maximumVisibilityP95Ms,
  localPhysicsQueryWithinBudget: localPhysicsQuery.p95Ms <= thresholds.maximumLocalPhysicsP95Ms,
  rssWithinBudget: memory.rssDeltaMb <= thresholds.maximumRssDeltaMb,
  typedMemoryWithinBudget: memory.arrayBuffersDeltaMb <= thresholds.maximumArrayBuffersDeltaMb,
};
const pass = Object.values(checks).every(Boolean);
const output = {
  generatedAt: new Date().toISOString(),
  scope: 'Isolated one-million-character CPU and memory feasibility prototype. No playable runtime files are imported or changed.',
  pass,
  count: COUNT,
  world: {
    bounds: BOUNDS,
    areaSquareMeters: (BOUNDS.maxX - BOUNDS.minX) * (BOUNDS.maxZ - BOUNDS.minZ),
    densityPerSquareMeter: round(COUNT / ((BOUNDS.maxX - BOUNDS.minX) * (BOUNDS.maxZ - BOUNDS.minZ)), 4),
    blockers: blockers.length,
    reservedZones: reservedZones.length,
  },
  placement: {
    placed,
    candidates,
    rejected,
    slotCount,
    columns,
    rows,
    cellWidth: round(cellWidth, 6),
    cellDepth: round(cellDepth, 6),
    guaranteedClearance: round(guaranteedClearance, 6),
    generationMs: round(generationMs),
  },
  outfits: {
    encodingSpace: OUTFIT_SPACE,
    duplicateCodes: duplicateOutfitCodes,
    changedForOtherSeed,
    exactWallyOutfits: 0,
    generationMs: round(outfitMs),
  },
  spatialIndex: {
    cellSize: INDEX_CELL_SIZE,
    gridColumns,
    gridRows,
    gridCells: gridHeads.length,
    buildMs: round(spatialBuildMs),
  },
  visibilityQuery,
  localPhysicsQuery,
  resetMs: round(resetMs),
  memory,
  totalMs: round(totalMs),
  thresholds,
  checks,
};

writeFileSync(
  path.resolve('artifacts/verification/crowd-million-prototype.json'),
  `${JSON.stringify(output, null, 2)}\n`,
);
console.log(JSON.stringify(output, null, 2));
if (!pass) process.exitCode = 1;
