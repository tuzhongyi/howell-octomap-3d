import { Injectable } from '@angular/core';
import {
  OctomapPaintedVoxels,
  OctomapPointCloud,
  OctomapProjectionSource,
} from '../octomap-3d-pcd.model';
import { Octomap3dPcdDog } from './octomap-3d-pcd-dog.controller';
import { Octomap3dPcdGlobal } from './octomap-3d-pcd-global.controller';
import { OctomapGroundExtent } from './octomap-3d-pcd-ground-plane';
import { Octomap3dPcdPath } from './octomap-3d-pcd-path.controller';
import { Octomap3dPcdGrille, OctomapRenderOptions } from './octomap-3d-pcd-point.controller';

/**
 * 将场景级（{@link Octomap3dPcdGlobal}）、点相关（{@link Octomap3dPcdGrille}）、
 * 导航（{@link Octomap3dPcdPath}）和小狗（{@link Octomap3dPcdDog}）
 * 控制器串联成一个门面，使组件只需调用这里，而不必自己把它们接在一起。
 */
@Injectable()
export class Octomap3dPcd {
  constructor(
    public readonly grille: Octomap3dPcdGrille,
    public readonly global: Octomap3dPcdGlobal,
    public readonly dog: Octomap3dPcdDog,
    public readonly path: Octomap3dPcdPath,
  ) {}

  /**
   * 重建点云，然后刷新灯光并（可选）重新适配相机。
   *
   * 三个「要不要跟着换」的开关，默认一致、实际只有一处会分叉：
   *
   * - `fit`：**几何推导**（包围盒、地板高度）——只有「换个渲染方式」这类原地重画
   *   才会给 false，因为它读的是同一份 positions。
   * - `refitCamera`：相机。同一份云挪个位置时不给——机位是用户自己调好的，每改
   *   一次就跳回默认视角没人受得了。
   * - `refitReference`：参考物（网格 + 地面平面）的锚点。只有**换了一份云**或
   *   **换了一套坐标系**才重定；原地转/挪时钉着不动，云在它上面滑过去，用户才看
   *   得出挪了多少（参考物跟着走的话，整幅画一起平移，看着像什么都没发生）。
   */
  rebuild(
    points: OctomapPointCloud | null,
    options: OctomapRenderOptions,
    fit: boolean,
    ground: OctomapGroundExtent,
    refitCamera = fit,
    refitReference = refitCamera,
  ): void {
    this.grille.rebuild(points, options, fit);
    // 平移手柄抓的是整片云的重心，云换了位置它就得跟着走。
    this.global.moveGizmoTo(this.grille.boundingBox);
    this.global.updateLights(this.grille.boundingBox);
    this.global.anchorReference(this.grille.boundingBox, this.grille.groundLevel, refitReference);
    // 锚点定完才知道那块灰平面在哪：回填给 grille，宿主靠它做「贴合地面」。
    this.grille.setReferenceLevel(this.global.referenceLevel);
    this.global.updateGroundPlane(this.grille.boundingBox, ground, this.grille.groundLevel);
    this.global.alignGrid(this.grille.boundingBox);
    // 规划上限范围的边界线**不**归参考物那一套（见上面 `refitReference`）：它画的
    // 是「规划能到哪儿」，是点云的属性，云挪到哪儿它就跟到哪儿——钉住反而会让那条
    // 线罩不住云。
    this.path.setBounds(this.grille.boundingBox, this.grille.groundLevel);
    // 换了点云，渲染体素大小（自动时由包围盒算出）跟着变，锥和管的下限也变。
    this.syncMarkerScale();
    if (options.fitView && refitCamera) {
      this.global.fitCamera(this.grille.boundingBox);
    }
  }

  /** 调整地面大小，使其与当前的“地面向外延伸”设置匹配。 */
  updateGroundPlane(ground: OctomapGroundExtent): void {
    this.global.updateGroundPlane(this.grille.boundingBox, ground, this.grille.groundLevel);
  }

  /**
   * 在体素中心周围刷上障碍。返回值原样来自
   * {@link Octomap3dPcdPoint.brushAt}——`occupied === 0` 就是「这一带没有点」，
   * 调用方拿它决定要不要提示（见 `OctomapBrushMissDetail`）。
   */
  brush(
    center: [number, number, number],
    radius: number,
    options: OctomapRenderOptions,
  ): { marked: number; occupied: number } {
    return this.grille.brushAt(center[0], center[1], center[2], radius, options);
  }

  /** 擦除体素中心周围的障碍（反向刷）。返回值见 {@link brush}；擦除侧不提示。 */
  erase(
    center: [number, number, number],
    radius: number,
    options: OctomapRenderOptions,
  ): { marked: number; occupied: number } {
    return this.grille.eraseAt(center[0], center[1], center[2], radius, options);
  }

