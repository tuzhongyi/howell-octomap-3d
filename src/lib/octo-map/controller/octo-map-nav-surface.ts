import { DEFAULT_OCTO_MAP_SETTINGS, OctoMapBoundingBox } from '../octo-map.model';

/**
 * 同一个 run 内相邻两点的最大竖直间距（世界单位）。
 *
 * 扫描出来的地面自带 1~3 cm 的起伏（见 `OctoMapPathPlanner` 里 `MIN_STEP_HEIGHT` 的
 * 注释），不合并的话一个平面会被噪声切成好几层，小狗在同一个地板上会有几十个
 * 「不同的高度」。
 *
 * 取 3 cm 是两头权衡：再小 → 噪声把平面切碎；再大 → 桌面会和它底下那层并成一块，
 * 于是「站在桌上」和「站在桌下」变成同一个 run。
 *
 * 可站判定里也用同一个值当「连成一片」的容差（{@link OctoMapNavSurface.standable}）：
 * 一个 run 的底端离局部表面比这更近，就算是我脚下的面的一部分，而不是悬空的一块。
 */
const RUN_GAP = 0.03;

/**
 * 跨越候选的**格距**上限，12 格 = 0.6 m（{@link OctoMapNavConfig.crossWidth}）。
 *
 * 设置面板的滑杆最大只到 0.3 m（6 格），这里是给手改配置文件留的兜底：格距每加一格，
 * 每个节点要枚举的候选邻居数按平方涨（`π·d²`），而 A* 每扩展一个节点都要走一遍，
 * 顺着它涨下去就是页面卡死。超出的部分**砍掉**而不是报错——它是个性能护栏，不是语义
 * 的一部分。
 */
const MAX_CROSS_CELLS = 12;

/**
 * 直线段算「贴着表面走」的竖直容差（米），只用在 {@link OctoMapNavSurface.segmentClear}。
 *
 * **不能拿 `step`（跨越高度）当这个容差**：那是「迈一步的容许落差」，不是「表面起伏的
 * 容许量」。用 step 的话，一根 12 格（0.6 m）的弦可以从一个 0.4 m 高的土包正上方笔直
 * 掠过——判据认为「脚下有地」（`|hi − foot| ≤ step`），而小狗是从土包**中间穿过去**的。
 * 那比锯齿更难看，而且是平滑最容易引入的退化：折线是直了，但它在切地形。
 *
 * 取 0.05 m：地面噪声是 1~3 cm（见 {@link RUN_GAP}），5 cm 留了余量；同时它小于任何一级
 * 台阶，所以台阶处的锯齿宁可留着（那里本来就该拐弯），也不许拉出穿地的直线。
 */
const SURFACE_BAND = 0.05;

/**
 * 空列认领邻居面高时的搜索半径上限（格），以及下限。
 *
 * 半径由**数据**推（见 {@link fillEmptyColumns}），这两个只是护栏：下限 2 格是「至少
 * 够到最近一个邻列的中点」，上限 12 格与 `MAX_CROSS_CELLS` 同量级——真图上量到的
 * 推导值是 2（9.5% 的列有点），离上限很远，所以上限只在极端稀疏的点云上才起作用；
 * 而它起作用时是**好事**：半径一大，认领到的东西就越可能是「隔着半间屋子」的地形。
 */
const FILL_RADIUS_MIN = 2;
const FILL_RADIUS_MAX = 12;

/**
 * {@link OctoMapMapSettings.fillBaseCells} 的上限（格）：认领高度最多拿多大的邻域当基准。
 *
 * 它是个**性能护栏**，和 `MAX_CROSS_CELLS` / `FILL_RADIUS_MAX` 同一类：`minLo` 的传播
 * 是「窗口」趟 8 邻取最小，而窗口取 `max(半径, 设置值)`（见 {@link fillEmptyColumns}），
 * 所以这一项直接乘在每次 build 的耗时上。8M 格那档、窗口 12 时是 8M × 12 × 9 ≈ 8.6 亿次
 * 比较，已经到「感觉得到」的量级；配置文件里手改成 1000 就是把页面挂死。超出的部分
 * **砍掉**而不是报错。
 *
 * 取 12（= 0.6 m）而不是更大，理由与 `MAX_CROSS_CELLS` 的 0.6 m 同源：再往外，所谓
 * 「这一带的本地地面」就开始跨到隔壁房间、下一层地板去了，而那道高度守卫的整个意义
 * 就在于「同一张面」。真图上量过（`q:\tmp\fill-real-probe.mjs`）W = 8/16/32 三个窗口
 * 打出来的填充**逐列相同**，说明有效信息在 8 格以内就已经全部到手。
 */
const FILL_BASE_CELLS_MAX = 12;

/**
 * 认领来的高度允许比「窗口内最低的真实列」高出多少（米）；超出就退回 `groundLevel`。
 *
 * **这个数是被量出来的，不是想出来的。** 真图（`q:\tmp\fill-measure.mjs`）上 R = 2，
 * 96935 个空列里 13288 个能在半径内找到源，把「认领高度 − 邻域最低真实地板」的分布
 * 量出来是：
 *
 *      ≤0     5843      同一层（甚至略低）
 *     ≤0.05   5988  ← 到此 89.0%，断层就在这里
 *     ≤0.10    262
 *     ≤0.20    180
 *     ≤0.30    331
 *     ≤0.50    324
 *     ≤1.0     183
 *     ≤2.0     152
 *      >2.0     25   ← 最坏 2.403（门楣/架子那一类）
 *
 * 89% 落在 5 cm 以内，就是「同一张面、只是没扫到」那一档；往上到 1 m 是一整条稀疏
 * 长尾，典型的翻车现场是**门楣**（门洞上方那列最低也是 2.0 m，门洞底下没扫到的列
 * 认领了它，于是半空多一层幻影台阶，而原来 `groundLevel` 那层地板节点被顶掉了）。
 *
 * 取 **0.1 m（两格）** 而不是断层边上的 0.05：断层说明这个阈值本身不吃劲，取在谷的
 * 远端更稳，同时仍然把整条幻影长尾（0.1 以上的 1195 列，含那 25 列 2 m 以上的）全部
 * 挡在外面。**取小了是拿真地板换幻影**（0.05 只多留下 262 列），取大了整条长尾都进来。
 *
 * **刻意不跟 `step`（跨越高度）挂钩。** 一开始的设想是「不得比邻域最低高出超过一个
 * 跨越高度」，量完才知道那是错的：那等于让**小狗的攀爬能力**决定「一处没扫到的地板
 * 算不算同一张面」，而这是两个无关的问题。同一份数据上按 step = 0.5 卡，会拒掉
 * 13288 列里的 6348 列（48%）；把 step 拖到 1.5，被拒的又只剩 177 列。顺带它还解决
 * 了一个结构问题：`step` 要到 `configure` 才拿得到，而填充在 `build` 里就得定下来。
 */
const FILL_MAX_RISE = 0.1;

/**
 * 可站判定的输入。每次规划前由 `OctoMapPathPlanner` 用当前的设置和小狗参数
 * {@link OctoMapNavSurface.configure} 一次。
 *
 * `clearanceRadius` 由调用方算好（碰撞半径 **+ 半格安全余量**）再传进来：半格余量
 * 的来历见 `octo-map-path-grid.ts` 里 `CELL_SAFETY` 的注释，那是「格心判据推真实墙
 * 面距离」的账，属于规划器的口径，不该在这里重算一遍。
 */
