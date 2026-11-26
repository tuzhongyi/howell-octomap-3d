import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import * as THREE from 'three';
import {
  OctomapBoundingBox,
  OctomapCloudPreview,
  OctomapHoverInfo,
  OctomapPaintedVoxels,
  OctomapPointClickedDetail,
  OctomapPointCloud,
  OctomapPointsChangedDetail,
  OctomapProjectionSource,
  OctomapRenderMode,
} from '../octomap-3d-pcd.model';
import { cloudFloorY } from '../utils/cloud-floor.util';
import { MAX_VOXEL_COUNT } from '../utils/voxel-sample.util';
import { Octomap3dPcdVoxelGrid } from './octomap-3d-pcd-grid';
import { Octomap3dPcdGlobal } from './octomap-3d-pcd-global.controller';

const AUTO_VOXEL_DIVISIONS = 64;
/**
 * 体素超过上限时最多自动放大几档（每档翻倍）。
 *
 * 0.05 m 起算，八档能放大到 12.8 m——再密的云也够用了；设这个上限是为了让病态输入
 * （坐标反复落在极端值上）不会在这里无限转。
 */
const MAX_VOXEL_FIT_STEPS = 8;

/** 每次（重新）构建时传入的点云专用渲染参数。 */
export interface OctomapRenderOptions {
  renderMode: OctomapRenderMode;
  voxelSize: number | null;
  pointSize: number | null;
  pointColor: string;
  fitView: boolean;
  /** 当前是否显示已刷（障碍）颜色。 */
  showColoring: boolean;
  forbiddenColor: string;
  /** 高于该高度的点被隐藏（null 表示全部显示）。 */
  maxHeight: number | null;
  /** 低于该高度的点被隐藏（null 表示全部显示）。 */
  minHeight: number | null;
}

/** 体素拾取结果：单元键及其世界坐标中心。 */
export interface OctomapVoxelPick {
  key: string;
  center: [number, number, number];
}

/** 体素聚类中的一个格子：下标、累计颜色，以及落进这个格的点数。 */
interface OctomapVoxelCell {
  ix: number;
  iy: number;
  iz: number;
  r: number;
  g: number;
  b: number;
  n: number;
}

/**
 * 预览中正在被挪动的那批实例。
 *
 * `centers` 存的是每个实例**原来的**中心（3 个一组）：撤掉预览时要按它放回去，而
 * 实例矩阵在预览期间已经被改过，不能就地反算。`start`/`count` 是它是按哪段点算出来
 * 的——换一段点就要重算（见 {@link Octomap3dPcdGrille.applyPreview}）。
 */
interface OctomapPreviewInstances {
  ids: Int32Array;
  centers: Float32Array;
  start: number;
  count: number;
}

/**
 * 负责渲染出的点云/体素网格以及射线拾取与刷交互。
 * 所有针对“点”的操作都在这里。
 */
@Injectable()
export class Octomap3dPcdGrille {
  readonly pointsChanged = new Subject<OctomapPointsChangedDetail>();
  readonly pointClicked = new Subject<OctomapPointClickedDetail>();
  readonly paintedChanged = new Subject<OctomapPaintedVoxels>();
  readonly error = new Subject<Error>();

  currentPointCount = 0;
  boundingBox: OctomapBoundingBox | null = null;
  /**
   * 扫描出来的地板高度（世界 Y）。地面平面、参考网格、以及寻路的攀爬/墙体阈值
   * 都从它起量——`y = 0` 只是世界原点，不是「地面」。
   *
   * 这三个地方原先各算各的：寻路自己估地板（{@link cloudFloorY}），
   * 地面平面和网格却钉死在 y=0。扫描的地板不在 0 时两者能差出一米多——路径画在
   * 地板高度上，用户却是点着 y=0 的平面放狗，看到的就是「路线跑到地下了」。
   * 现在这个值只算一次、只放在这里，平面和网格跟着它走，放狗也就落在真正的地板上。
   *
   * 没有点云时为 0（此时平面本来就是隐藏的）。
   */
  groundLevel = 0;
  /**
   * 参考物（灰色地面平面、参考网格）锚在哪个世界 Y；还没锚定时为 null。
   *
   * 与 {@link groundLevel} 的差别就是「跟不跟着云走」：那个每次重建都重算，这个是
   * 锚定那一刻的快照（见 `Octomap3dPcdGlobal.anchorReference`）。由
   * {@link setReferenceLevel} 回填——它得等这个控制器交出包围盒和新地板高度之后才
   * 定得下来，所以比 {@link groundLevel} 晚一步。
   */
  referenceLevel: number | null = null;
  /** 常驻体素结构——导航/障碍空间。点云模式下为 null。 */
  grid: Octomap3dPcdVoxelGrid | null = null;
  /** 原始交错的 XYZ 坐标，保留用于精细分辨率导航。 */
  positions: Float32Array | null = null;
  /**
   * 实际用来建体素的格边长、以及按设置算出来的格边长（米）；点渲染时为 null。
   *
   * 两者不等 = 为了守住 {@link MAX_VOXEL_COUNT} 自动放大了。报给宿主（见
   * {@link emitPointsChanged}），由它在工具栏上说明一句。
   */
  private renderedVoxelSize: number | null = null;
  private requestedVoxelSize: number | null = null;
  /**
   * 上一次自动放大得到的那一档，见 {@link buildVoxels} 里对缓存键的说明。
   *
   * 换一份点云、改原点、或者改要求值都会让它作废；同一份云上改颜色、改障碍不值得
   * 把前面几档再撞一遍（每一档都是一遍几百万点的扫描）。
   */
  private voxelFit: {
    source: Float32Array | null;
    maxHeight: number | null;
    minHeight: number | null;
    min: [number, number, number];
    requested: number;
    fitted: number;
  } | null = null;

  private pointsObject: THREE.Points | null = null;
  private voxelObject: THREE.InstancedMesh | null = null;
  private hasColors = false;
  /** 原始逐点颜色，与{@link positions} 保持同步以便导出。 */
  private rawColors: Float32Array | null = null;
  /**
   * 上一次 {@link rebuild} 收到的**未过滤**坐标。
   *
   * {@link positions} 是高度过滤之后的（点号已经变了），而拖动预览按宿主给的「合并
   * 点云点号」取点——只有在原始那份上，索引才和宿主的范围对得上。
   */
  private sourcePositions: Float32Array | null = null;
  /** 正在预览的实例，见 {@link applyPreview}。 */
  private previewInstances: OctomapPreviewInstances | null = null;
  /** 在待添加/移动的放置位置显示的半透明立方体。 */
  private previewMesh: THREE.Mesh | null = null;
  /** 当前被编辑器悬停/手持高亮着色的体素。 */
  private highlightKey: string | null = null;

  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();

  constructor(private readonly global: Octomap3dPcdGlobal) {}

