import { OctoMapPathAlgorithm } from '../octomap-3d-pcd.model';
import { OctoMapNavSurface } from './octo-map-nav-surface';
import { OctoMapPathPlanner } from './octo-map-path-planner';

/**
 * 现有那条寻路：**每列一个常数虚拟地面**的表面图上做 A*。
 *
 * 这是从 `OctoMapPathController` 里原样搬过来的那一套，行为一个字节没动（重构前后
 * 的真图基线逐点相同，见 `q:\tmp\path-baseline.mjs`）。保留它不只是为了对照：它带来
 * 的两件事是别的建图方式不好替代的——空列一定有节点（`groundExtendsOutside` 因此
 * 能工作，小狗可以绕到建筑外面去），以及平面上的代价处处相同（因此不会为了抄近路
 * 而跳着走）。
 *
 * 它的代价则记在 {@link OctoMapPathAlgorithm} 上：那些虚拟地面 run 的高度是个**常数**，
 * 跟它旁边有没有地板无关。
 */
export class OctoMapPathSurfaceGraphController extends OctoMapPathPlanner {
  readonly algorithm: OctoMapPathAlgorithm = 'surfaceGraph';

  /**
   * 末位那个 `fillBaseCells` **收下但不用**：这一档根本不填（`fillFromNeighbors` 关着），
   * 没有认领高度、也就没有那道「拿多大邻域当基准」的守卫。参数留着只是为了满足基类的
   * 签名——按算法的实际需要收参数，比在基类上开一个「哪些算法用得上」的开关干净。
   */
  protected override buildSurface(
    positions: Float32Array | null,
    nx: number,
    nz: number,
    minX: number,
    minZ: number,
    cell: number,
    groundLevel: number,
    _fillBaseCells: number,
  ): OctoMapNavSurface {
    return OctoMapNavSurface.build(positions, nx, nz, minX, minZ, cell, groundLevel);
  }
}
