import { OctomapPointCloud } from '../octomap-3d-pcd.model';

/**
 * 查看器一次愿意渲染的体素上限。与 `buildVoxels` 共用同一个数字，避免两处
 * 上限各自漂移：抽稀结果超过它，查看器同样会拒绝。
 *
 * 查看器自己遇到超限不再直接报错：它把格边长翻倍重试，直到落进这个数以内
 * （见 `octomap-3d-pcd-point.controller.ts` 的 `buildVoxels`），并在工具栏说明实际用了哪一档。
 */
export const MAX_VOXEL_COUNT = 2_000_000;

/**
 * 数值体素键在单轴上的格数（每轴可表示 ±65536 格）。三轴各占 17 位，合起来
 * 约 2^51，仍在 2^53 以内，因此用 double 做键精确无碰撞。**不能放宽**：21/21/21
 * 会到 2^63，double 失去整数精确性，不同格子会算出同一个键。
 */
const KEY_RANGE = 65536;
const KEY_SHIFT_Y = 2 ** 17;
const KEY_SHIFT_X = 2 ** 34;
const KEY_OFFSET = 65536;

/** 累加器超过体素上限时抛出，便于调用方区分并提示换用更大的体素尺寸。 */
export class VoxelLimitError extends Error {
  /** 触发时的体素数量。 */
  readonly cellCount: number;
  /** 允许的上限。 */
  readonly maxCells: number;

  constructor(cellCount: number, maxCells: number) {
    super(`体素数量超过上限 (${cellCount} > ${maxCells})`);
    this.name = 'VoxelLimitError';
    this.cellCount = cellCount;
    this.maxCells = maxCells;
  }
}

/**
 * 把大点云按体素抽稀成小点云，语义与查看器的 `buildVoxels` 对齐：
 * 每格的颜色取**格内平均**，输出的点落在**格中心**，而不是「每格留第一个点」。
 *
 * 原点固定为 `[0, 0, 0]`（而不是包围盒最小值），因此是单遍处理——不需要为了
 * 求包围盒先把几十 GB 的数据扫一遍，这在流式读取里是决定性的。
 *
 * 输出用格中心（而非某个原始点）是刻意的，这让结果尺寸可预测：把抽稀结果交给
 * 查看器、用同一个体素尺寸再体素化一次时，每个点最多只会落到 0 或 1 格之外，
 * 因此**格数只会持平或略减，绝不会增长**——抽稀到不超过上限，就一定不会撞上
 * 查看器自己的上限。略减的原因是浮点：查看器以包围盒最小值为原点，而这个值
 * 本身就是一个格中心（即它自己的格边界），于是每个抽稀点都恰好压在边界上，
 * 极少数相邻格会因舍入而合并（实测约 0.02%）。
 */
export class VoxelAccumulator {
  private readonly voxelSize: number;
  private readonly maxCells: number;
  /** 数值体素键 → 槽位下标，槽位按首次出现顺序分配。 */
  private readonly slots = new Map<number, number>();
  /** 各格的整数格坐标；与 `slots` 一一对应。 */
  private cellX: Int32Array;
  private cellY: Int32Array;
  private cellZ: Int32Array;
  /** 各格的颜色分量之和与点数，仅在带颜色时累加。 */
  private sumR: Float64Array;
  private sumG: Float64Array;
  private sumB: Float64Array;
  private hits: Int32Array;
  private used = 0;
  private beyondRange = 0;

  constructor(voxelSize: number, maxCells: number = MAX_VOXEL_COUNT) {
    if (!(voxelSize > 0)) {
      throw new Error(`体素尺寸必须是正数 (${voxelSize})`);
    }
    this.voxelSize = voxelSize;
    this.maxCells = maxCells;
    const capacity = 1024;
    this.cellX = new Int32Array(capacity);
    this.cellY = new Int32Array(capacity);
    this.cellZ = new Int32Array(capacity);
    this.sumR = new Float64Array(capacity);
    this.sumG = new Float64Array(capacity);
    this.sumB = new Float64Array(capacity);
    this.hits = new Int32Array(capacity);
  }

  /** 已占用的体素数量。 */
  get cellCount(): number {
    return this.used;
  }

