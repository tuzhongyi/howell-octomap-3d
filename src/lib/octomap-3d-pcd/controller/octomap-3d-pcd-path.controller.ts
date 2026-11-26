import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import * as THREE from 'three';
import {
  DEFAULT_OCTOMAP_SETTINGS,
  OctomapBoundingBox,
  OctomapPathAlgorithm,
  OctomapPathFailedDetail,
  OctomapPathFailureReason,
} from '../octomap-3d-pcd.model';
import { Octomap3dPcdVoxelGrid } from './octomap-3d-pcd-grid';
import { Octomap3dPcdGlobal } from './octomap-3d-pcd-global.controller';
import { MAX_FREE_CELLS, NAV_CELL_SIZE, navGridSize } from './octomap-3d-pcd-path-grid';
import { Octomap3dPcdPathPlanner } from './octomap-3d-pcd-path-planner';
import { Octomap3dPcdPathCloudFit } from './octomap-3d-pcd-path-cloud-fit.controller';
import { Octomap3dPcdPathSurfaceGraph } from './octomap-3d-pcd-path-surface-graph.controller';

/**
 * 终点锥和路径管相对小狗碰撞足迹的比例。系数取自改动前写死的尺寸与默认足迹
 * （碰撞半径 0.25、通行高度 0.8）之比——锥底半径 0.15/0.25、管半径 0.05/0.25，
 * 所以默认参数下算出来的尺寸和当时一模一样，只是从此跟着「碰撞半径」滑动条走。
 */
const CONE_RADIUS_RATIO = 0.6;
const TUBE_RADIUS_RATIO = 0.2;

/**
 * 路径点珠子相对路径管的半径比。取 1 就正好和管子一样粗，而球心与管轴重合——那是
 * **埋在管子里面**、一个像素都看不见。1.8 让珠子从管壁上鼓出来一圈，像绳子上的结。
 */
const PATH_POINT_RADIUS_RATIO = 1.8;

/**
 * 终点锥的高径比，沿用旧锥的 0.4 / 0.15。锁住形状是为了让锥只看碰撞半径：半径
 * 一路调小，锥等比缩小，而不会摊成一个饼。
 */
const CONE_ASPECT = 0.4 / 0.15;

/**
 * 场景下限：装饰不小于渲染体素的这个倍数。大场景的体素颗粒本身就有几十厘米，
 * 装饰比它还细就看不见了；小场景这一项通常取不到，尺寸全由小狗决定。
 */
const CONE_VOXEL_RATIO = 0.6;
const TUBE_VOXEL_RATIO = 0.4;

/**
 * 终点范围圆环的段数。它是单位圆再靠 scale 缩放的，段数只决定圆看着有多圆；
 * 64 段让默认半径下每段约占屏幕 6 px，肉眼看不出折角。
 */
const GOAL_RANGE_SEGMENTS = 64;

/**
 * 规划上限范围那条边界线的颜色：平时是一个中性的灰（它只是又一次「参考物」，
 * 该像参考网格那样退到背景里），超限时换成洋红——要和旁边的用色都能区分开：
 * 终点范围是青 `#22d3ee`、路径是黄 `#facc15`、障碍是红 `#ef4444`、碰撞体是
 * 橙 `#f97316`。洋红是这套色板里唯一还没被占的醒目色。
 */
const NAV_LIMIT_COLOR = '#94a3b8';
const NAV_LIMIT_EXCEEDED_COLOR = '#d946ef';

// 小狗的碰撞半径和通行高度来自设置，因此可以缩小半径来打开狭窄的门洞（或降低
// 高度以从低矮的悬空物下方钻过）。

/**
 * 持有导航终点、渲染出的路径，以及**这一次**规划的失败缘由。
 *
 * 规划本身**不在这里**：真正搜路的是一组 `Octomap3dPcdPathPlanner`，按
 * {@link OctomapMapSettings.pathAlgorithm} 选一个（见 {@link setAlgorithm}）。这个类
 * 是它们的外壳，管三件事：
 *
 * 1. **建网格参数**（{@link navGridSize}，与绘制规划范围框共用同一份推导）并判上限；
 * 2. **画和清**——终点锥、终点范围圆环、路径管、规划范围框（都在这个文件里，因为
 *    它们碰 THREE，而规划器不碰）；
 * 3. **失败缘由**——{@link navLimitExceeded} / {@link heightGap} / {@link dogStuck} /
 *    {@link goalTooHigh} 四个字段加 {@link failedReason}。规划器把后三个整份返回，
 *    这里无条件抄回。
 *
 * 拆开是因为「小狗走的那张面」现在是个**可选**的东西（见 {@link OctomapPathAlgorithm}），
 * 而搜索、平滑、起终点吸附那一套与它无关、且各自都有一堆量出来的坑，不该跟着复制。
 *
 * 不变的部分是每一步的「站不站得住」判据（「身子那一带不许有几何」，从**脚下的那个
 * 面**起量而不是从地面起量，见 `Octomap3dPcdNavSurface.standable`），以及一个旋钮同时管住
 * 上爬和下跳这件事。
 */
@Injectable()
export class Octomap3dPcdPath {
  /** 发出路径点数量（0 = 未找到，null = 已清除）。 */
  readonly pathChanged = new Subject<number | null>();

  /**
   * 寻路失败时发出，带上失败原因。
   *
   * 与 {@link pathChanged} 分工不同：那个是「画出来的路径变成了什么」的公共契约
   * （三态，任何变化都发），这个是「这次规划为什么没成」的一次性报告。父组件据此
   * 给出比一句笼统的「找不到路径」更有用的提示。
   */
  readonly pathFailed = new Subject<OctomapPathFailedDetail>();

  /** 地面上的世界坐标终点位置，用作寻路目标。 */
  goalPosition: [number, number, number] | null = null;

  /**
   * 终点的接受范围半径。规划器**不用**它——它只决定「算出来的路径算不算成功」，
   * 由 {@link Octomap3dPcd.findPath} 读取判定，同时也是圆环的画法尺寸。
   * 与 {@link goalPosition} 一样公开只读：改它走 {@link setGoalRadius}。
   *
   * 初值直接取默认设置，不抄字面量：`Octomap3dPcdComponent.ngOnChanges` 在首次绑定
   * 时因为 `viewInitialized` 还是 false 而整个跳过，所以这里**必须**等于默认值，
   * 否则用户没动过这一项时就悄悄用了另一个数。
   */
  goalRadius = DEFAULT_OCTOMAP_SETTINGS.goalRadius;

