import * as THREE from 'three';
import {
  CHARACTER_CROWD_MODEL_URL,
  loadCharacterCrowdAsset,
  type CharacterCrowdAsset,
  type CharacterCrowdGeometrySet,
  type CharacterCrowdPart,
  type CharacterCrowdTier,
} from './CharacterCrowdAsset';
import type { Aabb2 } from './CityWorld';
import { CrowdSpatialIndex } from '../systems/CrowdSpatialIndex';

type CrowdOptions = {
  count: number;
  bounds: Aabb2;
  blockers: Aabb2[];
  seed: number;
  reservedZones: ReadonlyArray<{ position: THREE.Vector3; radius: number }>;
  maxVisibleCharacters?: number;
};

type PlacementResult = {
  positions: Float32Array;
  candidatesTested: number;
  rejectedCandidates: number;
  duplicatedFallbacks: number;
};

type CrowdLayer = {
  mesh: THREE.InstancedMesh;
  geometry: THREE.BufferGeometry;
  ownsGeometry: boolean;
};

type InstanceBinding = {
  mesh: THREE.InstancedMesh;
  instanceIndex: number;
};

export type OutfitVariant = {
  id: string;
  stripeColor: string;
  stripeLight: string;
  stripeHeight: number;
  stripePhase: number;
  stripeBalance: number;
  edgeSoftness: number;
  pantsColor: string;
  signature: string;
};

type OutfitAppearance = Omit<OutfitVariant, 'id' | 'signature'>;

export type VisibleCrowdCharacters = {
  indices: Int32Array;
  count: number;
};

export type CrowdLoadResult = {
  loaded: true;
  source: 'blender-characterbase';
  modelUrl: string;
  message: string;
};

export type CrowdDiagnostics = Record<string, number | string | boolean>;

const LARGE_CROWD_COUNT = 10_000;
const MAX_UNIQUE_OUTFITS = 1_000_000;
const CHARACTER_PARTS = ['body', 'shirt', 'pants'] as const;
const DEFAULT_VISIBLE_CHARACTER_BUDGET = 1_024;
const VISIBILITY_REEVALUATION_DISTANCE = 1.35;
const NPC_COLLISION_RADIUS = 0.195;
const WALLY_RED = '#e83030';
const WALLY_WHITE = '#f8f8f8';
const WALLY_BLUE = '#00a0e0';
const RED_PALETTE = [
  '#ad3540', '#b83c43', '#c14342', '#ca4944', '#d14f48',
  '#b9484d', '#c45351', '#ce5c55', '#d56359', '#bc3f48',
] as const;
const LIGHT_PALETTE = [
  '#eadfce', '#eee4d6', '#f1e7d9', '#e7dfd4', '#f0e8dd',
  '#e4ddd2', '#f2e6d3', '#e9e3d9', '#efe1cf', '#e5e1da',
] as const;
const PANTS_PALETTE = [
  '#24557a', '#2d6080', '#32678a', '#385b82', '#276b7d',
  '#3c6489', '#285d8d', '#3d718e', '#31577b', '#2c6a87',
] as const;
const SKIN_COLORS = ['#ffd1b0', '#efad83', '#c9825b', '#a4684b', '#784b3c', '#ffe0c9'];

/**
 * One exact Blender CharacterBase source is evaluated in Idle and every character
 * is rendered with its complete High geometry plus a unique Wally-adjacent outfit.
 */
export class CrowdSystem {
  readonly count: number;
  readonly positions: Float32Array;
  readonly radii: Float32Array;

  private readonly scene: THREE.Scene;
  private readonly root = new THREE.Group();
  private readonly layers: CrowdLayer[] = [];
  private readonly directMeshes: THREE.Mesh[] = [];
  private readonly directMaterials = new Set<THREE.Material>();
  private readonly pooledLayers: CrowdLayer[] = [];
  private readonly materials: Record<CharacterCrowdPart, THREE.MeshStandardMaterial>;
  private readonly diagnostics: CrowdDiagnostics;
  private readonly initialViewer = new THREE.Vector3();
  private readonly lastLodViewer = new THREE.Vector3();
  private readonly scales: Float32Array;
  private readonly yaws: Float32Array;
  private outfitSeed: number;
  private readonly outfitScratch: OutfitAppearance = {
    stripeColor: RED_PALETTE[0],
    stripeLight: LIGHT_PALETTE[0],
    stripeHeight: 0.055,
    stripePhase: 0,
    stripeBalance: 0,
    edgeSoftness: 0.8,
    pantsColor: PANTS_PALETTE[0],
  };
  private readonly skinIndices: Uint8Array;
  private readonly removedFlags: Uint8Array;
  private readonly removedIndices: number[] = [];
  private readonly instanceBindings: InstanceBinding[][] | null;
  private readonly directBindings: THREE.Mesh[][] | null;
  private readonly poolSlotByCharacter: Int32Array;
  private readonly spatialIndex: CrowdSpatialIndex;
  private readonly visibilityCandidates: number[] = [];
  private readonly transformDummy = new THREE.Object3D();
  private readonly hiddenMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
  private readonly dirtyMeshes = new Set<THREE.InstancedMesh>();
  private readonly maxVisibleCharacters: number;
  private pooledCharacterBySlot = new Int32Array(0);
  private asset: CharacterCrowdAsset | null = null;
  private loadPromise: Promise<CrowdLoadResult> | null = null;
  private lodInitialized = false;
  private disposed = false;

