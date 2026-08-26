import * as THREE from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { disposeObject3D } from '../utils/dispose';

export type WallyLoadResult = {
  loaded: boolean;
  fallback: boolean;
  message: string;
};

export type WallyDiagnostics = {
  ready: boolean;
  loaded: boolean;
  fallback: boolean;
  position: { x: number; y: number; z: number };
  meshCount: number;
  triangles: number;
  textures: number;
  animation: string | null;
  loadError: string | null;
};

const PUBLIC_BASE_URL = import.meta.env.BASE_URL;
const MODEL_URL = `${PUBLIC_BASE_URL}assets/models/wally/WallyRuntime.glb?v=42ede4df`;
const DRACO_DECODER_PATH = `${PUBLIC_BASE_URL}draco/`;
const TARGET_HEIGHT = 1.82;

export class Wally {
  readonly root = new THREE.Group();

  private mixer: THREE.AnimationMixer | null = null;
  private interactionProxy: THREE.Mesh | null = null;
  private animationName: string | null = null;
  private ready = false;
  private loaded = false;
  private fallback = false;
  private loadError: string | null = null;
  private meshCount = 0;
  private triangles = 0;
  private textures = 0;
  private disposed = false;

  constructor(private readonly scene: THREE.Scene) {
    this.root.name = 'WallyTarget';
    this.root.userData.isWally = true;
    this.root.visible = false;
    this.scene.add(this.root);
  }

  async load(onProgress: (ratio: number | null) => void): Promise<WallyLoadResult> {
    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath(DRACO_DECODER_PATH);
    const loader = new GLTFLoader();
    loader.setDRACOLoader(dracoLoader);

    try {
      const gltf = await loader.loadAsync(MODEL_URL, (event) => {
        onProgress(event.total > 0 ? event.loaded / event.total : null);
      });
      if (this.disposed) {
        disposeObject3D(gltf.scene);
        return { loaded: false, fallback: false, message: 'Search closed before Wally finished loading.' };
      }

      this.prepareImportedModel(gltf.scene);
      this.root.add(gltf.scene);
      this.addInteractionProxy();
      this.collectAssetStats(this.root);

      const idleClip = gltf.animations.find((clip) => /(^|\W)idle(\W|$)/i.test(clip.name))
        ?? gltf.animations[0];
      if (idleClip) {
        idleClip.name = 'Idle';
        this.playIdle(gltf.scene, idleClip);
      }

      this.ready = true;
      this.loaded = true;
      this.fallback = false;
      this.root.visible = true;
      return { loaded: true, fallback: false, message: 'Wally is hidden. The search zone is ready.' };
    } catch (error) {
      if (this.disposed) {
        return { loaded: false, fallback: false, message: 'Search closed before Wally finished loading.' };
      }

      this.loadError = this.readError(error);
      this.ready = false;
      this.loaded = false;
      this.fallback = false;
      this.root.visible = false;
      throw new Error(`Wally CharacterBase could not load: ${this.loadError}`);
    } finally {
      dracoLoader.dispose();
    }
  }

  setSpot(position: THREE.Vector3, facingRadians: number): void {
    this.root.position.copy(position);
    this.root.rotation.set(0, facingRadians, 0);
    this.root.updateMatrixWorld(true);
  }

  update(deltaSeconds: number): void {
    this.mixer?.update(deltaSeconds);
  }

  getChestPosition(target: THREE.Vector3): THREE.Vector3 {
    this.root.updateMatrixWorld(true);
    return target.set(0, 1.28, 0).applyMatrix4(this.root.matrixWorld);
  }

  isWallyObject(object: THREE.Object3D): boolean {
    let current: THREE.Object3D | null = object;
    while (current) {
      if (current.userData.isWally === true) return true;
      current = current.parent;
    }
    return false;
  }

  getInteractionTarget(): THREE.Object3D | null {
    return this.interactionProxy;
  }

  isReady(): boolean {
    return this.ready;
  }

