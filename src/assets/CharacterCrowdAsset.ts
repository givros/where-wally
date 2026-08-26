import * as THREE from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { disposeObject3D } from '../utils/dispose';

const PUBLIC_BASE_URL = import.meta.env.BASE_URL;

export const CHARACTER_CROWD_MODEL_URL = `${PUBLIC_BASE_URL}assets/models/crowd/CharacterCrowdRuntime.glb`;
export const CHARACTER_CROWD_TARGET_HEIGHT = 1.72;
export const CHARACTER_CROWD_TIERS = ['high', 'medium', 'low'] as const;
export const CHARACTER_CROWD_PARTS = ['body', 'shirt', 'pants'] as const;

const DRACO_DECODER_PATH = `${PUBLIC_BASE_URL}draco/`;
const SOURCE_NODE_NAMES = {
  high: { body: 'CrowdBodyHigh', shirt: 'CrowdShirtHigh', pants: 'CrowdPantsHigh' },
  medium: { body: 'CrowdBodyMedium', shirt: 'CrowdShirtMedium', pants: 'CrowdPantsMedium' },
  low: { body: 'CrowdBodyLow', shirt: 'CrowdShirtLow', pants: 'CrowdPantsLow' },
} as const;

export type CharacterCrowdTier = (typeof CHARACTER_CROWD_TIERS)[number];
export type CharacterCrowdPart = (typeof CHARACTER_CROWD_PARTS)[number];
export type CharacterCrowdGeometrySet = Record<CharacterCrowdPart, THREE.BufferGeometry>;

export type CharacterCrowdBoundsDiagnostics = {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
  size: { x: number; y: number; z: number };
};

type PartCounts = Record<CharacterCrowdPart | 'total', number>;

export type CharacterCrowdAssetDiagnostics = {
  sourceUrl: string;
  sourceBytes: number | null;
  sourceNodeNames: readonly string[];
  sourceBounds: CharacterCrowdBoundsDiagnostics;
  normalizedBounds: CharacterCrowdBoundsDiagnostics;
  targetHeight: number;
  normalizationScale: number;
  animationClips: number;
  skinnedMeshes: number;
  triangleCounts: Record<CharacterCrowdTier, PartCounts>;
  vertexCounts: Record<CharacterCrowdTier, PartCounts>;
  attributes: Record<CharacterCrowdTier, Record<CharacterCrowdPart, readonly string[]>>;
};

export type CharacterCrowdAsset = {
  geometries: Record<CharacterCrowdTier, CharacterCrowdGeometrySet>;
  diagnostics: CharacterCrowdAssetDiagnostics;
  dispose(): void;
};

export type CharacterCrowdLoadOptions = {
  onProgress?: (ratio: number | null) => void;
};

