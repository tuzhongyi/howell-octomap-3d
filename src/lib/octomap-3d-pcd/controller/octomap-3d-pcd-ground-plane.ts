import { OctoMapBoundingBox } from '../octomap-3d-pcd.model';

/**
 * 视口那块灰色地面平面的外圈延展量，**各轴独立**。
 *
 * `outside` 为 false（设置里的「仅限立方体内」）时 `x` / `z` 一律按 0 处理——
 * 两个数仍然留在结构体里，免得调用方为了这两种情形拼两个形状。
 */
export interface OctoMapGroundExtent {
  /** 是否往包围盒外延展。 */
  outside: boolean;
  /** 沿世界 X 轴的延展长度（世界单位，单边）。 */
  x: number;
  /** 沿世界 Z 轴的延展宽度（世界单位，单边）。 */
  z: number;
}

/**
 * 包围盒 + 延展设置 → 地面平面的宽/深。
 *
 * 独立成纯函数（而不是 `Octomap3dPcdGlobal` 的方法）的理由和
 * `octomap-3d-pcd-path-grid.ts` 里的 `navGridSize` 一样：那个控制器顶层
 * `import { OrbitControls } from 'three/addons/...'`，而全仓没有任何 spec import
 * 过那个文件（只有几个控制器 import 它，且都只用在类型位置）——把纯算术留在那里
 * 就等于让一个 THREE addons 依赖来给测试会不会跑起来作答。这里要钉的东西（各轴
 * 独立、脏值兜底、退化轴下限）跟渲染毫无关系。
 *
 * **每轴对称生长**，两边各长 `x` / `z`。
 *
 * `anchor` 是平面**实际**的中心（XZ）。省略时就是包围盒中心，也就是平面永远罩着
 * 点云；给了别的点（参考物钉住不动时，见 `Octomap3dPcdGlobal.anchorReference`），
 * 点云可能已经挪到平面外，那就再按「锚点到包围盒中心」的距离**长出去**——平面不
 * 挪，只是变大。它是放狗、设终点、刷障碍的射线靶面，盖不住就点不着，所以这一步
 * 不能省。锚点恰好在包围盒中心时这一项为 0，与改动前逐个数字相同。
 *
 * 历史：改动前这里是一个标量 `max(size[0], size[2]) * 0.06` 喂给两个轴，也就是
 * 那个「6% 边距」。现在边距的大小由用户设置，6% 那个隐式公式没了；对这张真图
 * （最大边约 15.25 m）两者正好都在 0.9 附近，见下面 `1e-3` 与默认值的注释。
 */
export function groundPlaneRect(
  bbox: OctoMapBoundingBox,
  extent: OctoMapGroundExtent,
  anchor?: { x: number; z: number },
): { width: number; depth: number } {
  // 兜底不是防御性编程：`config.service.ts` 把 `octomap.config.json` 裸断言成
  // `OctoMapMapSettings`，手写资产里的 `"groundExtendX": "0.9"`（字符串）或 `null`
  // 会一路进到 `scale.set()` 里变成 NaN，而 NaN 的比例会让**整个平面消失**——
  // 连带着放狗/刷障碍的射线靶面一起没。负数同理（`Math.max` 之前先夹住）。
  const side = (v: number) => (Number.isFinite(v) ? Math.max(v, 0) : 0);
  const marginX = extent.outside ? side(extent.x) : 0;
  const marginZ = extent.outside ? side(extent.z) : 0;
  // 锚点只在调用方真的挪开过平面时才不是包围盒中心；两边一起长，中心不动。
  const growX = anchor ? side(Math.abs(bbox.center[0] - anchor.x)) : 0;
  const growZ = anchor ? side(Math.abs(bbox.center[2] - anchor.z)) : 0;
  // 1e-3 的下限照旧保留、按轴各算：某一个轴恰好为 0 时（单点云、纯平面的云）
  // 零面积三角形射线打不中，平面就既看不见也点不着。改动前两轴也是各算各的下限
  // （`Math.max(bbox.size[i], 1e-3)`），这一点没变。
  return {
    width: Math.max(bbox.size[0], 1e-3) + marginX * 2 + growX * 2,
    depth: Math.max(bbox.size[2], 1e-3) + marginZ * 2 + growZ * 2,
  };
}