  /**
   * 「填充基准范围」（单位：格），见 {@link OctomapMapSettings.fillBaseCells}；改它走
   * {@link setFillBaseCells}。
   *
   * 和 {@link goalRadius} 一样是**字段**而不是 {@link computePath} 的第 12 个位置参数：
   * 那个签名有「十一个位置参数、一条不增删」的约定（它被 spec 里的 `null as never` 和
   * `octomap-3d-pcd-path-straight.cases.ts` 依赖着），而这个设置与「这次查询用什么参数」不同，
   * 它是「这张表面图怎么建」——建完就缓存在规划器上，不进每次调用的参数表。
   *
   * 初值直接取默认设置，不抄字面量：`Octomap3dPcdComponent.ngOnChanges` 在首次绑定时因为
   * `viewInitialized` 还是 false 而整个跳过，所以这里**必须**等于默认值，否则用户没动过
   * 这一项时就悄悄用了另一个数。
   */
  fillBaseCells = DEFAULT_OCTOMAP_SETTINGS.fillBaseCells;

  /**
   * 上一次 {@link computePath} 是否因为规划网格超过 `MAX_FREE_CELLS` 而放弃。
   *
   * **每次调用都会重写**，所以不存在读到陈旧值的可能。用字段而不是改返回值：
   * `computePath` 返回 null 的原因有好几个（搜不到、端点吸附失败），而调用方只
   * 关心「这次是不是尺寸问题」——为它把返回值改成判别式联合会牵动一堆无关分支。
   *
   * 注意它说的是**那一次调用**，而不是「场景太大」：调用的网格还要算上起点和终点，
   * 所以终点摆得极远时它也会置位，而场景本身可能装得下。画出来的框用的是后一个
   * 判据（见 {@link navLimitRect}）。
   */
  navLimitExceeded = false;

  /**
   * 上一次 {@link computePath} 里「终点够不着」的**落差**（世界单位，取绝对值）；
   * 没发生就是 null。和 {@link navLimitExceeded} 一样**每次调用都会重写**。
   *
   * 只在「搜不过去、退到最近的可达节点」这条路上置位，两种情形取其一（见
   * {@link computePath}）：
   *
   * - **终点那一头够不着**（`gap`）：终点映射出的节点**站得住**、落在一片面上，而它与
   *   最近可达节点的高度差**超过了**这一次的跨越高度——小狗不是不知道终点在哪，是迈不
   *   上去那个台面。这个数**照着拖滑杆就有用**；
   * - **小狗这一头下不来**（`dogStuck`，见 {@link dogStuck}）：它自己站的那一片整个悬在
   *   地面之上，四周每个方向下去都超过跨越高度。这时量的是**小狗离地多高**，那是个
   *   说明，不是滑杆该拖到的位置。
   * - **终点吸到了地面上**（`goalTooHigh`，见 {@link goalTooHigh}）：终点**浮在那一列
   *   所有面之上**，最后落脚的节点（吸附到的那一个，或者 A* 够不着之后退而求其次的那
   *   一个）在地面上，丢掉的高度就是这个数。同样是「说明」——半空里没有面可迈，滑杆拖
   *   多大都不通。
   *
   * 第三种是**在吸附之后、搜索之前**就量出来的（前两种要等搜索失败），因为「吸掉了多少
   * 高度」这件事本身就是失败的理由：不拦的话路径会忠实地走到终点正下方，而调用方只量
   * 水平距离，于是报一条「成功」。（A* 够不着那一支在**搜索失败之后**再量一次，同一个
   * 判据、换一个高度，理由见 {@link goalTooHigh}。）
   *
   * 没超过就不置位：那说明落差一步就能迈过去，末端只是没走到那么准，`'outOfRange'`
   * 那句「差 X m」才是对的解释。判据放在这里而不是调用方，是因为只有这里知道这一次用
   * 的跨越高度。
   */
  heightGap: number | null = null;

  /**
   * 上一条那两种情形里，卡住的是**小狗自己**吗？与 {@link heightGap} 同时置位、同时
   * 清掉，只有它决定调用方报 `'gap'` 还是 `'dogStuck'`——两者的建议不同，见
   * {@link failedReason}。
   *
   * 判据是「从起点节点洪水填出来的那一片，**最低**的节点也在 `groundLevel` 之上超过一
   * 格」：它那一小片面整个悬空，怎么走都下不到地面。还要再确认一次「真的是小狗站在那儿」
   * （`hi[startNode]` 与小狗自己的高度差在一格以内），因为搜索是从碰撞体**前方**的探测
   * 点起算的，那个点可能落在小狗旁边的一级台沿上（见 {@link computePath} 里那段）。
   *
   * 这一句话覆盖不了的情形：**终点自己也在一座孤岛上**。那时「挪狗到地面」也到不了终点
   * （终点那一片从地面同样上不去），该动的是终点或者「跨越高度」。文案因此只说「再试」，
   * 不点名一个能拖到的数字、也不保证挪狗一定通——真图上量过的那一档（B.8，8/8 挪狗通）
   * 里，那些终点从地面爬得上去。
   */
  dogStuck = false;

  /**
   * 终点是不是**浮在那一列所有面之上**（点在半空里）？与 {@link heightGap} 一样每次
   * 调用都会重写。
   *
   * 它和 {@link dogStuck} 是同一层的开关：`heightGap` 只说明「差多少」，这一个决定
   * 调用方报 `'gap'` / `'dogStuck'` / `'goalTooHigh'` 里的哪一个——三者的建议不同，
   * 见 {@link failedReason}。
   *
   * 判据（放在 `Octomap3dPcdPathPlanner.plan` 里，只有那儿同时拿得到终点、列顶与跨越高度）
   * 是两条**与**关系：终点落脚的那个节点比终点低了一次跨越高度还多，**且**终点比那一列
   * 最高的面还高出一格。第二条是防误伤的那一条：点墙面时终点远高于它落到的地面、恒有
   * 第一条成立，但那时列顶（那堵墙）比终点高，第二条不成立——所以这个开关不会把「点墙
   * 面」打掉。
   *
   * 这**两条**在 `plan` 里量两处：一处量吸附节点（吸附当场就掉下去了），一处量 A* 够不
   * 着之后退而求其次的那个节点（吸附看着没事，但那个面走不到，真正落脚的在地面上）。
   * 只量第一处会漏掉后者：`mapPoint` 第 3 段可以跳到**隔壁列**一个可站的面上去，那时光
   * 看吸附甚至没有下降（真图上量到过 −0.019 m：往上跳），而退下来的落脚点离终点 5.8 m。
   */
  goalTooHigh = false;

