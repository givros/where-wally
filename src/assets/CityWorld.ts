import * as THREE from 'three';

export type Aabb2 = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

type InstanceSpec = {
  x: number;
  y: number;
  z: number;
  sx?: number;
  sy?: number;
  sz?: number;
  rx?: number;
  ry?: number;
  rz?: number;
  color?: THREE.ColorRepresentation;
};

type CityWorldResult = {
  bounds: Aabb2;
  blockers: Aabb2[];
  interactionOccluders: THREE.Object3D[];
  spawn: THREE.Vector3;
  wallySpots: THREE.Vector3[];
  diagnostics: Record<string, number>;
  dispose(): void;
};

type CityWorldOptions = {
  crowdCount?: number;
};

const PLAZA_BOUNDS: Aabb2 = {
  minX: -48,
  maxX: 48,
  minZ: -34,
  maxZ: 34,
};

const PLAZA_WIDTH = PLAZA_BOUNDS.maxX - PLAZA_BOUNDS.minX;
const PLAZA_DEPTH = PLAZA_BOUNDS.maxZ - PLAZA_BOUNDS.minZ;

/** Builds a large, enclosed festival district from a small shared procedural kit. */
export function createCityWorld(
  scene: THREE.Scene,
  options: CityWorldOptions = {},
): CityWorldResult {
  if ((options.crowdCount ?? 0) >= 100_000) return createMillionCityWorld(scene);
  const root = new THREE.Group();
  root.name = 'enclosed-festival-city';
  scene.add(root);

  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  let totalInstances = 0;
  let instancedMeshCount = 0;

  const ownGeometry = <T extends THREE.BufferGeometry>(geometry: T): T => {
    geometries.add(geometry);
    return geometry;
  };

  const ownMaterial = <T extends THREE.Material>(material: T): T => {
    materials.add(material);
    return material;
  };

  const unitBox = ownGeometry(new THREE.BoxGeometry(1, 1, 1));
  const unitCylinder = ownGeometry(new THREE.CylinderGeometry(1, 1, 1, 8));
  const unitSphere = ownGeometry(new THREE.SphereGeometry(1, 8, 5));
  const unitCone = ownGeometry(new THREE.ConeGeometry(1, 1, 8));
  const flagGeometry = ownGeometry(createFlagGeometry());

  const groundMaterial = ownMaterial(
    new THREE.MeshStandardMaterial({ color: '#707971', roughness: 0.94, metalness: 0.01 }),
  );
  const paverMaterial = ownMaterial(
    new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.93, metalness: 0.01 }),
  );
  const facadeMaterial = ownMaterial(
    new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.82, metalness: 0.01 }),
  );
  const insetMaterial = ownMaterial(
    new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.76, metalness: 0.02 }),
  );
  const windowMaterial = ownMaterial(
    new THREE.MeshStandardMaterial({
      color: '#ffffff',
      roughness: 0.24,
      metalness: 0.22,
      emissive: '#102c38',
      emissiveIntensity: 0.45,
    }),
  );
  const trimMaterial = ownMaterial(
    new THREE.MeshStandardMaterial({ color: '#ece5d3', roughness: 0.58, metalness: 0.08 }),
  );
  const darkMaterial = ownMaterial(
    new THREE.MeshStandardMaterial({ color: '#39474a', roughness: 0.62, metalness: 0.12 }),
  );
  const timberMaterial = ownMaterial(
    new THREE.MeshStandardMaterial({ color: '#6f4935', roughness: 0.86, metalness: 0.01 }),
  );
  const accentMaterial = ownMaterial(
    new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.6, metalness: 0.04 }),
  );
  const lampMaterial = ownMaterial(
    new THREE.MeshStandardMaterial({
      color: '#fff4b8',
      emissive: '#ffc956',
      emissiveIntensity: 2.4,
      roughness: 0.28,
      metalness: 0.04,
    }),
  );
  const foliageMaterial = ownMaterial(
    new THREE.MeshStandardMaterial({ color: '#406c4d', roughness: 0.9, metalness: 0.01 }),
  );
  const flagMaterial = ownMaterial(
    new THREE.MeshStandardMaterial({
      color: '#ffffff',
      roughness: 0.72,
      metalness: 0.01,
      side: THREE.DoubleSide,
    }),
  );

  const makeInstances = (
    name: string,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    specs: InstanceSpec[],
    castShadow = false,
    receiveShadow = true,
  ): THREE.InstancedMesh => {
    const mesh = new THREE.InstancedMesh(geometry, material, specs.length);
    mesh.name = name;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);

    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();
    let hasInstanceColor = false;

    specs.forEach((spec, index) => {
      position.set(spec.x, spec.y, spec.z);
      scale.set(spec.sx ?? 1, spec.sy ?? 1, spec.sz ?? 1);
      euler.set(spec.rx ?? 0, spec.ry ?? 0, spec.rz ?? 0);
      quaternion.setFromEuler(euler);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(index, matrix);
      if (spec.color !== undefined) {
        color.set(spec.color);
        mesh.setColorAt(index, color);
        hasInstanceColor = true;
      }
    });

    mesh.instanceMatrix.needsUpdate = true;
    if (hasInstanceColor && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    root.add(mesh);
    totalInstances += specs.length;
    instancedMeshCount += 1;
    return mesh;
  };

  makeInstances(
    'plaza-ground',
    unitBox,
    groundMaterial,
    [{ x: 0, y: -0.1, z: 0, sx: PLAZA_WIDTH + 0.4, sy: 0.2, sz: PLAZA_DEPTH + 0.4 }],
    false,
    true,
  );

  const pavers: InstanceSpec[] = [];
  const paverColors = ['#7d867d', '#727b73', '#899087', '#69756f'];
  const paverColumns = Math.ceil(PLAZA_WIDTH / 1.25);
  const paverRows = Math.ceil(PLAZA_DEPTH / 1.2);
  for (let row = 0; row < paverRows; row += 1) {
    for (let column = 0; column < paverColumns; column += 1) {
      pavers.push({
        x: PLAZA_BOUNDS.minX + 0.65 + column * 1.25 + (row % 2) * 0.22,
        y: 0.012,
        z: PLAZA_BOUNDS.minZ + 0.8 + row * 1.2,
        sx: 1.16,
        sy: 0.024,
        sz: 1.1,
        color: paverColors[(row * 3 + column) % paverColors.length],
      });
    }
  }
  makeInstances('ground-paver-detail', unitBox, paverMaterial, pavers);

  const floorMarkings: InstanceSpec[] = [
    { x: 0, y: 0.034, z: 0, sx: 0.1, sy: 0.014, sz: 54, color: '#c7ae64' },
    { x: -23, y: 0.034, z: 28.4, sx: 20, sy: 0.014, sz: 0.08, color: '#7da39a' },
    { x: 23, y: 0.034, z: 28.4, sx: 20, sy: 0.014, sz: 0.08, color: '#7da39a' },
  ];
  makeInstances('plaza-wayfinding-inlays', unitBox, accentMaterial, floorMarkings);

  const blockers: Aabb2[] = [
    { minX: -48, maxX: 48, minZ: -34, maxZ: -33.12 },
    { minX: -48, maxX: 48, minZ: 33.12, maxZ: 34 },
    { minX: -48, maxX: -47.12, minZ: -34, maxZ: 34 },
    { minX: 47.12, maxX: 48, minZ: -34, maxZ: 34 },
  ];

  const buildingShells: InstanceSpec[] = [];
  const facadeInsets: InstanceSpec[] = [];
  const windows: InstanceSpec[] = [];
  const cornices: InstanceSpec[] = [];
  const doors: InstanceSpec[] = [];
  const facadeBanners: InstanceSpec[] = [];
  const buildingPalette = ['#b96855', '#d69c5b', '#8ea185', '#72949e', '#9c829a', '#b3a071', '#767f8a'];
  const insetPalette = ['#9e5145', '#bf7e46', '#74896f', '#5b7c89', '#846b84', '#958458', '#606b76'];
  const windowPalette = ['#8ad1d2', '#9bc4d8', '#d8c47f', '#7aa7b8'];

  const addHorizontalFacade = (north: boolean, index: number, x: number, width: number, height: number): void => {
    const depth = 3.2;
    const z = north ? 35.18 : -35.18;
    const frontZ = north ? 33.56 : -33.56;
    buildingShells.push({
      x,
      y: height / 2,
      z,
      sx: width,
      sy: height,
      sz: depth,
      color: buildingPalette[index % buildingPalette.length],
    });
    facadeInsets.push({
      x,
      y: height / 2,
      z: frontZ + (north ? -0.035 : 0.035),
      sx: width - 0.28,
      sy: height - 0.38,
      sz: 0.08,
      color: insetPalette[index % insetPalette.length],
    });
    cornices.push({
      x,
      y: height - 0.28,
      z: frontZ + (north ? -0.1 : 0.1),
      sx: width + 0.2,
      sy: 0.18,
      sz: 0.2,
      color: index % 3 === 0 ? '#ede3cc' : '#323c40',
    });

    const windowColumns = Math.max(2, Math.floor(width / 0.9));
    const windowRows = Math.max(2, Math.floor((height - 1.5) / 1.25));
    for (let row = 0; row < windowRows; row += 1) {
      for (let column = 0; column < windowColumns; column += 1) {
        const windowX = x - (windowColumns - 1) * 0.39 + column * 0.78;
        windows.push({
          x: windowX,
          y: 1.75 + row * 1.18,
          z: frontZ + (north ? -0.085 : 0.085),
          sx: 0.52,
          sy: 0.62,
          sz: 0.055,
          color: windowPalette[(index + row + column) % windowPalette.length],
        });
      }
    }
    doors.push({
      x,
      y: 0.8,
      z: frontZ + (north ? -0.1 : 0.1),
      sx: 0.72,
      sy: 1.52,
      sz: 0.08,
      color: '#273236',
    });
    if (index % 2 === 0) {
      facadeBanners.push({
        x: x + width * 0.3,
        y: Math.min(height - 1.5, 3.8),
        z: frontZ + (north ? -0.14 : 0.14),
        sx: 0.55,
        sy: 2.0,
        sz: 0.055,
        color: index % 4 === 0 ? '#e4af45' : '#3a918b',
      });
    }
  };

  const addVerticalFacade = (east: boolean, index: number, z: number, width: number, height: number): void => {
    const depth = 3.2;
    const x = east ? 49.18 : -49.18;
    const frontX = east ? 47.56 : -47.56;
    buildingShells.push({
      x,
      y: height / 2,
      z,
      sx: depth,
      sy: height,
      sz: width,
      color: buildingPalette[(index + 3) % buildingPalette.length],
    });
    facadeInsets.push({
      x: frontX + (east ? -0.035 : 0.035),
      y: height / 2,
      z,
      sx: 0.08,
      sy: height - 0.38,
      sz: width - 0.28,
      color: insetPalette[(index + 3) % insetPalette.length],
    });
    cornices.push({
      x: frontX + (east ? -0.1 : 0.1),
      y: height - 0.28,
      z,
      sx: 0.2,
      sy: 0.18,
      sz: width + 0.2,
      color: index % 2 === 0 ? '#ede3cc' : '#323c40',
    });

    const windowColumns = Math.max(2, Math.floor(width / 0.9));
    const windowRows = Math.max(2, Math.floor((height - 1.5) / 1.25));
    for (let row = 0; row < windowRows; row += 1) {
      for (let column = 0; column < windowColumns; column += 1) {
        const windowZ = z - (windowColumns - 1) * 0.39 + column * 0.78;
        windows.push({
          x: frontX + (east ? -0.085 : 0.085),
          y: 1.75 + row * 1.18,
          z: windowZ,
          sx: 0.055,
          sy: 0.62,
          sz: 0.52,
          color: windowPalette[(index + row + column + 1) % windowPalette.length],
        });
      }
    }
    doors.push({
      x: frontX + (east ? -0.1 : 0.1),
      y: 0.8,
      z,
      sx: 0.08,
      sy: 1.52,
      sz: 0.72,
      color: '#273236',
    });
  };

  const horizontalModuleCount = Math.ceil(PLAZA_WIDTH / 4.2);
  const horizontalStep = PLAZA_WIDTH / horizontalModuleCount;
  const horizontalCenters = Array.from(
    { length: horizontalModuleCount },
    (_, index) => PLAZA_BOUNDS.minX + horizontalStep * (index + 0.5),
  );
  const horizontalWidths = horizontalCenters.map(() => horizontalStep - 0.08);
  horizontalCenters.forEach((x, index) => {
    addHorizontalFacade(true, index, x, horizontalWidths[index], 5.8 + ((index * 7) % 4) * 0.85);
    addHorizontalFacade(false, index + 2, x, horizontalWidths[index], 6.25 + ((index * 5) % 4) * 0.78);
  });
  const verticalModuleCount = Math.ceil(PLAZA_DEPTH / 4.1);
  const verticalStep = PLAZA_DEPTH / verticalModuleCount;
  const verticalCenters = Array.from(
    { length: verticalModuleCount },
    (_, index) => PLAZA_BOUNDS.minZ + verticalStep * (index + 0.5),
  );
  verticalCenters.forEach((z, index) => {
    addVerticalFacade(true, index, z, verticalStep - 0.08, 6.1 + ((index * 3) % 4) * 0.82);
    addVerticalFacade(false, index + 1, z, verticalStep - 0.08, 5.7 + ((index * 5) % 4) * 0.88);
  });

  makeInstances('modular-building-shells', unitBox, facadeMaterial, buildingShells, true, true);
  makeInstances('facade-inset-panels', unitBox, insetMaterial, facadeInsets, false, true);
  makeInstances('facade-window-grid', unitBox, windowMaterial, windows, false, false);
  makeInstances('facade-cornice-trim', unitBox, trimMaterial, cornices, true, true);
  makeInstances('facade-doors', unitBox, darkMaterial, doors, false, true);
  makeInstances('facade-festival-banners', unitBox, accentMaterial, facadeBanners, false, true);

  const stallCounters: InstanceSpec[] = [];
  const stallCanopies: InstanceSpec[] = [];
  const stallPosts: InstanceSpec[] = [];
  const stallSigns: InstanceSpec[] = [];
  const stallColors = ['#e1a63d', '#438b88', '#bb6d4d', '#6e76a7', '#84a35e', '#c17d9a'];
  const stallZ = [-24, -16, -8, 0, 8, 16, 24];
  let stallCount = 0;

  const addStall = (east: boolean, z: number, color: string): void => {
    const x = east ? 44.4 : -44.4;
    stallCounters.push({ x, y: 0.52, z, sx: 1.55, sy: 1.0, sz: 2.3, color: '#76513c' });
    stallCanopies.push({ x, y: 2.24, z, sx: 2.0, sy: 0.18, sz: 2.72, color });
    for (const postX of [-0.72, 0.72]) {
      for (const postZ of [-1.04, 1.04]) {
        stallPosts.push({ x: x + postX, y: 1.33, z: z + postZ, sx: 0.09, sy: 1.7, sz: 0.09 });
      }
    }
    stallSigns.push({
      x: east ? x - 0.82 : x + 0.82,
      y: 1.55,
      z,
      sx: 0.08,
      sy: 0.58,
      sz: 1.35,
      color,
    });
    blockers.push({
      minX: x - 0.96,
      maxX: x + 0.96,
      minZ: z - 1.38,
      maxZ: z + 1.38,
    });
    stallCount += 1;
  };

  stallZ.forEach((z, index) => {
    addStall(false, z, stallColors[index % stallColors.length]);
    addStall(true, z, stallColors[(index + 3) % stallColors.length]);
  });
  makeInstances('market-stall-counters', unitBox, timberMaterial, stallCounters, true, true);
  makeInstances('market-stall-canopies', unitBox, accentMaterial, stallCanopies, true, true);
  makeInstances('market-stall-posts', unitBox, darkMaterial, stallPosts, true, true);
  makeInstances('market-stall-signboards', unitBox, accentMaterial, stallSigns, false, true);

  const stageParts: InstanceSpec[] = [
    { x: 0, y: 0.36, z: -30.5, sx: 18.4, sy: 0.72, sz: 4.8, color: '#30393c' },
    { x: 0, y: 2.15, z: -33.0, sx: 17.6, sy: 2.8, sz: 0.16, color: '#2b4852' },
    { x: 0, y: 4.05, z: -30.55, sx: 18.8, sy: 0.28, sz: 5.15, color: '#293336' },
    { x: 0, y: 2.45, z: -32.82, sx: 10.6, sy: 1.25, sz: 0.1, color: '#d0a347' },
  ];
  const stageTruss: InstanceSpec[] = [];
  for (const x of [-9.05, 9.05]) {
    for (const z of [-32.85, -28.15]) {
      stageTruss.push({ x, y: 2.25, z, sx: 0.16, sy: 3.6, sz: 0.16 });
    }
  }
  const stageSpeakers: InstanceSpec[] = [];
  for (const x of [-7.8, 7.8]) {
    for (let level = 0; level < 3; level += 1) {
      stageSpeakers.push({
        x,
        y: 0.88 + level * 0.62,
        z: -27.95,
        sx: 0.72,
        sy: 0.54,
        sz: 0.62,
        rz: x < 0 ? -0.045 : 0.045,
      });
    }
  }
  makeInstances('festival-stage', unitBox, accentMaterial, stageParts, true, true);
  makeInstances('stage-truss', unitBox, darkMaterial, stageTruss, true, true);
  makeInstances('stage-speaker-stacks', unitBox, darkMaterial, stageSpeakers, false, true);
  blockers.push({ minX: -9.35, maxX: 9.35, minZ: -33.2, maxZ: -27.62 });

  const lampPositions: Array<[number, number]> = [];
  for (const z of [-26, -19.5, -13, -6.5, 0, 6.5, 13, 19.5, 26]) {
    lampPositions.push([-41.2, z], [41.2, z]);
  }
  for (const x of [-36, -28, -20, -12, -4, 4, 12, 20, 28, 36]) lampPositions.push([x, 29.2]);
  const lampPoles: InstanceSpec[] = [];
  const lampHeads: InstanceSpec[] = [];
  const lampShades: InstanceSpec[] = [];
  lampPositions.forEach(([x, z]) => {
    lampPoles.push({ x, y: 1.42, z, sx: 0.065, sy: 2.82, sz: 0.065 });
    lampHeads.push({ x, y: 2.94, z, sx: 0.15, sy: 0.15, sz: 0.15 });
    lampShades.push({ x, y: 3.08, z, sx: 0.28, sy: 0.22, sz: 0.28 });
    blockers.push({ minX: x - 0.09, maxX: x + 0.09, minZ: z - 0.09, maxZ: z + 0.09 });
  });
  makeInstances('festival-lamp-posts', unitCylinder, darkMaterial, lampPoles, true, true);
  makeInstances('festival-lamp-globes', unitSphere, lampMaterial, lampHeads, false, false);
  makeInstances('festival-lamp-shades', unitCone, darkMaterial, lampShades, false, true);

  const bannerWires: InstanceSpec[] = [];
  const flags: InstanceSpec[] = [];
  const flagColors = ['#e7b242', '#3d9690', '#c36b50', '#6a79aa', '#83a65b'];
  for (const [wireIndex, z] of [-18, -2, 14].entries()) {
    bannerWires.push({ x: 0, y: 4.2, z, sx: 90, sy: 0.025, sz: 0.025 });
    for (let flagIndex = 0; flagIndex < 92; flagIndex += 1) {
      flags.push({
        x: -44.6 + flagIndex * 0.98,
        y: 4.18,
        z,
        sx: 0.78,
        sy: 0.78,
        sz: 0.78,
        ry: wireIndex % 2 === 0 ? 0 : Math.PI,
        color: flagColors[(wireIndex * 2 + flagIndex) % flagColors.length],
      });
    }
  }
  makeInstances('overhead-banner-wires', unitBox, darkMaterial, bannerWires, false, false);
  makeInstances('overhead-festival-flags', flagGeometry, flagMaterial, flags, false, false);

  const planterBases: InstanceSpec[] = [];
  const planterFoliage: InstanceSpec[] = [];
  const planterLocations: Array<[number, number]> = [
    [-38, -29],
    [38, -29],
    [-38, 29],
    [38, 29],
    [-22, -29],
    [22, -29],
    [-22, 29],
    [22, 29],
  ];
  planterLocations.forEach(([x, z], index) => {
    planterBases.push({ x, y: 0.3, z, sx: 0.82, sy: 0.6, sz: 0.82, color: '#7b6850' });
    planterFoliage.push({
      x,
      y: 0.88,
      z,
      sx: 0.52,
      sy: 0.68,
      sz: 0.52,
      color: index % 2 === 0 ? '#4f7d54' : '#5c8755',
    });
    blockers.push({ minX: x - 0.52, maxX: x + 0.52, minZ: z - 0.52, maxZ: z + 0.52 });
  });
  makeInstances('plaza-planters', unitBox, timberMaterial, planterBases, true, true);
  makeInstances('plaza-planter-foliage', unitSphere, foliageMaterial, planterFoliage, false, true);

  const drainCovers: InstanceSpec[] = [];
  for (const x of [-36, -27, -18, -9, 9, 18, 27, 36]) {
    drainCovers.push({ x, y: 0.045, z: -10, sx: 0.2, sy: 0.025, sz: 0.2 });
    drainCovers.push({ x, y: 0.045, z: 11, sx: 0.2, sy: 0.025, sz: 0.2 });
  }
  makeInstances('ground-drain-covers', unitCylinder, darkMaterial, drainCovers, false, true);

  const spawn = new THREE.Vector3(0, 0.04, 29.4);
  const wallySpots = [
    new THREE.Vector3(-35, 0.04, -22),
    new THREE.Vector3(-18, 0.04, -18),
    new THREE.Vector3(1, 0.04, -22),
    new THREE.Vector3(21, 0.04, -18),
    new THREE.Vector3(35, 0.04, -23),
    new THREE.Vector3(-34, 0.04, -2),
    new THREE.Vector3(-15, 0.04, 5),
    new THREE.Vector3(4, 0.04, -1),
    new THREE.Vector3(23, 0.04, 7),
    new THREE.Vector3(36, 0.04, 2),
    new THREE.Vector3(-29, 0.04, 22),
    new THREE.Vector3(-8, 0.04, 24),
    new THREE.Vector3(14, 0.04, 21),
    new THREE.Vector3(31, 0.04, 23),
  ];

  let meshCount = 0;
  root.traverse((object) => {
    if ((object as THREE.Mesh).isMesh) meshCount += 1;
  });

  const diagnostics: Record<string, number> = {
    meshCount,
    instancedMeshCount,
    estimatedDrawCalls: meshCount,
    totalInstances,
    uniqueGeometries: geometries.size,
    uniqueMaterials: materials.size,
    blockers: blockers.length,
    buildingModules: buildingShells.length,
    facadeWindows: windows.length,
    stalls: stallCount,
    stageParts: stageParts.length + stageTruss.length + stageSpeakers.length,
    lamps: lampPositions.length,
    banners: facadeBanners.length + flags.length,
    groundDetails: pavers.length + floorMarkings.length + drainCovers.length,
    wallySpots: wallySpots.length,
  };

  // Identification rays only need the substantial geometry that can truly
  // block a sightline. Keeping this list explicit avoids testing decorative
  // windows, pavers and flags while preserving real stalls, stage pieces and
  // the enclosing buildings as finite-height occluders.
  const interactionOccluderNames = new Set([
    'modular-building-shells',
    'market-stall-counters',
    'market-stall-canopies',
    'market-stall-posts',
    'festival-stage',
    'stage-truss',
    'stage-speaker-stacks',
    'festival-lamp-posts',
    'plaza-planters',
    'plaza-planter-foliage',
  ]);
  const interactionOccluders = root.children.filter((object) =>
    interactionOccluderNames.has(object.name),
  );
  diagnostics.interactionOccluders = interactionOccluders.length;

  let disposed = false;
  return {
    bounds: { ...PLAZA_BOUNDS },
    blockers: blockers.map((blocker) => ({ ...blocker })),
    interactionOccluders,
    spawn: spawn.clone(),
    wallySpots: wallySpots.map((spot) => spot.clone()),
    diagnostics,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      scene.remove(root);
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((material) => material.dispose());
      root.clear();
    },
  };
}