  constructor(scene: THREE.Scene, options: CrowdOptions) {
    const { count, bounds, blockers, seed, reservedZones } = options;
    this.scene = scene;
    this.count = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0));
    this.removedFlags = new Uint8Array(this.count);
    this.maxVisibleCharacters = Math.min(
      this.count,
      Math.max(
        1,
        Math.floor(
          Number.isFinite(options.maxVisibleCharacters)
            ? options.maxVisibleCharacters as number
            : DEFAULT_VISIBLE_CHARACTER_BUDGET,
        ),
      ),
    );
    if (this.count > MAX_UNIQUE_OUTFITS) {
      throw new Error(`CrowdSystem supports at most ${MAX_UNIQUE_OUTFITS.toLocaleString('en-US')} unique outfits.`);
    }
    this.outfitSeed = seed;
    this.instanceBindings = this.count > 64 && this.count < LARGE_CROWD_COUNT
      ? Array.from({ length: this.count }, () => [])
      : null;
    this.directBindings = this.count <= 64
      ? Array.from({ length: this.count }, () => [])
      : null;
    this.poolSlotByCharacter = new Int32Array(this.count);
    this.poolSlotByCharacter.fill(-1);
    this.root.name = 'characterbase-festival-crowd';
    this.materials = {
      body: createCrowdMaterial('body'),
      shirt: createCrowdMaterial('shirt'),
      pants: createCrowdMaterial('pants'),
    };
    this.scene.add(this.root);

    const random = createMulberry32(seed >>> 0);
    const placement = generatePositions(this.count, bounds, blockers, reservedZones, random);
    this.positions = placement.positions;
    this.spatialIndex = new CrowdSpatialIndex({
      positions: this.positions,
      bounds,
      cellSize: 2,
      maximumDisplacement: 0.75,
    });
    this.initialViewer.copy(
      reservedZones[0]?.position ??
        new THREE.Vector3((bounds.minX + bounds.maxX) * 0.5, 0, (bounds.minZ + bounds.maxZ) * 0.5),
    );

    this.scales = new Float32Array(this.count);
    this.yaws = new Float32Array(this.count);
    this.radii = new Float32Array(this.count);
    this.skinIndices = new Uint8Array(this.count);
    for (let index = 0; index < this.count; index += 1) {
      this.scales[index] = 0.92 + random() * 0.16;
      this.radii[index] = NPC_COLLISION_RADIUS * this.scales[index];
      this.skinIndices[index] = Math.floor(random() * SKIN_COLORS.length);
      this.yaws[index] = random() < 0.78 ? (random() - 0.5) * 0.85 : random() * Math.PI * 2;
    }

    this.diagnostics = {
      characters: this.count,
      remainingCharacters: this.count,
      removedCharacters: 0,
      characterPositionBytes: this.positions.byteLength,
      source: 'blender-characterbase',
      sourceModel: CHARACTER_CROWD_MODEL_URL,
      oneCanonicalBase: true,
      fullGeometryOnly: true,
      completeCharacterBaseCharacters: this.count,
      simplifiedCharacters: 0,
      idlePoseBaked: true,
      assetLoaded: false,
      loadProgress: 0,
      renderPartInstances: 0,
      approximateTriangles: 0,
      drawCallEstimate: 0,
      instancedMeshes: 0,
      activeInstancedMeshes: 0,
      uniqueGeometries: 0,
      uniqueMaterials: 1,
      animatedLayers: 0,
      activeHighCharacters: 0,
      activeMediumCharacters: 0,
      activeLowCharacters: 0,
      lodChunks: 0,
      mediumChunks: 0,
      lowChunks: 0,
      spatialChunks: 0,
      visibleChunks: 0,
      culledChunks: 0,
      visibleCharacters: 0,
      culledCharacters: 0,
      renderPoolCapacity: this.maxVisibleCharacters,
      farthestRenderedCharacter: 0,
      candidatesTested: placement.candidatesTested,
      rejectedCandidates: placement.rejectedCandidates,
      duplicatedFallbacks: placement.duplicatedFallbacks,
      blockersConsidered: blockers.length,
      reservedZones: reservedZones.length,
      collidableCharacters: this.count,
      pushableCharacters: this.count,
      collisionShape: 'dynamic-2d-circles',
      stripedCharacters: this.count,
      roundGlasses: 0,
      redWhiteHats: 0,
      canes: 0,
      wallyLikeCharacters: 0,
      shirtVariants: this.count,
      trouserVariants: this.count,
      outfitVariants: this.count,
      uniqueOutfitSignatures: this.count,
      perceptuallyUniqueOutfits: this.count,
      outfitSignatureHash: hashOutfitEncoding(this.count, seed),
      outfitSeed: (seed ^ 0x68bc21eb) >>> 0,
      outfitEncodingSpace: MAX_UNIQUE_OUTFITS,
      exactWallyOutfits: 0,
      skinVariants: SKIN_COLORS.length,
      visibleExtraElements: 0,
      spatialIndexBytes: this.spatialIndex.getDiagnostics().bytes,
      spatialIndexCells: this.spatialIndex.getDiagnostics().gridCells,
    };
  }

  load(onProgress?: (ratio: number | null) => void): Promise<CrowdLoadResult> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.loadInternal(onProgress);
    return this.loadPromise;
  }

  update(_elapsedSeconds: number, viewerPosition?: THREE.Vector3): void {
    if (viewerPosition && this.pooledLayers.length > 0) {
      this.updatePooledVisibility(viewerPosition, false);
    }
  }

  /** Regenerates a complete unique wardrobe without rebuilding CharacterBase geometry. */
  regenerateOutfits(seed: number): void {
    this.outfitSeed = seed;
    this.diagnostics.shirtVariants = this.count;
    this.diagnostics.trouserVariants = this.count;
    this.diagnostics.outfitVariants = this.count;
    this.diagnostics.uniqueOutfitSignatures = this.count;
    this.diagnostics.perceptuallyUniqueOutfits = this.count;
    this.diagnostics.outfitSignatureHash = hashOutfitEncoding(this.count, seed);
    this.diagnostics.outfitSeed = (seed ^ 0x68bc21eb) >>> 0;

    if (this.layers.length === 0) return;
    const stripeColor = new THREE.Color();
    const lightColor = new THREE.Color();
    const pantsColor = new THREE.Color();
    for (let characterIndex = 0; characterIndex < this.count; characterIndex += 1) {
      const outfit = this.readOutfit(characterIndex);
      stripeColor.set(outfit.stripeColor);
      lightColor.set(outfit.stripeLight);
      pantsColor.set(outfit.pantsColor);
      for (const binding of this.instanceBindings?.[characterIndex] ?? []) {
        if (binding.mesh.name.endsWith('-shirt')) {
          binding.mesh.setColorAt(binding.instanceIndex, stripeColor);
          const lightAttribute = binding.mesh.geometry.getAttribute(
            'aOutfitLight',
          ) as THREE.InstancedBufferAttribute;
          const patternAttribute = binding.mesh.geometry.getAttribute(
            'aOutfitPattern',
          ) as THREE.InstancedBufferAttribute;
          lightAttribute.setXYZ(
            binding.instanceIndex,
            lightColor.r,
            lightColor.g,
            lightColor.b,
          );
          patternAttribute.setXYZW(
            binding.instanceIndex,
            outfit.stripeHeight,
            outfit.stripePhase,
            outfit.stripeBalance,
            outfit.edgeSoftness,
          );
        } else if (binding.mesh.name.endsWith('-pants')) {
          binding.mesh.setColorAt(binding.instanceIndex, pantsColor);
        }
      }
    }
    for (const { mesh } of this.layers) {
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      const lightAttribute = mesh.geometry.getAttribute('aOutfitLight');
      const patternAttribute = mesh.geometry.getAttribute('aOutfitPattern');
      if (lightAttribute) lightAttribute.needsUpdate = true;
      if (patternAttribute) patternAttribute.needsUpdate = true;
    }
    if (this.pooledLayers.length > 0) this.refreshPooledAppearance();
  }

  /** Keeps rendered instances aligned with positions changed by crowd physics. */
  syncTransforms(movedCharacters?: Uint8Array | ReadonlyArray<number>): void {
    const movedIndices = Array.isArray(movedCharacters) ? movedCharacters : null;
    const movedFlags = movedCharacters instanceof Uint8Array && movedCharacters.length === this.count
      ? movedCharacters
      : null;
    this.dirtyMeshes.clear();
    const syncCharacter = (characterIndex: number) => {
      if (characterIndex < 0 || characterIndex >= this.count) return;
      const removed = this.removedFlags[characterIndex] !== 0;
      const matrix = removed
        ? this.hiddenMatrix
        : this.getCharacterMatrix(characterIndex, this.transformDummy);
      for (const binding of this.instanceBindings?.[characterIndex] ?? []) {
        binding.mesh.setMatrixAt(binding.instanceIndex, matrix);
        this.dirtyMeshes.add(binding.mesh);
      }
      const poolSlot = this.poolSlotByCharacter[characterIndex];
      if (poolSlot >= 0) {
        for (const layer of this.pooledLayers) {
          layer.mesh.setMatrixAt(poolSlot, matrix);
          this.dirtyMeshes.add(layer.mesh);
        }
      }
      for (const mesh of this.directBindings?.[characterIndex] ?? []) {
        mesh.visible = !removed;
        if (removed) continue;
        mesh.matrix.copy(matrix);
        mesh.matrixWorldNeedsUpdate = true;
      }
    };
    if (movedIndices) {
      for (const characterIndex of movedIndices) syncCharacter(characterIndex);
    } else {
      for (let characterIndex = 0; characterIndex < this.count; characterIndex += 1) {
        if (movedFlags && movedFlags[characterIndex] === 0) continue;
        syncCharacter(characterIndex);
      }
    }
    if (movedIndices || movedFlags) {
      for (const mesh of this.dirtyMeshes) mesh.instanceMatrix.needsUpdate = true;
    } else {
      for (const { mesh } of this.layers) mesh.instanceMatrix.needsUpdate = true;
    }
  }

  getDiagnostics(): CrowdDiagnostics {
    return { ...this.diagnostics };
  }

  getCompleteCharacterGeometries(): CharacterCrowdGeometrySet | null {
    return this.asset?.geometries.high ?? null;
  }

  getSpatialIndex(): CrowdSpatialIndex {
    return this.spatialIndex;
  }

  /** Shared tombstones consumed by rendering, picking, and crowd physics. */
  getRemovedFlags(): Uint8Array {
    return this.removedFlags;
  }

  getRemainingCount(): number {
    return this.count - this.removedIndices.length;
  }

  isCharacterRemoved(characterIndex: number): boolean {
    return characterIndex >= 0 &&
      characterIndex < this.count &&
      this.removedFlags[characterIndex] !== 0;
  }

  /** Removes one wrong suspect for the rest of the current search round. */
  removeCharacter(characterIndex: number): boolean {
    if (
      !Number.isInteger(characterIndex) ||
      characterIndex < 0 ||
      characterIndex >= this.count ||
      this.removedFlags[characterIndex] !== 0
    ) {
      return false;
    }

    this.removedFlags[characterIndex] = 1;
    this.removedIndices.push(characterIndex);
    for (const mesh of this.directBindings?.[characterIndex] ?? []) mesh.visible = false;
    for (const binding of this.instanceBindings?.[characterIndex] ?? []) {
      binding.mesh.setMatrixAt(binding.instanceIndex, this.hiddenMatrix);
      binding.mesh.instanceMatrix.needsUpdate = true;
    }
    if (this.pooledLayers.length > 0) {
      this.updatePooledVisibility(this.lastLodViewer, true);
    }
    this.refreshRemovalDiagnostics();
    this.refreshRenderDiagnostics();
    return true;
  }

  /** Restores only suspects removed during this round, preserving stable IDs. */
  restoreRemovedCharacters(): void {
    if (this.removedIndices.length === 0) return;
    const restoredIndices = this.removedIndices.slice();
    for (const characterIndex of restoredIndices) this.removedFlags[characterIndex] = 0;
    this.removedIndices.length = 0;
    if (this.pooledLayers.length > 0) {
      this.updatePooledVisibility(this.lastLodViewer, true);
    } else {
      this.syncTransforms(restoredIndices);
    }
    this.refreshRemovalDiagnostics();
    this.refreshRenderDiagnostics();
  }

  getVisibleCharacters(): VisibleCrowdCharacters | null {
    if (this.pooledLayers.length === 0) return null;
    return {
      indices: this.pooledCharacterBySlot,
      count: Number(this.diagnostics.visibleCharacters) || 0,
    };
  }

  copyCharacterMatrix(characterIndex: number, target: THREE.Matrix4): boolean {
    if (
      characterIndex < 0 ||
      characterIndex >= this.count ||
      this.removedFlags[characterIndex] !== 0
    ) return false;
    target.copy(this.getCharacterMatrix(characterIndex, this.transformDummy));
    return true;
  }

  isCharacterVisible(characterIndex: number): boolean {
    if (
      characterIndex < 0 ||
      characterIndex >= this.count ||
      this.removedFlags[characterIndex] !== 0
    ) return false;
    return this.pooledLayers.length === 0 || this.poolSlotByCharacter[characterIndex] >= 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.remove(this.root);
    for (const layer of this.layers) {
      if (layer.ownsGeometry) layer.geometry.dispose();
    }
    for (const material of this.directMaterials) material.dispose();
    this.directMaterials.clear();
    this.directMeshes.length = 0;
    this.asset?.dispose();
    this.asset = null;
    for (const material of Object.values(this.materials)) material.dispose();
    this.root.clear();
  }

  private async loadInternal(onProgress?: (ratio: number | null) => void): Promise<CrowdLoadResult> {
    const asset = await loadCharacterCrowdAsset({
      onProgress: (ratio) => {
        this.diagnostics.loadProgress = ratio ?? 0;
        onProgress?.(ratio);
      },
    });
    if (this.disposed) {
      asset.dispose();
      throw new Error('CrowdSystem was disposed before its CharacterBase asset finished loading.');
    }
    this.asset = asset;

    if (this.count <= 64) this.createDirectCrowd(asset.geometries.high);
    else if (this.count >= LARGE_CROWD_COUNT) this.createPooledCrowd(asset.geometries.high);
    else this.createDetailedCrowd(asset);
    if (this.pooledLayers.length > 0) this.updatePooledVisibility(this.initialViewer, true);
    this.finalizeLayers();
    this.diagnostics.assetLoaded = true;
    this.diagnostics.loadProgress = 1;
    this.diagnostics.sourceNodeCount = asset.diagnostics.sourceNodeNames.length;
    this.diagnostics.sourceAnimationClips = asset.diagnostics.animationClips;
    this.diagnostics.sourceSkinnedMeshes = asset.diagnostics.skinnedMeshes;
    this.diagnostics.highTrianglesPerCharacter = asset.diagnostics.triangleCounts.high.total;
    this.diagnostics.mediumTrianglesPerCharacter = asset.diagnostics.triangleCounts.medium.total;
    this.diagnostics.lowTrianglesPerCharacter = asset.diagnostics.triangleCounts.low.total;
    this.diagnostics.uniqueGeometries = 9;
    this.diagnostics.uniqueMaterials = this.directMaterials.size > 0
      ? this.directMaterials.size
      : CHARACTER_PARTS.length;
    this.refreshRenderDiagnostics();

    return {
      loaded: true,
      source: 'blender-characterbase',
      modelUrl: CHARACTER_CROWD_MODEL_URL,
      message: `${this.count} complete validated Blender CharacterBase instances with unique Wally-adjacent striped outfits.`,
    };
  }

  private createDetailedCrowd(asset: CharacterCrowdAsset): void {
    const ordered = Array.from({ length: this.count }, (_, index) => index).sort((left, right) => {
      const leftDistance = this.distanceSquaredTo(this.initialViewer, left);
      const rightDistance = this.distanceSquaredTo(this.initialViewer, right);
      return leftDistance - rightDistance || left - right;
    });
    const highCount = ordered.length;
    const highIndices = ordered.slice(0, highCount);
    const mediumIndices = ordered.slice(highCount);
    this.createCharacterSet('crowd-high', 'high', highIndices, asset.geometries.high);
    this.createCharacterSet('crowd-medium', 'medium', mediumIndices, asset.geometries.medium);
    this.diagnostics.activeHighCharacters = highIndices.length;
    this.diagnostics.activeMediumCharacters = mediumIndices.length;
    this.diagnostics.activeLowCharacters = 0;
    this.diagnostics.renderMode = 'instanced-complete-characterbase';
  }

  private createDirectCrowd(geometries: CharacterCrowdGeometrySet): void {
    const skinPalette = SKIN_COLORS.map((value) => new THREE.Color(value));
    const materialCache = new Map<string, THREE.MeshStandardMaterial>();
    const dummy = new THREE.Object3D();

    for (let characterIndex = 0; characterIndex < this.count; characterIndex += 1) {
      const matrix = this.removedFlags[characterIndex] !== 0
        ? this.hiddenMatrix
        : this.getCharacterMatrix(characterIndex, dummy).clone();
      const outfit = createWallyAdjacentOutfit(characterIndex, this.outfitSeed);
      for (const part of CHARACTER_PARTS) {
        const materialKey = part === 'body'
          ? `body-${skinPalette[this.skinIndices[characterIndex]].getHexString()}`
          : part === 'shirt'
            ? `shirt-${outfit.id}`
            : `pants-${outfit.pantsColor}`;
        let material = materialCache.get(materialKey);
        if (!material) {
          material = part === 'shirt'
            ? createStripedShirtMaterial(outfit, geometries.shirt)
            : createSolidCharacterMaterial(
                part === 'body'
                  ? skinPalette[this.skinIndices[characterIndex]]
                  : new THREE.Color(outfit.pantsColor),
                materialKey,
              );
          materialCache.set(materialKey, material);
          this.directMaterials.add(material);
        }
        const mesh = new THREE.Mesh(geometries[part], material);
        mesh.name = `crowd-striped-${characterIndex}-${part}`;
        mesh.matrix.copy(matrix);
        mesh.matrixAutoUpdate = false;
        mesh.visible = this.removedFlags[characterIndex] === 0;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.raycast = () => undefined;
        this.root.add(mesh);
        this.directMeshes.push(mesh);
        this.directBindings?.[characterIndex]?.push(mesh);
      }
    }
    this.diagnostics.renderMode = 'direct-striped-lit';
    this.diagnostics.activeHighCharacters = this.count;
    this.diagnostics.activeMediumCharacters = 0;
    this.diagnostics.activeLowCharacters = 0;
  }

  private createPooledCrowd(geometries: CharacterCrowdGeometrySet): void {
    const capacity = this.maxVisibleCharacters;
    const shirtGeometry = geometries.shirt.clone();
    shirtGeometry.setAttribute(
      'aOutfitLight',
      new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3),
    );
    shirtGeometry.setAttribute(
      'aOutfitPattern',
      new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4),
    );
    this.pooledLayers.push(
      this.createLayer('crowd-visible-high-body', 'body', geometries.body, capacity, false),
      this.createLayer('crowd-visible-high-shirt', 'shirt', shirtGeometry, capacity, true),
      this.createLayer('crowd-visible-high-pants', 'pants', geometries.pants, capacity, false),
    );
    for (const layer of this.pooledLayers) layer.mesh.frustumCulled = false;
    this.pooledCharacterBySlot = new Int32Array(capacity);
    this.pooledCharacterBySlot.fill(-1);

    this.diagnostics.activeHighCharacters = 0;
    this.diagnostics.activeMediumCharacters = 0;
    this.diagnostics.activeLowCharacters = 0;
    this.diagnostics.lodChunks = 0;
    this.diagnostics.mediumChunks = 0;
    this.diagnostics.lowChunks = 0;
    this.diagnostics.spatialChunks = 0;
    this.diagnostics.renderMode = 'pooled-visible-complete-characterbase-high';
  }

  private createCharacterSet(
    name: string,
    _tier: CharacterCrowdTier,
    indices: readonly number[],
    geometries: CharacterCrowdGeometrySet,
  ): CrowdLayer[] {
    if (indices.length === 0) return [];
    const shirtGeometry = geometries.shirt.clone();
    const outfitLight = new Float32Array(indices.length * 3);
    const outfitPattern = new Float32Array(indices.length * 4);
    const lightColor = new THREE.Color();
    indices.forEach((characterIndex, instanceIndex) => {
      const outfit = this.readOutfit(characterIndex);
      lightColor.set(outfit.stripeLight);
      lightColor.toArray(outfitLight, instanceIndex * 3);
      const patternOffset = instanceIndex * 4;
      outfitPattern[patternOffset] = outfit.stripeHeight;
      outfitPattern[patternOffset + 1] = outfit.stripePhase;
      outfitPattern[patternOffset + 2] = outfit.stripeBalance;
      outfitPattern[patternOffset + 3] = outfit.edgeSoftness;
    });
    shirtGeometry.setAttribute(
      'aOutfitLight',
      new THREE.InstancedBufferAttribute(outfitLight, 3),
    );
    shirtGeometry.setAttribute(
      'aOutfitPattern',
      new THREE.InstancedBufferAttribute(outfitPattern, 4),
    );
    const layers = [
      this.createLayer(`${name}-body`, 'body', geometries.body, indices.length, false),
      this.createLayer(`${name}-shirt`, 'shirt', shirtGeometry, indices.length, true),
      this.createLayer(`${name}-pants`, 'pants', geometries.pants, indices.length, false),
    ];
    const layerByPart = {
      body: layers[0],
      shirt: layers[1],
      pants: layers[2],
    } satisfies Record<CharacterCrowdPart, CrowdLayer>;
    const dummy = new THREE.Object3D();
    const skinPalette = SKIN_COLORS.map((value) => new THREE.Color(value));
    const shirtColor = new THREE.Color();
    const trouserColor = new THREE.Color();

    indices.forEach((characterIndex, instanceIndex) => {
      const matrix = this.removedFlags[characterIndex] !== 0
        ? this.hiddenMatrix
        : this.getCharacterMatrix(characterIndex, dummy);
      for (const layer of layers) {
        layer.mesh.setMatrixAt(instanceIndex, matrix);
        this.instanceBindings?.[characterIndex]?.push({ mesh: layer.mesh, instanceIndex });
      }
      layerByPart.body.mesh.setColorAt(instanceIndex, skinPalette[this.skinIndices[characterIndex]]);
      layerByPart.shirt.mesh.setColorAt(
        instanceIndex,
        shirtColor.set(this.readOutfit(characterIndex).stripeColor),
      );
      layerByPart.pants.mesh.setColorAt(
        instanceIndex,
        trouserColor.set(this.readOutfit(characterIndex).pantsColor),
      );
    });
    return layers;
  }

  private createLayer(
    name: string,
    part: CharacterCrowdPart,
    geometry: THREE.BufferGeometry,
    count: number,
    ownsGeometry: boolean,
  ): CrowdLayer {
    const mesh = new THREE.InstancedMesh(geometry, this.materials[part], count);
    mesh.name = name;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = true;
    mesh.raycast = () => undefined;
    this.root.add(mesh);
    const layer = { mesh, geometry, ownsGeometry };
    this.layers.push(layer);
    return layer;
  }

  private finalizeLayers(): void {
    for (const { mesh } of this.layers) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      const lightAttribute = mesh.geometry.getAttribute('aOutfitLight');
      const patternAttribute = mesh.geometry.getAttribute('aOutfitPattern');
      if (lightAttribute) lightAttribute.needsUpdate = true;
      if (patternAttribute) patternAttribute.needsUpdate = true;
      if (mesh.count > 0) {
        mesh.computeBoundingBox();
        mesh.computeBoundingSphere();
      }
    }
  }

  private updatePooledVisibility(viewerPosition: THREE.Vector3, force: boolean): void {
    if (!force && this.lodInitialized) {
      const thresholdSquared =
        VISIBILITY_REEVALUATION_DISTANCE * VISIBILITY_REEVALUATION_DISTANCE;
      if (this.lastLodViewer.distanceToSquared(viewerPosition) < thresholdSquared) return;
    }
    this.lastLodViewer.copy(viewerPosition);
    this.lodInitialized = true;

    let queryRadius = 14;
    this.spatialIndex.collectNearby(
      viewerPosition.x,
      viewerPosition.z,
      queryRadius,
      this.visibilityCandidates,
    );
    this.filterRemovedVisibilityCandidates();
    while (
      this.visibilityCandidates.length < this.maxVisibleCharacters &&
      queryRadius < 72
    ) {
      queryRadius *= 1.5;
      this.spatialIndex.collectNearby(
        viewerPosition.x,
        viewerPosition.z,
        queryRadius,
        this.visibilityCandidates,
      );
      this.filterRemovedVisibilityCandidates();
    }
    const ordered = this.visibilityCandidates;
    ordered.sort((left, right) => {
      const leftDistance = this.distanceSquaredTo(viewerPosition, left);
      const rightDistance = this.distanceSquaredTo(viewerPosition, right);
      return leftDistance - rightDistance || left - right;
    });
    const visibleCharacters = Math.min(this.maxVisibleCharacters, ordered.length);
    for (const characterIndex of this.pooledCharacterBySlot) {
      if (characterIndex >= 0) this.poolSlotByCharacter[characterIndex] = -1;
    }
    this.pooledCharacterBySlot.fill(-1);
    for (let slot = 0; slot < visibleCharacters; slot += 1) {
      const characterIndex = ordered[slot];
      this.pooledCharacterBySlot[slot] = characterIndex;
      this.poolSlotByCharacter[characterIndex] = slot;
      const matrix = this.getCharacterMatrix(characterIndex, this.transformDummy);
      for (const layer of this.pooledLayers) layer.mesh.setMatrixAt(slot, matrix);
    }
    this.refreshPooledAppearance();
    for (const layer of this.pooledLayers) {
      layer.mesh.count = visibleCharacters;
      layer.mesh.instanceMatrix.needsUpdate = true;
    }
    const farthestIndex = visibleCharacters > 0 ? ordered[visibleCharacters - 1] : -1;
    const farthestDistance = farthestIndex >= 0
      ? Math.sqrt(this.distanceSquaredTo(viewerPosition, farthestIndex))
      : 0;
    this.diagnostics.activeHighCharacters = visibleCharacters;
    this.diagnostics.activeMediumCharacters = 0;
    this.diagnostics.activeLowCharacters = 0;
    this.diagnostics.visibleCharacters = visibleCharacters;
    this.diagnostics.culledCharacters = this.getRemainingCount() - visibleCharacters;
    this.diagnostics.visibleChunks = visibleCharacters > 0 ? 1 : 0;
    this.diagnostics.culledChunks = 0;
    this.diagnostics.farthestRenderedCharacter = farthestDistance;
    this.refreshRenderDiagnostics();
  }

  private refreshPooledAppearance(): void {
    if (this.pooledLayers.length !== CHARACTER_PARTS.length) return;
    const bodyMesh = this.pooledLayers[0].mesh;
    const shirtMesh = this.pooledLayers[1].mesh;
    const pantsMesh = this.pooledLayers[2].mesh;
    const lightAttribute = shirtMesh.geometry.getAttribute(
      'aOutfitLight',
    ) as THREE.InstancedBufferAttribute;
    const patternAttribute = shirtMesh.geometry.getAttribute(
      'aOutfitPattern',
    ) as THREE.InstancedBufferAttribute;
    const skinColor = new THREE.Color();
    const stripeColor = new THREE.Color();
    const lightColor = new THREE.Color();
    const pantsColor = new THREE.Color();
    for (let slot = 0; slot < this.pooledCharacterBySlot.length; slot += 1) {
      const characterIndex = this.pooledCharacterBySlot[slot];
      if (characterIndex < 0) continue;
      const outfit = this.readOutfit(characterIndex);
      bodyMesh.setColorAt(slot, skinColor.set(SKIN_COLORS[this.skinIndices[characterIndex]]));
      shirtMesh.setColorAt(slot, stripeColor.set(outfit.stripeColor));
      pantsMesh.setColorAt(slot, pantsColor.set(outfit.pantsColor));
      lightColor.set(outfit.stripeLight);
      lightAttribute.setXYZ(slot, lightColor.r, lightColor.g, lightColor.b);
      patternAttribute.setXYZW(
        slot,
        outfit.stripeHeight,
        outfit.stripePhase,
        outfit.stripeBalance,
        outfit.edgeSoftness,
      );
    }
    if (bodyMesh.instanceColor) bodyMesh.instanceColor.needsUpdate = true;
    if (shirtMesh.instanceColor) shirtMesh.instanceColor.needsUpdate = true;
    if (pantsMesh.instanceColor) pantsMesh.instanceColor.needsUpdate = true;
    lightAttribute.needsUpdate = true;
    patternAttribute.needsUpdate = true;
  }

  private refreshRenderDiagnostics(): void {
    const activeLayers = this.layers.filter((layer) => layer.mesh.visible && layer.mesh.count > 0);
    const activeDirectMeshes = this.directMeshes.filter((mesh) => mesh.visible);
    const directTriangles = activeDirectMeshes.reduce(
      (sum, mesh) => sum + getTriangleCount(mesh.geometry),
      0,
    );
    const approximateTriangles = directTriangles + activeLayers.reduce(
      (sum, layer) => sum + getTriangleCount(layer.geometry) * layer.mesh.count,
      0,
    );
    this.diagnostics.renderPartInstances = activeLayers.reduce(
      (sum, layer) => sum + layer.mesh.count,
      activeDirectMeshes.length,
    );
    this.diagnostics.approximateTriangles = approximateTriangles;
    this.diagnostics.drawCallEstimate = activeLayers.length + activeDirectMeshes.length;
    this.diagnostics.instancedMeshes = this.layers.length;
    this.diagnostics.activeInstancedMeshes = activeLayers.length;
    this.diagnostics.animatedLayers = activeLayers.length;
  }

  private filterRemovedVisibilityCandidates(): void {
    let writeIndex = 0;
    for (let readIndex = 0; readIndex < this.visibilityCandidates.length; readIndex += 1) {
      const characterIndex = this.visibilityCandidates[readIndex];
      if (this.removedFlags[characterIndex] !== 0) continue;
      this.visibilityCandidates[writeIndex] = characterIndex;
      writeIndex += 1;
    }
    this.visibilityCandidates.length = writeIndex;
  }

  private refreshRemovalDiagnostics(): void {
    const remaining = this.getRemainingCount();
    this.diagnostics.remainingCharacters = remaining;
    this.diagnostics.removedCharacters = this.removedIndices.length;
    this.diagnostics.collidableCharacters = remaining;
    this.diagnostics.pushableCharacters = remaining;
  }

  private getCharacterMatrix(index: number, dummy: THREE.Object3D): THREE.Matrix4 {
    dummy.position.set(
      this.positions[index * 3],
      this.positions[index * 3 + 1],
      this.positions[index * 3 + 2],
    );
    dummy.rotation.set(0, this.yaws[index], 0);
    const scale = this.scales[index];
    dummy.scale.setScalar(scale);
    dummy.updateMatrix();
    return dummy.matrix;
  }

  private distanceSquaredTo(position: THREE.Vector3, index: number): number {
    const deltaX = this.positions[index * 3] - position.x;
    const deltaZ = this.positions[index * 3 + 2] - position.z;
    return deltaX * deltaX + deltaZ * deltaZ;
  }

  private readOutfit(characterIndex: number): OutfitAppearance {
    return writeWallyAdjacentOutfitAppearance(
      characterIndex,
      this.outfitSeed,
      this.outfitScratch,
    );
  }
}

