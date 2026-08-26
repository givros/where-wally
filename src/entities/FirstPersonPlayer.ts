import * as THREE from 'three';
import type { Aabb2 } from '../assets/CityWorld';
import type { InputController } from '../core/InputController';
import type { CollisionSystem } from '../systems/CollisionSystem';

export type FirstPersonDiagnostics = {
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  speed: number;
  sprinting: boolean;
  yaw: number;
  pitch: number;
  collisions: number;
};

const WALK_SPEED = 3.85;
const SPRINT_SPEED = 6.35;
const ACCELERATION = 12.5;
const DECELERATION = 15;
const LOOK_SENSITIVITY = 0.00205;
const EYE_HEIGHT = 1.67;
const PLAYER_RADIUS = 0.31;

export class FirstPersonPlayer {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  readonly radius = PLAYER_RADIUS;

  private readonly movementInput = new THREE.Vector2();
  private readonly lookInput = new THREE.Vector2();
  private readonly desiredVelocity = new THREE.Vector3();
  private readonly frameMovement = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly cameraEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private walkPhase = 0;
  private yaw = 0;
  private pitch = 0;
  private sprinting = false;
  private collisionCount = 0;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    spawn: THREE.Vector3,
  ) {
    this.teleport(spawn);
  }

  update(
    deltaSeconds: number,
    input: InputController,
    collision: CollisionSystem,
    bounds: Aabb2,
    blockers: readonly Aabb2[],
  ): void {
    input.consumeLookDelta(this.lookInput);
    this.yaw -= this.lookInput.x * LOOK_SENSITIVITY;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch - this.lookInput.y * LOOK_SENSITIVITY,
      -Math.PI * 0.47,
      Math.PI * 0.47,
    );

    input.readMovement(this.movementInput);
    this.sprinting = input.isSprinting() && this.movementInput.y > 0.1;
    const moveSpeed = this.sprinting ? SPRINT_SPEED : WALK_SPEED;

    this.forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this.desiredVelocity
      .set(0, 0, 0)
      .addScaledVector(this.forward, this.movementInput.y)
      .addScaledVector(this.right, this.movementInput.x);
    if (this.desiredVelocity.lengthSq() > 1) this.desiredVelocity.normalize();
    this.desiredVelocity.multiplyScalar(moveSpeed);

    const smoothing = 1 - Math.exp(
      -(this.movementInput.lengthSq() > 0.001 ? ACCELERATION : DECELERATION) * deltaSeconds,
    );
    this.velocity.lerp(this.desiredVelocity, smoothing);
    this.frameMovement.copy(this.velocity).multiplyScalar(deltaSeconds);

    const collisionResult = collision.moveCircle(
      this.position,
      this.frameMovement,
      PLAYER_RADIUS,
      bounds,
      blockers,
    );
    this.collisionCount += collisionResult.contacts;

    const horizontalSpeed = this.velocity.length();
    this.walkPhase += horizontalSpeed * deltaSeconds * (this.sprinting ? 3.15 : 2.7);
    const bobStrength = THREE.MathUtils.clamp(horizontalSpeed / WALK_SPEED, 0, 1.35);
    const bobY = Math.sin(this.walkPhase * 2) * 0.018 * bobStrength;
    const bobRoll = Math.sin(this.walkPhase) * 0.0035 * bobStrength;

    const targetFov = this.sprinting ? 72.5 : 69;
    const nextFov = THREE.MathUtils.lerp(
      this.camera.fov,
      targetFov,
      1 - Math.exp(-7 * deltaSeconds),
    );
    if (Math.abs(nextFov - this.camera.fov) > 0.0005) {
      this.camera.fov = nextFov;
      this.camera.updateProjectionMatrix();
    }
    this.syncCamera(bobY, bobRoll);
  }

  teleport(position: THREE.Vector3): void {
    this.position.copy(position);
    this.velocity.set(0, 0, 0);
    this.walkPhase = 0;
    this.syncCamera();
  }

  lookAt(target: THREE.Vector3): void {
    const eyeX = this.position.x;
    const eyeY = this.position.y + EYE_HEIGHT;
    const eyeZ = this.position.z;
    const deltaX = target.x - eyeX;
    const deltaY = target.y - eyeY;
    const deltaZ = target.z - eyeZ;
    const horizontal = Math.max(0.0001, Math.hypot(deltaX, deltaZ));
    this.yaw = Math.atan2(-deltaX, -deltaZ);
    this.pitch = THREE.MathUtils.clamp(
      Math.atan2(deltaY, horizontal),
      -Math.PI * 0.47,
      Math.PI * 0.47,
    );
    this.syncCamera();
  }

  stop(): void {
    this.velocity.set(0, 0, 0);
    this.sprinting = false;
  }

  /** Applies the position correction made by the crowd solver to the camera immediately. */
  syncAfterCrowdResolution(contacts: number): void {
    if (contacts > 0) {
      this.collisionCount += contacts;
      this.velocity.multiplyScalar(0.88);
    }
    this.syncCamera();
  }

  getDiagnostics(): FirstPersonDiagnostics {
    return {
      position: {
        x: this.position.x,
        y: this.position.y,
        z: this.position.z,
      },
      velocity: {
        x: this.velocity.x,
        y: this.velocity.y,
        z: this.velocity.z,
      },
      speed: this.velocity.length(),
      sprinting: this.sprinting,
      yaw: this.yaw,
      pitch: this.pitch,
      collisions: this.collisionCount,
    };
  }

  private syncCamera(bobY = 0, bobRoll = 0): void {
    this.camera.position.set(
      this.position.x,
      this.position.y + EYE_HEIGHT + bobY,
      this.position.z,
    );
    this.cameraEuler.set(this.pitch, this.yaw, bobRoll, 'YXZ');
    this.camera.quaternion.setFromEuler(this.cameraEuler);
  }
}