export interface OctoMapNavConfig {
  /** 碰撞半径 + 半格安全余量（世界单位）。 */
  clearanceRadius: number;
  /** 小狗的通行高度。 */
  dogHeight: number;
  /** 跨越高度（设置里那一项，已过下限）。上爬与下跳**都**受它限制。 */
  step: number;
  /**
   * 跨越宽度（设置里那一项）：一步能跨过去的**无支撑水平跨度**上限，0 = 不跨。
   *
   * 「无支撑」指两端之间那一段里什么都没有——地上的坑、沟、扫描缺口。没有它时图里
   * 只有八邻的边，小狗必须**踩到**中间每一列上，而比一步深的坑（坑底自己的 run 离
   * 坑沿不止一个跨越高度）中间那一列没有节点，于是就过不去了。有了它，小狗可以一步
   * 跨到对岸。
   *
   * 量的是两列**格心**之间、除去两端各占的半格之后剩下的那一段，所以格距 `d`（格）
   * 的两列要满足 `(d − 1) * cell <= crossWidth` 才连得上边。
   */
  crossWidth: number;
  /** 假想地面是否延伸到点云之外（设置里那一项）。 */
  groundExtendsOutside: boolean;
  /** 点云包围盒；`groundExtendsOutside` 为 false 时用来封住扫描之外的地面。 */
  bounds: OctoMapBoundingBox | null;
  /**
   * 被刷成禁行的**列**（长 `nx*nz`），整列不可站。null = 一个都没有。
   *
   * 由调用方从体素网格的 `forbidden` 集合翻译过来（一个禁行体素 → 它格心所在的那
   * 一列），与改动前的行为一致：刷过的格子整列封死，而不是只挡它自己那段高度。
   * 否则「刷桌面禁止站上去」这个手势会失效——云自己的 run 还在，照样可站。
   */
  banned: Uint8Array | null;
}

/**
 * 给每个**空列**算一个待用高度：窗口内最近的一个有点的列，它最低那个 run 的 `lo`。
 * 找不到源、或者被 {@link FILL_MAX_RISE} 那道守卫挡下的，记 `NaN`（调用方退回
 * `groundLevel`）。
 *
 * 为什么是**最低那个 run 的 `lo`** 而不是 `hi`：一面墙那一列只有一根 0→2.5 的 run，
 * 它的 `hi` 是墙顶，取 `hi` 会在每堵墙旁边凭空造出一层 2.5 m 的地板；`lo` 才是墙脚跟
 * 的地面。对地板列来说两者本来就相等。
 *
 * 半径 `R` 由**占用率**推：`ceil(sqrt(cellCount / occupied) / 2)`，夹在
 * `[FILL_RADIUS_MIN, FILL_RADIUS_MAX]`。要填的是**点云自己的稀疏度**（随机撒点的
 * 最近邻平均间距就是 `0.5/sqrt(p)` 格的量级），而 `positions` 是原始点云，跟渲染用的
 * 体素大小无关。真图上 9.5% 占用 → R = 2；0.2 m 的点阵 → R = 2（正好够到 4 格间隙的
 * 中点）；0.6 m 的点阵 → R = 6。
 *
 * 并列时取 **`lo` 更小的**那个源，完全相等再按列号决胜。这不是洁癖：不定这两条，
 * 同一个点云会给出不同的表面图，这个新算法连稳定的回归测试都写不了。
 *
 * 代价是两趟 O(nx·nz)（BFS 一趟 + 守卫的 `window` 趟 8 邻取最小），**每次 build 一次**。
 * 本函数只在 `fillFromNeighbors` 打开时才被调用。
 *
 * ## `baseCells`：那道高度守卫拿多大的邻域当基准
 *
 * `window = max(R, baseCells)`（夹在 {@link FILL_BASE_CELLS_MAX}），即**守卫看的范围至少
 * 有 `baseCells` 格**。改这个数**只会让填充变少，不会变多、也不会改变任何一列的认领
 * 高度**：`minLo` 是「窗口内真实列的最低 `lo`」，窗口一大，这个最小值只可能更小，于是
 * 被 `out[c] > minLo[c] + FILL_MAX_RISE` 拒掉的列只可能更多。真图上量到的是
 * 10241 → 9179 列（`q:\tmp\fill-real-probe.mjs`）。这条单调性让「哪一列为什么被拒」
 * 可以逐列对账，也让回归的差异解释得干净：每一处差异都是**某列丢了填充、退回
 * `groundLevel`**。
 *
 * **为什么必须是 `max(R, …)`，不能让用户把它调到 R 以下**：`minLo` 的种子只有真实列，
 * 而空列的认领高度来自 BFS 找到的源（切比雪夫距离 ≤ R）。窗口比 R 还小时，`minLo` 有
 * 可能取不到任何真实列、停在 `+∞`——而 `out[c] > ∞ + 0.1` 恒为假，守卫**整条失效**，
 * 幽灵坡道原样回来。下限因此不是「越小越松」，而是「小于 R 就没有意义」。
 *
 * 窗口取 8 而不是 R（= 2）治的是**薄片旁边**那一类：一道 0.4 m 宽、6 m 高的连续斜面
 * （真图上的「云梯」）旁边，R 格内唯一的真实列**就是薄片自己**，`minLo` 恰好等于认领
 * 到的坡道高度，落差恒为 0，守卫必然放行——于是填充沿着一侧挤出一条平行的可行走
 * 幽灵坡道（量到紧挨薄带的两列被抬到离地 5.73 / 5.77 m）。窗口放到 8 格，这层邻域里
 * 总算有了薄片脚下的地面，`minLo` 回到地面高度，落差 5.7 m ≫ 0.1 m，薄带旁的列全部
 * 被拒（同一处量到 12 个抬高的填充列 → 0，两侧列回到离地 0.15 / 0.10 m）。窗口再大
 * 就没有新信息了：8/16/32 三个值打出来的填充逐列相同。
 */
