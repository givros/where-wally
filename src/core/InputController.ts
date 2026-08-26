import * as THREE from 'three';

export type InputHandlers = {
  onIdentify: () => void;
  onPause: () => void;
  onMute: () => void;
  onRestart: () => void;
};

export type InputDiagnostics = {
  mode: 'desktop' | 'touch';
  touchMovement: { x: number; y: number };
  touchLooking: boolean;
  autoSprint: boolean;
};

const GAME_KEYS = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowUp',
  'ArrowLeft',
  'ArrowDown',
  'ArrowRight',
  'ShiftLeft',
  'ShiftRight',
  'KeyE',
  'KeyP',
  'KeyM',
  'KeyR',
]);

const TOUCH_DEAD_ZONE = 0.12;
const TOUCH_AUTO_SPRINT_THRESHOLD = 0.86;
const TOUCH_LOOK_MULTIPLIER = 1.6;

export function prefersTouchInput(): boolean {
  return window.matchMedia?.('(hover: none) and (pointer: coarse)').matches ?? false;
}

export class InputController {
  private readonly keys = new Set<string>();
  private readonly touchMovement = new THREE.Vector2();
  private readonly moveStick: HTMLElement;
  private readonly moveKnob: HTMLElement;
  private readonly identifyButton: HTMLButtonElement;
  private lookX = 0;
  private lookY = 0;
  private inputMode: 'desktop' | 'touch';
  private movePointerId: number | null = null;
  private lookPointerId: number | null = null;
  private lookPointerX = 0;
  private lookPointerY = 0;
  private touchAutoSprint = false;

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (GAME_KEYS.has(event.code)) event.preventDefault();
    this.keys.add(event.code);
    if (event.repeat) return;

