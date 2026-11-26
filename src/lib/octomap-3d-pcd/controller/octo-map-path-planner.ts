import { OctoMapBoundingBox, OctoMapPathAlgorithm } from '../octomap-3d-pcd.model';
import { OctoMapVoxelGrid } from './octo-map-grid';
import { OctoMapNavSurface } from './octo-map-nav-surface';
import { CELL_SAFETY } from './octo-map-path-grid';

/** A* 开放集合使用的最小二叉堆。 */
class MinHeap<T> {
  private readonly items: T[] = [];

  constructor(private readonly compare: (a: T, b: T) => number) {}

  get size(): number {
    return this.items.length;
  }

  push(item: T): void {
    this.items.push(item);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.compare(this.items[i], this.items[parent]) >= 0) {
        break;
      }
      [this.items[i], this.items[parent]] = [this.items[parent], this.items[i]];
      i = parent;
    }
  }

  pop(): T | undefined {
    if (this.items.length === 0) {
      return undefined;
    }
    const top = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = i * 2 + 2;
        let smallest = i;
        if (left < this.items.length && this.compare(this.items[left], this.items[smallest]) < 0) {
          smallest = left;
        }
        if (right < this.items.length && this.compare(this.items[right], this.items[smallest]) < 0) {
          smallest = right;
        }
        if (smallest === i) {
          break;
        }
        [this.items[i], this.items[smallest]] = [this.items[smallest], this.items[i]];
        i = smallest;
      }
    }
    return top;
  }
}

/**
 * 攀爬阈值（设置里的「跨越高度」）的下限，1 cm。
 *
 * 之所以要有下限：扫描出来的地面自带 1~3 cm 的起伏，阈值比这还小的话，地面自己
 * 的点就会落进「墙」那一档，小狗连站的地方都没有。
 *
 * 下限取 1 cm 而不是导航网格分辨率：那样会把用户设的 1~4 cm 一律抬到 5 cm，滑块
 * 左边一段就成了摆设。
 */
export const MIN_STEP_HEIGHT = 0.01;

/**
 * 一条**跨越边**（格距 ≥ 2 格，见 `OctoMapNavSurface` 的 `crossWidth`）的额外代价，
 * 单位是格。
 *
 * 不加这一项，A* 对「走过去」和「跳过去」是**无所谓**的：边权是格心之间的水平距离，
 * 一次 3 格的跨越和三次 1 格的迈步都是 3。而跨越那一段只按墙规则采样（见
 * `OctoMapNavSurface.crossClear`），**不做**脚印判定，比走更松——于是泛化成本一样、
 * 约束更少的那个，A* 会挑它。真图上量过：默认 0.125 m 时 60 组配对里 57 组的折线
 * 都含跨格步，整条路是连跳带蹦，而不是「绕着走、遇上坑才迈一步」。
 *
 * 取 1 格（5 cm）是把跨越压成**退路**的尺度：跳一次只值当，如果比绕过去至少省一格。
 * 于是平地上照样老老实实走，只有前方真的没路（坑、断口）时才跨。
 *
 * 加上它之后启发函数仍然可采纳且一致：它只让真实代价变大（`距离 + 惩罚 ≥ 距离`），
 * 而启发量的是格心距离，所以既不高估也不破坏一致性（`h(a) − h(b) ≤ 距离 ≤ 代价`）。
 */
const CROSS_EDGE_PENALTY = 1;

/**
 * 竖直方向的代价权重：边权里加 `|Δ高| / 格 × 本系数`（单位还是「格」）。
 *
 * 不加这一项时，边权只有水平距离，**上下挪一层是免费的**。「一列里有几层可站的面」
 * 正是多层表面图的常态（地面 + 台面、地面 + 家具顶、同一片地上的噪声把一列切成两
 * 个 run……），于是 A* 在「留在这一层」和「挪到隔壁那一层」之间完全并列，靠堆的
 * 出栈顺序随便挑——挑出来的结果就是折线在竖直方向来回蹦。
 *
 * 真图上量过（`q:\tmp\path-jitter2.mjs`，60 条成功路径 8097 步）：**45% 的相邻点落差
 * 超过 2 cm**，p90 是 19 cm，最大 48 cm；而把它逐条拿去对账「抬高的那一头，它那一列
 * 底下还有没有够得着的可站层」——**3686 步无一例外都有**，也就是**真爬的步是 0 步**，
 * 全是白抖。上下反复交替的步占全部步的 41%，最长连蹦 33 步。画出来的管子自然看着
 * 一直在跳。
 *
 * 取 1.0 = 竖直一米和水平一米等价。这是「绕一点路也别上上下下」的尺度：为了让落差
 * 20 cm 的一步消失，小狗愿意多走 20 cm 的平路。真正要上桌子时（终点就在上面）仍然
 * 照上——只是不再为省一格平路而上下横跳。
 *
 * 加了它启发函数仍然可采纳且一致：它只让真实代价变大（`额外项 ≥ 0`），而启发量的是
 * 格心水平距离，所以 `h(a) − h(b) ≤ 水平距离 ≤ 代价` 照样成立。
 */
const VERTICAL_COST = 1;