  /**
   * 终点**有面接着**吗——它的 Y 落在那一列最高的那个面上（含一格容差）。与
   * {@link heightGap} 一样每次调用都会重写，由 `Octomap3dPcdPathPlanner.plan` 交付。
   *
   * {@link Octomap3dPcd.findPath} 拿它决定**接受范围量几维**：没有面接着终点时
   * 量三维（终点浮在半空，路径末端必须真的走到那个点上，停在正下方不算到），有面接着
   * 时只量水平（点墙面、点桌面这一类命中里，路径末端本来就该落在终点脚下的那个面上，
   * 竖直那一维归落差判据管）。理由详见那个方法，以及
   * `Octomap3dPcdPathPlanner` 里 `goalOnFace` 的注释。
   *
   * 它同时也是范围指示物的画法依据，见 {@link resizeGoalMarkers}。
   */
  goalOnFace = false;

  private goalMarker: THREE.Mesh | null = null;
  /**
   * 终点周围的接受范围指示物：三个同心圆（水平那个 + 两个竖直的）组成的球轮廓。
   *
   * 竖直那两个只在**终点浮在半空**时显示——那时接受范围是一个球；终点有面接着时
   * 竖直那一维根本不计入（见 {@link goalOnFace}），显示成球会骗人，只留水平那个圆。
   * 这个开关在 {@link resizeGoalMarkers} 里跟着 `goalOnFace` 走。
   */
  private goalRange: THREE.Group | null = null;
  private pathLine: THREE.Mesh | null = null;
  /**
   * 路径点的珠子（设置面板路径页那个「标出路径点」）。一次 `InstancedMesh` 画完全部顶点，
   * 见 {@link drawPathPointMarkers}。
   */
  private pathPointMarkers: THREE.InstancedMesh | null = null;
  /** 场景里那根管子照着它画出来的折线；尺寸变了要照着原样重画，所以得留着。 */
  private pathPoints: [number, number, number][] | null = null;
  /** 规划上限范围那条边界线，平面水平、贴地。 */
  private navLimitBox: THREE.LineLoop | null = null;
  /** 当前点云包围盒；画上限范围要用（它跟着点云变，所以得留着）。 */
  private bounds: OctomapBoundingBox | null = null;
  /** 边界线要贴的那层地面高度（跟路径、参考网格用的是同一个）。 */
  private groundLevel = 0;
  /**
   * 设置面板上「显示规划范围」那个开关。超限时无视它，见 {@link refreshNavLimit}。
   *
   * 初值取默认设置而不是抄字面量（首次绑定会被 `ngOnChanges` 跳过，这里必须是那个
   * 默认值）；显式标注 `boolean` 则是因为 `DEFAULT_OCTOMAP_SETTINGS` 用 `satisfies`
   * 收尾、各值保留字面量类型，不标注就会被推成 `true`。
   */
  private navLimitVisible: boolean = DEFAULT_OCTOMAP_SETTINGS.showNavLimit;

  /**
   * 设置面板路径页上「显示路径」那个开关的当前值。新画的管子按它决定露不露面（见
   * {@link drawPath}）——`setPathVisible` 只改得到**已经**画出来的那根。
   */
  private pathVisible: boolean = DEFAULT_OCTOMAP_SETTINGS.showPath;
  /**
   * 设置面板路径页上「标出路径点」那个开关。
   *
   * 与 {@link pathVisible} **互不干涉**：那个只管管子，这个只管珠子（见
   * `OctomapMapSettings.showPathPoints`）。两个都是布尔显示开关，谁也管不着谁。
   *
   * 显式标注 `boolean`：`DEFAULT_OCTOMAP_SETTINGS` 用 `satisfies` 收尾、各值保留
   * 字面量类型，不标注就会被推成 `false`（那个默认值恰好是 `false`，于是写不进去
   * `true`）。
   */
  private pathPointsVisible: boolean = DEFAULT_OCTOMAP_SETTINGS.showPathPoints;
  /** 小狗碰撞足迹的底面半径，装饰尺寸的主参考。 */
  private dogRadius = 0.25;
  /** 小狗的通行高度，决定路径管悬浮的高度。 */
  private dogHeight = 0.8;
  /** 渲染体素大小，装饰尺寸的下限；还没有网格时为 0。 */
  private voxelSize = 0;
  /**
   * 当前选中的寻路方式，见 {@link setAlgorithm}。
   *
   * 初值取默认设置而不是抄字面量（首次绑定会被 `ngOnChanges` 跳过，这里必须是那个
   * 默认值）；标注 `OctomapPathAlgorithm` 则是因为 `DEFAULT_OCTOMAP_SETTINGS` 用
   * `satisfies` 收尾、各值保留字面量类型。
   */
  private algorithm: OctomapPathAlgorithm = DEFAULT_OCTOMAP_SETTINGS.pathAlgorithm;
  /**
   * 已经建出来的规划器，按算法缓存。
   *
   * 惰性建而不是构造时把两个都 `new` 出来：每个规划器各持一份自己的表面图缓存
   * （8M 列那档约 13 MB），而同一时刻只有一个在跑。缓存住实例是为了切回旧算法时
   * 不必重建表面图——用户来回对比两条路时，点云一动没动。
   */
  private readonly planners = new Map<OctomapPathAlgorithm, Octomap3dPcdPathPlanner>();

  constructor(private readonly global: Octomap3dPcdGlobal) {}

