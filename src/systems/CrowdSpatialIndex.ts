export type CrowdSpatialBounds = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

export type CrowdSpatialIndexOptions = {
  positions: Float32Array;
  bounds: CrowdSpatialBounds;
  cellSize?: number;
  maximumDisplacement?: number;
};

export type CrowdSpatialIndexDiagnostics = {
  cellSize: number;
  gridColumns: number;
  gridRows: number;
  gridCells: number;
  indexedCharacters: number;
  bytes: number;
  maximumDisplacement: number;
};

/**
 * Compact static-cell index for a very large crowd.
 *
 * Crowd members may move locally, but the local push solver clamps them to
 * `maximumDisplacement` from their seeded position. Queries expand their cell
 * window by that amount, so the index never needs an O(N) rebuild during play.
 */
export class CrowdSpatialIndex {
  readonly count: number;
  readonly cellSize: number;
  readonly maximumDisplacement: number;

  private readonly positions: Float32Array;
  private readonly bounds: CrowdSpatialBounds;
  private readonly gridColumns: number;
  private readonly gridRows: number;
  private readonly gridHeads: Int32Array;
  private readonly gridNext: Int32Array;

  constructor(options: CrowdSpatialIndexOptions) {
    if (options.positions.length % 3 !== 0) {
      throw new Error('CrowdSpatialIndex positions must contain complete xyz triples.');
    }
    this.positions = options.positions;
    this.count = options.positions.length / 3;
    this.bounds = { ...options.bounds };
    this.cellSize = Math.max(0.5, finitePositive(options.cellSize, 2));
    this.maximumDisplacement = Math.max(
      0,
      finiteOr(options.maximumDisplacement, 0.75),
    );
    const width = Math.max(this.cellSize, this.bounds.maxX - this.bounds.minX);
    const depth = Math.max(this.cellSize, this.bounds.maxZ - this.bounds.minZ);
    this.gridColumns = Math.max(1, Math.ceil(width / this.cellSize));
    this.gridRows = Math.max(1, Math.ceil(depth / this.cellSize));
    this.gridHeads = new Int32Array(this.gridColumns * this.gridRows);
    this.gridNext = new Int32Array(this.count);
    this.build();
  }

  collectNearby(x: number, z: number, radius: number, target: number[]): number[] {
    target.length = 0;
    this.forEachNearby(x, z, radius, (characterIndex) => {
      target.push(characterIndex);
    });
    return target;
  }

  forEachNearby(
    x: number,
    z: number,
    radius: number,
    visitor: (characterIndex: number) => void,
  ): void {
    const safeRadius = Math.max(0, finiteOr(radius, 0));
    const indexedRadius = safeRadius + this.maximumDisplacement;
    const minCellX = this.getGridX(x - indexedRadius);
    const maxCellX = this.getGridX(x + indexedRadius);
    const minCellZ = this.getGridZ(z - indexedRadius);
    const maxCellZ = this.getGridZ(z + indexedRadius);
    const radiusSquared = safeRadius * safeRadius;

    for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
        let characterIndex = this.gridHeads[cellZ * this.gridColumns + cellX];
        while (characterIndex >= 0) {
          const offset = characterIndex * 3;
          const deltaX = this.positions[offset] - x;
          const deltaZ = this.positions[offset + 2] - z;
          if (deltaX * deltaX + deltaZ * deltaZ <= radiusSquared) {
            visitor(characterIndex);
          }
          characterIndex = this.gridNext[characterIndex];
        }
      }
    }
  }

  getDiagnostics(): CrowdSpatialIndexDiagnostics {
    return {
      cellSize: this.cellSize,
      gridColumns: this.gridColumns,
      gridRows: this.gridRows,
      gridCells: this.gridHeads.length,
      indexedCharacters: this.count,
      bytes: this.gridHeads.byteLength + this.gridNext.byteLength,
      maximumDisplacement: this.maximumDisplacement,
    };
  }

  private build(): void {
    this.gridHeads.fill(-1);
    for (let characterIndex = 0; characterIndex < this.count; characterIndex += 1) {
      const offset = characterIndex * 3;
      const cell = this.getGridCell(this.positions[offset], this.positions[offset + 2]);
      this.gridNext[characterIndex] = this.gridHeads[cell];
      this.gridHeads[cell] = characterIndex;
    }
  }

  private getGridCell(x: number, z: number): number {
    return this.getGridZ(z) * this.gridColumns + this.getGridX(x);
  }

  private getGridX(x: number): number {
    return clampInteger(
      Math.floor((x - this.bounds.minX) / this.cellSize),
      0,
      this.gridColumns - 1,
    );
  }

  private getGridZ(z: number): number {
    return clampInteger(
      Math.floor((z - this.bounds.minZ) / this.cellSize),
      0,
      this.gridRows - 1,
    );
  }
}

function finitePositive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? value as number : fallback;
}

function finiteOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? value as number : fallback;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}
