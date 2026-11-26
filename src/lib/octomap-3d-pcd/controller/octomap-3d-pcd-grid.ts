/** 网格内的体素坐标。 */
export interface OctoMapGridCoord {
  ix: number;
  iy: number;
  iz: number;
}

/**
 * 由点云构建的常驻体素网格。每个占用单元映射到渲染的
 * InstancedMesh 中的一个实例索引，并带有基准颜色以及
 * 供刷选和寻路使用的禁行（障碍）标记。
 *
 * 单元用紧凑的 `${ix},${iy},${iz}` 键寻址；单元的世界
 * 坐标位置由{@link min} + {@link voxelSize} 推导。
 */
export class Octomap3dPcdVoxelGrid {
  /** 网格最小角的世界坐标位置（与点云边界一致）。 */
  readonly min: [number, number, number];
  /** 一个体素的边长（世界单位）。 */
  readonly voxelSize: number;
  /** 已刷障碍单元（{@link cells} 的子集）。 */
  readonly forbidden = new Set<string>();

  private readonly cells = new Map<string, number>();
  private readonly byInstance = new Map<number, string>();
  private readonly baseColors = new Map<string, [number, number, number]>();

  constructor(min: [number, number, number], voxelSize: number) {
    this.min = min;
    this.voxelSize = voxelSize;
  }

  static key(ix: number, iy: number, iz: number): string {
    return `${ix},${iy},${iz}`;
  }

  static parse(key: string): OctoMapGridCoord {
    const [ix, iy, iz] = key.split(',').map(Number);
    return { ix, iy, iz };
  }

  add(
    ix: number,
    iy: number,
    iz: number,
    instanceId: number,
    baseColor: [number, number, number],
  ): void {
    const key = Octomap3dPcdVoxelGrid.key(ix, iy, iz);
    this.cells.set(key, instanceId);
    this.byInstance.set(instanceId, key);
    this.baseColors.set(key, baseColor);
  }

  /** 添加一个单元（已存在时不做任何事），返回其键。 */
  addCell(ix: number, iy: number, iz: number, baseColor: [number, number, number]): string {
    const key = Octomap3dPcdVoxelGrid.key(ix, iy, iz);
    if (this.cells.has(key)) {
      return key;
    }
    this.cells.set(key, this.cells.size);
    this.baseColors.set(key, baseColor);
    return key;
  }

  /** 移除一个单元及其全部辅助数据。存在时返回 true。 */
  remove(key: string): boolean {
    const instanceId = this.cells.get(key);
    if (instanceId === undefined) {
      return false;
    }
    this.cells.delete(key);
    this.byInstance.delete(instanceId);
    this.baseColors.delete(key);
    this.forbidden.delete(key);
    return true;
  }

  /** 在添加/移除操作后重新分配紧凑的实例 id（0..size-1）。 */
  compact(): void {
    this.byInstance.clear();
    let id = 0;
    for (const key of this.cells.keys()) {
      this.cells.set(key, id);
      this.byInstance.set(id, key);
      id++;
    }
  }

  has(key: string): boolean {
    return this.cells.has(key);
  }

  baseColor(key: string): [number, number, number] | undefined {
    return this.baseColors.get(key);
  }

  instanceId(key: string): number | undefined {
    return this.cells.get(key);
  }

  keyOfInstance(instanceId: number): string | undefined {
    return this.byInstance.get(instanceId);
  }

  get size(): number {
    return this.cells.size;
  }

  worldToVoxel(x: number, y: number, z: number): OctoMapGridCoord {
    return {
      ix: Math.floor((x - this.min[0]) / this.voxelSize),
      iy: Math.floor((y - this.min[1]) / this.voxelSize),
      iz: Math.floor((z - this.min[2]) / this.voxelSize),
    };
  }

  /** 单元的世界坐标中心。 */
  center(key: string): [number, number, number] {
    const { ix, iy, iz } = Octomap3dPcdVoxelGrid.parse(key);
    return [
      this.min[0] + (ix + 0.5) * this.voxelSize,
      this.min[1] + (iy + 0.5) * this.voxelSize,
      this.min[2] + (iz + 0.5) * this.voxelSize,
    ];
  }

  /** 距世界点最近的占用单元（逐层扩展搜索），没有则为 null。 */
  nearest(x: number, y: number, z: number): string | null {
    if (this.cells.size === 0) {
      return null;
    }
    const { ix, iy, iz } = this.worldToVoxel(x, y, z);
    for (let r = 0; r < 256; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dz = -r; dz <= r; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) {
              continue;
            }
            const key = Octomap3dPcdVoxelGrid.key(ix + dx, iy + dy, iz + dz);
            if (this.cells.has(key)) {
              return key;
            }
          }
        }
      }
    }
    return null;
  }

  /** 一个单元的 26 邻接占用邻居。 */
  neighbors(key: string): string[] {
    const { ix, iy, iz } = Octomap3dPcdVoxelGrid.parse(key);
    const result: string[] = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (dx === 0 && dy === 0 && dz === 0) {
            continue;
          }
          const neighbor = Octomap3dPcdVoxelGrid.key(ix + dx, iy + dy, iz + dz);
          if (this.cells.has(neighbor)) {
            result.push(neighbor);
          }
        }
      }
    }
    return result;
  }

  /** 遍历每个占用单元及其实例 id 和基准颜色。 */
  *entries(): IterableIterator<{
    key: string;
    instanceId: number;
    base: [number, number, number];
  }> {
    for (const [key, instanceId] of this.cells) {
      yield { key, instanceId, base: this.baseColors.get(key)! };
    }
  }
}