  /**
   * 更新终点锥与路径管的尺寸参考：小狗的碰撞足迹（半径、通行高度）和场景的
   * 渲染体素大小。
   *
   * 这两样装饰不该是固定尺寸——同一个 0.4 m 的锥，摆在 0.65 m 的椅子上占掉大半
   * 屏，放进几十米的扫描里又只是个小点。它们跟着碰撞足迹走，因为那是用户直接调
   * 的量（「碰撞半径」「通行高度」），也正是寻路里把障碍外扩、让小狗不蹭墙的同一
   * 个数（见 `OctomapPathGrid.CELL_SAFETY`）。体素大小只作下限，见 {@link CONE_VOXEL_RATIO}。
   *
   * 参数没变就直接返回：设置面板上任何一项改动都会走到这里，而为一次无关的重建
   * 重画一根几万个顶点的管不值得。
   */
  setScaleReference(dogRadius: number, dogHeight: number, voxelSize: number): void {
    if (
      dogRadius === this.dogRadius &&
      dogHeight === this.dogHeight &&
      voxelSize === this.voxelSize
    ) {
      return;
    }
    this.dogRadius = dogRadius;
    this.dogHeight = dogHeight;
    this.voxelSize = voxelSize;
    this.resizeGoalMarkers();
    // 碰撞半径还决定了网格的边距（见 navGridSize），所以上限范围也跟着它变。
    this.refreshNavLimit();
    // 管粗和悬浮高度都变了，已经画出来的那根得重画——拖动「碰撞半径」或「通行
    // 高度」时，它就是这么实时跟着变的。
    this.drawPath();
  }

  /**
   * 记住当前点云的范围（以及它贴着的那层地面），据此重画规划上限范围的边界线。
   *
   * 由 `Octomap3dPcd.rebuild()` 在点云变化后调用，跟 `alignGrid` / 地面平面
   * 是同一时机——三者都是「场景换了、参考物跟着换」。
   */
  setBounds(bbox: OctomapBoundingBox | null, groundLevel: number): void {
    this.bounds = bbox;
    this.groundLevel = groundLevel;
    this.refreshNavLimit();
  }

  /**
   * 设置面板上「显示规划范围」的开关。
   *
   * 只影响「平时画不画」：场景超限时无论如何都会画出来（见 {@link refreshNavLimit}），
   * 那正是这条线最有用的时刻，不能让它被一个显示开关挡住。
   */
  setNavLimitVisible(visible: boolean): void {
    if (visible === this.navLimitVisible) {
      return;
    }
    this.navLimitVisible = visible;
    this.refreshNavLimit();
  }

  /**
   * 设置面板路径页上「显示路径」那个开关。
   *
   * **只动管子的 `visible`，不动 {@link pathPoints}**：关掉只是让它从画面上消失，规划
   * 结果还在，所以行进不受影响、打开时也不用重新规划。也不走 {@link drawPath} 重画一遍
   * ——那会白白丢掉并重建管子的几何（它是 `TubeGeometry`，顶点数按折线长度算），只是
   * 藏起来而已。
   *
   * 同值早返回的理由与 {@link setNavLimitVisible} 同：父组件的绑定在首次绑定时还会再补
   * 一次（`ngOnChanges` 跳过首次绑定）。
   */
  setPathVisible(visible: boolean): void {
    if (visible === this.pathVisible) {
      return;
    }
    this.pathVisible = visible;
    if (this.pathLine) {
      this.pathLine.visible = visible;
    }
  }

  /**
   * 设置面板路径页上「标出路径点」那个开关：把折线的每个顶点标成一颗珠子。
   *
   * 与 {@link setPathVisible} 的**实现方式正好相反**，这不是不一致而是同一件事的两面：
   * 管子那一份几何与点数、尺寸都无关，藏起来就是对的做法；而珠子的**个数**就是点数、
   * **半径**就是尺寸参考，任何一头变了都得重建，没有「留着不画」的意义。所以这里走
   * {@link drawPathPointMarkers}，与管子同生共死（`render` / 尺寸变化都从那儿过）。
   *
   * 同值早返回的理由与 {@link setPathVisible} 同：父组件的绑定在首次绑定时还会再补一次
   * （`ngOnChanges` 跳过首次绑定）。
   */
  setPathPointsVisible(visible: boolean): void {
    if (visible === this.pathPointsVisible) {
      return;
    }
    this.pathPointsVisible = visible;
    this.drawPathPointMarkers();
  }

  /**
   * 换一种寻路方式（设置面板上那个下拉，见 {@link OctomapPathAlgorithm}）。
   *
   * **不会自动重规划**：和这个面板上其它每一项一样，改完要重新点「找路径」才生效
   * （面板上那句提示说的就是这件事）。这里只决定下一次用哪个规划器。
   *
   * 同值早返回：设置面板上任何一项改动都会走到各个 setter，而父组件的绑定在首次
   * 绑定时还会再补一次（`ngOnChanges` 会跳过首次绑定）——不早返回就会白建一个
   * 规划器，连带一张表面图。
   */
  setAlgorithm(algorithm: OctomapPathAlgorithm): void {
    if (algorithm === this.algorithm) {
      return;
    }
    this.algorithm = algorithm;
  }

  /** 当前算法对应的规划器，按需建、建好留着（见 {@link planners}）。 */
  private planner(): Octomap3dPcdPathPlanner {
    let planner = this.planners.get(this.algorithm);
    if (!planner) {
      planner = createPlanner(this.algorithm);
      this.planners.set(this.algorithm, planner);
    }
    return planner;
  }