/**
 * 折线平滑的**弦长上限**（单位：格）。
 *
 * 平滑的做法是「从当前顶点尽量往前跳，跳到跳不过去为止」——这一步能跳多远，决定了
 * 锯齿能被拉直到什么程度。取 12 格（0.6 m）与 `MAX_CROSS_CELLS` 同量级：弦越长，
 * 越能一次跨掉好几个锯齿周期；但一根长弦也是「AI 在图上抄近路」，它只受
 * {@link OctoMapNavSurface.segmentClear} 约束，所以别往长了放。
 *
 * 量过的锯齿尺度是 1 格幅、几个格一个周期（`q:\tmp\path-jitter.mjs`：每米 3 个转角，
 * 转角的 75% 是左右翻号的），12 格足够跨掉它。
 */
const SMOOTH_CHORD_CELLS = 12;

/**
 * 判「这是一片面而不是散点」时，至少要凑够多少列，3×3 = 15 cm 见方。
 *
 * 取 9 而不是更多：够小的桌面、台阶、窗台也就这么点大，再往上抬会把它们排除掉；
 * 而一颗孤点、一串竖直散点连 4 列都凑不齐，界线在这儿很宽。验证脚本里认「一块
 * 台面」用的也是这个数（`minPatchCells`），两边口径一致才好对账。
 */
const SURFACE_MIN_CELLS = 9;

/**
 * 一次规划请求：跑 `plan()` 要的全部输入。
 *
 * 网格尺寸（`nx` / `nz` / `minX` / `minZ`）由**调用方**算好传进来，规划器不自己调
 * `navGridSize`。两个理由：调用方（`OctoMapPathController.computePath`）为了判
 * 「会不会超限」本来就得先算一次，再算一遍是白花；更要紧的是**两边必须逐位相同**，
 * 而传进来就只有一份，不存在两处推导出不同结果的可能。
 */
export interface OctoMapPathRequest {
  /** 体素网格，只用来读刷过的禁行列（见 {@link OctoMapPathPlanner.bannedColumns}）。 */
  grid: OctoMapVoxelGrid;
  positions: Float32Array | null;
  /** 点云包围盒；`groundExtendsOutside` 为 false 时用来封住扫描之外的地面。 */
  bbox: OctoMapBoundingBox;
  start: [number, number, number];
  goal: [number, number, number];
  /** 设置里的「跨越高度」**原值**，下限在这里面兜（见 {@link MIN_STEP_HEIGHT}）。 */
  maxStepHeight: number;
  crossWidth: number;
  /**
   * 「填充基准范围」（设置里那一项，单位：格），见
   * {@link OctoMapMapSettings.fillBaseCells}。
   *
   * 它是**建图参数**，所以只有 `'cloudFit'` 那条算法读它（`'surfaceGraph'` 根本不填）；
   * 与 `maxStepHeight` / `crossWidth` 那些 `configure` 期的参数不同，它在
   * {@link OctoMapNavSurface.build} 里就要用上——也因此必须进
   * {@link navSurface} 的缓存键，否则用户在面板上拖这根滑杆、再点「找路径」，读到的
   * 还是那张按旧窗口建好的图。
   */
  fillBaseCells: number;
  dogRadius: number;
  dogHeight: number;
  groundExtendsOutside: boolean;
  groundLevel: number;
  nx: number;
  nz: number;
  minX: number;
  minZ: number;
  /** 导航网格分辨率，见 `NAV_CELL_SIZE`。 */
  cell: number;
}

/**
 * 一次规划的结果。
 *
 * 五个字段**永远都在**，不管成没成：折线可以是 null，但 `heightGap` / `dogStuck` /
 * `goalTooHigh` / `goalOnFace` 的取值必须每一次都完整交付。调用方
 * （`OctoMapPathController`）照着无条件抄回自己的字段——只在「有折线」时抄的话，
 * 上一次的落差会活到下一次，`failedReason()` 就会拿一个不相干的旧值给这次失败报
 * `'gap'`。
 */
export interface OctoMapPathPlan {
  /** 有序的世界坐标折线，或 null。 */
  points: [number, number, number][] | null;
  /**
   * 「终点够不着」「小狗下不来」「吸附替终点丢了高度」这三件事的程度，
   * 见 `OctoMapPathController.heightGap` 与 `OctoMapPathFailureReason` 的 `goalTooHigh`。
   */
  heightGap: number | null;
  /** 卡住的是小狗自己吗，见 `OctoMapPathController.dogStuck`。 */
  dogStuck: boolean;
  /** 终点浮在它那一列所有面之上吗，见 `OctoMapPathFailureReason` 的 `goalTooHigh`。 */
  goalTooHigh: boolean;
  /**
   * 终点**有面接着**吗——它的 Y 落在那一列最高的那个面上（含一格容差，与
   * `mapPoint` 第 1 段认「点到的那个面」同一条）。
   *
   * 它就是下面 `goalTooHigh` 判据第 1 条的**取反**，量一次记在两处：规划器自己拿它
   * 决定要不要报 `goalTooHigh`；`OctoMapController.findPath` 拿它决定接受范围量几维
   * ——没有面接着终点时量**三维**，有面接着时只量水平（终点在竖直面上时路径末端
   * 本来就该落在它脚下的地面，竖直那一维归落差判据管，见那个方法的注释）。
   */
  goalOnFace: boolean;
}

/** 什么都没规划出来时的那份结果（五个字段都取空值）。 */
export function emptyPlan(): OctoMapPathPlan {
  return {
    points: null,
    heightGap: null,
    dogStuck: false,
    goalTooHigh: false,
    goalOnFace: false,
  };
}