  /** 因坐标超出可表示范围而被丢弃的点数。 */
  get outOfRangeCount(): number {
    return this.beyondRange;
  }

  /** 把一个点并入它所属的体素。`r`/`g`/`b` 仅在 `hasColor` 为真时参与平均。 */
  add(x: number, y: number, z: number, r: number, g: number, b: number, hasColor: boolean): void {
    const ix = Math.floor(x / this.voxelSize);
    const iy = Math.floor(y / this.voxelSize);
    const iz = Math.floor(z / this.voxelSize);
    // 取反的写法顺带挡掉 NaN（NaN 的比较恒为 false）。
    if (
      !(ix >= -KEY_RANGE && ix < KEY_RANGE) ||
      !(iy >= -KEY_RANGE && iy < KEY_RANGE) ||
      !(iz >= -KEY_RANGE && iz < KEY_RANGE)
    ) {
      this.beyondRange += 1;
      return;
    }

    const key = (ix + KEY_OFFSET) * KEY_SHIFT_X + (iy + KEY_OFFSET) * KEY_SHIFT_Y + (iz + KEY_OFFSET);
    let slot = this.slots.get(key);
    if (slot === undefined) {
      if (this.used === this.cellX.length) {
        this.grow();
      }
      slot = this.used++;
      this.slots.set(key, slot);
      this.cellX[slot] = ix;
      this.cellY[slot] = iy;
      this.cellZ[slot] = iz;
      // 新格子的大小恰好等于上限时，再收一个点就已经越界了，此刻中止——
      // 比跑完整份数据再报错快得多（几秒 vs 几分钟），也不会先吃掉几百 MB 内存。
      if (this.used > this.maxCells) {
        throw new VoxelLimitError(this.used, this.maxCells);
      }
    }
    if (hasColor) {
      this.sumR[slot] += r;
      this.sumG[slot] += g;
      this.sumB[slot] += b;
      this.hits[slot] += 1;
    }
  }

  /**
   * 导出抽稀后的点云：每格一个点，位于格中心；带颜色时为格内平均色。
   * 输出顺序是各格首次出现的顺序，因此对同一份输入稳定可复现。
   */
  toCloud(hasColors: boolean): OctomapPointCloud {
    const count = this.used;
    if (count === 0) {
      throw new Error('抽稀后没有任何点');
    }

    const size = this.voxelSize;
    const positions = new Float32Array(count * 3);
    const colors = hasColors ? new Float32Array(count * 3) : null;

    for (let slot = 0; slot < count; slot++) {
      const offset = slot * 3;
      positions[offset] = (this.cellX[slot] + 0.5) * size;
      positions[offset + 1] = (this.cellY[slot] + 0.5) * size;
      positions[offset + 2] = (this.cellZ[slot] + 0.5) * size;
      if (colors) {
        // 没有颜色点的格子（理论上不会出现）保持黑色，而不是除以零。
        const hits = this.hits[slot];
        if (hits > 0) {
          colors[offset] = this.sumR[slot] / hits;
          colors[offset + 1] = this.sumG[slot] / hits;
          colors[offset + 2] = this.sumB[slot] / hits;
        }
      }
    }

    const cloud: OctomapPointCloud = { positions, pointCount: count };
    if (colors) {
      cloud.colors = colors;
    }
    return cloud;
  }

  /** 槽位数组容量翻倍。 */
  private grow(): void {
    const capacity = this.cellX.length * 2;
    this.cellX = growInt32(this.cellX, capacity);
    this.cellY = growInt32(this.cellY, capacity);
    this.cellZ = growInt32(this.cellZ, capacity);
    this.hits = growInt32(this.hits, capacity);
    this.sumR = growFloat64(this.sumR, capacity);
    this.sumG = growFloat64(this.sumG, capacity);
    this.sumB = growFloat64(this.sumB, capacity);
  }
}

function growInt32(source: Int32Array, capacity: number): Int32Array {
  const next = new Int32Array(capacity);
  next.set(source);
  return next;
}

function growFloat64(source: Float64Array, capacity: number): Float64Array {
  const next = new Float64Array(capacity);
  next.set(source);
  return next;
}
