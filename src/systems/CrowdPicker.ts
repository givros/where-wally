import type * as THREE from 'three';

export type CrowdHit = {
  distance: number;
  characterIndex: number;
};

export function findCrowdHit(
  positions: Float32Array,
  count: number,
  ray: THREE.Ray,
  maxDistance: number,
  selectionRadius: number,
  selectionHeights: readonly number[],
  result?: CrowdHit,
  isCandidateVisible?: (characterIndex: number) => boolean,
  candidateIndices?: ArrayLike<number>,
  candidateCount = candidateIndices?.length ?? count,
): CrowdHit | null {
  const radiusSquared = selectionRadius * selectionRadius;
  let nearestDistance = Number.POSITIVE_INFINITY;
  let nearestCharacterIndex = -1;

  const iterationCount = Math.min(
    candidateIndices ? candidateIndices.length : count,
    Math.max(0, Math.floor(candidateCount)),
  );
  for (let candidateOffset = 0; candidateOffset < iterationCount; candidateOffset += 1) {
    const index = candidateIndices ? candidateIndices[candidateOffset] : candidateOffset;
    if (index < 0 || index >= count) continue;
    if (isCandidateVisible && !isCandidateVisible(index)) continue;
    const x = positions[index * 3];
    const z = positions[index * 3 + 2];
    const deltaX = x - ray.origin.x;
    const deltaZ = z - ray.origin.z;

    for (const y of selectionHeights) {
      const deltaY = y - ray.origin.y;
      const alongRay =
        deltaX * ray.direction.x +
        deltaY * ray.direction.y +
        deltaZ * ray.direction.z;
      if (alongRay <= 0.2 || alongRay - selectionRadius > maxDistance) continue;

      const distanceSquared = deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
      const perpendicularSquared = Math.max(0, distanceSquared - alongRay * alongRay);
      if (perpendicularSquared > radiusSquared) continue;

      // Match Three.js ray hits by comparing the near surface of the proxy,
      // rather than its centre projection. This preserves correct ordering
      // when a crowd member stands just in front of Wally.
      const halfChord = Math.sqrt(radiusSquared - perpendicularSquared);
      const hitDistance = Math.max(0, alongRay - halfChord);
      if (hitDistance < nearestDistance) {
        nearestDistance = hitDistance;
        nearestCharacterIndex = index;
      }
    }
  }

  if (nearestCharacterIndex < 0) return null;
  const hit = result ?? { distance: 0, characterIndex: -1 };
  hit.distance = nearestDistance;
  hit.characterIndex = nearestCharacterIndex;
  return hit;
}

export function findCrowdHitDistance(
  positions: Float32Array,
  count: number,
  ray: THREE.Ray,
  maxDistance: number,
  selectionRadius: number,
  selectionHeights: readonly number[],
): number | null {
  return findCrowdHit(
    positions,
    count,
    ray,
    maxDistance,
    selectionRadius,
    selectionHeights,
  )?.distance ?? null;
}
