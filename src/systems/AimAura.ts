import * as THREE from 'three';
import type { CharacterCrowdGeometrySet } from '../assets/CharacterCrowdAsset';

export type AimAuraTargetKind = 'crowd' | 'wally';

export type AimAuraDiagnostics = {
  visible: boolean;
  targetKind: AimAuraTargetKind | 'none';
  crowdIndex: number | null;
  distance: number | null;
  sameAppearanceForEveryPerson: true;
  style: 'white-body-silhouette';
  color: '#ffffff';
  bodyHighlight: true;
  proceduralRings: 0;
  outlineThickness: number;
  crowdHighlightMeshes: number;
  wallyHighlightMeshes: number;
};

type WallyHighlightBinding = {
  source: THREE.Mesh;
  outline: THREE.Mesh;
  fill: THREE.Mesh;
};

const CHARACTER_PARTS = ['body', 'shirt', 'pants'] as const;
const HIGHLIGHT_COLOR = '#ffffff' as const;
const MIN_OUTLINE_THICKNESS = 0.012;
const MAX_OUTLINE_THICKNESS = 0.034;

/**
 * One reusable white silhouette highlight. Crowd targets use the exact complete
 * CharacterBase High geometries; Wally uses skinned clones sharing his live skeleton.
 */
export class AimAura {
  private readonly crowdRoot = new THREE.Group();
  private readonly crowdOutlineMeshes: THREE.Mesh[] = [];
  private readonly crowdFillMeshes: THREE.Mesh[] = [];
  private readonly wallyBindings: WallyHighlightBinding[] = [];
  private readonly outlineThickness = { value: MIN_OUTLINE_THICKNESS };
  private readonly crowdTime = { value: 0 };
  private readonly crowdOutlineMaterial = createHighlightMaterial(
    'crowd',
    'outline',
    this.outlineThickness,
    this.crowdTime,
  );
  private readonly crowdFillMaterial = createHighlightMaterial(
    'crowd',
    'fill',
    this.outlineThickness,
    this.crowdTime,
  );
  private readonly wallyOutlineMaterial = createHighlightMaterial(
    'wally',
    'outline',
    this.outlineThickness,
    this.crowdTime,
  );
  private readonly wallyFillMaterial = createHighlightMaterial(
    'wally',
    'fill',
    this.outlineThickness,
    this.crowdTime,
  );
  private targetKind: AimAuraTargetKind | 'none' = 'none';
  private crowdIndex: number | null = null;
  private distance: number | null = null;

  constructor(private readonly scene: THREE.Scene) {
    this.crowdRoot.name = 'reticle-white-body-highlight';
    this.crowdRoot.visible = false;
    this.crowdRoot.matrixAutoUpdate = false;
    this.scene.add(this.crowdRoot);
  }

  configureCrowd(geometries: CharacterCrowdGeometrySet): void {
    for (const mesh of [...this.crowdOutlineMeshes, ...this.crowdFillMeshes]) {
      this.crowdRoot.remove(mesh);
    }
    this.crowdOutlineMeshes.length = 0;
    this.crowdFillMeshes.length = 0;

    for (const part of CHARACTER_PARTS) {
      const geometry = geometries[part];
      const outline = createStaticHighlightMesh(
        geometry,
        this.crowdOutlineMaterial,
        `reticle-white-outline-${part}`,
        60,
      );
      const fill = createStaticHighlightMesh(
        geometry,
        this.crowdFillMaterial,
        `reticle-white-fill-${part}`,
        61,
      );
      this.crowdOutlineMeshes.push(outline);
      this.crowdFillMeshes.push(fill);
      this.crowdRoot.add(outline, fill);
    }
  }