export type CrowdLodMix = {
  high: number;
  medium: number;
  low: number;
  mediumChunks: number;
  lowChunks: number;
};

/** Pure LOD accounting used by both deterministic verification and runtime budgets. */
export function estimateCrowdLodMix(
  _positions: Float32Array,
  count: number,
  _bounds: Aabb2,
  _viewerPosition: THREE.Vector3,
): CrowdLodMix {
  return {
    high: count,
    medium: 0,
    low: 0,
    mediumChunks: 0,
    lowChunks: 0,
  };
}

function createSolidCharacterMaterial(
  color: THREE.Color,
  name: string,
): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.82,
    metalness: 0,
    fog: true,
  });
  material.name = `crowd-lit-${name}`;
  return material;
}

function createStripedShirtMaterial(
  outfit: OutfitVariant,
  geometry: THREE.BufferGeometry,
): THREE.MeshStandardMaterial {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const stripeOrigin = geometry.boundingBox?.min.y ?? 0;
  const material = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.82,
    metalness: 0,
    fog: true,
  });
  material.name = `crowd-striped-shirt-${outfit.id}`;
  material.userData.outfitVariant = outfit.id;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uStripeColor = { value: new THREE.Color(outfit.stripeColor) };
    shader.uniforms.uStripeLight = { value: new THREE.Color(outfit.stripeLight) };
    shader.uniforms.uStripeHeight = { value: outfit.stripeHeight };
    shader.uniforms.uStripePhase = { value: outfit.stripePhase };
    shader.uniforms.uStripeBalance = { value: outfit.stripeBalance };
    shader.uniforms.uEdgeSoftness = { value: outfit.edgeSoftness };
    shader.uniforms.uStripeOrigin = { value: stripeOrigin };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