  /**
   * 在地面上放置（或移动）终点标记——一个倒置的圆锥，外加标出接受范围的三个圆。
   *
   * 那三个圆不只是装饰：路径末端落在接受范围之外就会被判为寻路失败，用户得看得见这条
   * 边界在哪儿，才知道该把「终点范围」调多大。而且**范围是个球**（见 {@link goalOnFace}），
   * 所以画法也得跟着是球——竖直那两圈在终点浮空时才是判定的一部分，有面接着时收起来，
   * 详见 {@link resizeGoalMarkers}。
   */
  setGoal(position: [number, number, number]): void {
    this.goalPosition = position;
    // 换了终点，上一次那个「有没有面接着」的判断就作废了（放终点不触发规划，要等
    // 用户按寻路）。先当作**浮空**——那是接受范围的一般形状（球），等下一次规划
    // 拿到真值再收成平环。宁可多画两圈，也别拿上一个终点的结论罩住这一个。
    this.goalOnFace = false;
    if (!this.goalMarker) {
      // 单位锥（底面半径 1、高 1），实际尺寸交给 scale，见 resizeGoalMarkers()。
      // rotateX(π) 把顶点翻到 −Y，锥尖朝下，好点在终点上。
      const geometry = new THREE.ConeGeometry(1, 1, 32);
      geometry.rotateX(Math.PI);
      const material = new THREE.MeshBasicMaterial({ color: '#22d3ee', depthTest: false });
      this.goalMarker = new THREE.Mesh(geometry, material);
      this.goalMarker.renderOrder = 1000;
      this.global.scene.add(this.goalMarker);
    }
    if (!this.goalRange) {
      // 三个单位圆（半径 1、64 段），同样交给 scale，见 resizeGoalMarkers()。三个
      // 圆共用「圆心在原点、半径 1」的写法，只是各自的平面不同：水平那个在 XZ 上，
      // 另两个分别绕 X、绕 Z 立起来，合起来读作一个球的轮廓。
      //
      // 用线而不是 RingGeometry：线的屏幕宽度恒为 1 px，半径调到下限（1 cm）也
      // 看得见；环形网格缩放后环宽跟着缩，1 cm 时环宽不到 1 mm，等于没有。顺带
      // 省掉「半径变了要重建几何」——缩放即可。
      const circle = (x: (a: number) => number, y: (a: number) => number, z: (a: number) => number) =>
        new THREE.BufferGeometry().setFromPoints(
          Array.from({ length: GOAL_RANGE_SEGMENTS }, (_, i) => {
            const angle = (i / GOAL_RANGE_SEGMENTS) * Math.PI * 2;
            return new THREE.Vector3(x(angle), y(angle), z(angle));
          }),
        );
      this.goalRange = new THREE.Group();
      for (const geometry of [
        circle(Math.cos, () => 0, Math.sin),
        circle(Math.cos, Math.sin, () => 0),
        circle(() => 0, Math.cos, Math.sin),
      ]) {
        const material = new THREE.LineBasicMaterial({ color: '#22d3ee', depthTest: false });
        const ring = new THREE.LineLoop(geometry, material);
        ring.renderOrder = 1000;
        this.goalRange.add(ring);
      }
      this.global.scene.add(this.goalRange);
    }
    this.resizeGoalMarkers();
  }

  /** 从场景中移除终点标记和范围圆环，并忘记终点位置。 */
  clearGoal(): void {
    this.goalPosition = null;
    if (this.goalMarker) {
      this.global.scene.remove(this.goalMarker);
      this.goalMarker.geometry.dispose();
      (this.goalMarker.material as THREE.Material).dispose();
      this.goalMarker = null;
    }
    if (this.goalRange) {
      this.global.scene.remove(this.goalRange);
      // 三个圆各有各的几何与材质，得逐个拆——`Group` 自己不持有这两样。
      for (const child of this.goalRange.children) {
        const ring = child as THREE.LineLoop;
        ring.geometry.dispose();
        (ring.material as THREE.Material).dispose();
      }
      this.goalRange = null;
    }
  }

  /**
   * 设置终点的接受范围半径（世界单位），圆环随之实时变。
   *
   * 参数没变就直接返回：设置面板上任何一项改动都会走到这里。
   */
  setGoalRadius(radius: number): void {
    if (radius === this.goalRadius) {
      return;
    }
    this.goalRadius = radius;
    this.resizeGoalMarkers();
  }

  /**
   * 设置「填充基准范围」（单位：格）。
   *
   * 只记下来，**不重建表面图**：建图是 `plan()` 里按需做的，而这里正是它的缓存键里
   * 的一项（见 `Octomap3dPcdPathPlanner.navSurface`）——下次点「找路径」时键一对不上就自然
   * 重建，代价落在真正需要它的那一次调用上，而不是拖滑杆的每一帧上。
   *
   * 参数没变就直接返回：设置面板上任何一项改动都会走到这里。
   */
  setFillBaseCells(cells: number): void {
    if (cells === this.fillBaseCells) {
      return;
    }
    this.fillBaseCells = cells;
  }

  /**
   * 根据有序的世界坐标点列表，将路径绘制（或清除）为一根粗管。粗细和悬浮高度
   * 由 {@link setScaleReference} 记下的参考尺寸算出，见 {@link tubeRadius}。
   */
  render(points: [number, number, number][] | null): void {
    this.clearLine();
    this.pathPoints = points && points.length >= 2 ? points : null;
    this.drawPath();
    this.pathChanged.next(points ? points.length : null);
  }

  /**
   * 刚跑完的这次 {@link computePath} 没给出可用路径时，该报哪个原因。
   *
   * 这是**唯一**能分出「找不到路径」各种缘由的地方：三个字段都在这里，而调用方手上只
   * 有一句话和一条折线。`'outOfRange'` 不在这里——那要等调用方量完末端离终点多远才知
   * 道，它比这里这几种都靠后。
   *
   * 顺序是有讲究的：尺寸超限时规划器压根没建图，落差必然是 null，可万一将来不是，报
   * 尺寸仍然更对——那是用户改参数也挪不动的根因（见 {@link navLimitExceeded}）。
   * {@link goalTooHigh} 紧跟在 {@link dogStuck} 之后，位置不算讲究（这两件事不可能同时
   * 成立：一个要求终点浮空，另一个要求吸附成功且终点节点就在小狗脚下那片）。
   */
  failedReason(): OctomapPathFailureReason {
    if (this.navLimitExceeded) {
      return 'tooLarge';
    }
    if (this.dogStuck) {
      return 'dogStuck';
    }
    if (this.goalTooHigh) {
      return 'goalTooHigh';
    }
    return this.heightGap !== null ? 'gap' : 'unreachable';
  }

  /**
   * 通知未找到可行进路线：清掉线、报告 0，并说明失败原因。
   *
   * `distance` 是路径末端到终点的距离，只有 `outOfRange` 有；另外两种压根没算出
   * 路径（或算了也没走到），无从谈起，传 null。落差（`gap`）直接读
   * {@link heightGap}，不从参数过——调用方必须紧接着 `computePath` 调它，否则
   * 读到的是上一次的落差。眼下的唯一调用方 `Octomap3dPcd.findPath` 就是这个
   * 顺序。
   *
   * 两个事件都在这里发，是「我们失败了」的**唯一出口**。顺序有讲究：父组件的
   * {@link pathChanged} 处理器会先把状态写成笼统的「找不到路径」，紧接着
   * {@link pathFailed} 用更具体的原因把它覆盖掉。
   */
  noPath(reason: OctomapPathFailureReason, distance: number | null): void {
    this.clearLine();
    this.pathChanged.next(0);
    this.pathFailed.next({ reason, distance, heightGap: this.heightGap });
  }