  configureWally(root: THREE.Object3D): void {
    this.removeWallyBindings();
    const sources: THREE.Mesh[] = [];
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      if (object.name === 'WallyInteractionProxy' || object.userData.isAimHighlight === true) return;
      if (!object.geometry.getAttribute('position')) return;
      sources.push(object);
    });

    for (const source of sources) {
      if (!source.parent) continue;
      const outline = createWallyHighlightClone(
        source,
        this.wallyOutlineMaterial,
        'outline',
        60,
      );
      const fill = createWallyHighlightClone(source, this.wallyFillMaterial, 'fill', 61);
      source.parent.add(outline, fill);
      this.wallyBindings.push({ source, outline, fill });
    }
    this.setWallyVisibility(false);
  }

  setCrowdTarget(characterIndex: number, matrix: THREE.Matrix4, distance: number): void {
    this.targetKind = 'crowd';
    this.crowdIndex = characterIndex;
    this.setDistance(distance);
    this.setWallyVisibility(false);
    this.crowdRoot.matrix.copy(matrix);
    this.crowdRoot.matrixWorldNeedsUpdate = true;
    this.crowdRoot.visible = this.crowdOutlineMeshes.length > 0;
  }

  setWallyTarget(distance: number): void {
    this.targetKind = 'wally';
    this.crowdIndex = null;
    this.setDistance(distance);
    this.crowdRoot.visible = false;
    this.setWallyVisibility(true);
  }

  clear(): void {
    this.targetKind = 'none';
    this.crowdIndex = null;
    this.distance = null;
    this.crowdRoot.visible = false;
    this.setWallyVisibility(false);
  }

  update(crowdElapsedSeconds: number): void {
    this.crowdTime.value = Number.isFinite(crowdElapsedSeconds) ? crowdElapsedSeconds : 0;
    if (this.targetKind !== 'wally') return;
    for (const binding of this.wallyBindings) {
      syncHighlightClone(binding.source, binding.outline);
      syncHighlightClone(binding.source, binding.fill);
    }
  }

  getDiagnostics(): AimAuraDiagnostics {
    return {
      visible:
        (this.targetKind === 'crowd' && this.crowdRoot.visible) ||
        (this.targetKind === 'wally' && this.wallyBindings.some(({ outline }) => outline.visible)),
      targetKind: this.targetKind,
      crowdIndex: this.crowdIndex,
      distance: this.distance,
      sameAppearanceForEveryPerson: true,
      style: 'white-body-silhouette',
      color: HIGHLIGHT_COLOR,
      bodyHighlight: true,
      proceduralRings: 0,
      outlineThickness: this.outlineThickness.value,
      crowdHighlightMeshes: this.crowdOutlineMeshes.length + this.crowdFillMeshes.length,
      wallyHighlightMeshes: this.wallyBindings.length * 2,
    };
  }

  dispose(): void {
    this.clear();
    this.removeWallyBindings();
    this.scene.remove(this.crowdRoot);
    this.crowdRoot.clear();
    this.crowdOutlineMaterial.dispose();
    this.crowdFillMaterial.dispose();
    this.wallyOutlineMaterial.dispose();
    this.wallyFillMaterial.dispose();
  }

  private setDistance(distance: number): void {
    this.distance = Number.isFinite(distance) ? distance : null;
    const screenStableThickness = Number.isFinite(distance) ? distance * 0.0034 : 0;
    this.outlineThickness.value = THREE.MathUtils.clamp(
      screenStableThickness,
      MIN_OUTLINE_THICKNESS,
      MAX_OUTLINE_THICKNESS,
    );
  }

  private setWallyVisibility(visible: boolean): void {
    for (const binding of this.wallyBindings) {
      const sourceVisible = isEffectivelyVisible(binding.source);
      binding.outline.visible = visible && sourceVisible;
      binding.fill.visible = visible && sourceVisible;
    }
  }

  private removeWallyBindings(): void {
    for (const binding of this.wallyBindings) {
      binding.outline.parent?.remove(binding.outline);
      binding.fill.parent?.remove(binding.fill);
    }
    this.wallyBindings.length = 0;
  }
}

function createStaticHighlightMesh(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  name: string,
  renderOrder: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  prepareHighlightMesh(mesh, name, renderOrder);
  return mesh;
}