  /** 将持久化的已刷集合重新应用到当前网格（不匹配时为空操作）。 */
  restorePainted(painted: OctomapPaintedVoxels | null, options: OctomapRenderOptions): void {
    this.grille.restorePainted(painted, options);
  }

  /** 将小狗放置到空闲的地面位置（A）并清除残留的路径。 */
  placeDog(position: [number, number, number]): void {
    this.dog.placeAt(position);
    this.path.clear();
  }

  /** 设置地面上的目的地（B）并清除残留的路径。 */
  placeGoal(position: [number, number, number]): void {
    this.path.setGoal(position);
    this.dog.stop();
    this.path.clear();
  }

  /** 将小狗移动到新的地面位置（拖动它时使用）。 */
  moveDog(position: [number, number, number]): void {
    this.dog.moveTo(position);
    this.path.clear();
  }

  /** 丢弃当前路径，不动小狗和终点。 */
  clearPath(): void {
    this.dog.stop();
    this.path.clear();
  }

  /** 移除小狗、终点和路径，以便用户从头重新部署。 */
  resetDeployment(): void {
    this.dog.remove();
    this.path.clearGoal();
    this.path.clear();
  }

  /** 更新小狗的碰撞体（半径 + 高度 + 可见性）。 */
  setDogCollision(radius: number, height: number, visible: boolean): void {
    this.dog.setCollisionRadius(radius);
    this.dog.setCollisionHeight(height);
    this.dog.setCollisionVisible(visible);
    // 终点锥和路径管都按碰撞足迹取尺寸，改了半径/高度它们要跟着变。
    this.syncMarkerScale();
  }

  /** 一次性将每个占用的体素标记为禁行障碍。 */
  markAllObstacles(options: OctomapRenderOptions): void {
    this.grille.markAllForbidden(options);
  }

  /**
   * 从小狗到终点运行 A* 并绘制路径（不行进）。路径沿地面跟随地形，能一步跨过
   * 地上的小坑（见 {@link OctomapMapSettings.crossWidth}）。
   */
  findPath(
    maxStepHeight: number,
    crossWidth: number,
    dogRadius: number,
    dogHeight: number,
    groundExtendsOutside: boolean,
  ): void {
    const params = { maxStepHeight, crossWidth, dogRadius, dogHeight };
    // 每次重新规划都从小狗的起点位置开始，而不是上一次行进或拖动后它停下的
    // 位置。
    this.dog.resetToStart();
    const grid = this.grille.grid;
    const positions = this.grille.positions;
    const bbox = this.grille.boundingBox;
    const start = this.dog.startPosition;
    const goal = this.path.goalPosition;
    if (!grid || !bbox || !start || !goal) {
      this.dog.stop();
      this.path.clear();
      console.log(
        `[寻路] 没算：${!grid || !bbox ? '点云还没加载' : '小狗和终点没放齐'}`,
      );
      return;
    }
    // 从「方向前端」起算：起点沿小狗的朝向偏移一个碰撞半径，正贴着碰撞体
    // （圆柱）的表面，路径就不会从小狗身体中间穿过。
    const front = this.dog.frontPosition() ?? start;
    // 在 octomap 的*空闲*空间中规划，避开占用的体素。
    const points = this.path.computePath(
      grid,
      positions,
      bbox,
      front,
      goal,
      maxStepHeight,
      crossWidth,
      dogRadius,
      dogHeight,
      groundExtendsOutside,
      this.grille.groundLevel,
    );
    if (!points || points.length < 2) {
      this.dog.stop();
      // 报哪个原因由规划器自己定（尺寸超限 > 小狗下不来 > 终点浮空 > 终点够不着 >
      // 搜不到，见 `Octomap3dPcdPath.failedReason`）：那四个字段都在它手上，
      // 这里只有一句话和一条折线。
      this.logPlan(start, goal, null, this.failureText(), params);
      this.path.noPath(this.path.failedReason(), null);
      return;
    }
    // 末端落在终点的接受范围之外：按没找到处理。规划器会尽量给出一条路，终点
    // 落在障碍里时它退而求其次吸附到最近站得住的地方（搜不过去时还会改用「可达
    // 的最近点」兜底），结果可能离用户点的位置任意远——那条路径画出来看着像模像
    // 样，狗其实没走到地方。
    //
    // 接受范围是一个**球**，不是地平面上的一圈——量三维。只量水平会让「停在终点
    // **正下方**」也算走到：终点悬在半空（点在一面薄墙、一条窄带的正上方）时，
    // `mapPoint` 会把它一路吸附到地面上，路径忠实地走到那个投影，水平差几厘米
    // → 判成成功，而狗离终点还差着好几米。用户看到的就是「路径找到了终点的投影」。
    //
    // 唯一的例外是**终点有面接着**（`goalOnFace`，终点是射线打在墙面、桌面、台阶
    // 立面上的原始命中点）：那时路径末端本来就该落在终点脚下的那个面上，竖直那一
    // 维归上面那条「落差」判据管——量三维会把「点墙面」这个常见手势一律判失败。
    // 两个分支与规划器里 `goalTooHigh` 那两条判据同源，见
    // `Octomap3dPcdPathPlanner` 的 `goalOnFace`。
    const end = points[points.length - 1];
    const distance = this.path.goalOnFace
      ? Math.hypot(end[0] - goal[0], end[2] - goal[2])
      : Math.hypot(end[0] - goal[0], end[1] - goal[1], end[2] - goal[2]);
    if (this.path.heightGap !== null) {
      // 高度那两种（终点够不着 / 小狗自己下不来）优先于「差多远」：这两种情形里末端离
      // 得远只是**症状**，根因是高度——报「差 0.3 m」会把用户引到「终点范围」那根滑杆
      // 上，而该动的是「跨越高度」，或者干脆把小狗挪个地方。走到这儿说明路径是画得出
      // 来的（末端是退而求其次的那个点），高度那两句话不报就只剩一句「路径 N 个点」，
      // 用户看着狗停在桌子底下，只会以为是自己没点准。
      //
      // 距离给 null：这里要用户动的不是终点范围，再报一个水平距离只会把人往那根滑杆上
      // 引（见 OctomapPathFailedDetail.distance）。到底哪一句由规划器定。
      this.dog.stop();
      this.logPlan(start, goal, points, this.failureText(), params);
      this.path.noPath(this.path.failedReason(), null);
      return;
    }
    if (distance > this.path.goalRadius) {
      this.dog.stop();
      this.logPlan(
        start,
        goal,
        points,
        `失败：路径没走到终点（末端离终点 ${distance.toFixed(2)} m，超出终点范围 ${this.path.goalRadius.toFixed(2)} m）`,
        params,
      );
      this.path.noPath('outOfRange', distance);
      return;
    }
    this.logPlan(start, goal, points, '成功', params);
    // 折线第一点就是碰撞体正前方，绘制与行进共用它。setPath 会把小狗挪到
    // 那里待命——放置点仍记在 startPosition 里，因此重新规划时它会先回到
    // 放置点再算一次，不会每次往前叠一个半径。
    this.dog.setPath(points);
    this.syncMarkerScale();
    this.path.render(points);
  }