function fillEmptyColumns(
  colLo: Float32Array,
  nx: number,
  nz: number,
  occupied: number,
  baseCells: number,
): Float32Array {
  const cellCount = nx * nz;
  const out = new Float32Array(cellCount).fill(NaN);
  if (occupied === 0 || occupied === cellCount) {
    // 两个「可证明」的恒等域，直接短路，连 BFS 都不必跑：一个源都没有（点云还没
    // 载入、或全在网格外）时没有任何东西可认领；全都有点时空列根本不存在。
    return out;
  }
  const radius = Math.max(
    FILL_RADIUS_MIN,
    Math.min(FILL_RADIUS_MAX, Math.ceil(Math.sqrt(cellCount / occupied) / 2)),
  );

  // --- 多源 BFS：源 = 有点的列，层数 = 切比雪夫距离 --------------------------
  // 源本身也写进 out（它的 colLo 就是它自己的高度），守卫要用「邻域里最低的真实
  // 列」，而真实列恰好就是这个 BFS 的源集合。
  const dist = new Int32Array(cellCount).fill(-1);
  const src = new Int32Array(cellCount).fill(-1);
  const queue = new Int32Array(cellCount);
  let tail = 0;
  for (let c = 0; c < cellCount; c++) {
    if (colLo[c] !== Infinity) {
      dist[c] = 0;
      src[c] = c;
      out[c] = colLo[c];
      queue[tail++] = c;
    }
  }
  for (let head = 0; head < tail; head++) {
    const cur = queue[head];
    if (dist[cur] >= radius) {
      continue; // 不越过半径就不扩散，半径因此同时封住了 BFS
    }
    const cx = cur % nx;
    const cz = (cur / nx) | 0;
    for (let dz = -1; dz <= 1; dz++) {
      const z = cz + dz;
      if (z < 0 || z >= nz) {
        continue;
      }
      for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= nx || (dx === 0 && dz === 0)) {
          continue;
        }
        const n = x + z * nx;
        if (dist[n] < 0) {
          dist[n] = dist[cur] + 1;
          src[n] = src[cur];
          out[n] = out[cur];
          queue[tail++] = n;
          continue;
        }
        // 已经认领过：只跟**同一层**的候选比（更远的那些本来就不该赢），取 lo 更
        // 小的，完全相等再取源列号小的。
        if (dist[n] === dist[cur] + 1) {
          const cand = out[cur];
          if (
            cand < out[n] - 1e-9 ||
            (Math.abs(cand - out[n]) <= 1e-9 && src[cur] >= 0 && src[cur] < src[n])
          ) {
            out[n] = cand;
            src[n] = src[cur];
          }
        }
      }
    }
  }

  // --- 守卫：认领的高度不得比 window 格内最低的**真实**列高出 FILL_MAX_RISE ----
  // window 趟 8 邻取最小，种子只放真实列（空列一开始是 +∞，只能从邻居处得到值），
  // 于是第 k 趟之后 `minLo[c]` = 「离 c 的切比雪夫距离 ≤ k 的真实列里的最低 lo」。
  //
  // `baseCells` 是设置里那一项（默认 8 格），只放大**守卫的基准邻域**，不放大 BFS：
  // 填充伸得多远仍然由 `radius` 定。取 max 的理由（不能让它小于 radius）见本函数的
  // 文档；`Math.min` 那道是性能护栏，见 FILL_BASE_CELLS_MAX。
  const window = Math.max(radius, Math.min(FILL_BASE_CELLS_MAX, baseCells));
  let minLo = Float32Array.from(colLo, (v) => (v === Infinity ? Infinity : v));
  for (let pass = 0; pass < window; pass++) {
    const next = minLo.slice();
    for (let z = 0; z < nz; z++) {
      for (let x = 0; x < nx; x++) {
        const c = x + z * nx;
        let m = next[c];
        for (let dz = -1; dz <= 1; dz++) {
          const zz = z + dz;
          if (zz < 0 || zz >= nz) {
            continue;
          }
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= nx) {
              continue;
            }
            const v = minLo[xx + zz * nx];
            if (v < m) {
              m = v;
            }
          }
        }
        next[c] = m;
      }
    }
    minLo = next;
  }

  for (let c = 0; c < cellCount; c++) {
    // `dist <= 0` 一次盖掉两头：0 是源（它自己的高度不该被守卫动，调用方也只在空列上
    // 查这张表），−1 是压根没够到源。两者都抹成 NaN，于是「非 NaN 的格子 = 可用的
    // 填充高度」这个契约对测试也成立。
    if (dist[c] <= 0 || out[c] > minLo[c] + FILL_MAX_RISE) {
      out[c] = NaN;
    }
  }
  return out;
}

/**
 * 点云在 XZ 网格上的**多层**表面：每列若干个竖直 run，加上「站在哪个 run 上、
 * 能走到哪些 run」这两件事。
 *
 * 这是把寻路从「单层地面」升级成「多层表面」的核心。改动前每一列只有一个可行进
 * 高度（离地面 `maxStepHeight` 以内的最高点），所以小狗根本上不了桌面；现在每列
 * 保留它**全部**的竖直占用段，每段都是一个可站的候选面，段与段之间用落差是否在
 * 跨越高度以内来连边。
 *
 * 三件事都封装在这里，都是为了能脱离浏览器单测：
 *
 * 1. {@link build} 从原始点云抽出每列的 run（不依赖渲染体素，门和缝隙仍然可见）；
 * 2. {@link standable} 判一个 run 顶上站不站得住（小狗的身体和它周围的几何的关系）；
 * 3. {@link mapPoint} 把起终点吸附到最近的能站节点，{@link forEachNeighbor} 枚举
 *    一步能走到的邻居（八邻，外加「一步跨过去」的那一圈）。
 *
 * A* 本身不在这里——它属于规划器，这里只出「图」。
 */
export class OctoMapNavSurface {
  readonly nx: number;
  readonly nz: number;
  readonly minX: number;
  readonly minZ: number;
  readonly cell: number;
  readonly groundLevel: number;

  /** run 的下端点（世界 Y），按 run id 索引。 */
  readonly lo: Float32Array;
  /** run 的上端点。**上端点就是站上去以后脚下的那个高度**。 */
  readonly hi: Float32Array;
  /** 每列 run 的 id 区间：列 `c` 的 run 是 `[runOffset[c], runOffset[c + 1])`。 */
  readonly runOffset: Int32Array;
  /** run 所在的列（格索引 `ix + iz * nx`）。反查列是热路径，值得这 4 字节。 */
  readonly cellOf: Int32Array;
  /** 1 = 这列一个点都没有，是 {@link build} 补出来的虚拟地面。 */
  readonly virtualRun: Uint8Array;

  private config: OctoMapNavConfig | null = null;
  /** 可站判定的记忆：0 未知 / 1 可站 / 2 不可站。按 run id 索引。 */
  private standableMemo: Uint8Array;
  /** 净空判定要扫的邻域偏移（格），在 {@link configure} 里按半径算一次。 */
  private discDx = new Int32Array(0);
  private discDz = new Int32Array(0);
  /** 跨越宽度的候选偏移——{@link forEachNeighbor} 在八邻之外多走的那一圈。 */
  private crossDx = new Int32Array(0);
  private crossDz = new Int32Array(0);
  /** 第 `k` 个跨越偏移要跨过的中间格，在下面三个数组里的区间是 `[k, k+1)`。 */
  private crossMidOffset = new Int32Array(1);
  private crossMidDx = new Int32Array(0);
  private crossMidDz = new Int32Array(0);
  /** 中间格在跨段上的位置比例（0 = 起点那列，1 = 终点那列），用来插值脚下的高度。 */
  private crossMidT = new Float32Array(0);
  /** 点云包围盒占的格范围，`groundExtendsOutside` 为 false 时用来封边。 */
  private bx0 = 0;
  private bx1 = -1;
  private bz0 = 0;
  private bz1 = -1;

  get nodeCount(): number {
    return this.hi.length;
  }

  private constructor(
    nx: number,
    nz: number,
    minX: number,
    minZ: number,
    cell: number,
    groundLevel: number,
    lo: Float32Array,
    hi: Float32Array,
    runOffset: Int32Array,
    cellOf: Int32Array,
    virtualRun: Uint8Array,
  ) {
    this.nx = nx;
    this.nz = nz;
    this.minX = minX;
    this.minZ = minZ;
    this.cell = cell;
    this.groundLevel = groundLevel;
    this.lo = lo;
    this.hi = hi;
    this.runOffset = runOffset;
    this.cellOf = cellOf;
    this.virtualRun = virtualRun;
    this.standableMemo = new Uint8Array(hi.length);
  }