  /** 清除路径线并通知当前不显示路径。 */
  clear(): void {
    this.clearLine();
    this.pathChanged.next(null);
  }

  /**
   * 规划一条从 `start` 到 `goal`（世界坐标）的空闲空间路线，避开所有占用的
   * 体素。返回有序的世界坐标点列表（沿地形表面走，可以一级级爬上台阶和桌面，
   * 也能一步跨过地上的小坑），或 null。
   *
   * `crossWidth` 是「跨越宽度」（见 {@link OctomapMapSettings.crossWidth}）：无支撑的
   * 那一段不超过它就允许一步跨过去，0 表示只走相邻格。
   *
   * `groundLevel` 是扫描出的地板高度，由点云那一侧（`Octomap3dPcdGrille`）
   * 算好传进来：地面平面和参考网格用的也是同一个值，路径因此画在可见的地面上，
   * 而不是世界原点那一层。没有点的那一列按它补出来——**这是 `'surfaceGraph'` 的
   * 说法**，别的算法可以拿它当「附近没有源时才用的兜底」（见 `OctomapPathAlgorithm`）。
   *
   * 签名保持**十一个位置参数**、一条不增删：这个类的构造签名和它一起被 spec 里的
   * `null as never` 依赖着，改成对象会牵动一堆无关分支。真正的请求对象在
   * {@link Octomap3dPcdPathPlanner.plan} 那一层。
   *
   * 这里只做四件事：算网格参数、判上限、转发给当前算法、把失败标志抄回来。**建表面图
   * 与搜索都在规划器里**（见 {@link planner}）——它们的每一处阈值都是量出来的，而
   * 「小狗走的那张面」是可选的，两者不该搅在一起。
   */
  computePath(
    grid: Octomap3dPcdVoxelGrid,
    positions: Float32Array | null,
    bbox: OctomapBoundingBox,
    start: [number, number, number],
    goal: [number, number, number],
    maxStepHeight: number,
    crossWidth: number,
    dogRadius: number,
    dogHeight: number,
    groundExtendsOutside: boolean,
    groundLevel: number,
  ): [number, number, number][] | null {
    const cell = NAV_CELL_SIZE;

    const { nx, nz, minX, minZ } = navGridSize(bbox, start, goal, dogRadius);
    // 每次调用都重写，不留陈旧值——否则上一次的尺寸失败会污染下一次的报错。
    this.navLimitExceeded = false;
    this.heightGap = null;
    this.dogStuck = false;
    this.goalTooHigh = false;
    this.goalOnFace = false;
    if (nx * nz > MAX_FREE_CELLS) {
      this.navLimitExceeded = true;
      // 超限状态变了，边界线要跟着换成警示色并强制显示。
      //
      // **只在这一支里调**：正常规划完了也调一次，会把上一次留下的洋红框立刻刷回
      // 灰色——而「超限过」这件事在界面上本来就是靠那个颜色说的，框不褪色是有意的。
      this.refreshNavLimit();
      return null;
    }

    const plan = this.planner().plan({
      grid,
      positions,
      bbox,
      start,
      goal,
      maxStepHeight,
      crossWidth,
      fillBaseCells: this.fillBaseCells,
      dogRadius,
      dogHeight,
      groundExtendsOutside,
      groundLevel,
      nx,
      nz,
      minX,
      minZ,
      cell,
    });
    // 四个字段**无条件**抄回，不看有没有折线：只在成功时抄的话，上一次的落差会活到
    // 下一次，`failedReason()` 就会拿一个不相干的旧值给这次失败报 `'gap'`。
    this.heightGap = plan.heightGap;
    this.dogStuck = plan.dogStuck;
    this.goalTooHigh = plan.goalTooHigh;
    // `goalOnFace` 改的还是**画法**（球还是平环，见 `resizeGoalMarkers`），所以抄完
    // 得顺手重画一次——否则终点浮空这件事要等下一次挪终点才在界面上显出来。
    this.goalOnFace = plan.goalOnFace;
    this.resizeGoalMarkers();
    return plan.points;
  }

  /**
   * 释放这个控制器建在场景里的所有对象。
   *
   * 不手写拆解而是转给 `clearLine` / `clearGoal`：终点那边的装饰（锥和范围圆环）
   * 会越加越多，抄一份拆解逻辑在这里，加新装饰时就必然漏掉这一处。`clearGoal`
   * 顺手把 `goalPosition` 也清了，整个 provider 都要销毁，无所谓。
   *
   * 上限范围那条线没有归进上面两个（它不属于终点那一家），照 `groundPlane` /
   * `brushCursor` 的写法在这里自己拆——几何体和材质都要 dispose，字段置 null。
   */
  dispose(): void {
    this.clearLine();
    this.clearGoal();
    if (this.navLimitBox) {
      this.global.scene.remove(this.navLimitBox);
      this.navLimitBox.geometry.dispose();
      (this.navLimitBox.material as THREE.Material).dispose();
      this.navLimitBox = null;
    }
    this.bounds = null;
  }

  // --- 辅助方法 ---------------------------------------------------------------