function createMillionCityWorld(scene: THREE.Scene): CityWorldResult {
  const bounds: Aabb2 = { minX: -480, maxX: 480, minZ: -340, maxZ: 340 };
  const root = new THREE.Group();
  root.name = 'million-character-enclosed-festival-city';
  scene.add(root);

  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  let totalInstances = 0;
  let instancedMeshCount = 0;
  const ownGeometry = <T extends THREE.BufferGeometry>(geometry: T): T => {
    geometries.add(geometry);
    return geometry;
  };
  const ownMaterial = <T extends THREE.Material>(material: T): T => {
    materials.add(material);
    return material;
  };
  const unitBox = ownGeometry(new THREE.BoxGeometry(1, 1, 1));
  const unitCylinder = ownGeometry(new THREE.CylinderGeometry(1, 1, 1, 8));
  const unitSphere = ownGeometry(new THREE.SphereGeometry(1, 8, 5));
  const flagGeometry = ownGeometry(createFlagGeometry());
  const groundMaterial = ownMaterial(
    new THREE.MeshStandardMaterial({ color: '#78847b', roughness: 0.95, metalness: 0 }),
  );
  const paverMaterial = ownMaterial(
    new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.92, metalness: 0.01 }),
  );
  const facadeMaterial = ownMaterial(
    new THREE.MeshStandardMaterial({ color: '#d79a6f', roughness: 0.82, metalness: 0.01 }),
  );
  const windowMaterial = ownMaterial(
    new THREE.MeshStandardMaterial({
      color: '#b9e5ef',
      emissive: '#173e4c',
      emissiveIntensity: 0.65,
      roughness: 0.32,
      metalness: 0.1,
    }),
  );
  const accentMaterial = ownMaterial(
    new THREE.MeshStandardMaterial({ color: '#f0c54f', roughness: 0.66, metalness: 0.03 }),
  );
  const darkMaterial = ownMaterial(
    new THREE.MeshStandardMaterial({ color: '#32474b', roughness: 0.68, metalness: 0.08 }),
  );
  const lampMaterial = ownMaterial(
    new THREE.MeshStandardMaterial({
      color: '#fff3ad',
      emissive: '#ffc84f',
      emissiveIntensity: 2.1,
      roughness: 0.28,
    }),
  );
  const flagMaterial = ownMaterial(
    new THREE.MeshStandardMaterial({ color: '#e84a42', roughness: 0.72, side: THREE.DoubleSide }),
  );

  const makeInstances = (
    name: string,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    specs: InstanceSpec[],
    castShadow = false,
    receiveShadow = true,
  ): THREE.InstancedMesh => {
    const mesh = new THREE.InstancedMesh(geometry, material, specs.length);
    mesh.name = name;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();
    let hasColor = false;
    specs.forEach((spec, index) => {
      position.set(spec.x, spec.y, spec.z);
      scale.set(spec.sx ?? 1, spec.sy ?? 1, spec.sz ?? 1);
      euler.set(spec.rx ?? 0, spec.ry ?? 0, spec.rz ?? 0);
      quaternion.setFromEuler(euler);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(index, matrix);
      if (spec.color !== undefined) {
        mesh.setColorAt(index, color.set(spec.color));
        hasColor = true;
      }
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (hasColor && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    root.add(mesh);
    totalInstances += specs.length;
    instancedMeshCount += 1;
    return mesh;
  };

  makeInstances(
    'million-plaza-ground',
    unitBox,
    groundMaterial,
    [{ x: 0, y: -0.12, z: 0, sx: 961, sy: 0.24, sz: 681 }],
  );

  const pavers: InstanceSpec[] = [];
  const paverColumns = 120;
  const paverRows = 85;
  const paverWidth = 958 / paverColumns;
  const paverDepth = 678 / paverRows;
  const paverColors = ['#7b867d', '#849087', '#707c75', '#8b948b'];
  for (let row = 0; row < paverRows; row += 1) {
    for (let column = 0; column < paverColumns; column += 1) {
      pavers.push({
        x: bounds.minX + 1 + (column + 0.5) * paverWidth,
        y: 0.012,
        z: bounds.minZ + 1 + (row + 0.5) * paverDepth,
        sx: paverWidth - 0.08,
        sy: 0.022,
        sz: paverDepth - 0.08,
        color: paverColors[(row * 5 + column * 3) % paverColors.length],
      });
    }
  }
  makeInstances('million-ground-paver-detail', unitBox, paverMaterial, pavers);

  const buildingShells: InstanceSpec[] = [];
  const buildingWindows: InstanceSpec[] = [];
  const horizontalModules = 80;
  const verticalModules = 56;
  for (let index = 0; index < horizontalModules; index += 1) {
    const x = bounds.minX + 6 + index * 12;
    for (const z of [bounds.minZ + 3.2, bounds.maxZ - 3.2]) {
      const height = 8 + ((index * 7) % 5) * 1.35;
      buildingShells.push({ x, y: height * 0.5, z, sx: 11.4, sy: height, sz: 6.2 });
      buildingWindows.push({ x, y: Math.min(4.2, height - 1), z: z + (z < 0 ? 3.13 : -3.13), sx: 7.4, sy: 1.4, sz: 0.08 });
    }
  }
  for (let index = 0; index < verticalModules; index += 1) {
    const z = bounds.minZ + 6 + index * 12;
    for (const x of [bounds.minX + 3.2, bounds.maxX - 3.2]) {
      const height = 8.5 + ((index * 11) % 5) * 1.2;
      buildingShells.push({ x, y: height * 0.5, z, sx: 6.2, sy: height, sz: 11.4 });
      buildingWindows.push({ x: x + (x < 0 ? 3.13 : -3.13), y: Math.min(4.4, height - 1), z, sx: 0.08, sy: 1.4, sz: 7.4 });
    }
  }
  makeInstances('million-enclosing-buildings', unitBox, facadeMaterial, buildingShells, false, true);
  makeInstances('million-building-window-bands', unitBox, windowMaterial, buildingWindows, false, true);

  const blockers: Aabb2[] = [
    { minX: -480, maxX: -474, minZ: -340, maxZ: 340 },
    { minX: 474, maxX: 480, minZ: -340, maxZ: 340 },
    { minX: -480, maxX: 480, minZ: -340, maxZ: -334 },
    { minX: -480, maxX: 480, minZ: 334, maxZ: 340 },
    { minX: -28, maxX: 28, minZ: -333.5, maxZ: -324 },
  ];

  const stageParts: InstanceSpec[] = [
    { x: 0, y: 0.7, z: -329, sx: 56, sy: 1.4, sz: 10 },
    { x: 0, y: 8.1, z: -334, sx: 58, sy: 1.2, sz: 1.2 },
    { x: -27.2, y: 4.2, z: -332, sx: 1.2, sy: 8.4, sz: 1.2 },
    { x: 27.2, y: 4.2, z: -332, sx: 1.2, sy: 8.4, sz: 1.2 },
  ];
  makeInstances('million-festival-stage', unitBox, darkMaterial, stageParts, true, true);

  const stallBodies: InstanceSpec[] = [];
  const stallCanopies: InstanceSpec[] = [];
  for (const side of [-1, 1]) {
    for (let row = 0; row < 15; row += 1) {
      const z = -292 + row * 41.5;
      const x = side * (row % 2 === 0 ? 442 : 453);
      const width = 11;
      stallBodies.push({ x, y: 1.05, z, sx: width, sy: 2.1, sz: 6.4 });
      stallCanopies.push({ x, y: 2.7, z, sx: width + 0.8, sy: 0.25, sz: 7.1 });
      blockers.push({ minX: x - width * 0.5, maxX: x + width * 0.5, minZ: z - 3.2, maxZ: z + 3.2 });
    }
  }
  makeInstances('million-market-stalls', unitBox, facadeMaterial, stallBodies, false, true);
  makeInstances('million-market-canopies', unitBox, accentMaterial, stallCanopies, false, true);

  const pylonPoles: InstanceSpec[] = [];
  const pylonLights: InstanceSpec[] = [];
  const pylonFlags: InstanceSpec[] = [];
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 6; column += 1) {
      const x = -305 + column * 122;
      const z = -215 + row * 142;
      pylonPoles.push({ x, y: 2.7, z, sx: 0.13, sy: 5.4, sz: 0.13 });
      pylonLights.push({ x, y: 5.55, z, sx: 0.32, sy: 0.32, sz: 0.32 });
      pylonFlags.push({ x: x + 0.34, y: 4.8, z, ry: column % 2 === 0 ? 0 : Math.PI, sx: 1.7, sy: 1.7, sz: 1.7 });
      blockers.push({ minX: x - 1.2, maxX: x + 1.2, minZ: z - 1.2, maxZ: z + 1.2 });
    }
  }
  makeInstances('million-wayfinding-pylons', unitCylinder, darkMaterial, pylonPoles, false, true);
  makeInstances('million-wayfinding-lights', unitSphere, lampMaterial, pylonLights, false, true);
  makeInstances('million-wayfinding-flags', flagGeometry, flagMaterial, pylonFlags, false, false);

  const routeMarkings: InstanceSpec[] = [];
  for (let z = -280; z <= 280; z += 80) {
    routeMarkings.push({ x: 0, y: 0.04, z, sx: 1.4, sy: 0.03, sz: 20 });
  }
  for (let x = -400; x <= 400; x += 100) {
    routeMarkings.push({ x, y: 0.04, z: 0, sx: 20, sy: 0.03, sz: 1.4 });
  }
  makeInstances('million-route-markings', unitBox, accentMaterial, routeMarkings, false, true);

  const spawn = new THREE.Vector3(0, 0.04, 329);
  const wallySpots = [
    new THREE.Vector3(-402, 0.04, -292),
    new THREE.Vector3(-245, 0.04, -280),
    new THREE.Vector3(-75, 0.04, -305),
    new THREE.Vector3(152, 0.04, -286),
    new THREE.Vector3(395, 0.04, -274),
    new THREE.Vector3(-420, 0.04, -86),
    new THREE.Vector3(-212, 0.04, -62),
    new THREE.Vector3(18, 0.04, -94),
    new THREE.Vector3(238, 0.04, -55),
    new THREE.Vector3(425, 0.04, -78),
    new THREE.Vector3(-366, 0.04, 154),
    new THREE.Vector3(-128, 0.04, 116),
    new THREE.Vector3(126, 0.04, 167),
    new THREE.Vector3(378, 0.04, 132),
  ];

  const interactionOccluderNames = new Set([
    'million-enclosing-buildings',
    'million-festival-stage',
    'million-market-stalls',
    'million-market-canopies',
    'million-wayfinding-pylons',
  ]);
  const interactionOccluders = root.children.filter((object) =>
    interactionOccluderNames.has(object.name),
  );
  let meshCount = 0;
  root.traverse((object) => {
    if ((object as THREE.Mesh).isMesh) meshCount += 1;
  });
  const diagnostics: Record<string, number> = {
    meshCount,
    instancedMeshCount,
    estimatedDrawCalls: meshCount,
    totalInstances,
    uniqueGeometries: geometries.size,
    uniqueMaterials: materials.size,
    blockers: blockers.length,
    buildingModules: buildingShells.length,
    facadeWindows: buildingWindows.length,
    stalls: stallBodies.length,
    stageParts: stageParts.length,
    lamps: pylonLights.length,
    banners: pylonFlags.length,
    groundDetails: pavers.length + routeMarkings.length,
    wallySpots: wallySpots.length,
    interactionOccluders: interactionOccluders.length,
    megaCity: 1,
  };

  let disposed = false;
  return {
    bounds: { ...bounds },
    blockers: blockers.map((blocker) => ({ ...blocker })),
    interactionOccluders,
    spawn: spawn.clone(),
    wallySpots: wallySpots.map((spot) => spot.clone()),
    diagnostics,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      scene.remove(root);
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((material) => material.dispose());
      root.clear();
    },
  };
}

function createFlagGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([-0.28, 0, 0, 0.28, 0, 0, 0, -0.62, 0], 3),
  );
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 0.5, 0], 2));
  geometry.setIndex([0, 1, 2]);
  geometry.computeVertexNormals();
  return geometry;
}