  rebuild(points: OctomapPointCloud | null, options: OctomapRenderOptions, fit: boolean): void {
    this.dispose();
    // 这一轮会重新决定体素档位，只有体素分支会把它们写回来。
    this.renderedVoxelSize = null;
    this.requestedVoxelSize = null;
    if (!points || !points.positions || points.positions.length < 3) {
      this.currentPointCount = 0;
      this.boundingBox = null;
      this.groundLevel = 0;
      this.hasColors = false;
      this.grid = null;
      this.positions = null;
      this.rawColors = null;
      this.emitPointsChanged();
      return;
    }

    // 预览按宿主的点号取点，只能在过滤之前那份上取（见 `sourcePositions`）。
    this.sourcePositions = points.positions;

    // 包围盒和地板高度都基于*完整*点云计算，这样在上方的点被隐藏时，
    // 相机适配、高度过滤拉杆的最大值、以及地面都不会跟着动。
    if (fit || !this.boundingBox) {
      this.boundingBox = this.toBoundingBox(new THREE.Box3().setFromArray(points.positions));
      this.groundLevel = this.estimateGroundLevel(points.positions);
    }

    const cloud = this.filterCloud(points, options.maxHeight, options.minHeight);
    this.currentPointCount = cloud.pointCount;
    this.positions = cloud.positions;
    this.hasColors = !!(cloud.colors && cloud.colors.length === cloud.positions.length);
    this.rawColors = this.hasColors ? cloud.colors! : null;

    if (options.renderMode === 'voxel') {
      this.buildVoxels(cloud, options);
    } else {
      this.grid = null;
      this.buildPoints(cloud, options);
    }
    this.emitPointsChanged();
  }

  /**
   * 拖动整体平移手柄时，把渲染出来的云临时挪一下。
   *
   * 只挪渲染对象、不动 `positions`：真挪数据就得重新体素化，跟着指针每帧走会卡死。
   * 松手后宿主把位移写进数据，下一次 {@link rebuild} 会换上新几何并把这里的临时
   * 位移清零（对象是新建的，位置默认就在原点）。
   */
  setPreviewOffset(x: number, y: number, z: number): void {
    for (const object of [this.pointsObject, this.voxelObject]) {
      if (!object) {
        continue;
      }
      object.position.set(x, y, z);
      // 上一次旋转预览可能被半路取消（用户拖着手柄把开关关了），朝向得顺手抹平。
      object.quaternion.identity();
    }
  }

  /**
   * 拖动旋转手柄时，把渲染出来的云临时绕着 `pivot` 转一下。
   *
   * 与 {@link setPreviewOffset} 同一套取舍：只动渲染对象、不改 `positions`——真转数据
   * 就得重新体素化，跟着指针每帧走会卡死。松手后宿主把角度写进数据，下一次
   * {@link rebuild} 换上新几何，这里的临时变换自然消失。
   *
   * 转的是**支点**不是对象自己的原点（对象原点在世界原点），所以还要补一段平移
   * `pivot − q·pivot`：渲染对象的顶点是世界坐标，绕对象原点转等于绕世界原点转。
   *
   * `delta` 是相对按下那一刻的增量而不是总朝向——画面上显示的已经是转过之后的云，
   * 再叠一次总朝向就转了两遍。传 null 表示复原。
   */
  setPreviewRotation(delta: THREE.Quaternion | null, pivot: THREE.Vector3): void {
    const q = delta ?? new THREE.Quaternion();
    const offset = pivot.clone().sub(pivot.clone().applyQuaternion(q));
    for (const object of [this.pointsObject, this.voxelObject]) {
      if (!object) {
        continue;
      }
      object.quaternion.copy(q);
      object.position.copy(offset);
    }
  }

  /**
   * 多份点云拖动整体变换手柄时的预览（单份走上面那两条整体预览）。
   *
   * 目的与 {@link setPreviewOffset} / {@link setPreviewRotation} 相同——拖动中只改
   * 画面、世界不动——做法不同：那两条整份渲染对象一起挪，多份时会把没选中的云也
   * 带走。这里只改**选中那一份占的体素实例**：
   *
   * - 体素模式：实例就在同一个 `InstancedMesh` 里，按宿主给的点号范围算出它占了哪些
   *   格（一次性，`O(选中的点数)`），之后每一下只改写这几千个矩阵。**不重新体素化**
   *   ——整片世界重建一次要几十毫秒，跟着指针走必然卡，而那才是这里要除掉的成本。
   * - 点云模式：没有实例可挪，退回整份重画（那边不做体素化，本来就很便宜）。
   *
   * 传 null 撤掉预览：把挪过的实例按原中心放回去。松手之后紧接着的 `points` 换新会
   * 整份重建，这一步是给「没走到重建」的取消路径兜底。
   */
  applyPreview(
    preview: OctomapCloudPreview | null,
    options: OctomapRenderOptions,
    fallback: OctomapPointCloud | null,
  ): void {
    if (options.renderMode !== 'voxel') {
      this.rebuild(preview?.points ?? fallback, options, false);
      return;
    }
    if (!preview || !this.grid || !this.voxelObject || !this.sourcePositions) {
      this.restorePreview();
      return;
    }
    const state = this.previewInstances;
    if (!state || state.start !== preview.start || state.count !== preview.count) {
      this.restorePreview();
      this.previewInstances = this.collectPreviewInstances(preview.start, preview.count);
    }
    this.movePreviewInstances(preview.rotation, preview.translation);
  }

  /**
   * 选中那段点占了哪些体素格——按实例去重。
   *
   * 用的是当前网格的 `min` / `voxelSize` 与同一套取整规则，所以键一定落在
   * {@link grid} 上；查不到的（被高度过滤掉的点撑起来的格）直接跳过。几份云重叠处
   * 会有少数格同时属于两边（实测 0.5%），这里把它们算给选中那份——拖动中会跟着走，
   * 松手重建就恢复原样，看不出来。
   */
  private collectPreviewInstances(start: number, count: number): OctomapPreviewInstances {
    const grid = this.grid!;
    const positions = this.sourcePositions!;
    const total = Math.floor(positions.length / 3);
    const begin = Math.max(0, Math.min(total, start));
    const end = Math.max(begin, Math.min(total, start + count));
    const ids: number[] = [];
    const centers: number[] = [];
    const seen = new Set<number>();
    const { min, voxelSize } = grid;
    for (let i = begin; i < end; i++) {
      const p = i * 3;
      const ix = Math.floor((positions[p] - min[0]) / voxelSize);
      const iy = Math.floor((positions[p + 1] - min[1]) / voxelSize);
      const iz = Math.floor((positions[p + 2] - min[2]) / voxelSize);
      const instanceId = grid.instanceId(Octomap3dPcdVoxelGrid.key(ix, iy, iz));
      if (instanceId === undefined || seen.has(instanceId)) {
        continue;
      }
      seen.add(instanceId);
      ids.push(instanceId);
      centers.push(
        min[0] + (ix + 0.5) * voxelSize,
        min[1] + (iy + 0.5) * voxelSize,
        min[2] + (iz + 0.5) * voxelSize,
      );
    }
    return { ids: Int32Array.from(ids), centers: Float32Array.from(centers), start, count };
  }

