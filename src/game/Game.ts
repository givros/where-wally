import * as THREE from 'three';
import { createCityWorld } from '../assets/CityWorld';
import { CrowdSystem } from '../assets/CrowdSystem';
import { InputController, prefersTouchInput } from '../core/InputController';
import { Loop } from '../core/Loop';
import { createRenderer, resizeRenderer } from '../core/Renderer';
import { FirstPersonPlayer } from '../entities/FirstPersonPlayer';
import { Wally } from '../entities/Wally';
import { AimAura, type AimAuraTargetKind } from '../systems/AimAura';
import { AudioSystem } from '../systems/AudioSystem';
import { CollisionSystem } from '../systems/CollisionSystem';
import { findCrowdHit, type CrowdHit } from '../systems/CrowdPicker';
import { CrowdPushSystem } from '../systems/CrowdPushSystem';
import { LocalizedCrowdPushSystem } from '../systems/LocalizedCrowdPushSystem';
import { Hud, type GameUiState } from '../systems/Hud';

const ACTIVE_CROWD_COUNT = 1_000_000;
const DEFAULT_SEED = 7_331;
const WRONG_GUESS_PENALTY = 5;
const INTERACTION_RANGE = 10.5;
const CROWD_SELECTION_RADIUS = 0.3;
const CROWD_SELECTION_HEIGHTS = [1.08, 1.48] as const;
const SPAWN_CLEAR_RADIUS = 0.85;
const WALLY_CLEAR_RADIUS = 0.42;
const IDENTIFICATION_EPSILON = 0.08;

type IdentificationHits = {
  wallyDistance: number | null;
  crowdDistance: number | null;
  crowdIndex: number | null;
  worldDistance: number | null;
};