  /**
   * 规划器能覆盖的范围——以点云占地为中心、保持长宽比的那个矩形，单位世界坐标。
   * 返回的 `exceeded` 说的是「这块地本身**装不下**」。
   *
   * 求法是二分一个放大系数 `s`，取 `s = min(1, s_max)`，`s_max` 是「网格格数刚好
   * 不超过 `MAX_FREE_CELLS`」的最大系数：
   *
   * - 没超限 → `s = 1` → 框正好套在**点云加边距**上。也就是 A* 网格的真实矩形，
   *   小、贴着场景，顺带把「规划器会往点云外扩一圈边距」这件本来只存在于代码里的
   *   事画了出来。
   * - 超限 → `s < 1` → 框落在点云**里面**，一眼就能看出「扫描比能规划的范围还大」。
   *
   * 两种情形读的是同一条语义（「这条线就是规划器的边界」），而不是两个不同的东西。
   * 这正是**不**直接画「上限面积那个大矩形」的原因：上限是 8M 格 ≈ 141×141 m，
   * 正常场景里会是一个远远伸到屏幕外的大方框，既没信息量又挡视线。
   *
   * 用二分而不是解析解：格数是 `ceil` 出来的，解析解会差一两格；而 `navGridSize`
   * 很廉价，为它推闭式解不值。系数封顶在 1（而不是放到比 1 更大去找那个「能规划
   * 的最大范围」）是为了让这条线在正常场景里也**贴着点云**，成为一个可对照的参考。
   */
  private navLimitRect(): {
    center: [number, number];
    sizeX: number;
    sizeZ: number;
    exceeded: boolean;
  } | null {
    const bbox = this.bounds;
    if (!bbox) {
      return null;
    }
    const cell = NAV_CELL_SIZE;
    // 把点云占地按 s 绕中心缩一下，再问这个更小的范围要多少格。
    const gridAt = (s: number): { nx: number; nz: number; minX: number; minZ: number } => {
      const halfX = (bbox.size[0] * s) / 2;
      const halfY = (bbox.size[1] * s) / 2;
      const halfZ = (bbox.size[2] * s) / 2;
      const scaled: OctomapBoundingBox = {
        min: [bbox.center[0] - halfX, bbox.center[1] - halfY, bbox.center[2] - halfZ],
        max: [bbox.center[0] + halfX, bbox.center[1] + halfY, bbox.center[2] + halfZ],
        center: bbox.center,
        size: [halfX * 2, halfY * 2, halfZ * 2],
        radius: bbox.radius * s,
      };
      return navGridSize(scaled, null, null, this.dogRadius);
    };

    let grid = gridAt(1);
    const exceeded = grid.nx * grid.nz > MAX_FREE_CELLS;
    if (exceeded) {
      // `gridAt(0)` 一定装得下：范围退化成一个点时，格数只剩边距那一圈（几十格）。
      // 所以 [0, 1] 这个区间必有解，二分不需要额外的兜底。
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        const m = gridAt(mid);
        if (m.nx * m.nz > MAX_FREE_CELLS) {
          hi = mid;
        } else {
          lo = mid;
        }
      }
      grid = gridAt(lo);
    }
    // 画的是**网格本身**（`minX` 起 `nx` 格），不是名义上的「包围盒 + 边距」：格数
    // 是 ceil 出来的，网格总会比名义范围多处不到一格的零头，而这条线要画的就是
    // 规划器真正覆盖到的地方。
    return {
      center: [grid.minX + (grid.nx * cell) / 2, grid.minZ + (grid.nz * cell) / 2],
      sizeX: grid.nx * cell,
      sizeZ: grid.nz * cell,
      exceeded,
    };
  }

  /**
   * 按当前的点云范围、碰撞半径和显示开关，重画（或藏起）规划上限范围那条边界线。
   *
   * 可见性是三者的或：用户开了开关、场景本身装不下、或者上次规划就是因为尺寸放弃
   * 的。中间那项就是用户要的「场景太大就把它画出来」——它不依赖开关，因为那正是
   * 这条线最有用的时刻。
   */
  private refreshNavLimit(): void {
    const rect = this.navLimitRect();
    if (!rect) {
      // 没有点云：把线藏起来，而不是销毁。点云是随时可以换的，销毁意味着下次
      // 又要重建一遍几何和材质。
      if (this.navLimitBox) {
        this.navLimitBox.visible = false;
      }
      return;
    }
    if (!this.navLimitBox) {
      // 单位正方形（边长 1，中心在原点），实际尺寸交给 scale——和终点范围圆环
      // 同一个手法：线的屏幕宽度恒为 1 px，缩放不改变线宽。
      const geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-0.5, 0, -0.5),
        new THREE.Vector3(0.5, 0, -0.5),
        new THREE.Vector3(0.5, 0, 0.5),
        new THREE.Vector3(-0.5, 0, 0.5),
      ]);
      const material = new THREE.LineBasicMaterial({
        color: NAV_LIMIT_COLOR,
        depthTest: false,
      });
      this.navLimitBox = new THREE.LineLoop(geometry, material);
      this.navLimitBox.renderOrder = 1000;
      this.global.scene.add(this.navLimitBox);
    }
    const exceeded = rect.exceeded || this.navLimitExceeded;
    this.navLimitBox.scale.set(rect.sizeX, 1, rect.sizeZ);
    this.navLimitBox.position.set(rect.center[0], this.groundLevel, rect.center[1]);
    this.navLimitBox.visible = this.navLimitVisible || exceeded;
    (this.navLimitBox.material as THREE.LineBasicMaterial).color.set(
      exceeded ? NAV_LIMIT_EXCEEDED_COLOR : NAV_LIMIT_COLOR,
    );
  }

  /** 终点锥的底面半径：跟碰撞半径走，不小于按渲染体素算出的下限。 */
  private coneRadius(): number {
    return Math.max(this.dogRadius * CONE_RADIUS_RATIO, this.voxelSize * CONE_VOXEL_RATIO);
  }

  /** 终点锥的高：由半径按固定高径比推出，尺寸怎么变形状都不走样。 */
  private coneHeight(): number {
    return this.coneRadius() * CONE_ASPECT;
  }

  /** 路径管的半径，与锥同一套参考（碰撞半径 + 体素下限）。 */
  private tubeRadius(): number {
    return Math.max(this.dogRadius * TUBE_RADIUS_RATIO, this.voxelSize * TUBE_VOXEL_RATIO);
  }

  /** 路径点珠子的半径：由管半径按固定比例推出，于是两者永远同粗同细。 */
  private beadRadius(): number {
    return this.tubeRadius() * PATH_POINT_RADIUS_RATIO;
  }

  /**
   * 把终点锥调成当前参考尺寸（悬浮到终点上方、锥尖刚好触地），并把范围指示物
   * 摆到终点上、缩到当前半径、按 {@link goalOnFace} 决定竖不竖起来。
   *
   * 两者各自判空：锥和圆环是两个独立字段，任何一个缺失都不该拖住另一个更新。
   */
  private resizeGoalMarkers(): void {
    const goal = this.goalPosition;
    if (!goal) {
      return;
    }
    if (this.goalMarker) {
      const height = this.coneHeight();
      this.goalMarker.scale.set(this.coneRadius(), height, this.coneRadius());
      this.goalMarker.position.set(goal[0], goal[1] + height / 2, goal[2]);
    }
    if (this.goalRange) {
      // 圆环以终点为心，不随锥的尺寸参考变——它标的是接受范围，跟小狗多大、体素
      // 多粗都无关。
      this.goalRange.scale.setScalar(this.goalRadius);
      this.goalRange.position.set(goal[0], goal[1], goal[2]);
      // 竖直那两圈（子节点 1、2）只在终点**浮在半空**时露面：那时接受范围是个球，
      // 三个圆一起才是它的轮廓；终点有面接着时竖直那一维不计入判定
      // （见 `goalOnFace`），摆一个球出来等于把接受范围画大了。
      const solid = !this.goalOnFace;
      for (let i = 1; i < this.goalRange.children.length; i++) {
        this.goalRange.children[i].visible = solid;
      }
    }
  }

  /** 照着 {@link pathPoints} 重画路径管。尺寸变了要重画时也走这里。 */
  private drawPath(): void {
    this.disposeLine();
    const points = this.pathPoints;
    if (!points) {
      return;
    }
    // 将管悬浮在小狗身体中心的高度，使其清晰地处于地面之上，而不是埋在地面里。
    const centerHeight = this.dogHeight / 2;
    const pts = points.map(([x, y, z]) => new THREE.Vector3(x, y + centerHeight, z));
    const curve = new THREE.CatmullRomCurve3(pts);
    const geometry = new THREE.TubeGeometry(
      curve,
      Math.max(points.length * 6, 6),
      this.tubeRadius(),
      8,
      false,
    );
    // 渲染在体素/地面之上，让路线保持清晰可见。
    const material = new THREE.MeshBasicMaterial({ color: '#facc15', depthTest: false });
    this.pathLine = new THREE.Mesh(geometry, material);
    this.pathLine.renderOrder = 1000;
    this.pathLine.frustumCulled = false;
    // 每画一根都要问一次开关：规划完成后这条路径是新管子，`setPathVisible` 改不到它。
    this.pathLine.visible = this.pathVisible;
    this.global.scene.add(this.pathLine);
    // 珠子的个数与半径都是照着折线现算的，所以每次重画管子都跟着重画一遍。
    this.drawPathPointMarkers();
  }

  /** 丢掉当前路径：场景里的管和暂存的折线一起清。 */
  private clearLine(): void {
    this.disposeLine();
    this.pathPoints = null;
  }

  /**
   * 照着 {@link pathPoints} 重画路径点的珠子。
   *
   * 三处调它，都是为了同一件事——「折线或尺寸参考变了」：{@link drawPath}（管子跟着变）、
   * {@link setScaleReference}（那边转给 `drawPath`）、{@link setPathPointsVisible}。
   *
   * 先拆后建而不是「改改实例数」：`InstancedMesh` 的实例数是构造时定死的，折线一变就
   * 得新建一个对象。顺带把「开关关着」「没有折线」这两种情况收进同一个出口——它们要做的
   * 正是「拆掉旧的、什么都不建」。
   */
  private drawPathPointMarkers(): void {
    this.disposePathPointMarkers();
    const points = this.pathPoints;
    if (!points || !this.pathPointsVisible) {
      return;
    }
    // 高度和管子用同一个偏移（见 drawPath）：CatmullRomCurve3 是**插值**曲线，管子的
    // 中心线正好穿过每个控制点，所以珠子照原坐标摆上去就骑在管心上。
    const centerHeight = this.dogHeight / 2;
    // 球段数取 10 × 8：珠子只有管径的 1.8 倍大，屏幕上是几十个像素，再细分纯属浪费
    // ——长路径上千个顶点，每个顶点的面数都要乘上去。
    const geometry = new THREE.SphereGeometry(this.beadRadius(), 10, 8);
    const material = new THREE.MeshBasicMaterial({ color: '#ffffff', depthTest: false });
    const mesh = new THREE.InstancedMesh(geometry, material, points.length);
    // 比管子（1000）高一级：两者都不做深度测试，谁盖住谁**全看这个数**，而球心与管轴
    // 重合、球本来是在管子**里面**的。
    mesh.renderOrder = 1001;
    mesh.frustumCulled = false;
    const matrix = new THREE.Matrix4();
    points.forEach(([x, y, z], index) => {
      matrix.makeTranslation(x, y + centerHeight, z);
      mesh.setMatrixAt(index, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    this.pathPointMarkers = mesh;
    this.global.scene.add(mesh);
  }

  /** 只销毁场景里的珠子，留着折线与管子给重画用。 */
  private disposePathPointMarkers(): void {
    if (this.pathPointMarkers) {
      this.global.scene.remove(this.pathPointMarkers);
      this.pathPointMarkers.geometry.dispose();
      (this.pathPointMarkers.material as THREE.Material).dispose();
      this.pathPointMarkers = null;
    }
  }

  /** 只销毁场景里的管子和点标记，留着暂存的折线给重画用。 */
  private disposeLine(): void {
    if (this.pathLine) {
      this.global.scene.remove(this.pathLine);
      this.pathLine.geometry.dispose();
      (this.pathLine.material as THREE.Material).dispose();
      this.pathLine = null;
    }
    // 珠子归折线这一家：`clearLine` / `dispose` 都从这里过，拆解点只有这一个。
    this.disposePathPointMarkers();
  }
}

/**
 * 按算法建规划器。新的寻路方式在**这里**加一支，其余地方一行不动——外壳只认
 * {@link Octomap3dPcdPathPlanner} 这个抽象，不认具体是哪一个。
 *
 * 写成模块级函数而不是外壳的方法：它是构造期的一次分派，跟这个实例的状态无关，
 * 也就没有理由为了它去实例化一个 `Octomap3dPcdPath`。
 *
 * `default` 兜底回 `'surfaceGraph'` 而不是抛错：算法名可能来自配置文件
 * （`octomap.config.json`），那里写错一个词不该让寻路整个炸掉——退回默认的那套
 * 至少画得出路。**类型收紧了就该把这支删掉**，让它变成编译错（那时候 `default`
 * 就是死代码，而这里的声音本该由类型系统发）。
 */
function createPlanner(algorithm: OctomapPathAlgorithm): Octomap3dPcdPathPlanner {
  switch (algorithm) {
    case 'surfaceGraph':
      return new Octomap3dPcdPathSurfaceGraph();
    case 'cloudFit':
      return new Octomap3dPcdPathCloudFit();
    default:
      return new Octomap3dPcdPathSurfaceGraph();
  }
}
