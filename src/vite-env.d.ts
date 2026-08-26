/// <reference types="vite/client" />

type ThreeGameState = 'loading' | 'ready' | 'playing' | 'paused' | 'won';

interface ThreeGameTestLocation {
  x: number;
  y: number;
  z: number;
  spotIndex: number;
}

interface ThreeCrowdCharacterTestLocation {
  characterIndex: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  removed: boolean;
}

interface ThreeGameTestHooks {
  start(): void;
  findWally(): ThreeGameTestLocation;
  identifyReticle(): void;
  triggerIdentify(target?: 'wally' | 'wrong', characterIndex?: number): void;
  restart(): void;
  togglePause(): void;
  setupCrowdPush(): ThreeCrowdCharacterTestLocation;
  readCrowdCharacter(characterIndex: number): ThreeCrowdCharacterTestLocation;
}

interface ThreeGameDiagnostics {
  frame: number;
  fps: number;
  frameTimeMs: number;
  state: ThreeGameState;
  game: {
    state: ThreeGameState;
    elapsed: number;
    wrongGuesses: number;
    penaltySeconds: number;
    crowdCount: number;
    remainingCrowdCount: number;
    removedCrowdCount: number;
    requestedCrowdCount: number;
    densityLabel: string;
    seed: number;
    wallySpotIndex: number;
    interactionRange: number;
  };
  player: {
    position: { x: number; y: number; z: number };
    velocity: { x: number; y: number; z: number };
    speed: number;
    sprinting: boolean;
    yaw: number;
    pitch: number;
    collisions: number;
    pointerLocked: boolean;
  };
  input: {
    mode: 'desktop' | 'touch';
    touchMovement: { x: number; y: number };
    touchLooking: boolean;
    autoSprint: boolean;
  };
  wally: {
    ready: boolean;
    loaded: boolean;
    fallback: boolean;
    position: { x: number; y: number; z: number };
    meshCount: number;
    triangles: number;
    textures: number;
    animation: string | null;
    loadError: string | null;
    distanceFromPlayer: number;
  };
  renderer: {
    calls: number;
    triangles: number;
    points: number;
    lines: number;
    geometries: number;
    textures: number;
    programs: number;
  };
  canvas: {
    clientWidth: number;
    clientHeight: number;
    width: number;
    height: number;
    dpr: number;
  };
  crowd: Record<string, number | string | boolean> & { count: number };
  world: Record<string, number>;
  aimAura: {
    visible: boolean;
    targetKind: 'crowd' | 'wally' | 'none';
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
  audio: {
    supported: boolean;
    unlocked: boolean;
    muted: boolean;
    paused: boolean;
    contextState: AudioContextState | 'unavailable';
    ambienceActive: boolean;
  };
  testHooks: ThreeGameTestHooks;
}

interface Window {
  __THREE_GAME_DIAGNOSTICS__?: ThreeGameDiagnostics;
  __THREE_GAME_TEST_HOOKS__?: ThreeGameTestHooks;
}