/** Loads the one canonical CharacterBase-derived crowd asset and prepares its static LODs. */
export async function loadCharacterCrowdAsset(
  options: CharacterCrowdLoadOptions = {},
): Promise<CharacterCrowdAsset> {
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath(DRACO_DECODER_PATH);
  const gltfLoader = new GLTFLoader();
  gltfLoader.setDRACOLoader(dracoLoader);

  const createdGeometries: THREE.BufferGeometry[] = [];
  let sourceRoot: THREE.Object3D | null = null;

  try {
    const gltf = await gltfLoader.loadAsync(CHARACTER_CROWD_MODEL_URL, (event) => {
      options.onProgress?.(event.total > 0 ? event.loaded / event.total : null);
    });
    sourceRoot = gltf.scene;
    sourceRoot.updateMatrixWorld(true);

    const sourceMeshes = new Map<string, THREE.Mesh>();
    let skinnedMeshes = 0;
    sourceRoot.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      if (object instanceof THREE.SkinnedMesh) skinnedMeshes += 1;
      sourceMeshes.set(object.name, object);
    });
    const expectedNames = getExpectedNodeNames();
    const unexpectedNames = [...sourceMeshes.keys()].filter((name) => !expectedNames.includes(name));
    if (unexpectedNames.length > 0) {
      throw new Error(`Crowd asset contains unexpected mesh nodes: ${unexpectedNames.join(', ')}.`);
    }
    if (sourceMeshes.size !== expectedNames.length) {
      throw new Error(`Crowd asset must contain exactly ${expectedNames.length} mesh nodes.`);
    }
    if (gltf.animations.length > 0 || skinnedMeshes > 0) {
      throw new Error('Crowd runtime asset must be static and contain no skins or animations.');
    }

    const geometries = {} as Record<CharacterCrowdTier, CharacterCrowdGeometrySet>;
    for (const tier of CHARACTER_CROWD_TIERS) {
      geometries[tier] = {} as CharacterCrowdGeometrySet;
      for (const part of CHARACTER_CROWD_PARTS) {
        const nodeName = SOURCE_NODE_NAMES[tier][part];
        const node = requireMesh(sourceMeshes, nodeName);
        const geometry = bakeStaticGeometry(node, nodeName);
        geometries[tier][part] = geometry;
        createdGeometries.push(geometry);
      }
    }

    const sourceBounds = computeCombinedBounds(Object.values(geometries.high));
    const sourceSize = sourceBounds.getSize(new THREE.Vector3());
    if (!Number.isFinite(sourceSize.y) || sourceSize.y <= 0.0001) {
      throw new Error('Crowd character geometry has no usable vertical extent.');
    }

    const sourceCenter = sourceBounds.getCenter(new THREE.Vector3());
    const normalizationScale = CHARACTER_CROWD_TARGET_HEIGHT / sourceSize.y;
    for (const tier of CHARACTER_CROWD_TIERS) {
      for (const geometry of Object.values(geometries[tier])) {
        geometry.translate(-sourceCenter.x, -sourceBounds.min.y, -sourceCenter.z);
        geometry.scale(normalizationScale, normalizationScale, normalizationScale);
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
        else geometry.normalizeNormals();
      }
    }

    const normalizedBounds = computeCombinedBounds(Object.values(geometries.high));
    const triangleCounts = {} as Record<CharacterCrowdTier, PartCounts>;
    const vertexCounts = {} as Record<CharacterCrowdTier, PartCounts>;
    const attributes = {} as CharacterCrowdAssetDiagnostics['attributes'];
    for (const tier of CHARACTER_CROWD_TIERS) {
      const triangles = {} as PartCounts;
      const vertices = {} as PartCounts;
      const tierAttributes = {} as Record<CharacterCrowdPart, readonly string[]>;
      let triangleTotal = 0;
      let vertexTotal = 0;
      for (const part of CHARACTER_CROWD_PARTS) {
        const geometry = geometries[tier][part];
        triangles[part] = getTriangleCount(geometry);
        vertices[part] = getVertexCount(geometry);
        triangleTotal += triangles[part];
        vertexTotal += vertices[part];
        tierAttributes[part] = Object.keys(geometry.attributes);
      }
      triangles.total = triangleTotal;
      vertices.total = vertexTotal;
      triangleCounts[tier] = triangles;
      vertexCounts[tier] = vertices;
      attributes[tier] = tierAttributes;
    }

    const diagnostics: CharacterCrowdAssetDiagnostics = {
      sourceUrl: CHARACTER_CROWD_MODEL_URL,
      sourceBytes: null,
      sourceNodeNames: expectedNames,
      sourceBounds: serializeBounds(sourceBounds),
      normalizedBounds: serializeBounds(normalizedBounds),
      targetHeight: CHARACTER_CROWD_TARGET_HEIGHT,
      normalizationScale,
      animationClips: gltf.animations.length,
      skinnedMeshes,
      triangleCounts,
      vertexCounts,
      attributes,
    };

    disposeObject3D(sourceRoot);
    sourceRoot = null;

    let disposed = false;
    return {
      geometries,
      diagnostics,
      dispose(): void {
        if (disposed) return;
        disposed = true;
        for (const geometry of createdGeometries) geometry.dispose();
      },
    };
  } catch (error) {
    for (const geometry of createdGeometries) geometry.dispose();
    throw contextualizeLoadError(error);
  } finally {
    if (sourceRoot) disposeObject3D(sourceRoot);
    dracoLoader.dispose();
  }
}

function getExpectedNodeNames(): string[] {
  const names: string[] = [];
  for (const tier of CHARACTER_CROWD_TIERS) {
    for (const part of CHARACTER_CROWD_PARTS) names.push(SOURCE_NODE_NAMES[tier][part]);
  }
  return names;
}

function requireMesh(meshes: ReadonlyMap<string, THREE.Mesh>, exactName: string): THREE.Mesh {
  const object = meshes.get(exactName);
  if (!object) throw new Error(`Crowd character is missing required mesh node "${exactName}".`);
  if (!object.geometry.getAttribute('position')) {
    throw new Error(`Required crowd mesh "${exactName}" has no position attribute.`);
  }
  return object;
}

function bakeStaticGeometry(source: THREE.Mesh, name: string): THREE.BufferGeometry {
  const geometry = source.geometry.clone();
  geometry.name = `${name}StaticGeometry`;
  geometry.applyMatrix4(source.matrixWorld);
  geometry.deleteAttribute('skinIndex');
  geometry.deleteAttribute('skinWeight');
  geometry.morphAttributes = {};
  geometry.morphTargetsRelative = false;
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function computeCombinedBounds(geometries: readonly THREE.BufferGeometry[]): THREE.Box3 {
  const combined = new THREE.Box3().makeEmpty();
  for (const geometry of geometries) {
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    if (geometry.boundingBox) combined.union(geometry.boundingBox);
  }
  if (combined.isEmpty()) throw new Error('Crowd character meshes produced empty bounds.');
  return combined;
}

function getTriangleCount(geometry: THREE.BufferGeometry): number {
  const elementCount = geometry.index?.count ?? geometry.getAttribute('position')?.count ?? 0;
  return Math.floor(elementCount / 3);
}

function getVertexCount(geometry: THREE.BufferGeometry): number {
  return geometry.getAttribute('position')?.count ?? 0;
}

function serializeBounds(bounds: THREE.Box3): CharacterCrowdBoundsDiagnostics {
  const size = bounds.getSize(new THREE.Vector3());
  return {
    min: { x: bounds.min.x, y: bounds.min.y, z: bounds.min.z },
    max: { x: bounds.max.x, y: bounds.max.y, z: bounds.max.z },
    size: { x: size.x, y: size.y, z: size.z },
  };
}

function contextualizeLoadError(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`Could not prepare ${CHARACTER_CROWD_MODEL_URL}: ${detail}`, { cause: error });
}