  /**
   * 从原始点云抽出每列的竖直 run。
   *
   * 走法是**计数排序**而不是「按高度分片打位图」：位图的体积是 `nx*nz*ceil(场景高/
   * 片厚)`，一个 +500 m 的离群点就能让它涨到 GB 级（`MAX_FREE_CELLS` 存在的理由
   * 正是这个），而按列散射内存只跟点数走。顺带把 run 的 lo/hi 做成**精确的**点
   * 高度——位图那条路只能给出量化到片厚的上下端。
   *
   * 步骤：数每列点数 → 前缀和 → 把 y 散射进一个按列分段的扁平数组 → 每列原地
   * 排序 → 扫描合并（间距 > {@link RUN_GAP} 就断开）→ 空列补一个虚拟地面 run。
   *
   * **空列也要有节点**，这是 `groundExtendsOutside` 能工作的前提：改动前空列是
   * `surface = groundLevel, obstacle = 0`（可走），小狗因此能绕过建筑走到另一侧
   * 的门；新模型里空列若没有 run 就没有节点，网格特意留的那圈边距会整片变成墙。
   * 网格内部点云的空洞（玻璃、扫描缺口）同理——改动前也是按地面走的。
   *
   * 那圈边距是 `navGridSize` 按包围盒和碰撞半径自己算的（15% 与膨胀半径取大者），
   * 与**视口那块灰地面的大小**无关：后者由设置里的「延展长度/宽度」单独给，是纯
   * 粹的可点击范围。两者别再互相按比例去推。
   *
   * `fillFromNeighbors` 打开时，空列的虚拟地面高度**不再取 `groundLevel`**，而是取
   * 「R 格内最近的一个有点的列，它最低那个 run 的 `lo`」（见 {@link fillEmptyColumns}）。
   * 默认关——关着时逐字节等于改动前。开着时**只换高度，不换任何别的东西**：虚拟 run
   * 仍然是虚拟 run（仍然跳过全部净空判定），节点数、run id、`runOffset` 全都不变。
   * 这一条是整套改法安全的前提，不能顺手「改进」成真实的 run。
   *
   * `fillBaseCells` 是设置里的「填充基准范围」（见 {@link OctoMapMapSettings.fillBaseCells}），
   * 只在 `fillFromNeighbors` 打开时有意义：它放大那道高度守卫的**基准邻域**，于是更
   * 多的空列会因为「认领到的面比这一带的本地地面高太多」而被拒、退回 `groundLevel`。
   * 它是**建图参数**，跟 `step` / `crossWidth` 那些不同——后者要到 `configure` 才拿得到，
   * 而填充在 `build` 里就把高度定死了（这也是 `FILL_MAX_RISE` 刻意不跟 `step` 挂钩的
   * 原因之一，见那条注释的末段）。
   */
  static build(
    positions: Float32Array | null,
    nx: number,
    nz: number,
    minX: number,
    minZ: number,
    cell: number,
    groundLevel: number,
    fillFromNeighbors = false,
    fillBaseCells: number = DEFAULT_OCTO_MAP_SETTINGS.fillBaseCells,
  ): OctoMapNavSurface {
    const cellCount = nx * nz;
    const counts = new Uint32Array(cellCount);
    let inGrid = 0;
    let emptyColumns = 0;
    if (positions) {
      for (let i = 0; i < positions.length; i += 3) {
        const ix = Math.floor((positions[i] - minX) / cell);
        const iz = Math.floor((positions[i + 2] - minZ) / cell);
        if (ix < 0 || ix >= nx || iz < 0 || iz >= nz) {
          continue;
        }
        counts[ix + iz * nx]++;
        inGrid++;
      }
    }

    const pointOffset = new Uint32Array(cellCount + 1);
    for (let c = 0; c < cellCount; c++) {
      pointOffset[c + 1] = pointOffset[c] + counts[c];
      if (counts[c] === 0) {
        emptyColumns++;
      }
    }

    const ys = new Float32Array(inGrid);
    const cursor = pointOffset.slice(0, cellCount);
    // 填充要用「每一列最低的那个 y」当源。它**顺路**就算出来了（散射那一遍里一次
    // 比较），不另开一趟遍历、更不提前排序——排序在主循环里是就地做的，而主循环的
    // 发射顺序是必须逐字节保持的东西。
    const colLo = fillFromNeighbors ? new Float32Array(cellCount).fill(Infinity) : null;
    if (positions) {
      for (let i = 0; i < positions.length; i += 3) {
        const ix = Math.floor((positions[i] - minX) / cell);
        const iz = Math.floor((positions[i + 2] - minZ) / cell);
        if (ix < 0 || ix >= nx || iz < 0 || iz >= nz) {
          continue;
        }
        const c = ix + iz * nx;
        ys[cursor[c]++] = positions[i + 1];
        if (colLo && positions[i + 1] < colLo[c]) {
          colLo[c] = positions[i + 1];
        }
      }
    }
    // 空列该补什么高度：一个源都没有 / 被守卫挡下 / 关闭填充的地方记 NaN，主循环
    // 见到 NaN 就用 `groundLevel`。
    const fillHi = colLo
      ? fillEmptyColumns(colLo, nx, nz, cellCount - emptyColumns, fillBaseCells)
      : null;

    // run 数的上界：每个 run 至少一个点，加上每个空列一个虚拟地面。
    const cap = inGrid + emptyColumns;
    const loBuf = new Float32Array(cap);
    const hiBuf = new Float32Array(cap);
    const cellBuf = new Int32Array(cap);
    const virtualBuf = new Uint8Array(cap);
    const runOffset = new Int32Array(cellCount + 1);
    let runCount = 0;

    for (let c = 0; c < cellCount; c++) {
      runOffset[c] = runCount;
      const from = pointOffset[c];
      const to = pointOffset[c + 1];
      if (from === to) {
        // 填充开着时这里是**查表**而不是第二遍追加：虚拟 run 与真实 run 仍然在这
        // 一个 `for (c)` 里按列号发射，所以 run id 顺序不变。这一条不能改——`MinHeap`
        // 没有 decrease-key，`mapPoint` / `nearestReachableNode` 在并列时按
        // `distSq` / `hi` 决胜，**run id 的顺序会决定并列时输出哪条路**，于是
        // 「另开一遍遍历把填充列补上去」会把旧算法的输出也一起改掉。
        const filled = fillHi ? fillHi[c] : NaN;
        const h = Number.isNaN(filled) ? groundLevel : filled;
        loBuf[runCount] = h;
        hiBuf[runCount] = h;
        cellBuf[runCount] = c;
        virtualBuf[runCount] = 1;
        runCount++;
        continue;
      }
      // 定型数组的 sort 是数值序（不是字典序），就地排这一段。
      ys.subarray(from, to).sort();
      let runLo = ys[from];
      let prev = ys[from];
      for (let i = from + 1; i < to; i++) {
        const y = ys[i];
        if (y - prev > RUN_GAP) {
          loBuf[runCount] = runLo;
          hiBuf[runCount] = prev;
          cellBuf[runCount] = c;
          runCount++;
          runLo = y;
        }
        prev = y;
      }
      loBuf[runCount] = runLo;
      hiBuf[runCount] = prev;
      cellBuf[runCount] = c;
      runCount++;
    }
    runOffset[cellCount] = runCount;

    // 裁到实际长度：cap 是按点数估的上界，留着会白占几 MB。列内 run 按 hi 升序
    // （ys 已排好），`forEachNeighbor` 因此可以顺序扫。
    return new OctoMapNavSurface(
      nx, nz, minX, minZ, cell, groundLevel,
      loBuf.slice(0, runCount),
      hiBuf.slice(0, runCount),
      runOffset,
      cellBuf.slice(0, runCount),
      virtualBuf.slice(0, runCount),
    );
  }