type IdentificationResolution = {
  kind: AimAuraTargetKind | 'blocked' | 'none';
  crowdIndex: number | null;
  distance: number | null;
};

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(69, 1, 0.05, 110);
  private readonly raycaster = new THREE.Raycaster();
  private readonly rayCenter = new THREE.Vector2(0, 0);
  private readonly targetPoint = new THREE.Vector3();
  private readonly aimCharacterMatrix = new THREE.Matrix4();
  private readonly nearbyCandidate = new THREE.Vector3();
  private readonly previousPlayerPosition = new THREE.Vector3();
  private readonly crowdHit: CrowdHit = { distance: 0, characterIndex: -1 };
  private readonly identificationHits: IdentificationHits = {
    wallyDistance: null,
    crowdDistance: null,
    crowdIndex: null,
    worldDistance: null,
  };
  private readonly identificationResolution: IdentificationResolution = {
    kind: 'none',
    crowdIndex: null,
    distance: null,
  };
  private readonly crowdCount: number;
  private readonly densityLabel: string;
  private readonly seed: number;
  private readonly maxDpr: number;
  private readonly world: ReturnType<typeof createCityWorld>;
  private readonly crowd: CrowdSystem;
  private readonly crowdPush: CrowdPushSystem | LocalizedCrowdPushSystem;
  private readonly wally: Wally;
  private readonly aimAura: AimAura;
  private readonly player: FirstPersonPlayer;
  private readonly collision = new CollisionSystem();
  private readonly audio = new AudioSystem();
  private readonly hud: Hud;
  private readonly input: InputController;
  private readonly loop: Loop;
  private readonly testHooks: ThreeGameTestHooks;
  private state: GameUiState = 'loading';
  private frame = 0;
  private fps = 0;
  private fpsWindowSeconds = 0;
  private fpsWindowFrames = 0;
  private runtimeElapsed = 0;
  private searchElapsed = 0;
  private wrongGuesses = 0;
  private crowdRound = 0;
  private wallySpotIndex = 0;
  private lastHudSecond = -1;
  private interactionCooldownUntil = 0;
  private resizePending = true;
  private pointerLockWasActive = false;
  private disposed = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const parameters = new URLSearchParams(window.location.search);
    this.crowdCount = ACTIVE_CROWD_COUNT;
    this.densityLabel = 'Unique striped outfits';
    this.seed = this.readSeed(parameters);
    const touchPreferred = prefersTouchInput();
    this.maxDpr = touchPreferred ? 1 : 1.5;

    this.renderer = createRenderer(canvas, { lowOverhead: this.crowdCount >= 10_000 });
    this.createSceneLighting(touchPreferred);
    this.world = createCityWorld(this.scene, { crowdCount: this.crowdCount });
    if (this.world.wallySpots.length === 0) {
      this.world.wallySpots.push(new THREE.Vector3(0, 0.04, -4));
    }

    this.wallySpotIndex = (this.seed >>> 0) % this.world.wallySpots.length;
    this.wally = new Wally(this.scene);
    this.aimAura = new AimAura(this.scene);
    this.placeWally();
    this.crowd = new CrowdSystem(this.scene, {
      count: this.crowdCount,
      bounds: this.world.bounds,
      blockers: this.world.blockers,
      seed: this.seed,
      maxVisibleCharacters: touchPreferred ? 256 : 512,
      reservedZones: [
        { position: this.world.spawn, radius: SPAWN_CLEAR_RADIUS },
        ...this.world.wallySpots.map((position) => ({ position, radius: WALLY_CLEAR_RADIUS })),
      ],
    });
    this.crowdPush = this.crowdCount >= 100_000
      ? new LocalizedCrowdPushSystem({
          positions: this.crowd.positions,
          radii: this.crowd.radii,
          bounds: this.world.bounds,
          blockers: this.world.blockers,
          spatialIndex: this.crowd.getSpatialIndex(),
        })
      : new CrowdPushSystem({
          positions: this.crowd.positions,
          radii: this.crowd.radii,
          bounds: this.world.bounds,
          blockers: this.world.blockers,
        });

    this.player = new FirstPersonPlayer(this.camera, this.world.spawn);
    this.hud = new Hud({
      onStart: this.handleStart,
      onResume: this.handleResume,
      onRestart: this.handleRestart,
      onPause: this.handlePause,
      onMute: this.handleMute,
    });
    this.input = new InputController(this.canvas, {
      onIdentify: this.handleIdentify,
      onPause: this.handlePause,
      onMute: this.handleMute,
      onRestart: this.handleRestart,
    });
    this.loop = new Loop(
      (simulationDeltaSeconds, _elapsedSeconds, realDeltaSeconds) => {
        this.update(simulationDeltaSeconds, realDeltaSeconds);
      },
      () => this.render(),
    );

    this.testHooks = {
      start: () => this.beginSearch(false),
      findWally: () => this.findWallyForTest(),
      identifyReticle: () => this.attemptIdentification(),
      triggerIdentify: (target = 'wally') => this.triggerIdentifyForTest(target),
      restart: () => this.restartSearch(false),
      togglePause: () => this.togglePause(false),
      setupCrowdPush: () => this.setupCrowdPushForTest(),
      readCrowdCharacter: (characterIndex) => this.readCrowdCharacterForTest(characterIndex),
    };

    this.raycaster.far = INTERACTION_RANGE;
    this.hud.setCrowd(this.crowd.count, this.densityLabel);
    this.hud.updateTimer(0, 0);
    this.hud.setState('loading');
    document.addEventListener('pointerlockchange', this.handlePointerLockChange);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    window.addEventListener('resize', this.handleResize);
    resizeRenderer(this.renderer, this.camera, this.maxDpr);
    this.resizePending = false;
    if (import.meta.env.DEV) window.__THREE_GAME_TEST_HOOKS__ = this.testHooks;
    this.publishDiagnostics();
    void this.initializeAssets();
  }

  start(): void {
    this.loop.start();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loop.stop();
    document.removeEventListener('pointerlockchange', this.handlePointerLockChange);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    window.removeEventListener('resize', this.handleResize);
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.input.dispose();
    this.hud.dispose();
    this.audio.dispose();
    this.aimAura.dispose();
    this.wally.dispose();
    this.crowd.dispose();
    this.world.dispose();
    this.renderer.dispose();
    window.__THREE_GAME_DIAGNOSTICS__ = undefined;
    window.__THREE_GAME_TEST_HOOKS__ = undefined;
  }

  private async initializeAssets(): Promise<void> {
    let wallyProgress = 0;
    let crowdProgress = 0;
    const updateLoadingProgress = () => {
      this.hud.setLoadingProgress(wallyProgress * 0.68 + crowdProgress * 0.32);
    };
    try {
      const [wallyResult, crowdResult] = await Promise.all([
        this.wally.load((ratio) => {
          wallyProgress = ratio ?? wallyProgress;
          updateLoadingProgress();
        }),
        this.crowd.load((ratio) => {
          crowdProgress = ratio ?? crowdProgress;
          updateLoadingProgress();
        }),
      ]);
      if (this.disposed) return;
      const completeCrowdGeometries = this.crowd.getCompleteCharacterGeometries();
      if (!completeCrowdGeometries) {
        throw new Error('Complete CharacterBase geometry is unavailable for target highlighting.');
      }
      this.aimAura.configureCrowd(completeCrowdGeometries);
      this.aimAura.configureWally(this.wally.root);
      this.state = 'ready';
      this.hud.setReady({
        ...wallyResult,
        message: `${crowdResult.message} Wally is hidden; the search zone is ready.`,
      });
      this.hud.setState(this.state);
      this.publishDiagnostics();
    } catch (error) {
      if (this.disposed) return;
      const message = error instanceof Error ? error.message : String(error);
      console.error(error);
      this.hud.setLoadingError(`CharacterBase assets could not load: ${message}`);
      this.publishDiagnostics();
    }
  }

  private update(simulationDeltaSeconds: number, realDeltaSeconds: number): void {
    this.frame += 1;
    this.fpsWindowFrames += 1;
    this.fpsWindowSeconds += realDeltaSeconds;
    if (this.fpsWindowSeconds >= 0.5) {
      this.fps = this.fpsWindowFrames / this.fpsWindowSeconds;
      this.fpsWindowFrames = 0;
      this.fpsWindowSeconds = 0;
    }

    if (this.resizePending) {
      resizeRenderer(this.renderer, this.camera, this.maxDpr);
      this.resizePending = false;
    }
    if (this.state === 'playing') {
      this.searchElapsed += realDeltaSeconds;
      this.previousPlayerPosition.copy(this.player.position);
      this.player.update(
        simulationDeltaSeconds,
        this.input,
        this.collision,
        this.world.bounds,
        this.world.blockers,
      );
      const pushResult = this.crowdPush.step(
        simulationDeltaSeconds,
        this.player.position,
        this.previousPlayerPosition,
        this.player.velocity,
        this.player.radius,
      );
      if (pushResult.collided) {
        this.player.syncAfterCrowdResolution(pushResult.playerContacts);
      }
      this.crowd.syncTransforms(
        this.crowdPush instanceof LocalizedCrowdPushSystem
          ? this.crowdPush.getMovedIndices()
          : this.crowdPush.getMovedFlags(),
      );
    }

    if (this.state !== 'paused' && this.state !== 'won') {
      this.runtimeElapsed += realDeltaSeconds;
      this.crowd.update(this.runtimeElapsed, this.player.position);
      this.wally.update(realDeltaSeconds);
    }
    this.updateAimAura();

    const hudSecond = Math.floor(this.searchElapsed);
    if (hudSecond !== this.lastHudSecond) {
      this.lastHudSecond = hudSecond;
      this.hud.updateTimer(this.searchElapsed, this.wrongGuesses);
    }

    if (this.frame % 60 === 0) this.publishDiagnostics();
  }

  private render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  private createSceneLighting(mobile: boolean): void {
    this.scene.background = new THREE.Color('#b9ddea');
    this.scene.fog = this.crowdCount >= 100_000
      ? mobile
        ? new THREE.Fog('#b9ddea', 5.5, 13.5)
        : new THREE.Fog('#b9ddea', 7.5, 18)
      : mobile
        ? new THREE.Fog('#b9ddea', 6, 24)
        : new THREE.Fog('#b9ddea', 9, 32);

    const ambient = new THREE.AmbientLight('#fff8ec', 1.55);
    ambient.name = 'daylight-ambient';
    this.scene.add(ambient);

    const fill = new THREE.HemisphereLight('#dff3ff', '#b98962', 2.1);
    fill.name = 'daylight-sky-fill';
    this.scene.add(fill);

    const sun = new THREE.DirectionalLight('#fff0d2', 3.4);
    sun.name = 'daylight-sun';
    sun.position.set(-36, 52, 28);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 120;
    sun.shadow.camera.left = -52;
    sun.shadow.camera.right = 52;
    sun.shadow.camera.top = 40;
    sun.shadow.camera.bottom = -40;
    sun.shadow.bias = -0.00015;
    sun.shadow.normalBias = 0.025;
    this.scene.add(sun);

    const bounce = new THREE.DirectionalLight('#a9ccff', 0.85);
    bounce.name = 'daylight-bounce';
    bounce.position.set(10, 7, -12);
    this.scene.add(bounce);
  }

  private beginSearch(requestPointerLock: boolean): void {
    if (this.state === 'loading' || this.state === 'won') return;
    void this.audio.unlock().catch(() => undefined);
    this.audio.setPaused(false);
    this.state = 'playing';
    this.hud.setState(this.state);
    this.hud.showFeedback('Wally is somewhere in the crowd', 'neutral');
    this.hud.updateTimer(this.searchElapsed, this.wrongGuesses);
    if (requestPointerLock) this.requestPointerLock();
    this.publishDiagnostics();
  }

  private pauseSearch(exitPointerLock: boolean): void {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.player.stop();
    this.input.clear();
    this.audio.setPaused(true);
    this.aimAura.clear();
    this.hud.setState(this.state);
    if (exitPointerLock && document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.publishDiagnostics();
  }

  private resumeSearch(requestPointerLock: boolean): void {
    if (this.state !== 'paused') return;
    void this.audio.unlock().catch(() => undefined);
    this.audio.setPaused(false);
    this.state = 'playing';
    this.hud.setState(this.state);
    this.audio.uiConfirm();
    if (requestPointerLock) this.requestPointerLock();
    this.publishDiagnostics();
  }

  private togglePause(requestPointerLock: boolean): void {
    if (this.state === 'playing') this.pauseSearch(true);
    else if (this.state === 'paused') this.resumeSearch(requestPointerLock);
  }

  private restartSearch(requestPointerLock: boolean): void {
    if (this.state === 'loading') return;
    this.wallySpotIndex = (this.wallySpotIndex + 1) % this.world.wallySpots.length;
    this.placeWally();
    this.crowdRound += 1;
    this.crowd.regenerateOutfits(
      (this.seed ^ Math.imul(this.crowdRound, 0x45d9f3b)) >>> 0,
    );
    const resetCharacters = this.crowdPush.reset();
    if (Array.isArray(resetCharacters)) this.crowd.syncTransforms(resetCharacters);
    else this.crowd.syncTransforms();
    this.player.teleport(this.world.spawn);
    this.player.lookAt(this.targetPoint.copy(this.world.spawn).add(new THREE.Vector3(0, 1.2, -3)));
    this.input.clear();
    this.searchElapsed = 0;
    this.wrongGuesses = 0;
    this.lastHudSecond = -1;
    this.interactionCooldownUntil = 0;
    this.aimAura.clear();
    this.state = 'playing';
    void this.audio.unlock().catch(() => undefined);
    this.audio.setPaused(false);
    this.audio.uiConfirm();
    this.hud.updateTimer(0, 0);
    this.hud.setState(this.state);
    this.hud.showFeedback('New crowd. New hiding spot.', 'neutral');
    if (requestPointerLock) this.requestPointerLock();
    this.publishDiagnostics();
  }

  private attemptIdentification(): void {
    if (this.state !== 'playing' || !this.wally.getDiagnostics().ready) return;
    const now = performance.now();
    if (now < this.interactionCooldownUntil) return;
    this.interactionCooldownUntil = now + 360;

    const hits = this.readIdentificationHits();
    const target = this.resolveIdentificationTarget(hits);

    if (target.kind === 'blocked') {
      this.audio.uiNeutral();
      this.hud.showFeedback('Your view is blocked', 'neutral');
      return;
    }

    if (target.kind === 'none') {
      this.audio.uiNeutral();
      this.hud.showFeedback('Nothing under the reticle', 'neutral');
      return;
    }

    if (target.kind === 'wally') {
      this.confirmWally();
    } else {
      this.registerWrongGuess();
    }
  }

  private registerWrongGuess(): void {
    if (this.state !== 'playing') return;
    this.wrongGuesses += 1;
    this.searchElapsed += WRONG_GUESS_PENALTY;
    this.lastHudSecond = -1;
    this.audio.wrongGuess();
    this.hud.updateTimer(this.searchElapsed, this.wrongGuesses);
    this.hud.flashPenalty();
    this.hud.showFeedback(`Not Wally — +${WRONG_GUESS_PENALTY} seconds`, 'wrong');
    this.publishDiagnostics();
  }

  private confirmWally(): void {
    if (this.state !== 'playing') return;
    this.state = 'won';
    this.player.stop();
    this.input.clear();
    this.aimAura.clear();
    this.audio.correctGuess();
    this.audio.setPaused(true);
    this.hud.flashCorrect();
    this.hud.showFeedback('Identity confirmed', 'correct');
    this.hud.showSuccess({
      elapsedSeconds: this.searchElapsed,
      wrongGuesses: this.wrongGuesses,
      crowdCount: this.crowd.count,
    });
    this.hud.setState(this.state);
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.publishDiagnostics();
  }

  private placeWally(): void {
    const spot = this.world.wallySpots[this.wallySpotIndex];
    this.wally.setSpot(spot, this.getWallyFacing(this.wallySpotIndex));
  }

  private findWallyForTest(): ThreeGameTestLocation {
    if (this.state === 'ready') this.beginSearch(false);
    const wallyPosition = this.world.wallySpots[this.wallySpotIndex];
    let foundCandidate = false;
    const distances = [0.5, 0.62, 0.78, 0.96, 1.18] as const;
    for (const distance of distances) {
      for (let sample = 0; sample < 16; sample += 1) {
        const angle = (sample / 16) * Math.PI * 2;
        this.nearbyCandidate.set(
          wallyPosition.x + Math.sin(angle) * distance,
          this.world.spawn.y,
          wallyPosition.z + Math.cos(angle) * distance,
        );
        if (
          !this.collision.canOccupy(
            this.nearbyCandidate,
            this.player.radius,
            this.world.bounds,
            this.world.blockers,
          ) ||
          !this.crowdPush.canOccupyPlayer(this.nearbyCandidate, this.player.radius)
        ) {
          continue;
        }

        this.player.teleport(this.nearbyCandidate);
        this.crowd.update(this.runtimeElapsed, this.player.position);
        this.player.lookAt(this.wally.getChestPosition(this.targetPoint));
        const hits = this.readIdentificationHits();
        const crowdClear =
          hits.wallyDistance !== null &&
          (hits.crowdDistance === null ||
            hits.wallyDistance + IDENTIFICATION_EPSILON < hits.crowdDistance);
        const worldClear =
          hits.wallyDistance !== null &&
          (hits.worldDistance === null ||
            hits.wallyDistance + IDENTIFICATION_EPSILON < hits.worldDistance);
        if (crowdClear && worldClear) {
          foundCandidate = true;
          break;
        }
      }
      if (foundCandidate) break;
    }

    if (!foundCandidate) {
      this.player.teleport(this.world.spawn);
      this.crowd.update(this.runtimeElapsed, this.player.position);
      this.player.lookAt(this.wally.getChestPosition(this.targetPoint));
    }
    this.updateAimAura();
    this.publishDiagnostics();
    return {
      x: wallyPosition.x,
      y: wallyPosition.y,
      z: wallyPosition.z,
      spotIndex: this.wallySpotIndex,
    };
  }

  private setupCrowdPushForTest(): ThreeCrowdCharacterTestLocation {
    if (this.state === 'ready') this.beginSearch(false);
    const candidate = this.nearbyCandidate;
    for (let characterIndex = 0; characterIndex < this.crowd.count; characterIndex += 1) {
      const offset = characterIndex * 3;
      const characterX = this.crowd.positions[offset];
      const characterY = this.crowd.positions[offset + 1];
      const characterZ = this.crowd.positions[offset + 2];
      const distance = this.player.radius + this.crowd.radii[characterIndex] + 0.075;
      for (let sample = 0; sample < 16; sample += 1) {
        const angle = (sample / 16) * Math.PI * 2;
        const outwardX = Math.sin(angle);
        const outwardZ = Math.cos(angle);
        candidate.set(
          characterX + outwardX * distance,
          this.world.spawn.y,
          characterZ + outwardZ * distance,
        );
        if (!this.crowdPush.canOccupyPlayer(candidate, this.player.radius)) continue;
        this.targetPoint.set(
          characterX - outwardX * 0.45,
          characterY,
          characterZ - outwardZ * 0.45,
        );
        if (
          !this.collision.canOccupy(
            this.targetPoint,
            this.crowd.radii[characterIndex],
            this.world.bounds,
            this.world.blockers,
          )
        ) {
          continue;
        }
        let pushLaneClear = true;
        for (let otherIndex = 0; otherIndex < this.crowd.count; otherIndex += 1) {
          if (otherIndex === characterIndex) continue;
          const otherOffset = otherIndex * 3;
          const deltaX = this.crowd.positions[otherOffset] - this.targetPoint.x;
          const deltaZ = this.crowd.positions[otherOffset + 2] - this.targetPoint.z;
          const minimum = this.crowd.radii[characterIndex] + this.crowd.radii[otherIndex] + 0.04;
          if (deltaX * deltaX + deltaZ * deltaZ < minimum * minimum) {
            pushLaneClear = false;
            break;
          }
        }
        if (!pushLaneClear) continue;
        this.player.teleport(candidate);
        this.crowd.update(this.runtimeElapsed, this.player.position);
        this.targetPoint.set(characterX, characterY + 1.22, characterZ);
        this.player.lookAt(this.targetPoint);
        this.updateAimAura();
        this.publishDiagnostics();
        return this.readCrowdCharacterForTest(characterIndex);
      }
    }
    throw new Error('No accessible crowd character was available for the push integration test.');
  }

  private readCrowdCharacterForTest(characterIndex: number): ThreeCrowdCharacterTestLocation {
    const safeIndex = THREE.MathUtils.clamp(
      Math.floor(Number.isFinite(characterIndex) ? characterIndex : 0),
      0,
      Math.max(0, this.crowd.count - 1),
    );
    const offset = safeIndex * 3;
    return {
      characterIndex: safeIndex,
      x: this.crowd.positions[offset],
      y: this.crowd.positions[offset + 1],
      z: this.crowd.positions[offset + 2],
      radius: this.crowd.radii[safeIndex],
    };
  }

  private readIdentificationHits(): IdentificationHits {
    this.camera.updateMatrixWorld(true);
    this.scene.updateMatrixWorld(true);
    this.raycaster.setFromCamera(this.rayCenter, this.camera);

    const interactionTarget = this.wally.getInteractionTarget();
    const wallyHit = interactionTarget
      ? this.raycaster.intersectObject(interactionTarget, false)[0]
      : undefined;
    const worldHit = this.raycaster.intersectObjects(
      this.world.interactionOccluders,
      false,
    )[0];
    const visibleCrowd = this.crowd.getVisibleCharacters();
    const crowdHit = findCrowdHit(
      this.crowd.positions,
      this.crowd.count,
      this.raycaster.ray,
      INTERACTION_RANGE,
      CROWD_SELECTION_RADIUS,
      CROWD_SELECTION_HEIGHTS,
      this.crowdHit,
      visibleCrowd ? undefined : this.isCrowdCharacterVisible,
      visibleCrowd?.indices,
      visibleCrowd?.count,
    );

    this.identificationHits.wallyDistance = wallyHit?.distance ?? null;
    this.identificationHits.crowdDistance = crowdHit?.distance ?? null;
    this.identificationHits.crowdIndex = crowdHit?.characterIndex ?? null;
    this.identificationHits.worldDistance = worldHit?.distance ?? null;
    return this.identificationHits;
  }

  private resolveIdentificationTarget(hits: IdentificationHits): IdentificationResolution {
    const resolution = this.identificationResolution;
    resolution.crowdIndex = null;
    resolution.distance = null;
    const nearestSelectable = Math.min(
      hits.wallyDistance ?? Number.POSITIVE_INFINITY,
      hits.crowdDistance ?? Number.POSITIVE_INFINITY,
    );
    if (!Number.isFinite(nearestSelectable)) {
      resolution.kind = 'none';
      return resolution;
    }
    if (
      hits.worldDistance !== null &&
      hits.worldDistance + IDENTIFICATION_EPSILON < nearestSelectable
    ) {
      resolution.kind = 'blocked';
      resolution.distance = hits.worldDistance;
      return resolution;
    }
    if (
      hits.wallyDistance !== null &&
      (hits.crowdDistance === null ||
        hits.wallyDistance <= hits.crowdDistance + IDENTIFICATION_EPSILON)
    ) {
      resolution.kind = 'wally';
      resolution.distance = hits.wallyDistance;
      return resolution;
    }
    if (hits.crowdDistance !== null && hits.crowdIndex !== null) {
      resolution.kind = 'crowd';
      resolution.crowdIndex = hits.crowdIndex;
      resolution.distance = hits.crowdDistance;
      return resolution;
    }
    resolution.kind = 'none';
    return resolution;
  }

  private readonly isCrowdCharacterVisible = (characterIndex: number): boolean =>
    this.crowd.isCharacterVisible(characterIndex);

  private updateAimAura(): void {
    if (this.state !== 'playing' || !this.wally.isReady()) {
      this.aimAura.clear();
      return;
    }

    const target = this.resolveIdentificationTarget(this.readIdentificationHits());
    if (target.kind === 'none' || target.kind === 'blocked' || target.distance === null) {
      this.aimAura.clear();
      return;
    }

    if (target.kind === 'wally') {
      this.aimAura.setWallyTarget(target.distance);
    } else {
      const characterIndex = target.crowdIndex;
      if (
        characterIndex === null ||
        !this.crowd.copyCharacterMatrix(characterIndex, this.aimCharacterMatrix)
      ) {
        this.aimAura.clear();
        return;
      }
      this.aimAura.setCrowdTarget(
        characterIndex,
        this.aimCharacterMatrix,
        target.distance,
      );
    }
    this.aimAura.update(this.runtimeElapsed);
  }

  private triggerIdentifyForTest(target: 'wally' | 'wrong'): void {
    if (this.state === 'ready') this.beginSearch(false);
    if (target === 'wally') this.confirmWally();
    else this.registerWrongGuess();
  }

  private requestPointerLock(): void {
    if (this.input.isTouchMode()) return;
    this.canvas.focus({ preventScroll: true });
    try {
      const result = this.canvas.requestPointerLock() as void | Promise<void>;
      if (result) void result.catch(() => undefined);
    } catch {
      // Pointer lock can be denied outside a direct user gesture; keyboard play remains available.
    }
  }

  private publishDiagnostics(): void {
    if (!import.meta.env.DEV) return;
    const rendererInfo = this.renderer.info;
    const wallyDiagnostics = this.wally.getDiagnostics();
    const playerDiagnostics = this.player.getDiagnostics();
    window.__THREE_GAME_DIAGNOSTICS__ = {
      frame: this.frame,
      fps: this.fps,
      frameTimeMs: this.fps > 0 ? 1_000 / this.fps : 0,
      state: this.state,
      game: {
        state: this.state,
        elapsed: this.searchElapsed,
        wrongGuesses: this.wrongGuesses,
        penaltySeconds: this.wrongGuesses * WRONG_GUESS_PENALTY,
        crowdCount: this.crowd.count,
        requestedCrowdCount: this.crowdCount,
        densityLabel: this.densityLabel,
        seed: this.seed,
        wallySpotIndex: this.wallySpotIndex,
        interactionRange: INTERACTION_RANGE,
      },
      player: {
        ...playerDiagnostics,
        pointerLocked: document.pointerLockElement === this.canvas,
      },
      input: this.input.getDiagnostics(),
      wally: {
        ...wallyDiagnostics,
        distanceFromPlayer: this.player.position.distanceTo(this.wally.root.position),
      },
      renderer: {
        calls: rendererInfo.render.calls,
        triangles: rendererInfo.render.triangles,
        points: rendererInfo.render.points,
        lines: rendererInfo.render.lines,
        geometries: rendererInfo.memory.geometries,
        textures: rendererInfo.memory.textures,
        programs: rendererInfo.programs?.length ?? 0,
      },
      canvas: {
        clientWidth: this.canvas.clientWidth,
        clientHeight: this.canvas.clientHeight,
        width: this.canvas.width,
        height: this.canvas.height,
        dpr: Math.min(window.devicePixelRatio || 1, this.maxDpr),
      },
      crowd: {
        ...this.crowd.getDiagnostics(),
        ...this.crowdPush.getDiagnostics(),
        count: this.crowd.count,
      },
      world: {
        ...this.world.diagnostics,
        boundsWidth: this.world.bounds.maxX - this.world.bounds.minX,
        boundsDepth: this.world.bounds.maxZ - this.world.bounds.minZ,
      },
      aimAura: this.aimAura.getDiagnostics(),
      audio: this.audio.getDiagnostics(),
      testHooks: this.testHooks,
    };
  }

  private getWallyFacing(spotIndex: number): number {
    let value = (this.seed ^ Math.imul(spotIndex + 1, 0x45d9f3b)) >>> 0;
    value = Math.imul(value ^ (value >>> 16), 0x45d9f3b) >>> 0;
    return (value / 4_294_967_296) * Math.PI * 2;
  }

  private readSeed(parameters: URLSearchParams): number {
    const requested = Number(parameters.get('seed') ?? DEFAULT_SEED);
    return Number.isFinite(requested) ? Math.floor(requested) : DEFAULT_SEED;
  }

  private readonly handleStart = () => this.beginSearch(!this.input.isTouchMode());
  private readonly handleResume = () => this.resumeSearch(!this.input.isTouchMode());
  private readonly handleRestart = () => this.restartSearch(!this.input.isTouchMode());
  private readonly handlePause = () => this.togglePause(!this.input.isTouchMode());
  private readonly handleMute = () => {
    const muted = this.audio.toggleMute();
    this.hud.setMuted(muted);
    if (!muted) this.audio.uiConfirm();
    this.publishDiagnostics();
  };
  private readonly handleIdentify = () => this.attemptIdentification();

  private readonly handlePointerLockChange = () => {
    if (document.pointerLockElement === this.canvas) {
      this.pointerLockWasActive = true;
      return;
    }
    const lostActiveLock = this.pointerLockWasActive;
    this.pointerLockWasActive = false;
    if (lostActiveLock && !this.input.isTouchMode() && this.state === 'playing') {
      this.pauseSearch(false);
    }
  };

  private readonly handleVisibilityChange = () => {
    if (document.hidden && this.state === 'playing') this.pauseSearch(true);
  };

  private readonly handleResize = () => {
    this.resizePending = true;
  };
}