  getDiagnostics(): WallyDiagnostics {
    return {
      ready: this.ready,
      loaded: this.loaded,
      fallback: this.fallback,
      position: {
        x: this.root.position.x,
        y: this.root.position.y,
        z: this.root.position.z,
      },
      meshCount: this.meshCount,
      triangles: this.triangles,
      textures: this.textures,
      animation: this.animationName,
      loadError: this.loadError,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.mixer?.stopAllAction();
    this.mixer = null;
    this.interactionProxy = null;
    this.scene.remove(this.root);
    disposeObject3D(this.root);
    this.root.clear();
  }

  private prepareImportedModel(model: THREE.Object3D): void {
    model.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(model);
    const size = bounds.getSize(new THREE.Vector3());
    if (!Number.isFinite(size.y) || size.y < 0.01) {
      throw new Error('The Wally GLB has no usable visible bounds.');
    }

    const scale = TARGET_HEIGHT / size.y;
    model.scale.multiplyScalar(scale);
    model.updateMatrixWorld(true);
    bounds.setFromObject(model);
    const center = bounds.getCenter(new THREE.Vector3());
    model.position.x -= center.x;
    model.position.z -= center.z;
    model.position.y -= bounds.min.y;
    model.updateMatrixWorld(true);

    model.name = model.name || 'WallyCharacterBase';
    model.userData.isWally = true;
    const litMaterials = new Map<THREE.Material, THREE.Material>();
    model.traverse((object) => {
      object.userData.isWally = true;
      if (!(object instanceof THREE.Mesh)) return;
      object.name = object.name || 'WallyMesh';
      const sourceMaterials = Array.isArray(object.material) ? object.material : [object.material];
      const convertedMaterials = sourceMaterials.map((sourceMaterial) => {
        const existing = litMaterials.get(sourceMaterial);
        if (existing) return existing;
        const converted = createLitCharacterMaterial(sourceMaterial);
        litMaterials.set(sourceMaterial, converted);
        return converted;
      });
      object.material = Array.isArray(object.material) ? convertedMaterials : convertedMaterials[0];
      object.castShadow = true;
      object.receiveShadow = true;
      object.frustumCulled = true;
    });
    for (const sourceMaterial of litMaterials.keys()) sourceMaterial.dispose();
  }

  private addInteractionProxy(): void {
    const proxyMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
      colorWrite: false,
    });
    const proxy = new THREE.Mesh(new THREE.BoxGeometry(0.68, 1.82, 0.58), proxyMaterial);
    proxy.name = 'WallyInteractionProxy';
    proxy.position.y = 0.91;
    proxy.userData.isWally = true;
    this.interactionProxy = proxy;
    this.root.add(proxy);
  }

  private playIdle(model: THREE.Object3D, clip: THREE.AnimationClip): void {
    this.mixer = new THREE.AnimationMixer(model);
    const action = this.mixer.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.play();
    this.animationName = clip.name || 'Idle';
  }

  private collectAssetStats(root: THREE.Object3D): void {
    const textureSet = new Set<THREE.Texture>();
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      if (object.name === 'WallyInteractionProxy' || !isEffectivelyVisible(object, root)) return;
      this.meshCount += 1;
      const position = object.geometry.getAttribute('position');
      if (object.geometry.index) this.triangles += object.geometry.index.count / 3;
      else if (position) this.triangles += position.count / 3;

      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        for (const value of Object.values(material as unknown as Record<string, unknown>)) {
          if (value instanceof THREE.Texture) textureSet.add(value);
        }
      }
    });
    this.triangles = Math.round(this.triangles);
    this.textures = textureSet.size;
  }

  private readError(error: unknown): string {
    if (error instanceof Error) return error.message.slice(0, 240);
    return String(error).slice(0, 240);
  }
}

function createLitCharacterMaterial(source: THREE.Material): THREE.Material {
  if (!(source instanceof THREE.MeshStandardMaterial)) return source.clone();
  const material = source.clone();
  material.name = `${source.name || 'CharacterMaterial'}Lit`;
  material.metalness = Math.min(material.metalness, 0.04);
  material.roughness = Math.max(material.roughness, 0.72);
  material.envMapIntensity = 0.8;
  material.toneMapped = true;
  if (material.map) material.map.colorSpace = THREE.SRGBColorSpace;
  return material;
}

function isEffectivelyVisible(object: THREE.Object3D, boundary: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (current === boundary) return true;
    if (!current.visible) return false;
    current = current.parent;
  }
  return true;
}