  /**
   * 换一套小狗参数（碰撞半径、通行高度、跨越高度、地面范围、禁行列）。
   *
   * 单独一个方法而不是塞进 {@link build}：run 的结构只跟点云走，而参数每次拖滑块
   * 都在变。分开之后调用方能缓存 build 的结果，只重跑这一步。
   */
  configure(config: OctoMapNavConfig): void {
    this.config = config;
    // 判定结果全部作废。长度够就复用（拖滑块时不必重新分配），不够才新建。
    if (this.standableMemo.length < this.nodeCount) {
      this.standableMemo = new Uint8Array(this.nodeCount);
    } else {
      this.standableMemo.fill(0);
    }

    const r = config.clearanceRadius / this.cell;
    const reach = Math.ceil(r);
    const r2 = r * r;
    const dxs: number[] = [];
    const dzs: number[] = [];
    for (let dz = -reach; dz <= reach; dz++) {
      for (let dx = -reach; dx <= reach; dx++) {
        // `<=` 而不是 `<`：判据要与「以格心为心、半径 (r + 安全余量)/cell 的浮点圆盘」
        // 逐位相同（碰撞半径滑块上的一厘米要真的是一厘米），见 `octo-map-path-grid.ts`
        // 里 `CELL_SAFETY` 的说明。
        if (dx * dx + dz * dz <= r2) {
          dxs.push(dx);
          dzs.push(dz);
        }
      }
    }
    this.discDx = Int32Array.from(dxs);
    this.discDz = Int32Array.from(dzs);

    this.buildCrossOffsets(config.crossWidth);

    const bbox = config.bounds;
    if (bbox) {
      this.bx0 = Math.max(0, Math.floor((bbox.min[0] - this.minX) / this.cell));
      this.bx1 = Math.min(this.nx - 1, Math.floor((bbox.max[0] - this.minX) / this.cell));
      this.bz0 = Math.max(0, Math.floor((bbox.min[2] - this.minZ) / this.cell));
      this.bz1 = Math.min(this.nz - 1, Math.floor((bbox.max[2] - this.minZ) / this.cell));
    } else {
      this.bx1 = this.nx - 1;
      this.bz1 = this.nz - 1;
    }
  }