/**
 * 在**表面图**上做 A* 的那一套算法，与「表面图怎么建」正交。
 *
 * 一个算法 = 一个子类，靠 {@link buildSurface} 这一个钩子区分。分开是为了让
 * `OctoMapMapSettings.pathAlgorithm` 能选：现有那条（每列一个常数虚拟地面）与新的
 * 那条（空列从邻居取面高）共用全部搜索、平滑、吸附逻辑，**只差表面图怎么建**。
 *
 * 为什么是这个粒度而不是「每个算法一整份」：A* 的记账、平滑的判据、起终点吸附
 * 这三件事里的每一件都有各自已被量出来的坑（见 `CROSS_EDGE_PENALTY`、
 * `VERTICAL_COST`、`SMOOTH_CHORD_CELLS`、`mapPoint` 的分段），复制两份就是让它们
 * 将来各改各的。但**也不做成基类带一堆钩子**：非表面图的算法（比如栅格化的、
 * 采样式搜索的）根本用不上这张图，那时它实现 `plan()` 就是另一条路，而这个基类
 * 连同表面缓存一起被绕开，没有任何代价。
 *
 * 它是**纯类**：不碰 THREE、不碰 DOM、不是 `@Injectable`。构造它不需要 DI，测试
 * 里直接 `new` 就能跑，和 `OctoMapVoxelGrid` / `OctoMapNavSurface` 一个路子。
 */
export abstract class OctoMapPathPlanner {
  /** 上一次建的表面图，键见 {@link navSurface}。 */
  private surface: OctoMapNavSurface | null = null;
  private surfaceKey: {
    positions: Float32Array | null;
    nx: number;
    nz: number;
    minX: number;
    minZ: number;
    cell: number;
    groundLevel: number;
    /**
     * 「填充基准范围」。**必须在键里**：它是 `build` 期的参数，改它就会建出另一张
     * 表面图，而 `positions` 的数组身份、网格几何、`groundLevel` 一个都没变——不带上
     * 它，用户拖完滑杆再点「找路径」读到的还是旧图（面板上数字在动、路径一动不动）。
     */
    fillBaseCells: number;
  } | null = null;

  /** 这个规划器对应 `OctoMapMapSettings.pathAlgorithm` 里的哪一个。 */
  abstract readonly algorithm: OctoMapPathAlgorithm;

  /**
   * 按本算法的路子建一张表面图。子类**唯一**要实现的钩子。
   *
   * 入参与的 `OctoMapNavSurface.build` 一致；{@link navSurface} 负责缓存，所以这里
   * 每次被调用都该真的建一张新的。
   */
  protected abstract buildSurface(
    positions: Float32Array | null,
    nx: number,
    nz: number,
    minX: number,
    minZ: number,
    cell: number,
    groundLevel: number,
    fillBaseCells: number,
  ): OctoMapNavSurface;

  /**
   * 「小狗这一坨整个悬在地面之上」的判据里，`lowest` 允许比 `groundLevel` 高出多少。
   *
   * 这个门槛**不是**随便留的余量：它成立的前提是「虚拟地面 run 一定落在 `groundLevel`
   * 上」，于是「这一坨里有没有贴地的列」等价于「`lowest` 够不够得着 `groundLevel`」。
   * 默认给一格（`cell`）——地面自己的噪声有一两厘米，门槛取 0 会把站在地面上的小狗
   * 也判成悬空。
   *
   * `'cloudFit'` 必须覆盖它：填充过的空列读的是**局部**地板高度，上面那条等价关系就
   * 断了（见 {@link OctoMapPathCloudFitController.islandFloatMargin}）。
   */
  protected islandFloatMargin(cell: number, _step: number): number {
    return cell;
  }

