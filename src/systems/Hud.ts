import type { WallyLoadResult } from '../entities/Wally';

export type GameUiState = 'loading' | 'ready' | 'playing' | 'paused' | 'won';

export type HudActions = {
  onStart: () => void;
  onResume: () => void;
  onRestart: () => void;
  onPause: () => void;
  onMute: () => void;
};

export type SuccessSummary = {
  elapsedSeconds: number;
  wrongGuesses: number;
  crowdCount: number;
};

export class Hud {
  private readonly root = document.documentElement;
  private readonly startOverlay = this.getElement('#start-overlay');
  private readonly pauseOverlay = this.getElement('#pause-overlay');
  private readonly successOverlay = this.getElement('#success-overlay');
  private readonly startButton = this.getButton('#start-button');
  private readonly resumeButton = this.getButton('#resume-button');
  private readonly pauseRestartButton = this.getButton('#pause-restart-button');
  private readonly successRestartButton = this.getButton('#success-restart-button');
  private readonly pauseButton = this.getButton('#pause-button');
  private readonly muteButton = this.getButton('#mute-button');
  private readonly muteIcon = this.getElement('#mute-icon');
  private readonly loadingStatus = this.getElement('#loading-status');
  private readonly loadingCopy = this.getElement('#loading-copy');
  private readonly timerValue = this.getElement('#timer-value');
  private readonly timerCluster = this.getElement('#timer-cluster');
  private readonly penaltyValue = this.getElement('#penalty-value');
  private readonly crowdValue = this.getElement('#crowd-value');
  private readonly densityValue = this.getElement('#density-value');
  private readonly feedbackBanner = this.getElement('#feedback-banner');
  private readonly crosshair = this.getElement('#crosshair');
  private readonly resultTime = this.getElement('#result-time');
  private readonly resultWrongs = this.getElement('#result-wrongs');
  private readonly resultCrowd = this.getElement('#result-crowd');
  private feedbackTimeout = 0;
  private penaltyTimeout = 0;
  private crosshairTimeout = 0;
  private lastTimer = '';

  constructor(private readonly actions: HudActions) {
    this.startButton.addEventListener('click', this.actions.onStart);
    this.resumeButton.addEventListener('click', this.actions.onResume);
    this.pauseRestartButton.addEventListener('click', this.actions.onRestart);
    this.successRestartButton.addEventListener('click', this.actions.onRestart);
    this.pauseButton.addEventListener('click', this.actions.onPause);
    this.muteButton.addEventListener('click', this.actions.onMute);
  }

  setState(state: GameUiState): void {
    this.root.dataset.gameState = state;
    this.startOverlay.classList.toggle('is-hidden', state !== 'loading' && state !== 'ready');
    this.pauseOverlay.classList.toggle('is-hidden', state !== 'paused');
    this.successOverlay.classList.toggle('is-hidden', state !== 'won');

    if (state === 'paused') window.setTimeout(() => this.resumeButton.focus(), 0);
    if (state === 'won') window.setTimeout(() => this.successRestartButton.focus(), 0);
  }

  setLoadingProgress(ratio: number | null): void {
    this.loadingStatus.classList.remove('is-ready', 'is-fallback');
    this.startButton.disabled = true;
    this.loadingCopy.textContent = ratio === null
      ? 'Loading…'
      : `Loading — ${Math.round(ratio * 100)}%`;
  }

  setLoadingError(message: string): void {
    this.loadingStatus.classList.remove('is-ready');
    this.loadingStatus.classList.add('is-fallback');
    this.loadingCopy.textContent = message;
    this.startButton.disabled = true;
  }

  setReady(result: WallyLoadResult): void {
    this.loadingStatus.classList.add('is-ready');
    this.loadingStatus.classList.toggle('is-fallback', result.fallback);
    this.loadingCopy.textContent = result.message;
    this.startButton.disabled = false;
  }

  setCrowd(count: number, densityLabel: string): void {
    this.crowdValue.textContent = count.toLocaleString('en-US');
    this.densityValue.textContent = densityLabel;
  }