  /**
   * 按跨越宽度算出「一步能跨过去」的候选偏移，以及每个偏移路上要跨过的中间格。
   *
   * 判据只有一条：**两端格心之间的距离，除去两端各占的半格，剩下的就是没有支撑的那
   * 一段**，它不超过跨越宽度才允许连边。格距 `d`（格，欧氏）因此要满足
   * `d <= 1 + crossWidth / cell`。
   *
   * 八邻（`max(|dx|,|dz|) == 1`）不在这里——它们本来就有边，中间也没有别的格子。
   * 所以这里只管 `max(|dx|,|dz|) >= 2` 的那些；`crossWidth = 0` 时一个都没有，八邻
   * 图就是全部（改动前的行为）。
   *
   * 中间格是**预计算**的：搜索时每个候选偏移都要算一遍「这一段过不过得去」，而它经过
   * 哪些格子只跟偏移有关，跟两端的高度无关。
   */
  private buildCrossOffsets(crossWidth: number): void {
    const limit = Math.min(1 + Math.max(crossWidth, 0) / this.cell, MAX_CROSS_CELLS);
    const reach = Math.ceil(limit);
    const dxs: number[] = [];
    const dzs: number[] = [];
    const midDxs: number[] = [];
    const midDzs: number[] = [];
    const midTs: number[] = [];
    const offsets: number[] = [0];
    if (reach >= 2) {
      for (let dz = -reach; dz <= reach; dz++) {
        for (let dx = -reach; dx <= reach; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) < 2) {
            continue;
          }
          const d = Math.hypot(dx, dz);
          if (d > limit) {
            continue;
          }
          dxs.push(dx);
          dzs.push(dz);
          // 沿段每半格取一点、取它**落在的格**（最近整数，不是下取整——偏移的坐标系
          // 里，格 `i` 占的是 `[i − 0.5, i + 0.5)`）。半格的密度足够让一条斜跨不漏掉
          // 中间那一格，而 `d <= 1 + crossWidth / cell` 又把点数压在个位数。
          const n = Math.max(2, Math.ceil(2 * d));
          let lastDx = 0;
          let lastDz = 0;
          for (let k = 1; k < n; k++) {
            const t = k / n;
            const mx = Math.round(dx * t);
            const mz = Math.round(dz * t);
            if ((mx === 0 && mz === 0) || (mx === dx && mz === dz)) {
              continue;
            }
            if (mx === lastDx && mz === lastDz) {
              continue;
            }
            lastDx = mx;
            lastDz = mz;
            midDxs.push(mx);
            midDzs.push(mz);
            // 同一格被采到几次时留第一次的比例（离起点最近的那个），够用：跨段最多
            // 一个跨越宽度长，插值出来的高度差在一格以内。
            midTs.push(t);
          }
          offsets.push(midDxs.length);
        }
      }
    }
    this.crossDx = Int32Array.from(dxs);
    this.crossDz = Int32Array.from(dzs);
    this.crossMidOffset = Int32Array.from(offsets);
    this.crossMidDx = Int32Array.from(midDxs);
    this.crossMidDz = Int32Array.from(midDzs);
    this.crossMidT = Float32Array.from(midTs);
  }

  /** run 的世界坐标位置：格心 + 它的上端点（脚踏的那个面）。 */
  worldOf(runId: number): [number, number, number] {
    const cell = this.cellOf[runId];
    const ix = cell % this.nx;
    const iz = (cell / this.nx) | 0;
    return [
      this.minX + (ix + 0.5) * this.cell,
      this.hi[runId],
      this.minZ + (iz + 0.5) * this.cell,
    ];
  }

  /**
   * 小狗能不能站在这个 run 的顶上——即「站在这里，身体和小狗周围的几何冲不冲突」。
   *
   * 判据是半径 `clearanceRadius` 内**每一列**的每一个 run 都不与小狗的**身子带**
   * `(h + step, h + dogHeight]` 相交：
   *
   * ```
   * run.hi > h + step 且 run.lo < h + dogHeight
   * ```
   *
   * **`step` 这一项是承重的**，两种写法必须分清楚：
   *
   * - 写成 `run.hi > h`（「身体所占的区间里不许有任何几何」）是**致命**的：每个节点
   *   会被**自己脚下那个 run** 判死（`run.hi == h > h`），而且 30 cm 的台阶会在四周
   *   留一圈 0.275 m 的不可站护城河——门槛、路沿、门口地坎全变成墙，噪声地面上半数
   *   的格都站不住。
   * - 从 `h + step` 起量（本方案）等于说「跨越高度以内那一段是腿能迈过去的，不算
   *   阻挡」。台阶因此只是「可以迈上去的表面」；`h ≈ groundLevel` 时这条恰好退化成
   *   改动前的 `step < rel <= dogHeight` 逐格相同，门宽与碰撞半径的结果不变。
   *
   * `h` 取**局部表面**而不是地面高度，是这一整套能用的前提：站在桌面上时身子带跟着
   * 桌面走，桌子底下那一层才不会把桌面判死。
   *
   * **自己那一列还要多一条**：`run.lo` 落在 `(h + RUN_GAP, h + dogHeight)` 里的 run，
   * 是「起点在我脚下之上、顶在我头顶之下」的几何——矮桌子的桌面、椅子面、搁板，
   * 也就是说**我站不进它里面**。少了这条会错两处：小狗会从矮桌子底下穿过去（下层的
   * 地面节点和它在同一列，对 A* 来说更近），以及会站在 30 cm 台阶的**内部**（那一列
   * 的 run 从 0.05 起）。容差取 {@link RUN_GAP}（与 run 的合并容差同一个值）：比这
   * 更近的算连成一片，是我脚下的面。
   *
   * 这一条**只查自己那一列**，邻列仍按上面的脚步规则放行——否则 30 cm 的台阶又会
   * 在四周长出护城河。分界是「几何是不是长在我脚下」。台阶的竖直面在点云里是按扫描
   * 间距铺开的一串点，间距小于 `RUN_GAP` 时本来就合成一个 run；铺得稀疏而散成若干
   * 段时，邻列那条规则也会把顶在跨越高度以内的几段放行，只有真正高过 `h + step`
   * 的才挡路。
   */
  standable(runId: number): boolean {
    const memo = this.standableMemo;
    const cached = memo[runId];
    if (cached) {
      return cached === 1;
    }
    const ok = this.testStandable(runId);
    memo[runId] = ok ? 1 : 2;
    return ok;
  }

  /**
   * 从 `runId` 出发，一步能走到的所有节点（8 邻，落差在跨越高度以内，且目标可站）。
   *
   * **上下对称**：上爬受「跨越高度」限制，下跳同样受它限制——小狗从桌面跳下来要
   * 0.75 m 的话，得先把跨越高度调上去。这不只是保守：小狗每段的 Y 是线性插值、
   * 身体再按方向俯仰的，落差一大它就会低头俯冲，路径管也会拉出一段近乎竖直的下落。
   *
   * 候选**不是只取邻居列里最高的那个 run**。只取最高的会有两个坑：家具顶在跨越
   * 高度以内时，家具下面那层能站的地面就再也进不去了（改动前的单层模型是能进的）；
   * 而「最高的那个恰好不可站」还会把整条边判死，明明还有更低的合法落点。
   *
   * 八邻之外还有一圈**跨越**的邻居（{@link OctoMapNavConfig.crossWidth}）：格距在
   * 「一个跨越宽度 + 一格」以内的列都可以直接连边，条件是路上那些中间格过得去
   * （{@link crossClear}）。地上的坑因此能跨过去，而不必踩到坑底。跨界照样受跨越
   * 高度限制——一步跨过去，脚抬起来的那一下和爬台阶是同一条规矩。
   *
   * 回调里的 `dx` / `dz` 是**格单位的偏移**，跨越的邻居会超出 ±1。边权因此得按
   * `hypot(dx, dz)` 算，不能再用「斜着 √2、其余 1」那条口诀（八邻时两者相等）。
   * 另外「格距 ≥ 2」就是「这是一条跨越边」的判据，调用方（A* 的边权）还要按它加一笔
   * 惩罚，否则跳过去和走过去同价，而跳那一段的判定更松，A* 会一路跳着过去。
   *
   * 用回调而不是返回数组：这是 A* 最热的循环，每个节点都要枚举一遍邻居。
   */
  forEachNeighbor(
    runId: number,
    visit: (neighborId: number, dx: number, dz: number) => void,
  ): void {
    const cfg = this.cfg;
    const h = this.hi[runId];
    const up = h + cfg.step;
    const down = h - cfg.step;
    const cell = this.cellOf[runId];
    const cx = cell % this.nx;
    const cz = (cell / this.nx) | 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) {
          continue;
        }
        const x = cx + dx;
        const z = cz + dz;
        if (x < 0 || x >= this.nx || z < 0 || z >= this.nz) {
          continue;
        }
        const neighborCell = x + z * this.nx;
        const end = this.runOffset[neighborCell + 1];
        for (let id = this.runOffset[neighborCell]; id < end; id++) {
          const target = this.hi[id];
          if (target > up || target < down) {
            continue;
          }
          if (!this.standable(id)) {
            continue;
          }
          visit(id, dx, dz);
        }
      }
    }
    const crossDx = this.crossDx;
    for (let k = 0; k < crossDx.length; k++) {
      const dx = crossDx[k];
      const dz = this.crossDz[k];
      const x = cx + dx;
      const z = cz + dz;
      if (x < 0 || x >= this.nx || z < 0 || z >= this.nz) {
        continue;
      }
      const neighborCell = x + z * this.nx;
      const end = this.runOffset[neighborCell + 1];
      for (let id = this.runOffset[neighborCell]; id < end; id++) {
        const target = this.hi[id];
        if (target > up || target < down) {
          continue;
        }
        if (!this.standable(id)) {
          continue;
        }
        // 中间那几列过得去过不去的判定要按**这一跨**的落差插值，所以它跟落点的高度
        // 有关，只能放在取到具体 run 之后（同一个邻居列里可能不止一个合法落点）。
        if (!this.crossClear(cx, cz, h, target, k)) {
          continue;
        }
        visit(id, dx, dz);
      }
    }
  }

  /**
   * 从 `(cx, cz)` 一步跨到 `(cx + dx, cz + dz)`、落在高度 `targetH` 上，路上那些中间
   * 格让不让过。
   *
   * 只用**墙规则**，脚下的高度按段上的位置线性插值：
   *
   * ```
   * runHi > h + step 且 runLo < h + dogHeight
   * ```
   *
   * 这里**不能**拿可站判定来量：小狗只是**路过**这些格子，没打算站在上面。用「站不站
   * 得住」量「走不走得过去」，坑沿和桌腿旁边那圈地面全都会变成墙——净空审计那一课已经
   * 吃过一次（段内采样只认墙规则）。
   *
   * 禁行列与「点云之外不许走」这两条照旧管着中间格：刷过的障碍跨不过去。
   *
   * 老实说一句口径：默认宽度下这一跨整段都落在落点的净空圆盘（`clearanceRadius`，
   * 0.275 m）之内，那圈判定已经把它查过一遍了；这里的采样是为**把滑杆拖大之后**的
   * 长跨准备的，也让「跨过去」这件事在这张图上有个明确的位置可查。
   */
  private crossClear(cx: number, cz: number, h: number, targetH: number, k: number): boolean {
    const cfg = this.cfg;
    const from = this.crossMidOffset[k];
    const to = this.crossMidOffset[k + 1];
    const dh = targetH - h;
    for (let i = from; i < to; i++) {
      const x = cx + this.crossMidDx[i];
      const z = cz + this.crossMidDz[i];
      if (x < 0 || x >= this.nx || z < 0 || z >= this.nz) {
        return false;
      }
      const midCell = x + z * this.nx;
      if (cfg.banned && cfg.banned[midCell]) {
        return false;
      }
      if (
        !cfg.groundExtendsOutside &&
        (x < this.bx0 || x > this.bx1 || z < this.bz0 || z > this.bz1)
      ) {
        return false;
      }
      const foot = h + dh * this.crossMidT[i];
      const wallTop = foot + cfg.step;
      const bodyTop = foot + cfg.dogHeight;
      const end = this.runOffset[midCell + 1];
      for (let id = this.runOffset[midCell]; id < end; id++) {
        // 虚拟地面不是几何（见 testStandable）：跨过一片没扫到东西的缺口是过得去的。
        if (this.virtualRun[id]) {
          continue;
        }
        if (this.hi[id] > wallTop && this.lo[id] < bodyTop) {
          return false;
        }
      }
    }
    return true;
  }

  /**
   * 两端之间能不能**拉一条直线走过去**——小狗的身体沿这根弦扫过去，会不会碰到东西。
   *
   * 用途是**把锯齿拉直**（见 `OctoMapPathPlanner` 的 `SMOOTH_CHORD_CELLS`）：A* 的
   * 边权只跟「走了一步什么方向」有关，跟这些步的**先后**无关，于是所有同样方向组合的
   * 走法代价**严格相等**，折线的形状完全不受代价约束。量出来的样子就是每米 3 个转角、
   * 其中 75% 左右翻号——狗头一直在抖。要修它就得在代价之外再加一条**形状**判据，也就是
   * 这个函数：直线扫过去不碰东西，就可以把那一段的锯齿整段删掉。
   *
   * 判据分三条，缺一不可：
   *
   * 1. **两端高差 ≤ 跨越高度**：与图上一条边的规矩一样（`|Δh| ≤ step`），否则这一步
   *    本来就跨不过去，不该由平滑变出来。
   * 2. **脚下有地**：每一处采样点，自己那一列得有一个 run 贴着脚高
   *    （`|hi − 脚高| ≤ SURFACE_BAND`，**不是** `step`，理由见那个常量）。
   *    少了这条，弦就会从坑上、桌子外面直接飞过去——
   *    走路时**脚下有没有地**是净空判定管不着的（桌子外面那一列只有地面，身子带里
   *    空荡荡，墙规则一句都不会响）。虚拟地面 run 也算数，它的 `hi` 就是 `groundLevel`：
   *    「这里没扫到东西 → 按地面走」正是它存在的理由，所以空列照样能走，但**只有当脚
   *    也在那个高度上**（走在桌面上的人踩不到桌外的空气）。
   *    连着若干采样点都没地，就是一条沟：这条沟的宽度照 `crossWidth` 的规矩量
   *    （`(格距 − 1) × 格 ≤ crossWidth`），与跨格边同一个口径——**平滑绝不制造新的跨越**。
   * 3. **身子不碰墙**：按**净空圆盘**（`clearanceRadius`）扫，圆盘里每一列的每一个
   *    非虚拟 run 都不与身子带 `(脚高 + step, 脚高 + dogHeight]` 相交——照抄
   *    {@link testStandable} 的墙规则，只是这里量的是「**路过**」而不是「站住」，
   *    所以**不查自己那一列的悬空块**（那条是给「站进去」准备的，见 `standable()`）。
   *
   * 只查圆盘的墙规则会让「路过」比「站住」宽松一点，这是故意的：与 {@link crossClear}
   * 的口径一致（段内采样认墙规则），而且这里比它更严——`crossClear` 只扫弦上的格子，
   * 这里把**圆盘**扫了，小狗的宽度也算进去了。
   *
   * 禁行列与「点云之外不许走」两条照旧管着整段（与 {@link crossClear} 相同）。
   */
  segmentClear(
    from: readonly [number, number, number],
    to: readonly [number, number, number],
  ): boolean {
    const cfg = this.cfg;
    const dy = to[1] - from[1];
    // 1. 两端高差 —— 与图上一条边同规矩。
    if (Math.abs(dy) > cfg.step) {
      return false;
    }
    const dx = to[0] - from[0];
    const dz = to[2] - from[2];
    const length = Math.hypot(dx, dy, dz);
    // 每半格采一次：格距再大就可能整格跳过去，把一格宽的柱子漏掉。
    const steps = Math.max(1, Math.ceil(length / (this.cell * 0.5)));
    const stepCells = length / this.cell;
    const dxs = this.discDx;
    const dzs = this.discDz;
    let gap = 0;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const foot = from[1] + dy * t;
      const ix = Math.floor((from[0] + dx * t - this.minX) / this.cell);
      const iz = Math.floor((from[2] + dz * t - this.minZ) / this.cell);
      if (ix < 0 || ix >= this.nx || iz < 0 || iz >= this.nz) {
        return false;
      }
      const ownCell = ix + iz * this.nx;
      if (cfg.banned && cfg.banned[ownCell]) {
        return false;
      }
      if (
        !cfg.groundExtendsOutside &&
        (ix < this.bx0 || ix > this.bx1 || iz < this.bz0 || iz > this.bz1)
      ) {
        return false;
      }
      // 2. 脚下有地（虚拟地面 run 也算：它的 hi 就是 groundLevel）。连着没地就是一条沟，
      //    宽度照 crossWidth 的规矩量 —— 与跨格边同一个式子。
      //    容差是 SURFACE_BAND 而不是 step：弦要**贴着**表面，不能一步之差地悬在它上面。
      let grounded = false;
      for (let id = this.runOffset[ownCell]; id < this.runOffset[ownCell + 1]; id++) {
        if (Math.abs(this.hi[id] - foot) <= SURFACE_BAND) {
          grounded = true;
          break;
        }
      }
      if (grounded) {
        gap = 0;
      } else {
        gap += stepCells / steps;
        if ((gap - 1) * this.cell > cfg.crossWidth) {
          return false;
        }
      }
      // 3. 身子不碰墙，按圆盘扫。
      const wallTop = foot + cfg.step;
      const bodyTop = foot + cfg.dogHeight;
      for (let k = 0; k < dxs.length; k++) {
        const x = ix + dxs[k];
        const z = iz + dzs[k];
        if (x < 0 || x >= this.nx || z < 0 || z >= this.nz) {
          continue;
        }
        const discCell = x + z * this.nx;
        if (cfg.banned && cfg.banned[discCell]) {
          return false;
        }
        const end = this.runOffset[discCell + 1];
        for (let id = this.runOffset[discCell]; id < end; id++) {
          if (this.virtualRun[id]) {
            continue;
          }
          if (this.hi[id] > wallTop && this.lo[id] < bodyTop) {
            return false;
          }
        }
      }
    }
    return true;
  }

  /**
   * 把一个世界坐标点吸附到最近的**可站节点**（起点、终点都走它），找不到返回 −1。
   *
   * 三段，按顺序取第一个有结果的：
   *
   * 1. `|hi − Y| <= cell` 的候选里取 XZ 最近的（同格取更高的）——**「点到的那个面」
   *    就是这个面**。射线打在水平面上时 Y 就是那个面的高度，桌面、地板都命中这段。
   * 2. 否则 `hi <= Y + cell` 里取 XZ 最近的（同格取**更低**的，不是更高的）。点在
   *    **竖直面**上（墙面、台阶立面——这是很常见的一种命中）时落到它脚下的地面；
   *    同格里同时有 1.2 m 的架子和地面时，「点墙」应当落到地面而不是跳到架子上。
   * 3. 否则同一片邻域里退而求其次：先看高度差、再看距离，取任意可站节点。
   *
   * 第 1、2 段只在**小狗自己的脚印范围**内（`clearanceRadius` 那几格）找，超出范围
   * 才只按第 3 段的规则往外扩。这个半径不是随手取的：小狗脚下的那个面必然在它的
   * 脚印之内，所以「小狗站在桌面边缘、`frontPosition()` 前移一格探到桌外悬空」这种
   * 情形里，桌面节点在第 1 段就被找到了——不会被最近的那个地面节点抢走（那会让小狗
   * 瞬移到桌底下）。
   *
   * 第 3 段是必需的，不是保险：`groundLevel` 是点云 Y 的 **1% 分位**，点空白处走
   * `pickGroundPoint` 时 Y 正好等于它，而缓坡地面比它高 10 cm 时前两段会全落空。
   */
  mapPoint(x: number, y: number, z: number): number {
    const cfg = this.cfg;
    const fx = (x - this.minX) / this.cell;
    const fz = (z - this.minZ) / this.cell;
    const maxRing = Math.max(this.nx, this.nz);
    const inFootprint = Math.ceil(cfg.clearanceRadius / this.cell) + 1;

    let exact = -1;
    let exactDist = Infinity;
    let exactHi = -Infinity;
    let below = -1;
    let belowDist = Infinity;
    let belowHi = Infinity;
    let any = -1;
    let anyDelta = Infinity;
    let anyDist = Infinity;
    this.scanRings(fx, fz, 0, inFootprint, (id, distSq) => {
      const h = this.hi[id];
      const delta = Math.abs(h - y);
      if (delta <= this.cell && (distSq < exactDist || (distSq === exactDist && h > exactHi))) {
        exact = id;
        exactDist = distSq;
        exactHi = h;
      }
      if (h <= y + this.cell && (distSq < belowDist || (distSq === belowDist && h < belowHi))) {
        below = id;
        belowDist = distSq;
        belowHi = h;
      }
      if (delta < anyDelta || (delta === anyDelta && distSq < anyDist)) {
        any = id;
        anyDelta = delta;
        anyDist = distSq;
      }
    });
    if (exact >= 0) {
      return exact;
    }
    if (below >= 0) {
      return below;
    }
    if (any >= 0) {
      return any;
    }

    let far = -1;
    let farDelta = Infinity;
    let farDist = Infinity;
    this.scanRings(fx, fz, inFootprint + 1, maxRing, (id, distSq) => {
      const delta = Math.abs(this.hi[id] - y);
      if (delta < farDelta || (delta === farDelta && distSq < farDist)) {
        far = id;
        farDelta = delta;
        farDist = distSq;
      }
    });
    return far;
  }

  /**
   * 那一列上**最高的那个面**（最高 run 的 `hi`）；越界或那一列没有 run 时返回 `-Infinity`。
   *
   * 只回答一个几何问题：「**这儿有没有面接着你**」。所以它看**全部** run，不看
   * `standable()`——墙、被刷成障碍的带、虚拟地面都算面。
   *
   * **不复用 `mapPoint` 的两个理由**：一是它在回答「该站到哪个节点上」，跟「有没有面」
   * 是两件事（终点浮在半空时它照样会返回一个地面节点，而那正是问题本身）；二是它的
   * 签名被 spec 压着不能动。调用方见 `OctoMapPathPlanner.plan` 里 `goalTooHigh` 那段。
   */
  columnTop(x: number, z: number): number {
    const cx = Math.floor((x - this.minX) / this.cell);
    const cz = Math.floor((z - this.minZ) / this.cell);
    if (cx < 0 || cx >= this.nx || cz < 0 || cz >= this.nz) {
      return -Infinity;
    }
    const ownCell = cx + cz * this.nx;
    const end = this.runOffset[ownCell + 1];
    let top = -Infinity;
    for (let id = this.runOffset[ownCell]; id < end; id++) {
      if (this.hi[id] > top) {
        top = this.hi[id];
      }
    }
    return top;
  }

  /**
   * 按 Chebyshev 环扫过 `[r0, r1]` 圈内的每一列，把可站的 run 交给 `visit`。
   *
   * 距离给的是**平方**值（只用来排序，开方是白花）；环的顺序保证「先近后远」，
   * 而各段的取舍由调用方在同一次扫描里比出来（见 {@link mapPoint}）。
   */
  private scanRings(
    fx: number,
    fz: number,
    r0: number,
    r1: number,
    visit: (runId: number, distSq: number) => void,
  ): void {
    const cx = Math.floor(fx);
    const cz = Math.floor(fz);
    for (let r = r0; r <= r1; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) {
            continue;
          }
          const x = cx + dx;
          const z = cz + dz;
          if (x < 0 || x >= this.nx || z < 0 || z >= this.nz) {
            continue;
          }
          const dcx = (x + 0.5 - fx) * this.cell;
          const dcz = (z + 0.5 - fz) * this.cell;
          const distSq = dcx * dcx + dcz * dcz;
          const cell = x + z * this.nx;
          const end = this.runOffset[cell + 1];
          for (let id = this.runOffset[cell]; id < end; id++) {
            if (!this.standable(id)) {
              continue;
            }
            visit(id, distSq);
          }
        }
      }
    }
  }

  private testStandable(runId: number): boolean {
    const cfg = this.cfg;
    const cell = this.cellOf[runId];
    if (cfg.banned && cfg.banned[cell]) {
      return false;
    }
    const ix = cell % this.nx;
    const iz = (cell / this.nx) | 0;
    if (
      !cfg.groundExtendsOutside &&
      (ix < this.bx0 || ix > this.bx1 || iz < this.bz0 || iz > this.bz1)
    ) {
      return false;
    }

    // 两条界线都从**局部表面** h 起量，见 standable() 的说明。
    const h = this.hi[runId];
    const wallTop = h + cfg.step;
    const bodyTop = h + cfg.dogHeight;
    const underfoot = h + RUN_GAP;
    const dxs = this.discDx;
    const dzs = this.discDz;
    for (let k = 0; k < dxs.length; k++) {
      const x = ix + dxs[k];
      const z = iz + dzs[k];
      if (x < 0 || x >= this.nx || z < 0 || z >= this.nz) {
        continue;
      }
      const neighborCell = x + z * this.nx;
      if (cfg.banned && cfg.banned[neighborCell]) {
        return false;
      }
      const own = neighborCell === cell;
      const end = this.runOffset[neighborCell + 1];
      for (let id = this.runOffset[neighborCell]; id < end; id++) {
        // 虚拟地面不是几何，不参与净空判定（它只是「这里没有扫描到东西」）。
        if (this.virtualRun[id]) {
          continue;
        }
        const runLo = this.lo[id];
        const runHi = this.hi[id];
        const wall = runHi > wallTop && runLo < bodyTop;
        // 自己那一列里的悬空块：站不进去。邻列不算墙（台阶要迈过去），见 standable()。
        const hovered = own && runLo > underfoot && runLo < bodyTop;
        if (wall || hovered) {
          return false;
        }
      }
    }
    return true;
  }

  private get cfg(): OctoMapNavConfig {
    const cfg = this.config;
    if (!cfg) {
      throw new Error('OctoMapNavSurface 还没 configure 就被查询了');
    }
    return cfg;
  }
}
