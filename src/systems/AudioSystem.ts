export type AudioDiagnostics = {
  supported: boolean;
  unlocked: boolean;
  muted: boolean;
  paused: boolean;
  contextState: AudioContextState | 'unavailable';
  ambienceActive: boolean;
};

type AudioGroup = 'ui' | 'sfx' | 'ambience';

export class AudioSystem {
  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private uiGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private ambienceGain: GainNode | null = null;
  private ambienceSource: AudioBufferSourceNode | null = null;
  private ambienceFilter: BiquadFilterNode | null = null;
  private unlocked = false;
  private muted = false;
  private paused = false;
  private disposed = false;

  async unlock(): Promise<void> {
    if (this.disposed) return;
    if (!this.context) this.createContext();
    if (!this.context) return;
    if (this.context.state !== 'running') await this.context.resume();
    this.unlocked = this.context.state === 'running';
    if (this.unlocked && !this.ambienceSource) this.startCrowdAmbience();
    this.applyMasterLevel(0.02);
    this.applyAmbienceLevel(0.08);
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    this.applyMasterLevel(0.035);
    return this.muted;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.applyAmbienceLevel(0.18);
  }

  uiConfirm(): void {
    this.playTone({ frequency: 510, endFrequency: 690, duration: 0.09, volume: 0.055, type: 'triangle' }, 'ui');
  }

  uiNeutral(): void {
    this.playTone({ frequency: 390, endFrequency: 350, duration: 0.075, volume: 0.035, type: 'sine' }, 'ui');
  }

  wrongGuess(): void {
    this.playTone({ frequency: 185, endFrequency: 92, duration: 0.24, volume: 0.075, type: 'sawtooth' }, 'sfx');
    this.playTone(
      { frequency: 136, endFrequency: 112, duration: 0.2, volume: 0.045, type: 'square', delay: 0.035 },
      'sfx',
    );
  }

  correctGuess(): void {
    [0, 0.095, 0.19, 0.3].forEach((delay, index) => {
      const notes = [392, 523.25, 659.25, 783.99];
      this.playTone(
        {
          frequency: notes[index],
          endFrequency: notes[index] * 1.015,
          duration: index === 3 ? 0.42 : 0.18,
          volume: index === 3 ? 0.07 : 0.055,
          type: index === 3 ? 'sine' : 'triangle',
          delay,
        },
        'sfx',
      );
    });
  }

  getDiagnostics(): AudioDiagnostics {
    return {
      supported: this.getAudioContextClass() !== null,
      unlocked: this.unlocked,
      muted: this.muted,
      paused: this.paused,
      contextState: this.context?.state ?? 'unavailable',
      ambienceActive: this.ambienceSource !== null,
    };
  }

  dispose(): void {
    this.disposed = true;
    try {
      this.ambienceSource?.stop();
    } catch {
      // A source that already ended cannot be stopped again in every browser.
    }
    this.ambienceSource?.disconnect();
    this.ambienceFilter?.disconnect();
    this.masterGain?.disconnect();
    this.ambienceSource = null;
    this.ambienceFilter = null;
    this.masterGain = null;
    this.uiGain = null;
    this.sfxGain = null;
    this.ambienceGain = null;
    void this.context?.close();
    this.context = null;
    this.unlocked = false;
  }

  private createContext(): void {
    const AudioContextClass = this.getAudioContextClass();
    if (!AudioContextClass) return;

    this.context = new AudioContextClass({ latencyHint: 'interactive' });
    this.masterGain = this.context.createGain();
    this.uiGain = this.context.createGain();
    this.sfxGain = this.context.createGain();
    this.ambienceGain = this.context.createGain();

    this.masterGain.gain.value = 0.82;
    this.uiGain.gain.value = 0.85;
    this.sfxGain.gain.value = 0.9;
    this.ambienceGain.gain.value = 0.024;
    this.uiGain.connect(this.masterGain);
    this.sfxGain.connect(this.masterGain);
    this.ambienceGain.connect(this.masterGain);
    this.masterGain.connect(this.context.destination);
  }

  private startCrowdAmbience(): void {
    if (!this.context || !this.ambienceGain || this.ambienceSource) return;
    const sampleRate = this.context.sampleRate;
    const durationSeconds = 4;
    const frameCount = sampleRate * durationSeconds;
    const buffer = this.context.createBuffer(2, frameCount, sampleRate);
    let seed = 0x45d9f3b;

    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const samples = buffer.getChannelData(channel);
      let brown = 0;
      let murmur = 0;
      for (let index = 0; index < samples.length; index += 1) {
        seed = Math.imul(seed ^ (seed >>> 16), 0x45d9f3b);
        seed = Math.imul(seed ^ (seed >>> 16), 0x45d9f3b);
        const white = ((seed ^ (seed >>> 16)) >>> 0) / 2147483648 - 1;
        brown = brown * 0.985 + white * 0.015;
        const slowEnvelope = 0.72 + Math.sin(index * 0.00017 + channel * 1.7) * 0.16;
        murmur = murmur * 0.91 + white * 0.09;
        samples[index] = (brown * 0.72 + murmur * 0.18) * slowEnvelope * 0.34;
      }
    }

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const filter = this.context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 430;
    filter.Q.value = 0.32;
    source.connect(filter).connect(this.ambienceGain);
    source.start();
    this.ambienceSource = source;
    this.ambienceFilter = filter;
  }

  private playTone(
    options: {
      frequency: number;
      endFrequency: number;
      duration: number;
      volume: number;
      type: OscillatorType;
      delay?: number;
    },
    group: AudioGroup,
  ): void {
    if (!this.context || this.context.state !== 'running' || this.muted) return;
    const destination = this.getGroupGain(group);
    if (!destination) return;

    const oscillator = this.context.createOscillator();
    const envelope = this.context.createGain();
    const start = this.context.currentTime + (options.delay ?? 0);
    const end = start + options.duration;
    oscillator.type = options.type;
    oscillator.frequency.setValueAtTime(options.frequency, start);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, options.endFrequency), end);
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(options.volume, start + Math.min(0.018, options.duration * 0.22));
    envelope.gain.exponentialRampToValueAtTime(0.0001, end);
    oscillator.connect(envelope).connect(destination);
    oscillator.start(start);
    oscillator.stop(end + 0.01);
  }

  private getGroupGain(group: AudioGroup): GainNode | null {
    if (group === 'ui') return this.uiGain;
    if (group === 'ambience') return this.ambienceGain;
    return this.sfxGain;
  }

  private applyMasterLevel(rampSeconds: number): void {
    if (!this.context || !this.masterGain) return;
    const now = this.context.currentTime;
    this.masterGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.setValueAtTime(Math.max(0.0001, this.masterGain.gain.value), now);
    this.masterGain.gain.exponentialRampToValueAtTime(this.muted ? 0.0001 : 0.82, now + rampSeconds);
  }

  private applyAmbienceLevel(rampSeconds: number): void {
    if (!this.context || !this.ambienceGain) return;
    const now = this.context.currentTime;
    this.ambienceGain.gain.cancelScheduledValues(now);
    this.ambienceGain.gain.setValueAtTime(Math.max(0.0001, this.ambienceGain.gain.value), now);
    this.ambienceGain.gain.exponentialRampToValueAtTime(this.paused ? 0.0001 : 0.024, now + rampSeconds);
  }

  private getAudioContextClass(): typeof AudioContext | null {
    return (
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ||
      null
    );
  }
}