  updateTimer(elapsedSeconds: number, wrongGuesses: number): void {
    const formatted = this.formatTime(elapsedSeconds);
    if (formatted !== this.lastTimer) {
      this.timerValue.textContent = formatted;
      this.lastTimer = formatted;
    }
    this.penaltyValue.textContent = wrongGuesses === 0
      ? 'No penalties'
      : `+${wrongGuesses * 5}s · ${wrongGuesses} wrong`;
  }

  showFeedback(message: string, tone: 'wrong' | 'correct' | 'neutral'): void {
    window.clearTimeout(this.feedbackTimeout);
    this.feedbackBanner.textContent = message;
    this.feedbackBanner.dataset.tone = tone;
    this.feedbackBanner.classList.add('is-visible');
    this.feedbackTimeout = window.setTimeout(() => {
      this.feedbackBanner.classList.remove('is-visible');
    }, tone === 'correct' ? 1800 : 1300);
  }

  flashPenalty(): void {
    window.clearTimeout(this.penaltyTimeout);
    this.timerCluster.classList.remove('has-penalty');
    void this.timerCluster.offsetWidth;
    this.timerCluster.classList.add('has-penalty');
    this.penaltyTimeout = window.setTimeout(() => {
      this.timerCluster.classList.remove('has-penalty');
    }, 420);
    this.flashCrosshair('is-wrong', 310);
  }

  flashCorrect(): void {
    this.flashCrosshair('is-correct', 560);
  }

  setMuted(muted: boolean): void {
    this.muteButton.classList.toggle('is-muted', muted);
    this.muteButton.setAttribute('aria-label', muted ? 'Unmute sound' : 'Mute sound');
    this.muteButton.title = muted ? 'Unmute (M)' : 'Mute (M)';
    this.muteIcon.textContent = muted ? '◖×' : '◖))';
  }

  showSuccess(summary: SuccessSummary): void {
    this.resultTime.textContent = this.formatTime(summary.elapsedSeconds);
    this.resultWrongs.textContent = String(summary.wrongGuesses);
    this.resultCrowd.textContent = summary.crowdCount.toLocaleString('en-US');
  }

  dispose(): void {
    window.clearTimeout(this.feedbackTimeout);
    window.clearTimeout(this.penaltyTimeout);
    window.clearTimeout(this.crosshairTimeout);
    this.startButton.removeEventListener('click', this.actions.onStart);
    this.resumeButton.removeEventListener('click', this.actions.onResume);
    this.pauseRestartButton.removeEventListener('click', this.actions.onRestart);
    this.successRestartButton.removeEventListener('click', this.actions.onRestart);
    this.pauseButton.removeEventListener('click', this.actions.onPause);
    this.muteButton.removeEventListener('click', this.actions.onMute);
  }

  private flashCrosshair(className: 'is-wrong' | 'is-correct', duration: number): void {
    window.clearTimeout(this.crosshairTimeout);
    this.crosshair.classList.remove('is-wrong', 'is-correct');
    void this.crosshair.offsetWidth;
    this.crosshair.classList.add(className);
    this.crosshairTimeout = window.setTimeout(() => {
      this.crosshair.classList.remove(className);
    }, duration);
  }

  private formatTime(elapsedSeconds: number): string {
    const secondsTotal = Math.max(0, Math.floor(elapsedSeconds));
    const minutes = Math.floor(secondsTotal / 60).toString().padStart(2, '0');
    const seconds = (secondsTotal % 60).toString().padStart(2, '0');
    return `${minutes}:${seconds}`;
  }

  private getElement(selector: string): HTMLElement {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) throw new Error(`Missing HUD element: ${selector}`);
    return element;
  }

  private getButton(selector: string): HTMLButtonElement {
    const button = document.querySelector<HTMLButtonElement>(selector);
    if (!button) throw new Error(`Missing HUD button: ${selector}`);
    return button;
  }
}