  /**
   * 规划一条从 `start` 到 `goal`（世界坐标）的路线，避开所有占用的体素。
   *
   * 步骤是：建表面图 → 起终点各吸附到一个能站的节点 → 在节点图上 A* → 落回世界
   * 坐标 → 拉直。前两步和第三步都在 `OctoMapNavSurface` 里，落回坐标与拉直在这里。
   *
   * 这里**什么都不记在实例上**（除了表面图缓存）：结果整份返回，由调用方决定怎么
   * 用它。所以同一个规划器可以被连着调、被两个不同的起点终点交叉调，互不干扰。
   */
  plan(req: OctoMapPathRequest): OctoMapPathPlan {
    const step = Math.max(req.maxStepHeight, MIN_STEP_HEIGHT);
    const cell = req.cell;

    const surface = this.navSurface(
      req.positions,
      req.nx,
      req.nz,
      req.minX,
      req.minZ,
      cell,
      req.groundLevel,
      req.fillBaseCells,
    );
    surface.configure({
      // 小狗的脚印比碰撞半径本身再大**半格**：判定是格粒度的，这点余量把「格心
      // 之间的距离」折算成「离真实墙面的距离」，来历见 CELL_SAFETY。
      clearanceRadius: req.dogRadius + CELL_SAFETY,
      dogHeight: req.dogHeight,
      step,
      crossWidth: req.crossWidth,
      groundExtendsOutside: req.groundExtendsOutside,
      bounds: req.bbox,
      banned: this.bannedColumns(req.grid, req.nx, req.nz, req.minX, req.minZ, cell),
    });

    const startNode = surface.mapPoint(req.start[0], req.start[1], req.start[2]);
    const goalNode = surface.mapPoint(req.goal[0], req.goal[1], req.goal[2]);
    if (startNode < 0 || goalNode < 0) {
      return emptyPlan();
    }

    // 终点**浮在半空**吗（见 `OctoMapPathFailureReason` 的 `goalTooHigh`）。
    //
    // 不拦的话它会被**静默地**变成一条成功的路边小事：`mapPoint` 第 3 段把终点一路
    // 吸附到地面上，路径忠实地走到终点正下方，于是 `0.139 m < goalRadius 0.5 m`
    // → **报成功**。真图上量到过一条这样的「成功」：7 个顶点全在 Y = −6.836，终点
    // 在 Y = −1.020，丢了 5.816 m。（`findPath` 现在对浮空终点量**三维**，这一条
    // 已经不会再漏成「成功」；仍然报 `goalTooHigh` 是为了给出**这一句**建议——只说
    // 「末端离终点 5.8 m」会把用户引到「终点范围」那根滑杆上去。）
    //
    // 「那一列有没有面接着终点」——量一次、两处用：这儿判 `goalTooHigh`，调用方判
    // 接受范围量几维（见 `OctoMapPathPlan.goalOnFace`）。它是下面第 1 条的**取反**，
    // 所以两处的容差天生一致，不会出现「这边说浮空、那边说在面上」。
    //
    // 容差**取 `cell` 不是随手取的**——它正是 `mapPoint` 第 1 段认「点到的那个面」
    // 用的容差（`|hi − Y| <= cell`），所以这条判据不可能跟吸附的结果打架：吸附认下来
    // 的那个面，这里一定不判它浮空。容差也**必须这么小**，否则「终点比那一列最高的
    // 面只高出一格多」这种正是要拦的情形会漏过去。`columnTop` 越界时给 `-Infinity`，
    // 于是那儿连面都没有 → `goalOnFace` 为 false。
    const goalOnFace =
      req.goal[1] <= surface.columnTop(req.goal[0], req.goal[2]) + cell;

    // 两条判据缺一不可，分工是「上面有没有面」与「掉了多少」：
    //
    // - `!goalOnFace`：那一列**最高的面**都够不到它，也就是那儿没有面接着终点。
    // - `req.goal[1] − surface.hi[goalNode] > step`：吸附真的掉了超过一次跨越高度。
    //   少了它会把**点墙面**这个常见手势一起打掉：点墙面时终点 Y 远高于它落到的地面
    //   面（`mapPoint` 第 2 段的「落到脚下地面」），掉的也超过一个跨越高度——但那种
    //   情况第 1 条本来就成立不了（`columnTop` 是那堵墙的顶，比终点高），所以两条是
    //   与关系；只留第 2 条就会误伤。
    // 这两条判据在下面**量两次**：一次量吸附到的那个节点（这里），一次量退而求其次
    // 那个节点（A* 够不着时，量的是同一个「掉了多少」）。前者管「吸附就掉下去了」，
    // 后者管「吸附看着没事、但那个面走不到，真正落脚的在地面上」。为什么两次都要，
    // 见下面那一段的注释。
    const goalDrop = req.goal[1] - surface.hi[goalNode];
    if (goalDrop > step && !goalOnFace) {
      return {
        points: null,
        heightGap: goalDrop,
        dogStuck: false,
        goalTooHigh: true,
        goalOnFace,
      };
    }

    // 落差的那两个字段只在这一段里被赋值，其余路径上原样保持 null / false——
    // 与改动前逐字一致（那时它们直接写在外壳的字段上，而外壳在进这里之前刚重置过）。
    let heightGap: number | null = null;
    let dogStuck = false;
    let nodes = this.astarNodes(surface, startNode, goalNode);
    if (!nodes) {
      // 当终点落在墙上或墙后、或落在小狗进不去的房间里时，它吸附到的那个节点
      // 可能不可达。此时改为吸附到从起点真正可达的最近节点，而不是放弃，这样
      // 只要小狗站得住，就总能给出一条路线。
      const { node: reachable, lowest } = this.nearestReachableNode(
        surface,
        startNode,
        req.goal[0],
        req.goal[2],
      );
      // 退而求其次的那个节点本身可能就在**地面上**——那跟开头那条 `goalTooHigh` 判据量
      // 的是同一件事，只是那时候量不出来：第 1 条（那一列最高的面都够不到终点）**成立**，
      // 可 `mapPoint` 第 3 段把终点吸附到了**隔壁列**一个可站的面上（实测差 1.9 cm，吸附
      // 甚至往上跳），于是 `goalDrop = −0.019`，第 2 条（吸附掉的超过一次跨越高度）不成立
      // → 不报。接着 A* 到不了那个节点、退到地面的最近可达节点，而下面那道 `heightGap`
      // 判据又被 `onSurface` 挡掉（那一列的面被刷成障碍之后，它的邻列也没了，孤立成
      // 「散点」），`dogStuck` 也不成立——两个字段都是 null，`findPath` 于是看到一条 11 个
      // 顶点、末端离终点 0.09 m 的**地面**路径 → **报成功**。那正是这个判据要消灭的症状
      //（量到的现场：细笔 0.05 m 沿两侧边缘刷，见 `q:\tmp\ladder-probe6.mjs`）。
      //
      // 所以这里用同一个判据、换一个高度来量：**退而求其次那个节点**离终点有多远。
      // 第 1 条保持不动，它挡住的全是「终点自己就在一个面上」的情形（桌面、墙顶、台面、
      // 点墙面），那些地方该报的是下面那道 `heightGap`，不是这一条。
      const reachableDrop = req.goal[1] - surface.hi[reachable];
      if (reachableDrop > step && !goalOnFace) {
        return {
          points: null,
          heightGap: reachableDrop,
          dogStuck: false,
          goalTooHigh: true,
          goalOnFace,
        };
      }
      // 顺带把「够不着」这件事量下来：终点那个面与退而求其次的那个面之间差多少。
      // 差得超过一次跨越高度，就是小狗迈不过去（上不去桌子、下不来台），调用方
      // 会拿这个数点明原因；而在一个跨越高度以内，末端只是没走到那么准，报落差
      // 反而是误导。
      //
      // 这里量的是**表面**之间的差（run 的 hi），不是末端点与终点的差：终点那个
      // 节点站得住却搜不过去，缺的正是「从脚边迈到那个面上」这一下。
      //
      // 这道判据的两道门槛都为了同一件事：报出来的话得**有用**。文案给的建议是
      // 「调大跨越高度」，所以
      //
      // - 终点那个节点得**站得住**：站不住的成因里有跟跨越高度无关的（贴着它上方
      //   那一片，如悬空的板子），调参数救不回来；
      // - 它还得落在**一片面**上（见 {@link onSurface}）：点在竖直面上时命中的
      //   常常是散点，那不是「一块台面」，报落差会把人指错方向。
      const gap = Math.abs(surface.hi[goalNode] - surface.hi[reachable]);
      if (gap > step && surface.standable(goalNode) && this.onSurface(surface, goalNode)) {
        heightGap = gap;
      } else if (
        lowest > req.groundLevel + this.islandFloatMargin(cell, step) &&
        // 还得**确认真的是小狗站在那儿**：搜索是从碰撞体前方的探测点起算的（见
        // `OctoMapController.findPath` 里的 frontPosition），它可能落在小狗旁边的一级
        // 台沿上——小狗自己站在地板上，探测点却在 0.52 m 的坎上。那时按这个探测点报
        // 「小狗站在离地 0.52 m 的地方」是在说一件用户看不见的事，而原来的「差 X m」
        // 才是对的（量过：真图上就有两条这样的行，两种口径差 0.48 m）。
        //
        // 判据取「探测点落到的那个面就在小狗脚下这个高度」：表面优先摆放时两者本来
        // 就重合（差在噪声以内），探测点悬在台沿外时则相差一个坎的高度。
        Math.abs(surface.hi[startNode] - req.start[1]) <= cell
      ) {
        // 另一面：卡住的不是终点，是**小狗自己**。它这一片最低的节点也高过地面一格
        // 以上，就是说它站的那一坨整个悬在地面之上，往任何一个方向下去都超过跨越
        // 高度——桩子顶、垛子、柜面。`placeOnGround` 是表面优先的，正好容易把它放在
        // 这种地方：用户点的两个点明明一样高、看着就在同一层，图上却是两个互不相通
        // 的小岛（真图上这一档 8/8 都是这个原因，每个小岛 2~118 个节点，都够不到地面）。
        //
        // 报的是**小狗自己离地多高**（`start[1]`，用户眼睛看到的那个高度），不是终点与
        // 哪个面的差：这种情形里两头齐平，差出来接近 0，说了等于没说。而这个数是「它在
        // 多高的地方下不来」，**不是**滑杆该拖到的位置——真图上量过（见
        // `OctoMapPathController.dogStuck`）：要 0.69~0.77 m 才通，小狗离地却只有
        // 0.50~0.71 m，照着这个数拖滑杆大多还是不通；把它挪到 0.6 m 内的地面上则 8/8
        // 都通。所以这个数只作说明，提示里给的建议是挪狗。
        //
        // 门槛留一格（不是 0）：地面自己的噪声有一两厘米，虚拟地面 run 又正好落在
        // `groundLevel` 上，`> groundLevel` 会把站在地面上的小狗也判成悬空。门槛的
        // 具体取值由 {@link islandFloatMargin} 给——它依赖「虚拟 run 落在 `groundLevel`
        // 上」这条不变量，而 `'cloudFit'` 的填充把这条不变量拿掉了，于是要换一个。
        //
        // 反过来的情形（小狗**陷在**地面以下、爬不出来）不报这个：那两句文案都是照着
        // 「上面够不着」写的，报个负数只会把人绕晕，仍旧落到「找不到路径」。
        heightGap = req.start[1] - req.groundLevel;
        dogStuck = true;
      }
      nodes = this.astarNodes(surface, startNode, reachable);
    }
    if (!nodes) {
      return { points: null, heightGap, dogStuck, goalTooHigh: false, goalOnFace };
    }
    // 每个点都落在它那个节点代表的面上（脚踏那个面）。相邻两点的列必然不同——邻居
    // 枚举走的偏移里不含 (0, 0)，跨越那一圈也一样——所以不会出现「同一 XZ、两个高度」
    // 的相邻点让路径管折返。跨过坑的那一段因此是**一条直线**（两端各是一个列心，
    // Y 由 `CatmullRomCurve3` 插值），小狗是迈过去，不是踩着坑底走。
    return {
      points: this.smoothPath(surface, nodes.map((id) => surface.worldOf(id))),
      heightGap,
      dogStuck,
      goalTooHigh: false,
      goalOnFace,
    };
  }

