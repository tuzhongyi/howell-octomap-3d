import { OctomapPathAlgorithm } from '../octomap-3d-pcd.model';
import { Octomap3dPcdNavSurface } from './octomap-3d-pcd-nav-surface';
import { Octomap3dPcdPathPlanner } from './octomap-3d-pcd-path-planner';

/**
 * 第二种寻路：表面图还是同一张，只是**虚拟地面不用常数了**——每个没点的列从切比雪夫
 * 距离最近的、有点的列认领它的面高（见 `Octomap3dPcdNavSurface.build` 的 `fillFromNeighbors`）。
 *
 * 与 {@link Octomap3dPcdPathSurfaceGraph} 的关系是**只差建图这一步**：搜索、平滑、
 * 起终点吸附、失败判定全是基类那一份。要不要它取决于用户想量哪件事——`'surfaceGraph'`
 * 答的是「在名义地面上怎么走」，它答的是「**在云点这张面上**怎么走」，于是铲平坑洼、
 * 补全一片云点会直接反映到路线上。
 *
 * 两个已知的取舍，选它之前要知道：
 *
 * - **补的是缺口，不是重建地板**。填充只覆盖有点的列 `R` 格之内（半径按点云自己的稀疏
 *   度推，真图上是 2 格、覆盖空列的 13.7%），远离任何点的地方仍旧退回 `groundLevel`。
 *   所以整片没扫到的房间不会因为切到这一档就长出地板来。
 * - **可站判定的墙带整体上移**。虚拟地面从 `groundLevel` 抬到真实地板的高度（真图上
 *   0.17 m）之后，`(面高 + 跨越高度, 面高 + 通行高度]` 那道「挡路但不挡头」的墙带跟着
 *   上移，于是哪些家具开始挡路会变（`q:\tmp` 上量过的那道悬崖，见 nav-wall-band-cliff）。
 *   这是这个算法**想要**的后果，但它意味着路线会与另一档不同，不算回归。
 */
export class Octomap3dPcdPathCloudFit extends Octomap3dPcdPathPlanner {
  readonly algorithm: OctomapPathAlgorithm = 'cloudFit';

  /** 与基类的差别只有那个 `true`：打开「空列从邻居取面高」。 */
  protected override buildSurface(
    positions: Float32Array | null,
    nx: number,
    nz: number,
    minX: number,
    minZ: number,
    cell: number,
    groundLevel: number,
    fillBaseCells: number,
  ): Octomap3dPcdNavSurface {
    return Octomap3dPcdNavSurface.build(
      positions,
      nx,
      nz,
      minX,
      minZ,
      cell,
      groundLevel,
      true,
      fillBaseCells,
    );
  }

  /**
   * 门槛从「一格」换成「一个跨越高度」，因为填充把基类那条前提拿掉了：
   * 基类的判据是「这一坨里有没有高度 ≈ `groundLevel` 的列」，而填充过的空列读的是
   * **局部**地板高度（真图上 0.3 m 上下），不再是 `groundLevel`。
   *
   * 后果是真图上的**假阳性**：小狗站在一片连通性不好的真实地板上（0.3 m），它的岛里
   * 一个贴 `groundLevel` 的列都没有，`lowest − groundLevel = 0.36 m > 一格` 成立 →
   * 报「小狗站在离地 0.36 m 的地方下不来」，而它明明站在地板上。
   *
   * 换成跨越高度之后判的是**这件事本身**：从这一坨最低的面下去、够不够得着名义地面。
   * `lowest − groundLevel > 跨越高度` 就是这只狗迈不下去，与文案给的建议（「把它挪到
   * 地面上」）口径一致；而 `groundLevel` 与真实地板之间那 0.17 m 的落差不再顶到门槛上。
   *
   * 副作用是「矮一点的高台不再报 `dogStuck`」（比如离地 0.4 m 而跨越高度 0.5 m）——那
   * 情形下小狗本来就迈得下去，不报才对。
   */
  protected override islandFloatMargin(_cell: number, step: number): number {
    return step;
  }
}