  /** 把预览那批实例按增量摆好：朝向大家一样，只有平移逐实例不同。 */
  private movePreviewInstances(
    rotation: readonly number[],
    translation: readonly [number, number, number],
  ): void {
    const state = this.previewInstances;
    const mesh = this.voxelObject;
    if (!state || !mesh) {
      return;
    }
    const [r0, r1, r2, r3, r4, r5, r6, r7, r8] = rotation;
    // 旋转部分建一次，逐实例只改写平移那三个元素（`elements` 是列主序，12..14 是平移）。
    const matrix = new THREE.Matrix4().set(
      r0, r1, r2, 0,
      r3, r4, r5, 0,
      r6, r7, r8, 0,
      0, 0, 0, 1,
    );
    const elements = matrix.elements;
    const centers = state.centers;
    const [tx, ty, tz] = translation;
    for (let i = 0; i < state.ids.length; i++) {
      const c = i * 3;
      const x = centers[c];
      const y = centers[c + 1];
      const z = centers[c + 2];
      elements[12] = r0 * x + r1 * y + r2 * z + tx;
      elements[13] = r3 * x + r4 * y + r5 * z + ty;
      elements[14] = r6 * x + r7 * y + r8 * z + tz;
      mesh.setMatrixAt(state.ids[i], matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  /** 撤掉预览：把挪过的实例按原中心放回去（纯平移矩阵，与构建时同一种）。 */
  private restorePreview(): void {
    const state = this.previewInstances;
    const mesh = this.voxelObject;
    this.previewInstances = null;
    if (!state || !mesh) {
      return;
    }
    const matrix = new THREE.Matrix4();
    const centers = state.centers;
    for (let i = 0; i < state.ids.length; i++) {
      const c = i * 3;
      matrix.makeTranslation(centers[c], centers[c + 1], centers[c + 2]);
      mesh.setMatrixAt(state.ids[i], matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  applyMaterial(options: OctomapRenderOptions): void {
    if (!this.pointsObject) {
      return;
    }
    const material = this.pointsObject.material as THREE.PointsMaterial;
    material.size = this.resolvePointSize(options.pointSize);
    material.color.set(options.pointColor);
    material.vertexColors = this.hasColors;
    material.needsUpdate = true;
  }

  /** 不重建几何体即可为所有体素重新着色（保留障碍）。 */
  refreshColors(options: OctomapRenderOptions): void {
    if (!this.grid || !this.voxelObject) {
      return;
    }
    const forbiddenColor = new THREE.Color(options.forbiddenColor);
    const show = this.isShowing(options);
    const color = new THREE.Color();
    for (const { key, instanceId, base } of this.grid.entries()) {
      if (show && this.grid.forbidden.has(key)) {
        color.copy(forbiddenColor);
      } else {
        color.setRGB(base[0], base[1], base[2]);
      }
      this.voxelObject.setColorAt(instanceId, color);
    }
    if (this.voxelObject.instanceColor) {
      this.voxelObject.instanceColor.needsUpdate = true;
    }
  }

  /**
   * 把(x, y, z) 周围 `radius` 范围内的所有占用体素标记为禁行障碍。
   *
   * 返回两个数，供调用方判「这一笔有没有刷到东西」（见 `OctomapBrushMissDetail`）：
   *
   * - `marked`：本次**新**标记的体素数；
   * - `occupied`：范围内**已占用**的体素数（`grid.has`），**与是否已被禁无关**。
   *
   * 判「范围内有没有东西」要用 `occupied === 0`，不能用 `marked === 0`：后者把「在同一处
   * 重刷」（范围内全是点、且都已经禁了）也算成空刷，而那是再正常不过的操作。
   *
   * 但要说清楚：**`occupied === 0` 从组件那条路走不到**——`pickVoxel` 是对着体素网格做
   * 射线拾取的，命中就意味着那个体素存在。组件真正够得着的触发点是「射线没打到任何
   * 体素」（见 `octomap-3d-pcd.component.ts` 的 `reportBrushMiss`）。这两个数照旧返回：它们是
   * 控制器这一层的真话，且将来 `pickVoxel` 若改成吸附到附近体素，`occupied` 立刻就有用。
   */
  brushAt(
    x: number,
    y: number,
    z: number,
    radius: number,
    options: OctomapRenderOptions,
  ): { marked: number; occupied: number } {
    if (!this.grid || !this.voxelObject) {
      return { marked: 0, occupied: 0 };
    }
    const { ix, iy, iz } = this.grid.worldToVoxel(x, y, z);
    const r = Math.max(1, Math.ceil(radius / this.grid.voxelSize));
    const forbiddenColor = new THREE.Color(options.forbiddenColor);
    let recolored = false;
    let marked = 0;
    let occupied = 0;
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dz = -r; dz <= r; dz++) {
          if (dx * dx + dy * dy + dz * dz > r * r) {
            continue;
          }
          const key = Octomap3dPcdVoxelGrid.key(ix + dx, iy + dy, iz + dz);
          if (!this.grid.has(key)) {
            continue;
          }
          occupied++;
          if (this.grid.forbidden.has(key)) {
            continue;
          }
          this.grid.forbidden.add(key);
          marked++;
          if (this.isShowing(options)) {
            this.setVoxelColor(key, forbiddenColor);
            recolored = true;
          }
        }
      }
    }
    if (recolored && this.voxelObject.instanceColor) {
      this.voxelObject.instanceColor.needsUpdate = true;
    }
    this.emitPainted();
    return { marked, occupied };
  }

  /**
   * 反向刷：移除(x, y, z) 周围 `radius` 范围内体素的禁行标记。
   *
   * 返回值与 {@link brushAt} 对称（`marked` = 本次真正擦掉的、`occupied` = 范围内的
   * 已占用体素数），好让两边能共用一份判据；但**擦除不看它**——在没有障碍的地方擦本来
   * 就是常事，不该弹提示（见 `octomap-3d-pcd.component.ts` 里那一支）。
   */
  eraseAt(
    x: number,
    y: number,
    z: number,
    radius: number,
    options: OctomapRenderOptions,
  ): { marked: number; occupied: number } {
    if (!this.grid || !this.voxelObject) {
      return { marked: 0, occupied: 0 };
    }
    const { ix, iy, iz } = this.grid.worldToVoxel(x, y, z);
    const r = Math.max(1, Math.ceil(radius / this.grid.voxelSize));
    let recolored = false;
    let marked = 0;
    let occupied = 0;
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dz = -r; dz <= r; dz++) {
          if (dx * dx + dy * dy + dz * dz > r * r) {
            continue;
          }
          const key = Octomap3dPcdVoxelGrid.key(ix + dx, iy + dy, iz + dz);
          if (!this.grid.has(key)) {
            continue;
          }
          occupied++;
          if (!this.grid.forbidden.delete(key)) {
            continue;
          }
          marked++;
          const instanceId = this.grid.instanceId(key);
          if (instanceId !== undefined && this.isShowing(options)) {
            this.paintNormal(instanceId, key, options);
            recolored = true;
          }
        }
      }
    }
    if (recolored && this.voxelObject.instanceColor) {
      this.voxelObject.instanceColor.needsUpdate = true;
    }
    this.emitPainted();
    return { marked, occupied };
  }