  /**
   * 把折线里的锯齿拉直：从当前顶点尽量往远跳，跳到跳不过去为止（见 {@link SMOOTH_CHORD_CELLS}）。
   *
   * **为什么非做这一步**：A* 的边权是 `hypot(dx, dz) + 上升代价 + 跨越惩罚`，在一段平凡
   * 地面上（每步都是走一格、高度一样），每一步的价钱只跟「跨了几个格、什么方向」有关，
   * 跟这些步的**先后**毫无关系。于是**同一个方向组合的每一种走法代价严格相等**——
   * 「先斜后直」「先直后斜」「一路锯齿」三者同价，A* 挑哪个纯粹看堆的出栈顺序。
   * 折线的**形状**因此完全不受代价约束，挑出来的就是每米 3 个转角、左右翻号的那种锯齿
   * （`q:\tmp\path-jitter.mjs`：转角中位 0°、p90 45°，>30° 的占 17%，翻号占 75%）。
   *
   * 代价函数修不了它：补一条「转弯要加钱」的边权需要 (节点 × 来向) 的搜索状态，而这条
   * 折线是要**给小狗走路**的（狗按每一段定朝向），所以锯齿在观感上就是狗头在抖。改为在
   * **输出之后**加一道形状判据：直线扫过去不碰东西，就把那一段锯齿整段删掉。跳过的每个
   * 顶点仍然用它后面的邻点保证过——{@link OctoMapNavSurface.segmentClear} 就是那条判据。
   *
   * 保留的第一个点是 A* 的起点（小狗身前那个探测点），最后一个点是终点；中间的锯齿都是
   * 等价的走法，换掉不影响「这条路能不能走」。**代价也不再是最优的那条**：拉直只会让
   * 折线变短（省掉的都是绕出来的长度），所以它不会比 A* 的结果更长。
   */
  private smoothPath(
    surface: OctoMapNavSurface,
    points: [number, number, number][],
  ): [number, number, number][] {
    if (points.length <= 2) {
      return points;
    }
    // 弦长上限按**实际走过的距离**量，不是按顶点个数：一条跨越边就能跨 12 格，按个数
    // 数的话 12 个顶点最长能拉出 7 m 的弦。
    const maxChord = SMOOTH_CHORD_CELLS * surface.cell;
    const out: [number, number, number][] = [points[0]];
    let i = 0;
    while (i < points.length - 1) {
      // 从最近的一个邻点起试，能跳多远跳多远；**一跳不通就停**（不再往更远处试）。
      // 直线被挡住之后，同一方向上更远的地方基本也还是被挡着，而「第一个不通处停下」
      // 只会让弦更短——保守的方向，且把这段的检查压到 O(折线长度)。
      let best = i + 1;
      let travelled = 0;
      for (let j = i + 2; j < points.length; j++) {
        const a = points[j - 1];
        const b = points[j];
        travelled += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        if (travelled > maxChord || !surface.segmentClear(points[i], points[j])) {
          break;
        }
        best = j;
      }
      out.push(points[best]);
      i = best;
    }
    return out;
  }