  /**
   * 把这一次规划量到的几个距离打到控制台：**直线**、**能走多远**、**还差多少**。
   *
   * 界面上只说一句话（「路径没走到终点（差 X m）」之类），而这三个数一起看才能分清
   * 两种完全不同的失败：一种是**压根没算出折线**（`points` 为 null），另一种是**算出
   * 来了但只走了一半**——后者在界面上什么都不画（`noPath` 会清掉线），看着和「找不到
   * 路径」一模一样。而它恰恰是最容易被误判的一种：小狗明明往前走了几步，屏幕上却一片
   * 空白。
   *
   * `能走` 量的是折线末端到**小狗**的水平距离（问的是「往里走了多远」），不是折线的
   * 总长——绕路的路径这两个数会差出不少，所以路径总长另给一个数。末端到终点那一段
   * 就是界面上的「还差 X m」。
   */
  private logPlan(
    start: [number, number, number],
    goal: [number, number, number],
    points: [number, number, number][] | null,
    outcome: string,
    params: {
      maxStepHeight: number;
      crossWidth: number;
      dogRadius: number;
      dogHeight: number;
    },
  ): void {
    // 三个数各自的**量法**必须写在名字里，否则它们看着会互相打架。
    //
    // 「能走」量的是**折线本身的长度**——小狗真要迈过的距离。曾经它量的是
    // 「小狗 → 折线末端」的水平直线距离，于是和旁边的「路径长」对不上：折线
    // 不是从小狗脚下起算的，A* 用的是身前一个碰撞半径处的探测点（见 findPath），
    // 两个原点混在一起就会印出「能走 1.14 m（路径长 0.87 m）」这种看着不可能的行。
    // 起点挪了这一下也一并报出来，它正是那两个数对不上的原因。
    const straight = Math.hypot(goal[0] - start[0], goal[2] - start[2]);
    let walked = 0;
    let short = straight;
    let detail = '';
    if (points && points.length >= 2) {
      const end = points[points.length - 1];
      short = Math.hypot(goal[0] - end[0], goal[2] - end[2]);
      for (let i = 1; i < points.length; i++) {
        walked += Math.hypot(points[i][0] - points[i - 1][0], points[i][2] - points[i - 1][2]);
      }
      const lead = Math.hypot(points[0][0] - start[0], points[0][2] - start[2]);
      // 半格以下不提：折线本来就落在格心上，起点的吸附误差总有那么大。
      const leadText = lead > this.path.goalRadius / 5 ? `，起点在小狗前方 ${lead.toFixed(2)} m` : '';
      detail = `（${points.length} 点${leadText}）`;
    }
    console.log(
      `[寻路] 直线 ${straight.toFixed(2)} m ｜ 能走 ${walked.toFixed(2)} m ｜ 还差 ${short.toFixed(2)} m ｜ ${outcome}${detail}`,
    );
    console.log(
      `[寻路] 跨越高度 ${params.maxStepHeight.toFixed(2)} ｜ 跨越宽度 ${params.crossWidth.toFixed(2)} ｜ 碰撞半径 ${params.dogRadius.toFixed(2)} ｜ 通行高度 ${params.dogHeight.toFixed(2)} ｜ 终点范围 ${this.path.goalRadius.toFixed(2)} m`,
    );
  }