  /** 移除所有已刷障碍并恢复基准颜色。 */
  clearObstacles(options: OctomapRenderOptions): void {
    if (!this.grid) {
      return;
    }
    this.grid.forbidden.clear();
    this.refreshColors(options);
    this.emitPainted();
  }

  /** 一次性把所有占用体素标记为禁行障碍。 */
  markAllForbidden(options: OctomapRenderOptions): void {
    if (!this.grid || !this.voxelObject) {
      return;
    }
    for (const { key } of this.grid.entries()) {
      this.grid.forbidden.add(key);
    }
    this.refreshColors(options);
    this.emitPainted();
  }

  /** 把持久化的已刷集合（仅网格匹配时）重新应用到当前网格。 */
  restorePainted(painted: OctomapPaintedVoxels | null, options: OctomapRenderOptions): void {
    if (!this.grid || !this.voxelObject) {
      return;
    }
    this.grid.forbidden.clear();
    if (painted) {
      const sameGrid =
        painted.voxelSize === this.grid.voxelSize &&
        painted.min[0] === this.grid.min[0] &&
        painted.min[1] === this.grid.min[1] &&
        painted.min[2] === this.grid.min[2];
      if (sameGrid) {
        for (const key of painted.keys) {
          if (this.grid.has(key)) {
            this.grid.forbidden.add(key);
          }
        }
      }
    }
    this.refreshColors(options);
  }

  /** 在世界坐标位置添加一个体素（该单元已占用时不执行任何操作）。 */
  addVoxel(world: [number, number, number], options: OctomapRenderOptions): void {
    if (!this.grid) {
      return;
    }
    const { ix, iy, iz } = this.grid.worldToVoxel(world[0], world[1], world[2]);
    const key = Octomap3dPcdVoxelGrid.key(ix, iy, iz);
    if (this.grid.has(key)) {
      return;
    }
    const color = new THREE.Color(options.pointColor);
    const base: [number, number, number] = [color.r, color.g, color.b];
    this.grid.addCell(ix, iy, iz, base);
    this.appendPoint(world, base);
    this.rebuildVoxelMesh(options);
    this.emitPointsChanged();
  }

  /** 按网格键移除一个体素（及其来源点）。 */
  removeVoxel(key: string, options: OctomapRenderOptions): void {
    if (!this.grid || !this.grid.remove(key)) {
      return;
    }
    this.removePointsInCell(key);
    this.rebuildVoxelMesh(options);
    this.emitPointsChanged();
  }

  /** 把体素从其键移动到新的世界坐标位置。 */
  moveVoxel(key: string, world: [number, number, number], options: OctomapRenderOptions): void {
    if (!this.grid) {
      return;
    }
    const base = this.grid.baseColor(key);
    if (!base) {
      return;
    }
    const { ix, iy, iz } = this.grid.worldToVoxel(world[0], world[1], world[2]);
    const newKey = Octomap3dPcdVoxelGrid.key(ix, iy, iz);
    if (newKey === key) {
      return;
    }
    this.grid.remove(key);
    this.removePointsInCell(key);
    if (!this.grid.has(newKey)) {
      this.grid.addCell(ix, iy, iz, base);
      this.appendPoint(world, base);
    }
    this.rebuildVoxelMesh(options);
    this.emitPointsChanged();
  }

  /**
   * 以完整分辨率返回编辑后的点云。原始点会被保留并由编辑器保持
   * 同步（添加会追加一个点，移除会丢弃该单元内的点，移动则两者
   * 都做），因此导出时绝不会把点云重采样为每个体素一个点。
   */
  toPointCloud(): OctomapPointCloud | null {
    if (!this.positions || this.positions.length < 3) {
      return null;
    }
    const cloud: OctomapPointCloud = {
      positions: this.positions,
      pointCount: this.positions.length / 3,
    };
    if (this.rawColors && this.rawColors.length === this.positions.length) {
      cloud.colors = this.rawColors;
    }
    return cloud;
  }

  /**
   * 把点云重采样为每个占用体素中心一个点，即把每个点吸附到
   * 规则格网上。仅当点云本身带颜色时才沿用颜色。
   */
  toRegularCloud(): OctomapPointCloud | null {
    if (!this.grid || this.grid.size === 0) {
      return null;
    }
    const count = this.grid.size;
    const positions = new Float32Array(count * 3);
    const colors = this.hasColors ? new Float32Array(count * 3) : null;

    let i = 0;
    for (const { key, base } of this.grid.entries()) {
      const center = this.grid.center(key);
      positions[i * 3] = center[0];
      positions[i * 3 + 1] = center[1];
      positions[i * 3 + 2] = center[2];
      if (colors) {
        colors[i * 3] = base[0];
        colors[i * 3 + 1] = base[1];
        colors[i * 3 + 2] = base[2];
      }
      i++;
    }

    const cloud: OctomapPointCloud = { positions, pointCount: count };
    if (colors) {
      cloud.colors = colors;
    }
    return cloud;
  }

  /**
   * 这份云的地板高度。规则本身在 `cloud-floor.util.ts` 的 `cloudFloorY` 里——宿主
   * 的「贴合地面」用的是同一个函数，两边必须是同一个数（差一厘米就是挪歪）。
   */
  private estimateGroundLevel(positions: Float32Array): number {
    return cloudFloorY(positions);
  }

  /**
   * 当前俯视投影的全部输入：点位置、投影网格对齐用的包围盒、分辨率。
   *
   * 交给 `projection.util.ts` 里的纯函数去算，而不是在这里直接算出结果——投影现在
   * 有两个消费者（弹窗里看、以及存文件），算法只该有一份。
   *
   * 分辨率取渲染体素；点云渲染方式下没有网格，退回按包围盒自动推导（最长边 / 64），
   * 因此同一份云在两种渲染方式下投影的粗细不同。
   *
   * 注意 `boundingBox` 只在 `rebuild()` 里赋值，体素编辑不会更新它。两个投影函数都
   * 会把包围盒外的点丢掉，所以「投影反映增删云点」只在原包围盒**之内**成立。
   */
  projectionSource(): OctomapProjectionSource | null {
    const bbox = this.boundingBox;
    const positions = this.positions;
    if (!bbox || !positions || positions.length < 3) {
      return null;
    }
    return {
      positions,
      bounds: bbox,
      resolution: this.grid?.voxelSize ?? this.resolveVoxelSize(null),
    };
  }

  /** 射线拾取体素，返回其键 + 中心 + 命中面的法线。 */
  pickVoxelFace(
    event: MouseEvent | PointerEvent,
  ): { key: string; center: [number, number, number]; normal: [number, number, number] } | null {
    if (!this.voxelObject || !this.grid) {
      return null;
    }
    this.updatePointer(event);
    const hits = this.raycaster.intersectObject(this.voxelObject, false);
    if (hits.length === 0) {
      return null;
    }
    const hit = hits[0];
    const instanceId = hit.instanceId;
    if (instanceId === undefined) {
      return null;
    }
    const key = this.grid.keyOfInstance(instanceId);
    if (!key) {
      return null;
    }
    const normal = hit.face ? hit.face.normal : new THREE.Vector3(0, 1, 0);
    return { key, center: this.grid.center(key), normal: [normal.x, normal.y, normal.z] };
  }