  /**
   * 这个节点是不是**一片面**上的一点，而不是散在竖直面上的浮点。
   *
   * 判据：从它出发在 8 邻里洪水填充，只走「高度与它相差不超过一格」的那些邻居，
   * 看能不能凑够 {@link SURFACE_MIN_CELLS} 列。一片桌面、一块地面几列就够；而稀疏
   * 扫描的墙面是一层散点——相邻那些点差着十几厘米到几十厘米，得靠跨越高度才连得
   * 上，按「一格以内」走不了几步就断了。
   *
   * 这是 `plan()` 里**终点那一头**判据的**门槛**，不是几何精度：报「落差 X m」
   * 的前提是那边真有
   * 一块台面。点在墙上时命中的常常是一颗浮点（那一列就它一个点，`hi` 自然等于点的
   * 高度，第 1 段吸附必然命中它），它四周空空，报落差听着像有块台面在等着，其实那里
   * 什么也没有——那种情形该走原来那条路：末端走到墙脚地面，再由终点范围判成不成。
   *
   * 高度差量的是**与种子节点**的差（不是逐跳累加），和验证脚本里认「一块表面」的口径
   * 一致：逐跳累加会顺着斜坡一路漂出去，把半个房间算成一片面。
   */
  private onSurface(surface: OctoMapNavSurface, node: number): boolean {
    const band = surface.hi[node];
    const seen = new Set<number>([surface.cellOf[node]]);
    const queue = [node];
    for (let head = 0; head < queue.length; head++) {
      if (seen.size >= SURFACE_MIN_CELLS) {
        return true;
      }
      surface.forEachNeighbor(queue[head], (neighbor) => {
        const cell = surface.cellOf[neighbor];
        // 同一列里可能有多个 run 够得到（虚拟地面、台面上下），列去过就不再进队。
        if (seen.has(cell) || Math.abs(surface.hi[neighbor] - band) > surface.cell) {
          return;
        }
        seen.add(cell);
        queue.push(neighbor);
      });
    }
    return seen.size >= SURFACE_MIN_CELLS;
  }

