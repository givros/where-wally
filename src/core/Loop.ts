export class Loop {
  private frameId = 0;
  private lastTime = 0;
  private running = false;

  constructor(
    private readonly update: (
      simulationDeltaSeconds: number,
      elapsedSeconds: number,
      realDeltaSeconds: number,
    ) => void,
    private readonly render: () => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.frameId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.frameId);
  }

  private readonly tick = (time: number) => {
    if (!this.running) return;
    const realDeltaSeconds = Math.max(0, (time - this.lastTime) / 1000);
    const simulationDeltaSeconds = Math.min(realDeltaSeconds, 0.05);
    this.lastTime = time;
    this.update(simulationDeltaSeconds, time / 1000, realDeltaSeconds);
    this.render();
    this.frameId = requestAnimationFrame(this.tick);
  };
}