  /** 在世界坐标位置（吸附到体素）显示绿色放置立方体，或将其隐藏。 */
  setPreviewPosition(world: [number, number, number] | null): void {
    if (!this.grid) {
      this.hidePreview();
      return;
    }
    if (!world) {
      this.hidePreview();
      return;
    }
    const vs = this.grid.voxelSize;
    const { ix, iy, iz } = this.grid.worldToVoxel(world[0], world[1], world[2]);
    const center = this.grid.center(Octomap3dPcdVoxelGrid.key(ix, iy, iz));

    if (!this.previewMesh) {
      const geometry = new THREE.BoxGeometry(1, 1, 1);
      const material = new THREE.MeshBasicMaterial({
        color: 0x22c55e,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      });
      this.previewMesh = new THREE.Mesh(geometry, material);
      this.previewMesh.frustumCulled = false;
      this.global.scene.add(this.previewMesh);
    }
    this.previewMesh.scale.setScalar(vs);
    this.previewMesh.position.set(center[0], center[1], center[2]);
    this.previewMesh.visible = true;
  }

  /** 用高亮颜色为一个体素着色（删除/移动悬停或移动手持），或清除它。 */
  setVoxelHighlight(
    key: string | null,
    options: OctomapRenderOptions,
    color = '#fb923c',
  ): void {
    if (!this.grid || !this.voxelObject) {
      return;
    }
    const previous = this.highlightKey;
    if (previous && previous !== key) {
      const previousId = this.grid.instanceId(previous);
      if (previousId !== undefined) {
        this.paintNormal(previousId, previous, options);
      }
    }
    this.highlightKey = key;
    if (key) {
      const id = this.grid.instanceId(key);
      if (id !== undefined) {
        this.voxelObject.setColorAt(id, new THREE.Color(color));
      }
    }
    if (this.voxelObject.instanceColor) {
      this.voxelObject.instanceColor.needsUpdate = true;
    }
  }

  /** 隐藏两个编辑器反馈元素（放置立方体 + 体素着色）。 */
  clearEditorFeedback(options: OctomapRenderOptions): void {
    this.setPreviewPosition(null);
    this.setVoxelHighlight(null, options);
  }

  /** 对点击做射线拾取并发出拾取到的点/体素（无拖拽阈值）。 */
  pick(event: MouseEvent, renderMode: OctomapRenderMode, maxPickingPoints: number): void {
    const target: THREE.Object3D | null =
      renderMode === 'voxel' ? this.voxelObject : this.pointsObject;
    if (!target) {
      this.pointClicked.next({ index: -1, point: null });
      return;
    }
    this.updatePointer(event);

    if (renderMode === 'points' && this.currentPointCount > maxPickingPoints) {
      this.pointClicked.next({ index: -1, point: null });
      return;
    }

    const hits = this.raycaster.intersectObject(target, false);
    if (hits.length > 0) {
      const hit = hits[0];
      const index = hit.instanceId ?? hit.index ?? -1;
      this.pointClicked.next({ index, point: [hit.point.x, hit.point.y, hit.point.z] });
    } else {
      this.pointClicked.next({ index: -1, point: null });
    }
  }

  /**
   * 指针下那个云点的读数（供视口右下角的浮框）；没打到东西时为 null。
   *
   * 与 {@link pick} 的分工：那个是点击，要往外发事件、还得处理「点数太多」的退让；
   * 这个只读数，每帧都可能调一次，越便宜越好。
   *
   * 点云模式下取点自己的坐标，而不是射线上的命中点——`Points` 的拾取阈值有 5 cm
   * 起步（见 {@link buildPoints}），命中点会跟真实点差出一段，报出来的数就不准了。
   */
  probe(event: MouseEvent | PointerEvent, maxPickingPoints: number): OctomapHoverInfo | null {
    const target: THREE.Object3D | null = this.voxelObject ?? this.pointsObject;
    if (!target) {
      return null;
    }
    // 点云模式下打点很贵，点数超过上限时和 `pick` 一样放弃。
    if (!this.voxelObject && this.currentPointCount > maxPickingPoints) {
      return null;
    }
    this.updatePointer(event);
    const hits = this.raycaster.intersectObject(target, false);
    if (hits.length === 0) {
      return null;
    }
    const hit = hits[0];

    if (this.voxelObject && this.grid) {
      const instanceId = hit.instanceId;
      const key = instanceId === undefined ? null : this.grid.keyOfInstance(instanceId);
      if (!key) {
        return null;
      }
      const center = this.grid.center(key);
      return {
        position: center,
        height: center[1] - this.groundLevel,
        forbidden: this.grid.forbidden.has(key),
      };
    }

    const positions = this.positions;
    const index = hit.index;
    if (!positions || index === undefined || index * 3 + 2 >= positions.length) {
      return null;
    }
    const y = positions[index * 3 + 1];
    return {
      position: [positions[index * 3], y, positions[index * 3 + 2]],
      height: y - this.groundLevel,
      forbidden: null,
    };
  }

  /** 射线拾取体素，返回其键 + 中心（未命中任何东西时为 null）。 */
  pickVoxel(event: MouseEvent | PointerEvent): OctomapVoxelPick | null {
    if (!this.voxelObject || !this.grid) {
      return null;
    }
    this.updatePointer(event);
    const hits = this.raycaster.intersectObject(this.voxelObject, false);
    if (hits.length === 0) {
      return null;
    }
    const instanceId = hits[0].instanceId;
    if (instanceId === undefined) {
      return null;
    }
    const key = this.grid.keyOfInstance(instanceId);
    if (!key) {
      return null;
    }
    return { key, center: this.grid.center(key) };
  }

  /**
   * 射线拾取地面平面，返回世界坐标的命中点。
   *
   * Y 取的是**点云自己的地板**（{@link groundLevel}）而不是平面那一片的高度：平面
   * 是钉在锚点上的参考物，把云整体抬高/降低之后它不会跟着走（见
   * `Octomap3dPcdGlobal.anchorReference`），而放狗要落在云上、不是落在那块
   * 参考面上。两者平时就是同一个高度（平面当初就贴在地板上），只有平移过之后才
   * 分得开。
   */
  pickGroundPoint(event: MouseEvent): [number, number, number] | null {
    const plane = this.global.groundPlane;
    if (!plane || !plane.visible) {
      return null;
    }
    this.updatePointer(event);
    const hits = this.raycaster.intersectObject(plane, false);
    if (hits.length === 0) {
      return null;
    }
    const point = hits[0].point;
    return [point.x, this.groundLevel, point.z];
  }