  /**
   * 当前点云的表面图，带缓存。
   *
   * `build` 要遍历一遍点云、再逐列排序，是这条链路上最贵的一步；而拖「碰撞半径」、
   * 「通行高度」这些滑块时点云一动没动。缓存键因此取**点云数组的身份**加上网格本身
   * 的参数：点云换了，`OctoMapController.rebuild()` 会把 `positions` 换成新引用，
   * 键自然失效；网格随起终点或边距变化（见 `navGridSize`）时格数与原点一变，
   * 也一样失效。
   *
   * 小狗参数（跨越高度、碰撞半径、禁行列…）**不在键里**：它们走
   * {@link OctoMapNavSurface.configure}，那一步只重算可站判定，比重建便宜得多。
   *
   * 缓存挂在**实例**上，所以每个算法各持一份：`'surfaceGraph'` 和 `'cloudFit'` 建出来
   * 的表面图本来就不同，键里不需要再放算法名。代价是同时用过两种算法时两份都常驻
   * （8M 列那档约 13 MB），所以外壳是按需建的，不会一上来把两个都 `new` 出来。
   */
  private navSurface(
    positions: Float32Array | null,
    nx: number,
    nz: number,
    minX: number,
    minZ: number,
    cell: number,
    groundLevel: number,
    fillBaseCells: number,
  ): OctoMapNavSurface {
    const key = this.surfaceKey;
    const cached = this.surface;
    if (
      cached &&
      key &&
      key.positions === positions &&
      key.nx === nx &&
      key.nz === nz &&
      key.minX === minX &&
      key.minZ === minZ &&
      key.cell === cell &&
      key.groundLevel === groundLevel &&
      key.fillBaseCells === fillBaseCells
    ) {
      return cached;
    }
    const surface = this.buildSurface(
      positions,
      nx,
      nz,
      minX,
      minZ,
      cell,
      groundLevel,
      fillBaseCells,
    );
    this.surface = surface;
    this.surfaceKey = { positions, nx, nz, minX, minZ, cell, groundLevel, fillBaseCells };
    return surface;
  }

  /**
   * 把体素网格里刷过的障碍翻成「整列禁行」的掩码（长 `nx * nz`），一个都没有时给
   * null（省下那张 8M 格上限下最大 8 MB 的表）。
   *
   * 一个禁行体素 → 它**格心所在的那一列**，与改动前一致：刷过的格子整列封死，而不是
   * 只挡它自己那一段高度。后者听着更精细，实际会让「刷桌面禁止站上去」这个手势失效
   * ——桌面自己的 run 还在，照样可站，刷上去的那块只是叠了个多余的阻挡。
   * `markAllObstacles` 也是靠这个语义把全场封住的。也正因为整列封死，这里不需要看
   * 体素的高度。
   *
   * 直接遍历 `grid.forbidden` 而不是遍历全部体素再筛：它是 `cells` 的子集（见
   * `OctoMapVoxelGrid.remove`），刷满场时两者一样，没刷过时这个是零成本。
   */
  private bannedColumns(
    grid: OctoMapVoxelGrid,
    nx: number,
    nz: number,
    minX: number,
    minZ: number,
    cell: number,
  ): Uint8Array | null {
    if (grid.forbidden.size === 0) {
      return null;
    }
    const banned = new Uint8Array(nx * nz);
    for (const key of grid.forbidden) {
      const center = grid.center(key);
      const ix = Math.floor((center[0] - minX) / cell);
      const iz = Math.floor((center[2] - minZ) / cell);
      if (ix >= 0 && ix < nx && iz >= 0 && iz < nz) {
        banned[ix + iz * nx] = 1;
      }
    }
    return banned;
  }

