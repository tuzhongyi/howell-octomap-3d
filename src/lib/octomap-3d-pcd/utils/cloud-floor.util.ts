/**
 * 点云「地板」的纯函数。
 *
 * 单独成文件是因为它有两个消费者：地图拿它定地面平面 / 参考网格 / 寻路阈值的高度
 * 基准（`Octomap3dPcdGrille.groundLevel`），宿主拿它算「贴合地面」该挪多少
 * （`SystemManagerComponent.alignCloudTranslation`）。两边必须是**同一条规则**——
 * 差一厘米，按那一下按钮就会把云挪出一厘米。
 */

/**
 * 一片点云的地板高度（世界 Y）。
 *
 * 取**约 1% 分位**而不是最小值：扫描出来的地板总带着几粒飞点，直接用最小值会让整个
 * 地面（平面、网格、寻路阈值）被一粒噪点拽下去；取到最低的 1% 上，就落在地板面上。
 *
 * **前提是 Y 轴朝上**（地板在点的最低处）。相机坐标系（Y 朝下）的扫描要先翻到 Y 朝上
 * 再交给它，否则这里取到的是场景顶部，狗会沿着天花板走。
 *
 * 没有点（或只有残缺的一组坐标）时返回 0——「有没有点云」由调用方自己把关。
 */
export function cloudFloorY(positions: Float32Array): number {
  const total = Math.floor(positions.length / 3);
  if (total === 0) {
    return 0;
  }
  const ys = new Float64Array(total);
  for (let i = 0; i < total; i++) {
    ys[i] = positions[i * 3 + 1];
  }
  // 类型化数组的 sort 默认按数值升序（不像普通数组那样先转字符串）。
  ys.sort();
  return ys[Math.floor(total * 0.01)] ?? 0;
}