  /**
   * 指针射线正下方那个云点（点云模式专用）；一个都没打中时为 null。
   *
   * **不能直接用 THREE 的 `Points` 拾取**。它的判据是「顶点到射线的距离 <
   * threshold」，然后在通过的顶点里取**离相机最近**的那个；而 threshold 是由点
   * 大小推出来的（`pointSize * 4`，点大时能到 0.35 m，见 {@link buildPoints}）。
   * 于是离射线 0.3 m、但近 2 m 的顶点会顶掉指针正上方那个——实测落点最远往前跑
   * 2 m，而且悬在离最近云点 0.3 m 的空中。它返回的还是**射线上的投影点**而不是
   * 顶点本身（{@link probe} 里已经踩过一次，见那里的注释）。
   *
   * 这里改成按「屏幕角距」挑：垂直距² / 沿射线距离²。两者同乘一个常数才是真正的
   * 屏幕像素距，比大小用不着那个常数。角距打平时取更近的那个，与遮挡的直觉一致。
   *
   * 候选仍然限定在同一个 threshold 以内——这一条不能去：少了它，往空处点也会硬
   * 吸到天边某个点上，调用方就没有「退回地面平面」这一步了。
   *
   * 复杂度 O(点数)，与 THREE 那一版同一个量级（它每个顶点还要建一次 Vector3）；
   * 调用方用 `maxPickingPoints` 卡着上限。
   */
  private pickPointUnderCursor(target: THREE.Points): [number, number, number] | null {
    const positions = this.positions;
    if (!positions || positions.length < 3) {
      return null;
    }
    const threshold = this.raycaster.params.Points.threshold;
    const thresholdSq = threshold * threshold;
    // 顶点是物体本地坐标、射线是世界坐标，先把射线搬进本地空间。
    const inverse = new THREE.Matrix4().copy(target.matrixWorld).invert();
    const ray = new THREE.Ray().copy(this.raycaster.ray).applyMatrix4(inverse);
    const origin = ray.origin;
    const dir = ray.direction;

    let bestAngle = Infinity;
    let bestDepth = Infinity;
    let bestIndex = -1;
    for (let i = 0; i < positions.length; i += 3) {
      const vx = positions[i] - origin.x;
      const vy = positions[i + 1] - origin.y;
      const vz = positions[i + 2] - origin.z;
      const depth = vx * dir.x + vy * dir.y + vz * dir.z;
      if (depth <= 0) {
        continue; // 在相机背后
      }
      const perpSq = vx * vx + vy * vy + vz * vz - depth * depth;
      if (perpSq > thresholdSq) {
        continue;
      }
      const angle = perpSq / (depth * depth);
      if (angle > bestAngle) {
        continue;
      }
      if (angle === bestAngle && depth >= bestDepth) {
        continue;
      }
      bestAngle = angle;
      bestDepth = depth;
      bestIndex = i;
    }
    if (bestIndex < 0) {
      return null;
    }
    // 返回**顶点本身**，不是射线上的投影点：放狗和放终点要落在真实的云点上。
    const point = new THREE.Vector3(
      positions[bestIndex],
      positions[bestIndex + 1],
      positions[bestIndex + 2],
    ).applyMatrix4(target.matrixWorld);
    return [point.x, point.y, point.z];
  }

  /**
   * 射线拾取当前渲染出的点云表面（立体格栅拾体素、点云拾点），返回命中点的世界
   * 坐标；什么都没打中时为 null。
   *
   * 与 {@link pickGroundPoint} 的区别：那个只认地面平面，射线半路上挡着什么都
   * 不管，命中的永远是 y 恒定的那一片。要放在扫描出来的表面上（地板、桌面、
   * 台阶顶……）就得用这个。
   *
   * 两种渲染方式各自只建一个对象，谁在就是谁。拾的东西不同：立体格栅命中那个
   * 体素方块的**表面**（看到的那个面），点云命中**顶点本身**——见
   * {@link pickPointUnderCursor}，那里解释了为什么点云不能直接用 THREE 的拾取。
   *
   * 点云模式下打点很贵，点数超过 `maxPickingPoints` 时直接放弃——调用方会退回
   * 地面，与 {@link pick} 的取舍一致。
   */
  pickSurfacePoint(
    event: MouseEvent | PointerEvent,
    maxPickingPoints: number,
  ): [number, number, number] | null {
    const voxel = this.voxelObject;
    const points = this.pointsObject;
    if (!voxel && !points) {
      return null;
    }
    if (!voxel && this.currentPointCount > maxPickingPoints) {
      return null;
    }
    this.updatePointer(event);
    if (voxel) {
      const hits = this.raycaster.intersectObject(voxel, false);
      if (hits.length === 0) {
        return null;
      }
      const point = hits[0].point;
      return [point.x, point.y, point.z];
    }
    return points ? this.pickPointUnderCursor(points) : null;
  }

  dispose(): void {
    if (this.pointsObject) {
      this.global.scene.remove(this.pointsObject);
      this.pointsObject.geometry.dispose();
      (this.pointsObject.material as THREE.Material).dispose();
      this.pointsObject = null;
    }
    if (this.voxelObject) {
      this.global.scene.remove(this.voxelObject);
      this.voxelObject.geometry.dispose();
      (this.voxelObject.material as THREE.Material).dispose();
      this.voxelObject = null;
    }
    if (this.previewMesh) {
      this.global.scene.remove(this.previewMesh);
      this.previewMesh.geometry.dispose();
      (this.previewMesh.material as THREE.Material).dispose();
      this.previewMesh = null;
    }
    this.highlightKey = null;
    // 实例矩阵跟着 mesh 一起没了，预览的记账也一并作废：下一份点的预览会从头算。
    this.previewInstances = null;
    this.sourcePositions = null;
  }

  /** 返回移除了[minHeight, maxHeight] 范围之外的点后的点云。 */
  private filterCloud(
    cloud: OctomapPointCloud,
    maxHeight: number | null,
    minHeight: number | null,
  ): OctomapPointCloud {
    if (maxHeight === null && minHeight === null) {
      return cloud;
    }
    const positions = cloud.positions;
    const colors = cloud.colors;
    const normals = cloud.normals;
    const hasColors = !!colors && colors.length === positions.length;
    const hasNormals = !!normals && normals.length === positions.length;

    const outPositions: number[] = [];
    const outColors: number[] = [];
    const outNormals: number[] = [];
    for (let i = 0; i < positions.length; i += 3) {
      const y = positions[i + 1];
      if ((maxHeight !== null && y > maxHeight) || (minHeight !== null && y < minHeight)) {
        continue;
      }
      outPositions.push(positions[i], positions[i + 1], positions[i + 2]);
      if (hasColors) {
        outColors.push(colors![i], colors![i + 1], colors![i + 2]);
      }
      if (hasNormals) {
        outNormals.push(normals![i], normals![i + 1], normals![i + 2]);
      }
    }

    return {
      positions: new Float32Array(outPositions),
      colors: hasColors ? new Float32Array(outColors) : undefined,
      normals: hasNormals ? new Float32Array(outNormals) : undefined,
      pointCount: outPositions.length / 3,
    };
  }

  private buildPoints(cloud: OctomapPointCloud, options: OctomapRenderOptions): void {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(cloud.positions, 3));