function createWallyHighlightClone(
  source: THREE.Mesh,
  material: THREE.Material,
  role: 'outline' | 'fill',
  renderOrder: number,
): THREE.Mesh {
  let clone: THREE.Mesh;
  if (source instanceof THREE.SkinnedMesh) {
    const skinnedClone = new THREE.SkinnedMesh(source.geometry, material);
    skinnedClone.bindMode = source.bindMode;
    skinnedClone.bind(source.skeleton, source.bindMatrix);
    skinnedClone.bindMatrixInverse.copy(source.bindMatrixInverse);
    clone = skinnedClone;
  } else {
    clone = new THREE.Mesh(source.geometry, material);
  }
  if (source.morphTargetInfluences && clone.morphTargetInfluences) {
    clone.morphTargetInfluences = source.morphTargetInfluences;
    clone.morphTargetDictionary = source.morphTargetDictionary;
  }
  syncHighlightClone(source, clone);
  prepareHighlightMesh(clone, `reticle-white-${role}-${source.name}`, renderOrder);
  clone.visible = false;
  return clone;
}

function prepareHighlightMesh(mesh: THREE.Mesh, name: string, renderOrder: number): void {
  mesh.name = name;
  mesh.userData.isAimHighlight = true;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;
  mesh.raycast = () => undefined;
}

function syncHighlightClone(source: THREE.Mesh, target: THREE.Mesh): void {
  target.position.copy(source.position);
  target.quaternion.copy(source.quaternion);
  target.scale.copy(source.scale);
  target.matrixAutoUpdate = source.matrixAutoUpdate;
  target.matrix.copy(source.matrix);
  target.matrixWorldNeedsUpdate = true;
  target.layers.mask = source.layers.mask;
  if (source.morphTargetInfluences && target.morphTargetInfluences) {
    for (let index = 0; index < source.morphTargetInfluences.length; index += 1) {
      target.morphTargetInfluences[index] = source.morphTargetInfluences[index];
    }
  }
}

function createHighlightMaterial(
  target: AimAuraTargetKind,
  role: 'outline' | 'fill',
  outlineThickness: { value: number },
  crowdTime: { value: number },
): THREE.MeshBasicMaterial {
  const isOutline = role === 'outline';
  const material = new THREE.MeshBasicMaterial({
    color: HIGHLIGHT_COLOR,
    transparent: true,
    opacity: isOutline ? 0.98 : 0.18,
    depthTest: true,
    depthWrite: false,
    side: isOutline ? THREE.BackSide : THREE.FrontSide,
    blending: isOutline ? THREE.NormalBlending : THREE.AdditiveBlending,
    toneMapped: false,
    fog: false,
    polygonOffset: !isOutline,
    polygonOffsetFactor: !isOutline ? -1 : 0,
    polygonOffsetUnits: !isOutline ? -1 : 0,
  });
  material.name = `reticle-white-body-${target}-${role}`;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uAimOutlineThickness = outlineThickness;
    shader.uniforms.uAimCrowdTime = crowdTime;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uAimOutlineThickness;
uniform float uAimCrowdTime;`,
      )
      .replace(
        '#include <skinning_vertex>',
        `#include <skinning_vertex>
${target === 'crowd' ? `float aimCrowdPhase = modelMatrix[3][0] * 1.73 + modelMatrix[3][2] * 2.19;
float aimCrowdSway = 0.012 + fract(sin(aimCrowdPhase * 11.7) * 43758.5453) * 0.022;
transformed.x += sin(uAimCrowdTime * 1.55 + aimCrowdPhase) * aimCrowdSway;
transformed.z += cos(uAimCrowdTime * 1.07 + aimCrowdPhase * 1.31) * aimCrowdSway * 0.32;
transformed.y += sin(uAimCrowdTime * 1.22 + aimCrowdPhase * 0.73) * aimCrowdSway * 0.08;` : ''}
${isOutline ? `vec3 aimOutlineNormal = normal;
#ifdef USE_SKINNING
aimOutlineNormal = objectNormal;
#endif
transformed += normalize(aimOutlineNormal) * uAimOutlineThickness;` : ''}`,
      );
  };
  material.customProgramCacheKey = () => `found-wally-white-body-${target}-${role}-v1`;
  return material;
}

function isEffectivelyVisible(object: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (!current.visible) return false;
    current = current.parent;
  }
  return true;
}