  /**
   * 在**节点图**上做 A*，返回按顺序排好的节点 id，搜不到返回 null。
   *
   * 与改动前那版格 A* 的差别只有「节点」这两个字：记账仍是定型数组（按节点 id 索引），
   * 仍是「重复入堆 + 用 closed 滤掉陈旧副本」，`cameFrom = −1` 仍然兼表不可达，堆也还
   * 是同一个 `MinHeap`。不能照搬的只有**方向性**：图是有向的（上爬与下跳都要过
   * 跨越高度这一关，反边不保证存在），所以只能顺着 `forEachNeighbor` 走，不能拿邻居
   * 表当无向图用。
   *
   * 启发式取「到终点节点的**水平**距离」，单位是格。边权就是水平距离（一格 1、斜一格
   * √2），竖直那一维不花代价，所以它仍然可采纳、也一致——与改动前那一套逐字相同，
   * 只是量的是列心而不是格心。
   *
   * **public 是给测试用的**：它是个显式接收 surface 的纯函数，测试要能拿一张自己搭的
   * 表面图直接问它（比如量「平地上开着跨越宽度也照样一步一步走」就得看惩罚在边权里
   * 有没有生效，而 `plan()` 的输出已经被平滑抹过了）。
   */
  astarNodes(
    surface: OctoMapNavSurface,
    startNode: number,
    goalNode: number,
  ): number[] | null {
    const nx = surface.nx;
    const goalCell = surface.cellOf[goalNode];
    const goalX = (goalCell % nx) + 0.5;
    const goalZ = ((goalCell / nx) | 0) + 0.5;
    const heuristic = (node: number): number => {
      const cell = surface.cellOf[node];
      return Math.hypot((cell % nx) + 0.5 - goalX, ((cell / nx) | 0) + 0.5 - goalZ);
    };

    const count = surface.nodeCount;
    const gScore = new Float32Array(count).fill(Infinity);
    const cameFrom = new Int32Array(count).fill(-1);
    const closed = new Uint8Array(count);
    gScore[startNode] = 0;
    const open = new MinHeap<[number, number]>((a, b) => a[0] - b[0]);
    open.push([heuristic(startNode), startNode]);

    while (open.size > 0) {
      const [, current] = open.pop()!;
      if (current === goalNode) {
        break;
      }
      // 堆里允许留重复项、不做 decrease-key，所以弹出时用 closed 滤掉已定稿的节点和
      // 陈旧的副本——这点和用 Set 时一模一样。
      if (closed[current]) {
        continue;
      }
      closed[current] = 1;
      const currentG = gScore[current];
      surface.forEachNeighbor(current, (neighbor, dx, dz) => {
        if (closed[neighbor]) {
          return;
        }
        // 边权是两列格心之间的水平距离（格为单位）：八邻下它就是「斜着 √2、其余 1」，
        // 而跨越的邻居格距超过一格，那条口诀不再成立（`hypot` 把它一并覆盖了）。
        // 启发函数量的也是格心距离，两者同尺度，因此仍然可采纳且一致。
        //
        // 跨越边再加一笔固定惩罚（见 CROSS_EDGE_PENALTY）：光按距离算，跳 3 格和走
        // 3 步同价，而跳那一段的约束更松，A* 就会一路跳着过去。
        // 八邻的格距最大就是 1，所以「格距 ≥ 2」与「这是一条跨越边」等价。
        const crossing = Math.abs(dx) >= 2 || Math.abs(dz) >= 2;
        // 竖直方向也要算钱（见 VERTICAL_COST）：不算的话「往上挪一层」和「留在原地」
        // 代价一模一样，A* 就在同一列的几层可站面之间随便换。
        const rise = Math.abs(surface.hi[neighbor] - surface.hi[current]) / surface.cell;
        const tentative =
          currentG +
          Math.hypot(dx, dz) +
          (crossing ? CROSS_EDGE_PENALTY : 0) +
          rise * VERTICAL_COST;
        if (tentative < gScore[neighbor]) {
          gScore[neighbor] = tentative;
          cameFrom[neighbor] = current;
          open.push([tentative + heuristic(neighbor), neighbor]);
        }
      });
    }

    if (startNode !== goalNode && cameFrom[goalNode] < 0) {
      return null;
    }
    // 顺着 cameFrom 往回走。−1 在这里不需要特判：链上除起点外的每个节点都被松弛过，
    // 所以 cameFrom 必然非负；而起点正是循环的终止条件。
    const nodes: number[] = [];
    let cursor = goalNode;
    while (cursor !== startNode) {
      nodes.push(cursor);
      cursor = cameFrom[cursor];
    }
    nodes.push(startNode);
    nodes.reverse();
    return nodes;
  }

  /**
   * 从 `startNode` 出发在节点图上做洪水填充，返回 XZ 最接近终点（世界坐标 `goalX` /
   * `goalZ`）的**可达**节点，外加这一片里最低的那个节点的高度。用作回退方案，使落在
   * 墙上或墙后、或落在小狗进不去的房间里的终点仍能产生通往最近可达节点的路线，而不是
   * 报告「找不到路径」。
   *
   * `lowest` 是顺路捎回来的，不额外走一遍图：这一片里的节点小狗一步之内都走得到，它的
   * 最低点落在哪儿，就是小狗**能下到多低**。只有 `plan()` 里那条落差判据用它，别的
   * 调用方不看。
   *
   * 一定返回一个节点（最次就是起点自己）：终点在天边时末端落在起点上，于是整条路只
   * 有一个点，调用方照「找不到路径」处理——与改动前 `nearestReachable2d` 的行为一致。
   *
   * 队列用定型数组而不是 `Array.push`：长度上界就是节点数，每个节点最多入队一次
   * （`visited` 挡着），不必让引擎反复扩容。
   */
  private nearestReachableNode(
    surface: OctoMapNavSurface,
    startNode: number,
    goalX: number,
    goalZ: number,
  ): { node: number; lowest: number } {
    const nx = surface.nx;
    const distanceSq = (node: number): number => {
      const cell = surface.cellOf[node];
      const dx = surface.minX + ((cell % nx) + 0.5) * surface.cell - goalX;
      const dz = surface.minZ + (((cell / nx) | 0) + 0.5) * surface.cell - goalZ;
      return dx * dx + dz * dz;
    };
    const visited = new Uint8Array(surface.nodeCount);
    const queue = new Int32Array(surface.nodeCount);
    let head = 0;
    let tail = 0;
    queue[tail++] = startNode;
    visited[startNode] = 1;
    let best = startNode;
    let bestDist = distanceSq(startNode);
    let lowest = surface.hi[startNode];
    while (head < tail) {
      const current = queue[head++];
      const dist = distanceSq(current);
      if (dist < bestDist) {
        bestDist = dist;
        best = current;
      }
      if (surface.hi[current] < lowest) {
        lowest = surface.hi[current];
      }
      surface.forEachNeighbor(current, (neighbor) => {
        if (!visited[neighbor]) {
          visited[neighbor] = 1;
          queue[tail++] = neighbor;
        }
      });
    }
    return { node: best, lowest };
  }
}