    if (event.code === 'KeyE') this.handlers.onIdentify();
    if (event.code === 'KeyP') this.handlers.onPause();
    if (event.code === 'KeyM') this.handlers.onMute();
    if (event.code === 'KeyR') this.handlers.onRestart();
  };

  private readonly onKeyUp = (event: KeyboardEvent) => {
    this.keys.delete(event.code);
  };

  private readonly onMouseMove = (event: MouseEvent) => {
    if (document.pointerLockElement !== this.canvas) return;
    this.lookX += event.movementX;
    this.lookY += event.movementY;
  };

  private readonly onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0 || document.pointerLockElement !== this.canvas) return;
    event.preventDefault();
    this.handlers.onIdentify();
  };

  private readonly onAnyPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'touch') {
      this.setInputMode('touch');
      return;
    }
    if (
      event.pointerType === 'mouse' &&
      window.matchMedia?.('(hover: hover) and (pointer: fine)').matches
    ) {
      this.setInputMode('desktop');
    }
  };

  private readonly onMovePointerDown = (event: PointerEvent) => {
    if (!this.isTouchMode() || this.movePointerId !== null) return;
    event.preventDefault();
    this.movePointerId = event.pointerId;
    this.capturePointer(this.moveStick, event.pointerId);
    this.moveStick.classList.add('is-active');
    this.updateTouchMovement(event.clientX, event.clientY);
  };

  private readonly onMovePointerMove = (event: PointerEvent) => {
    if (event.pointerId !== this.movePointerId) return;
    event.preventDefault();
    this.updateTouchMovement(event.clientX, event.clientY);
  };

  private readonly onMovePointerEnd = (event: PointerEvent) => {
    if (event.pointerId !== this.movePointerId) return;
    event.preventDefault();
    this.resetTouchMovement();
  };

  private readonly onMovePointerCancel = (event: PointerEvent) => {
    if (this.movePointerId === null) return;
    event.preventDefault();
    this.resetTouchMovement();
  };

  private readonly onMovePointerCaptureLost = (event: PointerEvent) => {
    if (event.pointerId === this.movePointerId) this.resetTouchMovement(false);
  };

  private readonly onLookPointerDown = (event: PointerEvent) => {
    if (!this.isTouchMode() || this.lookPointerId !== null) return;
    event.preventDefault();
    this.lookPointerId = event.pointerId;
    this.lookPointerX = event.clientX;
    this.lookPointerY = event.clientY;
    this.capturePointer(this.canvas, event.pointerId);
    this.canvas.classList.add('is-touch-looking');
  };

  private readonly onLookPointerMove = (event: PointerEvent) => {
    if (event.pointerId !== this.lookPointerId) return;
    event.preventDefault();
    this.lookX += (event.clientX - this.lookPointerX) * TOUCH_LOOK_MULTIPLIER;
    this.lookY += (event.clientY - this.lookPointerY) * TOUCH_LOOK_MULTIPLIER;
    this.lookPointerX = event.clientX;
    this.lookPointerY = event.clientY;
  };

  private readonly onLookPointerEnd = (event: PointerEvent) => {
    if (event.pointerId !== this.lookPointerId) return;
    event.preventDefault();
    this.resetTouchLook();
  };

  private readonly onLookPointerCancel = (event: PointerEvent) => {
    if (this.lookPointerId === null) return;
    event.preventDefault();
    this.resetTouchLook();
  };

  private readonly onLookPointerCaptureLost = (event: PointerEvent) => {
    if (event.pointerId === this.lookPointerId) this.resetTouchLook(false);
  };

  private readonly onTouchIdentify = (event: MouseEvent) => {
    event.preventDefault();
    this.handlers.onIdentify();
  };

  private readonly onGlobalPointerEnd = (event: PointerEvent) => {
    if (event.pointerId === this.movePointerId) this.resetTouchMovement();
    if (event.pointerId === this.lookPointerId) this.resetTouchLook();
  };

  private readonly onGlobalPointerCancel = () => {
    if (this.movePointerId !== null) this.resetTouchMovement();
    if (this.lookPointerId !== null) this.resetTouchLook();
  };

  private readonly onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
  };

  private readonly clearTransientInput = () => {
    this.keys.clear();
    this.lookX = 0;
    this.lookY = 0;
    this.resetTouchMovement();
    this.resetTouchLook();
  };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly handlers: InputHandlers,
  ) {
    this.moveStick = this.getElement('#move-stick');
    this.moveKnob = this.getElement('#move-knob');
    this.identifyButton = this.getButton('#identify-touch');
    this.inputMode = prefersTouchInput() ? 'touch' : 'desktop';
    this.setInputMode(this.inputMode);

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.clearTransientInput);
    window.addEventListener('pointerdown', this.onAnyPointerDown, true);
    window.addEventListener('pointerup', this.onGlobalPointerEnd);
    window.addEventListener('pointercancel', this.onGlobalPointerCancel);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    this.canvas.addEventListener('mousedown', this.onMouseDown);
    this.canvas.addEventListener('pointerdown', this.onLookPointerDown);
    this.canvas.addEventListener('pointermove', this.onLookPointerMove);
    this.canvas.addEventListener('pointerup', this.onLookPointerEnd);
    this.canvas.addEventListener('pointercancel', this.onLookPointerCancel);
    this.canvas.addEventListener('lostpointercapture', this.onLookPointerCaptureLost);
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
    this.moveStick.addEventListener('pointerdown', this.onMovePointerDown);
    this.moveStick.addEventListener('pointermove', this.onMovePointerMove);
    this.moveStick.addEventListener('pointerup', this.onMovePointerEnd);
    this.moveStick.addEventListener('pointercancel', this.onMovePointerCancel);
    this.moveStick.addEventListener('lostpointercapture', this.onMovePointerCaptureLost);
    this.identifyButton.addEventListener('click', this.onTouchIdentify);
  }

  readMovement(target: THREE.Vector2): THREE.Vector2 {
    target.copy(this.touchMovement);
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) target.x -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) target.x += 1;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) target.y += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) target.y -= 1;
    if (target.lengthSq() > 1) target.normalize();
    return target;
  }

  consumeLookDelta(target: THREE.Vector2): THREE.Vector2 {
    target.set(this.lookX, this.lookY);
    this.lookX = 0;
    this.lookY = 0;
    return target;
  }

  isSprinting(): boolean {
    return this.touchAutoSprint || this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
  }

  isPointerLocked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  isTouchMode(): boolean {
    return this.inputMode === 'touch';
  }

  getDiagnostics(): InputDiagnostics {
    return {
      mode: this.inputMode,
      touchMovement: { x: this.touchMovement.x, y: this.touchMovement.y },
      touchLooking: this.lookPointerId !== null,
      autoSprint: this.touchAutoSprint,
    };
  }

  clear(): void {
    this.clearTransientInput();
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.clearTransientInput);
    window.removeEventListener('pointerdown', this.onAnyPointerDown, true);
    window.removeEventListener('pointerup', this.onGlobalPointerEnd);
    window.removeEventListener('pointercancel', this.onGlobalPointerCancel);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    this.canvas.removeEventListener('pointerdown', this.onLookPointerDown);
    this.canvas.removeEventListener('pointermove', this.onLookPointerMove);
    this.canvas.removeEventListener('pointerup', this.onLookPointerEnd);
    this.canvas.removeEventListener('pointercancel', this.onLookPointerCancel);
    this.canvas.removeEventListener('lostpointercapture', this.onLookPointerCaptureLost);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    this.moveStick.removeEventListener('pointerdown', this.onMovePointerDown);
    this.moveStick.removeEventListener('pointermove', this.onMovePointerMove);
    this.moveStick.removeEventListener('pointerup', this.onMovePointerEnd);
    this.moveStick.removeEventListener('pointercancel', this.onMovePointerCancel);
    this.moveStick.removeEventListener('lostpointercapture', this.onMovePointerCaptureLost);
    this.identifyButton.removeEventListener('click', this.onTouchIdentify);
    this.clearTransientInput();
    delete document.documentElement.dataset.inputMode;
  }

  private updateTouchMovement(clientX: number, clientY: number): void {
    const bounds = this.moveStick.getBoundingClientRect();
    const centerX = bounds.left + bounds.width * 0.5;
    const centerY = bounds.top + bounds.height * 0.5;
    const radius = Math.max(1, Math.min(bounds.width, bounds.height) * 0.34);
    const offsetX = clientX - centerX;
    const offsetY = clientY - centerY;
    const distance = Math.hypot(offsetX, offsetY);
    const scale = distance > radius ? radius / distance : 1;
    const visualX = offsetX * scale;
    const visualY = offsetY * scale;
    this.moveKnob.style.setProperty('--stick-x', `${visualX.toFixed(2)}px`);
    this.moveKnob.style.setProperty('--stick-y', `${visualY.toFixed(2)}px`);

    const rawMagnitude = THREE.MathUtils.clamp(distance / radius, 0, 1);
    if (rawMagnitude <= TOUCH_DEAD_ZONE || distance < 0.001) {
      this.touchMovement.set(0, 0);
      this.touchAutoSprint = false;
      return;
    }

    const magnitude = (rawMagnitude - TOUCH_DEAD_ZONE) / (1 - TOUCH_DEAD_ZONE);
    this.touchMovement.set(
      (offsetX / distance) * magnitude,
      (-offsetY / distance) * magnitude,
    );
    this.touchAutoSprint =
      rawMagnitude >= TOUCH_AUTO_SPRINT_THRESHOLD && this.touchMovement.y > 0.68;
  }

  private resetTouchMovement(releaseCapture = true): void {
    const pointerId = this.movePointerId;
    this.movePointerId = null;
    this.touchMovement.set(0, 0);
    this.touchAutoSprint = false;
    this.moveStick.classList.remove('is-active');
    this.moveKnob.style.setProperty('--stick-x', '0px');
    this.moveKnob.style.setProperty('--stick-y', '0px');
    if (releaseCapture && pointerId !== null) this.releasePointer(this.moveStick, pointerId);
  }

  private resetTouchLook(releaseCapture = true): void {
    const pointerId = this.lookPointerId;
    this.lookPointerId = null;
    this.canvas.classList.remove('is-touch-looking');
    if (releaseCapture && pointerId !== null) this.releasePointer(this.canvas, pointerId);
  }

  private setInputMode(mode: 'desktop' | 'touch'): void {
    if (this.inputMode === mode && document.documentElement.dataset.inputMode === mode) return;
    this.inputMode = mode;
    document.documentElement.dataset.inputMode = mode;
    if (mode === 'desktop') {
      this.resetTouchMovement();
      this.resetTouchLook();
    }
  }

  private capturePointer(element: HTMLElement, pointerId: number): void {
    try {
      element.setPointerCapture(pointerId);
    } catch {
      // Synthetic test events and older mobile engines can reject pointer capture.
    }
  }

  private releasePointer(element: HTMLElement, pointerId: number): void {
    try {
      if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
    } catch {
      // The pointer may already have been released by the browser.
    }
  }

  private readonly onPointerLockChange = () => {
    if (document.pointerLockElement !== this.canvas) this.clearTransientInput();
  };

  private getElement(selector: string): HTMLElement {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) throw new Error(`Missing input element: ${selector}`);
    return element;
  }

  private getButton(selector: string): HTMLButtonElement {
    const button = document.querySelector<HTMLButtonElement>(selector);
    if (!button) throw new Error(`Missing input button: ${selector}`);
    return button;
  }
}