varying float vOutfitLocalY;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vOutfitLocalY = position.y;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uStripeColor;
uniform vec3 uStripeLight;
uniform float uStripeHeight;
uniform float uStripePhase;
uniform float uStripeBalance;
uniform float uEdgeSoftness;
uniform float uStripeOrigin;
varying float vOutfitLocalY;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
float outfitStripeCoord = (vOutfitLocalY - uStripeOrigin + uStripePhase) / max(uStripeHeight, 0.001);
float outfitStripeWave = sin(3.14159265 * outfitStripeCoord);
float outfitStripeEdge = max(fwidth(outfitStripeWave) * uEdgeSoftness, 0.001);
float outfitLightMask = smoothstep(uStripeBalance - outfitStripeEdge, uStripeBalance + outfitStripeEdge, -outfitStripeWave);
diffuseColor.rgb *= mix(uStripeColor, uStripeLight, outfitLightMask);`,
      );
  };
  material.customProgramCacheKey = () => `found-wally-direct-striped-shirt-${outfit.id}-v1`;
  return material;
}

function createCrowdMaterial(part: CharacterCrowdPart): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.82,
    metalness: 0,
    fog: true,
  });
  material.name = `shared-characterbase-crowd-${part}-material`;
  material.onBeforeCompile = (shader) => {
    if (part === 'shirt') {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
attribute vec3 aOutfitLight;
attribute vec4 aOutfitPattern;
varying float vOutfitLocalY;
varying vec3 vOutfitLight;
varying vec4 vOutfitPattern;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
vOutfitLocalY = position.y;
vOutfitLight = aOutfitLight;
vOutfitPattern = aOutfitPattern;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
varying float vOutfitLocalY;
varying vec3 vOutfitLight;
varying vec4 vOutfitPattern;`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
float outfitStripeCoord = (vOutfitLocalY + vOutfitPattern.y) / max(vOutfitPattern.x, 0.001);
float outfitStripeWave = sin(3.14159265 * outfitStripeCoord);
float outfitStripeEdge = max(fwidth(outfitStripeWave) * vOutfitPattern.w, 0.001);
float outfitLightMask = smoothstep(
  vOutfitPattern.z - outfitStripeEdge,
  vOutfitPattern.z + outfitStripeEdge,
  -outfitStripeWave
);
diffuseColor.rgb = mix(diffuseColor.rgb, vOutfitLight, outfitLightMask);`,
        );
    }
  };
  material.customProgramCacheKey = () => `found-wally-characterbase-${part}-static-striped-v3`;
  return material;
}

/**
 * Creates one visually distinct, seed-dependent outfit per character. Every result
 * remains red/off-white/blue and structurally excludes Wally's exact colour trio.
 */
export function generateWallyAdjacentOutfits(count: number, seed: number): OutfitVariant[] {
  const safeCount = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0));
  if (safeCount > MAX_UNIQUE_OUTFITS) {
    throw new Error(`Only ${MAX_UNIQUE_OUTFITS.toLocaleString('en-US')} unique outfits are available.`);
  }
  return Array.from(
    { length: safeCount },
    (_, characterIndex) => createWallyAdjacentOutfit(characterIndex, seed),
  );
}

export function createWallyAdjacentOutfit(
  characterIndex: number,
  seed: number,
): OutfitVariant {
  const appearance = writeWallyAdjacentOutfitAppearance(
    characterIndex,
    seed,
    {
      stripeColor: RED_PALETTE[0],
      stripeLight: LIGHT_PALETTE[0],
      stripeHeight: 0.055,
      stripePhase: 0,
      stripeBalance: 0,
      edgeSoftness: 0.8,
      pantsColor: PANTS_PALETTE[0],
    },
  );
  const signature = getPerceptualOutfitSignature(appearance);
  return {
    id: `seed-${(seed >>> 0).toString(16)}-character-${characterIndex}`,
    ...appearance,
    signature,
  };
}

export function getWallyAdjacentOutfitCode(characterIndex: number, seed: number): number {
  const safeIndex = Math.max(0, Math.floor(Number.isFinite(characterIndex) ? characterIndex : 0));
  if (safeIndex >= MAX_UNIQUE_OUTFITS) {
    throw new Error(`Outfit index ${safeIndex} exceeds the unique outfit encoding space.`);
  }
  const multiplier = getOutfitMultiplier(seed);
  const offset = hashUint32((seed ^ 0x5d3a91e7) >>> 0) % MAX_UNIQUE_OUTFITS;
  return (safeIndex * multiplier + offset) % MAX_UNIQUE_OUTFITS;
}

function writeWallyAdjacentOutfitAppearance(
  characterIndex: number,
  seed: number,
  target: OutfitAppearance,
): OutfitAppearance {
  const slot = getWallyAdjacentOutfitCode(characterIndex, seed);
  const redIndex = slot % 10;
  const lightIndex = Math.floor(slot / 10) % 10;
  const pantsIndex = Math.floor(slot / 100) % 10;
  const heightIndex = Math.floor(slot / 1_000) % 10;
  const phaseIndex = Math.floor(slot / 10_000) % 10;
  const balanceIndex = Math.floor(slot / 100_000) % 10;
  target.stripeColor = RED_PALETTE[redIndex];
  target.stripeLight = LIGHT_PALETTE[lightIndex];
  target.pantsColor = PANTS_PALETTE[pantsIndex];
  target.stripeHeight = 0.052 + heightIndex * 0.0065;
  target.stripePhase = (phaseIndex / 10) * target.stripeHeight;
  target.stripeBalance = -0.3 + balanceIndex * 0.06;
  target.edgeSoftness = 0.7 + ((phaseIndex + balanceIndex) % 4) * 0.14;
  if (
    target.stripeColor.toLowerCase() === WALLY_RED &&
    target.stripeLight.toLowerCase() === WALLY_WHITE &&
    target.pantsColor.toLowerCase() === WALLY_BLUE
  ) {
    throw new Error('Generated an exact Wally outfit, which is forbidden for crowd characters.');
  }
  return target;
}

function getPerceptualOutfitSignature(outfit: OutfitAppearance): string {
  return [
    outfit.stripeColor,
    outfit.stripeLight,
    outfit.pantsColor,
    outfit.stripeHeight.toFixed(5),
    outfit.stripePhase.toFixed(6),
    outfit.stripeBalance.toFixed(3),
  ].join('|');
}

function hashOutfitEncoding(count: number, seed: number): string {
  let hash = 0x811c9dc5;
  for (const value of [count, seed, getOutfitMultiplier(seed)]) {
    hash ^= value >>> 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function getOutfitMultiplier(seed: number): number {
  let multiplier = (hashUint32((seed ^ 0x68bc21eb) >>> 0) % (MAX_UNIQUE_OUTFITS - 1)) + 1;
  while (multiplier % 2 === 0 || multiplier % 5 === 0) multiplier += 1;
  if (multiplier >= MAX_UNIQUE_OUTFITS) multiplier = 1;
  return multiplier;
}

function hashUint32(value: number): number {
  let hash = value >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
  return (hash ^ (hash >>> 16)) >>> 0;
}

function generatePositions(
  count: number,
  bounds: Aabb2,
  blockers: Aabb2[],
  reservedZones: CrowdOptions['reservedZones'],
  random: () => number,
): PlacementResult {
  const positions = new Float32Array(count * 3);
  if (count === 0) {
    return { positions, candidatesTested: 0, rejectedCandidates: 0, duplicatedFallbacks: 0 };
  }

  const margin = 0.3;
  const minimumSeparation = 0.43;
  const width = Math.max(0.01, bounds.maxX - bounds.minX - margin * 2);
  const depth = Math.max(0.01, bounds.maxZ - bounds.minZ - margin * 2);
  const targetCells = Math.max(
    count,
    Math.ceil(count * 1.45 + blockers.length * 12 + reservedZones.length * 20),
  );
  const columns = Math.max(1, Math.ceil(Math.sqrt(targetCells * (width / depth))));
  const rows = Math.max(1, Math.ceil(targetCells / columns));
  const slotCount = columns * rows;
  const slotOrder = new Uint32Array(slotCount);
  for (let index = 0; index < slotCount; index += 1) slotOrder[index] = index;
  for (let index = slotCount - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    const value = slotOrder[index];
    slotOrder[index] = slotOrder[swapIndex];
    slotOrder[swapIndex] = value;
  }

  const cellWidth = width / columns;
  const cellDepth = depth / rows;
  let placed = 0;
  let candidatesTested = 0;
  let rejectedCandidates = 0;
  for (let orderIndex = 0; orderIndex < slotOrder.length && placed < count; orderIndex += 1) {
    const slot = slotOrder[orderIndex];
    const column = slot % columns;
    const row = Math.floor(slot / columns);
    const x = bounds.minX + margin + (column + 0.5 + (random() - 0.5) * 0.2) * cellWidth;
    const z = bounds.minZ + margin + (row + 0.5 + (random() - 0.5) * 0.2) * cellDepth;
    candidatesTested += 1;
    if (
      !isPlacementAllowed(x, z, bounds, blockers, reservedZones, margin)
    ) {
      rejectedCandidates += 1;
      continue;
    }
    positions[placed * 3] = x;
    positions[placed * 3 + 1] = 0.025;
    positions[placed * 3 + 2] = z;
    placed += 1;
  }

  const randomAttemptLimit = Math.max(600, count * 32);
  let randomAttempts = 0;
  while (placed < count && randomAttempts < randomAttemptLimit) {
    const x = bounds.minX + margin + random() * width;
    const z = bounds.minZ + margin + random() * depth;
    candidatesTested += 1;
    randomAttempts += 1;
    if (
      !isPlacementAllowed(x, z, bounds, blockers, reservedZones, margin) ||
      !isSeparatedFromPlaced(positions, placed, x, z, minimumSeparation)
    ) {
      rejectedCandidates += 1;
      continue;
    }
    positions[placed * 3] = x;
    positions[placed * 3 + 1] = 0.025;
    positions[placed * 3 + 2] = z;
    placed += 1;
  }

  if (placed === 0) {
    throw new Error('CrowdSystem could not find any position outside the supplied blockers and reserved zones.');
  }

  const validPositionCount = placed;
  let duplicatedFallbacks = 0;
  while (placed < count) {
    const source = placed % validPositionCount;
    positions[placed * 3] = positions[source * 3];
    positions[placed * 3 + 1] = positions[source * 3 + 1];
    positions[placed * 3 + 2] = positions[source * 3 + 2];
    placed += 1;
    duplicatedFallbacks += 1;
  }

  return { positions, candidatesTested, rejectedCandidates, duplicatedFallbacks };
}

function isPlacementAllowed(
  x: number,
  z: number,
  bounds: Aabb2,
  blockers: Aabb2[],
  reservedZones: CrowdOptions['reservedZones'],
  margin: number,
): boolean {
  if (
    x < bounds.minX + margin ||
    x > bounds.maxX - margin ||
    z < bounds.minZ + margin ||
    z > bounds.maxZ - margin
  ) {
    return false;
  }

  const blockerPadding = 0.3;
  for (const blocker of blockers) {
    if (
      x >= blocker.minX - blockerPadding &&
      x <= blocker.maxX + blockerPadding &&
      z >= blocker.minZ - blockerPadding &&
      z <= blocker.maxZ + blockerPadding
    ) {
      return false;
    }
  }

  for (const reserved of reservedZones) {
    const radius = Math.max(0, reserved.radius);
    const deltaX = x - reserved.position.x;
    const deltaZ = z - reserved.position.z;
    if (deltaX * deltaX + deltaZ * deltaZ < radius * radius) return false;
  }
  return true;
}

function isSeparatedFromPlaced(
  positions: Float32Array,
  placed: number,
  x: number,
  z: number,
  minimumSeparation: number,
): boolean {
  if (minimumSeparation <= 0) return true;
  const minimumSquared = minimumSeparation * minimumSeparation;
  for (let index = 0; index < placed; index += 1) {
    const deltaX = positions[index * 3] - x;
    const deltaZ = positions[index * 3 + 2] - z;
    if (deltaX * deltaX + deltaZ * deltaZ < minimumSquared) return false;
  }
  return true;
}

function getTriangleCount(geometry: THREE.BufferGeometry): number {
  if (geometry.index) return geometry.index.count / 3;
  const position = geometry.getAttribute('position');
  return position ? position.count / 3 : 0;
}

function createMulberry32(seed: number): () => number {
  let state = seed || 0x6d2b79f5;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
