import { OctomapBoundingBox } from '../octomap-3d-pcd.model';

/**
 * 规划网格的**格数**上限（`nx * nz`，含外圈边距的全部格子）。
 *
 * 名字说的是「空闲空间」，实际卡的是**分配规模**而不是搜索规模——`nx * nz` 是下面
 * 那几张 `Float32Array` / `Uint8Array` 的长度，跟其中多少格真的被搜到无关。
 *
 * 它真正防的是一件事：包围盒来自 `new THREE.Box3().setFromArray(points.positions)`
 * （见 `Octomap3dPcdPoint`），是**全部点的裸 AABB**。一个离群点就能把盒子的
 * 边长撑大几倍，而格数是边长的**平方**——几个离群点足以让这里要分配几 GB，把页面
 * 搞崩。所以这个上限是必须要有的，不是保守。
 *
 * 取 8M：`NAV_CELL_SIZE` 从 0.1 减半到 0.05 后，同样一块地要 4 倍的格子，8M 正好
 * 把「最大可规划面积」维持在和改动前的 2M 一样（≈2 万平方米）。
 *
 * 别和 `utils/voxel-sample.util.ts` 的 `MAX_VOXEL_COUNT` 搞混：数值相同，
 * 但那个是**渲染侧**的点云采样上限，两者无关。
 */
export const MAX_FREE_CELLS = 8_000_000;

/**
 * 导航网格的分辨率（世界单位），固定不变，与用于渲染的体素大小无关。保持这个精细
 * （且固定）的分辨率，意味着无论绘制的体素多粗，门和狭窄缝隙对规划器都仍然可见。
 *
 * 注意它现在和默认的 `voxelSize` 数值相同（都是 0.05），但这仍然只是巧合——本常量
 * 不从 `voxelSize` 推导，也不跟着它变。
 */
export const NAV_CELL_SIZE = 0.05;

/**
 * 碰撞半径之外额外留的安全余量，取**半格**。
 *
 * 判定是格粒度的：小狗的脚印（半径 R 的那个圆盘，见 `Octomap3dPcdNavSurface.standable`）
 * 落在格上，挡住它的几何也是按**整列**算的，两者量出来的都是「格心之间的距离」，
 * 推不出「到**真实墙面**的距离」。设真实墙点 `w` 落在障碍格 `j` 里（格心 `C_j`），
 * 自由格心 `p` 满足 `dist(p, C_j) ≥ R`，于是
 *
 *     dist(p, w) ≥ dist(p, C_j) − |w − C_j| ≥ r + safety − 半格对角
 *
 * 要 `≥ r`，教科书上的紧界是 `safety = 0.707·cell`（半格对角）。那之所以不取它：
 * 紧界只在「`w` 恰好落在该格离 `p` 最远的对角」时取到，而墙是成片连起来的时候，
 * 最近的墙点总落在贴墙那一侧，偏差是半格量级。取半格正好把**轴对齐**的最坏情况
 * 精确抵消掉，而它换来的可用半径更大。
 *
 * 关键对比是「和改动前比」：改动前 `ceil(dogRadius / cell)` 在半径恰为格宽整数倍时
 * 余量正好是 **0**，最坏墙面重叠 0.707·cell（旧 cell 0.1）= **7.1 cm**。半格方案把
 * 这个最坏情况收紧到 `0.707·cell(0.05) − 0.5·cell = 0.207·cell ≈ **1.0 cm**`，同时
 * 把门的可用半径放大。所以这是**收紧**，不是让步。
 *
 * **残余要如实说**：那 1 cm 的重叠是真实存在的，只在「墙面对角于格网」或「孤立单格
 * 小障碍」这两种几何下出现，与扫描自身的 1~3 cm 地面噪声同量级。**不能**写成
 * 「可以证明零重叠」——那是 0.707·cell 的性质，不是这个取值的。
 */
export const CELL_SAFETY = NAV_CELL_SIZE / 2;

/**
 * 规划网格的尺寸与原点——建网格用的那一套边界。
 *
 * 独立函数（不是某个类的方法）是因为它有**三个**消费者，而它们分属两个类：
 * 真的建网格的 `Octomap3dPcdPath.computePath`、「这块地会不会超限」的判定，
 * 以及把上限范围画到场景里的那条边界线（`Octomap3dPcdPath.navLimitRect`，
 * **纯绘制**）。让「会不会超限」能在**不真的建网格**的前提下被问到，是绘制和报错
 * 都做得到的前提——也正因为它同时服务绘制与规划，它必须留在一个两边都够得着的
 * 纯模块里，而不是挂到某个规划器上（那样绘制就得先拿到一个规划器实例）。
 *
 * `start` / `goal` 可以不给（给 null）：只看点云占用时用不到它们，而两者通常都
 * 落在包围盒内部，边距又远大于一个碰撞半径，所以差别只有一个边距以内的零头。
 * 为这点差别把小狗和终点引进来的调用方不值。
 *
 * 网格要比点云包围盒大一圈（`margin`），好让小狗能绕到建筑外面去。这一圈还
 * **必须**容得下「膨胀后的障碍加一条通道」：障碍横在起终点之间、三者又大致在
 * 一条线上时，膨胀后的它正好顶满网格的整个宽度，四周明明是空地，A* 也会报
 * 「找不到路径」。所以边距取「包围盒的 15%」与「膨胀半径 + 2 格通道」的大者。
 * 两个数分别对应两种尺度：小场景里前一项通常取不到（0.15 * 0.65 m + 2 格
 * ≈ 0.20 m），大场景里则是后一项取不到——所以两项都得留着。
 *
 * **与视口那块灰地面无关**：灰平面的外圈是设置里的「延展长度/宽度」
 * （`groundPlaneRect`），纯粹决定哪些地方点得着。两者各算各的，别把一个的边距
 * 按比例搬到另一个上——那圈大是为了让小狗能绕行，这圈大是为了点击不被丢掉。
 */
export function navGridSize(
  bbox: OctomapBoundingBox,
  start: [number, number, number] | null,
  goal: [number, number, number] | null,
  dogRadius: number,
): { nx: number; nz: number; minX: number; minZ: number; margin: number } {
  const cell = NAV_CELL_SIZE;
  // 第二项是**世界单位**的膨胀半径（碰撞半径 + 安全余量）再加 2 格通道。改动前
  // 这里是格数 `(ceil(r / cell) + 2) * cell`——膨胀圈数被量化过的那个数。现在膨胀
  // 是精确距离场，不再有「圈数」，量化的台阶也从这条链路上消失了。
  const margin = Math.max(
    Math.max(bbox.size[0], bbox.size[2], 1e-3) * 0.15 + cell * 2,
    dogRadius + CELL_SAFETY + cell * 2,
  );
  const xs = [bbox.min[0], bbox.max[0]];
  const zs = [bbox.min[2], bbox.max[2]];
  if (start) {
    xs.push(start[0]);
    zs.push(start[2]);
  }
  if (goal) {
    xs.push(goal[0]);
    zs.push(goal[2]);
  }
  const minX = Math.min(...xs) - margin;
  const minZ = Math.min(...zs) - margin;
  const maxX = Math.max(...xs) + margin;
  const maxZ = Math.max(...zs) + margin;
  return {
    nx: Math.max(2, Math.ceil((maxX - minX) / cell)),
    nz: Math.max(2, Math.ceil((maxZ - minZ) / cell)),
    minX,
    minZ,
    margin,
  };
}