    if (this.hasColors && cloud.colors) {
      geometry.setAttribute('color', new THREE.BufferAttribute(cloud.colors, 3));
    }
    if (cloud.normals && cloud.normals.length === cloud.positions.length) {
      geometry.setAttribute('normal', new THREE.BufferAttribute(cloud.normals, 3));
    }

    const pointSize = this.resolvePointSize(options.pointSize);
    const material = new THREE.PointsMaterial({
      size: pointSize,
      sizeAttenuation: true,
      vertexColors: this.hasColors,
      color: new THREE.Color(options.pointColor),
    });

    this.pointsObject = new THREE.Points(geometry, material);
    this.pointsObject.frustumCulled = false;
    this.global.scene.add(this.pointsObject);

    this.raycaster.params.Points.threshold = Math.max(pointSize * 4, 0.05);
  }

  private buildVoxels(cloud: OctomapPointCloud, options: OctomapRenderOptions): void {
    const bb = this.boundingBox!;
    const min: [number, number, number] = [bb.min[0], bb.min[1], bb.min[2]];

    const positions = cloud.positions;
    const colors = this.hasColors ? cloud.colors : undefined;

    const requested = this.resolveVoxelSize(options.voxelSize);
    // 同一份点云、同一个原点、同一个要求值，上次放大到哪一档，这次直接从那一档起试：
    // 改颜色、改障碍都会重建，没必要每一遍都把前面几档再撞一次。缓存键用**未过滤**
    // 那朵云（`sourcePositions`）加高度范围，而不是过滤后的数组：开了高度过滤时每遍
    // 都会生成新数组，按数组身份记的话缓存永远不中，拖一次高度滑杆就要全撞一遍。
    const cached = this.voxelFit;
    let voxelSize =
      cached &&
      cached.source === this.sourcePositions &&
      cached.maxHeight === options.maxHeight &&
      cached.minHeight === options.minHeight &&
      cached.min[0] === min[0] &&
      cached.min[1] === min[1] &&
      cached.min[2] === min[2] &&
      cached.requested === requested
        ? Math.max(requested, cached.fitted)
        : requested;

    let cells = this.collectVoxelCells(positions, colors, min, voxelSize);
    for (let step = 0; !cells && step < MAX_VOXEL_FIT_STEPS; step++) {
      // 翻倍，并取整到毫米（0.05 → 0.1 → 0.2），免得 0.30000000000000004 这种值
      // 混进网格键与面板读数里。
      voxelSize = Math.round(voxelSize * 2000) / 1000;
      cells = this.collectVoxelCells(positions, colors, min, voxelSize);
    }
    if (!cells) {
      this.voxelFit = null;
      this.error.next(
        new Error(
          `体素数量过多（已放大到 ${voxelSize} m 仍超过 ${MAX_VOXEL_COUNT} 格），请增大 voxelSize`,
        ),
      );
      return;
    }
    this.voxelFit = {
      source: this.sourcePositions,
      maxHeight: options.maxHeight,
      minHeight: options.minHeight,
      min: [min[0], min[1], min[2]],
      requested,
      fitted: voxelSize,
    };
    this.renderedVoxelSize = voxelSize;
    this.requestedVoxelSize = requested;

    // 构建常驻网格，当网格的分辨率与原点不变时（例如仅颜色变化），
    // 沿用原有的禁行单元。
    const grid = new Octomap3dPcdVoxelGrid(min, voxelSize);
    for (const key of this.carryForbidden(voxelSize, min)) {
      grid.forbidden.add(key);
    }

    const geometry = new THREE.BoxGeometry(voxelSize, voxelSize, voxelSize);
    const material = new THREE.MeshStandardMaterial({ roughness: 0.65, metalness: 0.1 });
    const mesh = new THREE.InstancedMesh(geometry, material, cells.size);
    mesh.frustumCulled = false;

    const matrix = new THREE.Matrix4();
    const fallback = new THREE.Color(options.pointColor);
    const forbiddenColor = new THREE.Color(options.forbiddenColor);
    const show = this.isShowing(options);
    const color = new THREE.Color();

    let index = 0;
    cells.forEach((cell) => {
      matrix.makeTranslation(
        min[0] + (cell.ix + 0.5) * voxelSize,
        min[1] + (cell.iy + 0.5) * voxelSize,
        min[2] + (cell.iz + 0.5) * voxelSize,
      );
      mesh.setMatrixAt(index, matrix);

      const key = Octomap3dPcdVoxelGrid.key(cell.ix, cell.iy, cell.iz);
      const base: [number, number, number] = colors
        ? [cell.r / cell.n, cell.g / cell.n, cell.b / cell.n]
        : [fallback.r, fallback.g, fallback.b];
      grid.add(cell.ix, cell.iy, cell.iz, index, base);

      if (show && grid.forbidden.has(key)) {
        color.copy(forbiddenColor);
      } else {
        color.setRGB(base[0], base[1], base[2]);
      }
      mesh.setColorAt(index, color);
      index++;
    });

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) {
      mesh.instanceColor.needsUpdate = true;
    }

    this.grid = grid;
    this.voxelObject = mesh;
    this.global.scene.add(mesh);
  }

  /**
   * 按格边长把点聚成体素格；超出上限**当场放弃**（返回 null）。
   *
   * 格子数在扫描中只增不减，所以不必把几百万个点扫完再报错——真到上限就停，调用方
   * 立刻放大一档重来；放大后的那一遍通常就能扫完。
   */
  private collectVoxelCells(
    positions: Float32Array,
    colors: Float32Array | undefined,
    min: [number, number, number],
    voxelSize: number,
  ): Map<string, OctomapVoxelCell> | null {
    const cells = new Map<string, OctomapVoxelCell>();
    for (let i = 0; i < positions.length; i += 3) {
      const ix = Math.floor((positions[i] - min[0]) / voxelSize);
      const iy = Math.floor((positions[i + 1] - min[1]) / voxelSize);
      const iz = Math.floor((positions[i + 2] - min[2]) / voxelSize);
      const key = Octomap3dPcdVoxelGrid.key(ix, iy, iz);
      let cell = cells.get(key);
      if (!cell) {
        cell = { ix, iy, iz, r: 0, g: 0, b: 0, n: 0 };
        cells.set(key, cell);
        if (cells.size > MAX_VOXEL_COUNT) {
          return null;
        }
      }
      if (colors) {
        cell.r += colors[i];
        cell.g += colors[i + 1];
        cell.b += colors[i + 2];
        cell.n += 1;
      }
    }
    return cells;
  }

  private carryForbidden(voxelSize: number, min: [number, number, number]): Set<string> {
    const previous = this.grid;
    const sameGrid =
      previous &&
      previous.voxelSize === voxelSize &&
      previous.min[0] === min[0] &&
      previous.min[1] === min[1] &&
      previous.min[2] === min[2];
    return sameGrid ? new Set(previous.forbidden) : new Set<string>();
  }

  private isShowing(options: OctomapRenderOptions): boolean {
    return options.showColoring;
  }

  private emitPainted(): void {
    if (!this.grid) {
      return;
    }
    this.paintedChanged.next({
      voxelSize: this.grid.voxelSize,
      min: [...this.grid.min],
      keys: [...this.grid.forbidden],
    });
  }

  /** 向常驻的原始坐标/颜色追加一个点（与网格保持同步）。 */
  private appendPoint(world: [number, number, number], color: [number, number, number]): void {
    if (this.positions) {
      const next = new Float32Array(this.positions.length + 3);
      next.set(this.positions);
      next[next.length - 3] = world[0];
      next[next.length - 2] = world[1];
      next[next.length - 1] = world[2];
      this.positions = next;
    } else {
      this.positions = new Float32Array([world[0], world[1], world[2]]);
    }

    if (this.rawColors) {
      const nextColors = new Float32Array(this.rawColors.length + 3);
      nextColors.set(this.rawColors);
      nextColors[nextColors.length - 3] = color[0];
      nextColors[nextColors.length - 2] = color[1];
      nextColors[nextColors.length - 1] = color[2];
      this.rawColors = nextColors;
    }
    this.currentPointCount = this.positions.length / 3;
  }

  /** 移除落在某体素单元内的所有原始点（与网格移除同步）。 */
  private removePointsInCell(key: string): void {
    if (!this.grid || !this.positions) {
      return;
    }
    const { ix, iy, iz } = Octomap3dPcdVoxelGrid.parse(key);
    const min = this.grid.min;
    const vs = this.grid.voxelSize;
    const x0 = min[0] + ix * vs;
    const x1 = x0 + vs;
    const y0 = min[1] + iy * vs;
    const y1 = y0 + vs;
    const z0 = min[2] + iz * vs;
    const z1 = z0 + vs;

    const positions = this.positions;
    const colors = this.rawColors;
    const keep: number[] = [];
    const keepColors: number[] = [];
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i];
      const y = positions[i + 1];
      const z = positions[i + 2];
      if (x >= x0 && x < x1 && y >= y0 && y < y1 && z >= z0 && z < z1) {
        continue;
      }
      keep.push(x, y, z);
      if (colors) {
        keepColors.push(colors[i], colors[i + 1], colors[i + 2]);
      }
    }
    this.positions = new Float32Array(keep);
    if (colors) {
      this.rawColors = new Float32Array(keepColors);
    }
    this.currentPointCount = this.positions.length / 3;
  }

  /** 由当前网格重建 InstancedMesh（保留基准/禁行颜色）。 */
  private rebuildVoxelMesh(options: OctomapRenderOptions): void {
    if (!this.grid) {
      return;
    }
    // 整体重建网格会丢弃实例 id，因此清除编辑器的着色/预览。
    this.highlightKey = null;
    this.hidePreview();
    const grid = this.grid;
    const vs = grid.voxelSize;
    const count = grid.size;

    if (this.voxelObject) {
      this.global.scene.remove(this.voxelObject);
      this.voxelObject.geometry.dispose();
      (this.voxelObject.material as THREE.Material).dispose();
      this.voxelObject = null;
    }
    if (count === 0) {
      return;
    }

    const geometry = new THREE.BoxGeometry(vs, vs, vs);
    const material = new THREE.MeshStandardMaterial({ roughness: 0.65, metalness: 0.1 });
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.frustumCulled = false;

    const forbiddenColor = new THREE.Color(options.forbiddenColor);
    const show = this.isShowing(options);
    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();

    grid.compact();
    let index = 0;
    for (const { key, base } of grid.entries()) {
      const center = grid.center(key);
      matrix.makeTranslation(center[0], center[1], center[2]);
      mesh.setMatrixAt(index, matrix);
      if (show && grid.forbidden.has(key)) {
        color.copy(forbiddenColor);
      } else {
        color.setRGB(base[0], base[1], base[2]);
      }
      mesh.setColorAt(index, color);
      index++;
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) {
      mesh.instanceColor.needsUpdate = true;
    }

    this.voxelObject = mesh;
    this.global.scene.add(mesh);
  }

  private hidePreview(): void {
    if (this.previewMesh) {
      this.previewMesh.visible = false;
    }
  }

  /** 把体素实例恢复为其正常颜色（禁行色或基准色）。 */
  private paintNormal(instanceId: number, key: string, options: OctomapRenderOptions): void {
    const color = new THREE.Color();
    if (this.isShowing(options) && this.grid?.forbidden.has(key)) {
      color.set(options.forbiddenColor);
    } else {
      const base = this.grid?.baseColor(key) ?? [1, 1, 1];
      color.setRGB(base[0], base[1], base[2]);
    }
    this.voxelObject?.setColorAt(instanceId, color);
  }

  private setVoxelColor(key: string, color: THREE.Color): void {
    const instanceId = this.grid?.instanceId(key);
    if (instanceId === undefined || !this.voxelObject) {
      return;
    }
    this.voxelObject.setColorAt(instanceId, color);
  }

  private updatePointer(event: MouseEvent | PointerEvent): void {
    const rect = this.global.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.global.camera);
  }

  private resolvePointSize(pointSize: number | null): number {
    if (pointSize !== null) {
      return pointSize;
    }
    if (this.boundingBox) {
      return Math.max(this.boundingBox.radius * 0.01, 0.001);
    }
    return 0.02;
  }

  private resolveVoxelSize(voxelSize: number | null): number {
    if (voxelSize !== null) {
      return voxelSize;
    }
    if (this.boundingBox) {
      const size = this.boundingBox.size;
      const maxSize = Math.max(size[0], size[1], size[2], 1e-6);
      return maxSize / AUTO_VOXEL_DIVISIONS;
    }
    return 0.1;
  }

  private toBoundingBox(box: THREE.Box3): OctomapBoundingBox {
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
    return {
      min: [box.min.x, box.min.y, box.min.z],
      max: [box.max.x, box.max.y, box.max.z],
      center: [center.x, center.y, center.z],
      size: [size.x, size.y, size.z],
      radius,
    };
  }

  /**
   * 回填参考物的锚高（由 `Octomap3dPcd.rebuild` 在锚定之后调用）。
   *
   * 变了就**再发一次** `pointsChanged`：锚点要等这个控制器交出包围盒和新地板高度才
   * 定得下来，所以 `rebuild` 里那次 `emitPointsChanged` 带的还是上一轮的值（或
   * null）。宿主拿它当「贴合地面」的基准，晚一步就贴到几米之外去了。只在这一格真的
   * 变了时才多发——原地转/挪时锚点钉着不动，一次都不会多发。
   */
  setReferenceLevel(level: number | null): void {
    if (level === this.referenceLevel) {
      return;
    }
    this.referenceLevel = level;
    this.emitPointsChanged();
  }

  private emitPointsChanged(): void {
    this.pointsChanged.next({
      pointCount: this.currentPointCount,
      boundingBox: this.boundingBox,
      groundPlaneLevel: this.referenceLevel,
      voxelSize: this.renderedVoxelSize,
      requestedVoxelSize: this.requestedVoxelSize,
    });
  }
}