  /**
   * 规划失败的原因 → 控制台上那句话。
   *
   * 界面上那几句文案在 `SystemManagerComponent` 里（要带操作建议，是给用户看的）；
   * 这里只求排查时一眼认得，所以短。数从
   * {@link Octomap3dPcdPath.heightGap} 现取——它紧跟着 `computePath` 才有效。
   */
  private failureText(): string {
    const gap = this.path.heightGap ?? 0;
    switch (this.path.failedReason()) {
      case 'tooLarge':
        return '失败：场景太大，规划网格超限';
      case 'dogStuck':
        return `失败：小狗站在离地 ${gap.toFixed(2)} m 的地方，下不到地面`;
      case 'gap':
        return `失败：落差 ${gap.toFixed(2)} m，超过跨越高度`;
      case 'goalTooHigh':
        return `失败：终点浮在那一列最高的面之上，吸附丢了 ${gap.toFixed(2)} m`;
      default:
        return '失败：找不到路径（这一片走不到终点）';
    }
  }

  /** 让小狗沿存储的路径开始行进。 */
  startWalk(): void {
    this.dog.startWalking();
  }

  /** 将小狗拖拽定位到存储路径的某个比例（0..1）处。 */
  seekWalk(progress: number): void {
    this.dog.seek(progress);
  }

  /** 在行进途中暂停小狗。 */
  pauseWalk(): void {
    this.dog.pause();
  }

  /** 让小狗从暂停的行进中恢复。 */
  resumeWalk(): void {
    this.dog.resume();
  }

  /** 在世界坐标位置添加一个体素（供点云编辑器使用）。 */
  addVoxel(world: [number, number, number], options: OctomapRenderOptions): void {
    this.grille.addVoxel(world, options);
  }

  /** 按网格 key 移除一个体素（供点云编辑器使用）。 */
  removeVoxel(key: string, options: OctomapRenderOptions): void {
    this.grille.removeVoxel(key, options);
  }

  /** 将体素从其网格 key 移动到新的世界坐标位置（点云编辑器）。 */
  moveVoxel(key: string, world: [number, number, number], options: OctomapRenderOptions): void {
    this.grille.moveVoxel(key, world, options);
  }

  /** 以全分辨率返回编辑后的点云，用于导出。 */
  toPointCloud(): OctomapPointCloud | null {
    return this.grille.toPointCloud();
  }

  /** 将当前点云重采样为每个占用的体素中心一个点。 */
  toRegularCloud(): OctomapPointCloud | null {
    return this.grille.toRegularCloud();
  }

  /** 当前俯视投影的全部输入（点位置、对齐包围盒、分辨率）。 */
  projectionSource(): OctomapProjectionSource | null {
    return this.grille.projectionSource();
  }

  /**
   * 把小狗的碰撞足迹和当前的渲染体素大小交给路径控制器，让它按这个尺寸画终点
   * 锥和路径管。
   *
   * 体素大小取自网格：点云模式下没有网格（也就没有路径），此时退回 0，尺寸全由
   * 小狗决定。
   */
  private syncMarkerScale(): void {
    this.path.setScaleReference(
      this.dog.footprintRadius,
      this.dog.footprintHeight,
      this.grille.grid?.voxelSize ?? 0,
    );
  }

  dispose(): void {
    this.grille.dispose();
    this.dog.dispose();
    this.path.dispose();
    this.global.dispose();
  }
}

export const Octomap3dPcdProviders = [
  Octomap3dPcdGrille,
  Octomap3dPcdGlobal,
  Octomap3dPcdDog,
  Octomap3dPcdPath,
  Octomap3dPcd,
];
