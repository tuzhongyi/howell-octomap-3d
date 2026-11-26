import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  ViewChild,
  inject,
  signal,
} from '@angular/core';
import { Subscription } from 'rxjs';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OctoMapGroundExtent } from './controller/octomap-3d-pcd-ground-plane';
import { OctoMapRenderOptions } from './controller/octomap-3d-pcd-point.controller';
import { Octomap3dPcd, Octomap3dPcdProviders } from './controller/octomap-3d-pcd.controller';
import {
  DEFAULT_OCTO_MAP_SETTINGS,
  OctoMapBrushMissDetail,
  OctoMapCloudPreview,
  OctoMapCloudRotation,
  OctoMapCloudTranslation,
  OctoMapDogModelRequest,
  OctoMapGizmoMode,
  OctoMapGizmoPose,
  OctoMapHoverInfo,
  OctoMapInteractionMode,
  OctoMapPaintedVoxels,
  OctoMapPathAlgorithm,
  OctoMapPathFailedDetail,
  OctoMapPointClickedDetail,
  OctoMapPointCloud,
  OctoMapPointsChangedDetail,
  OctoMapProjectionSource,
  OctoMapReadyDetail,
  OctoMapRenderMode,
  OctoMapReply,
  OctoMapSelectionBox,
  OctoMapWalkProgress,
} from './octomap-3d-pcd.model';

const DEFAULT_BACKGROUND = '#0b1016';
const DEFAULT_POINT_COLOR = '#4fc3f7';
const DRAG_THRESHOLD_PX = 4;

/** 两份悬停读数是否指向同一个点（都为 null 时也算相同）。 */
function isSameHover(a: OctoMapHoverInfo | null, b: OctoMapHoverInfo | null): boolean {
  if (!a || !b) {
    return a === b;
  }
  return (
    a.forbidden === b.forbidden &&
    a.position[0] === b.position[0] &&
    a.position[1] === b.position[1] &&
    a.position[2] === b.position[2]
  );
}

/**
 * 可复用的 3D 查看器，使用 Three.js 渲染点云/octomap。
 *
 * 所有视觉参数通过 `@Input()` 传入，所有可观察的状态变化通过 `@Output()` 上报。
 * **动作**也走 `@Input()`——注册成 `EventEmitter` 由父组件发信号进来（见
 * {@link connectCommands}），取值型则把结果通过回填函数交回去。组件因此不对外
 * 暴露任何命令式方法，父组件也不需要拿到它的实例。
 * 组件本身只是一层薄外观：把参数和 DOM 事件转发给控制器，再把控制器的事件转发出去——
 * 所有渲染逻辑都在 `controller/` 里。
 */
@Component({
  selector: 'howell-octomap-3d-pcd',
  imports: [],
  templateUrl: './octomap-3d-pcd.component.html',
  styleUrl: './octomap-3d-pcd.component.less',
  providers: [...Octomap3dPcdProviders],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Octomap3dPcdComponent implements AfterViewInit, OnChanges, OnDestroy {
  @ViewChild('viewport', { static: true })
  private readonly viewportRef!: ElementRef<HTMLDivElement>;

  /** 要渲染的点云。传 null 清空视口。 */
  @Input() points: OctoMapPointCloud | null = null;

  /**
   * 拖动中的整体变换预览：把合并点云里的一段点当成刚体挪一下（见
   * {@link OctoMapCloudPreview}）。非 null 时**只改画面**，其余一概不碰。
   *
   * 多份点云拼成了一份渲染对象（手柄只该动其中一份），整份对象一挪会把别的云也
   * 带走，所以这里只动选中那一份：体素模式改写它占的那些实例矩阵，点云模式重画一份
   * 世界。与普通的 `points` 换新**刻意不同**：不走 {@link Octomap3dPcd.rebuild}，
   * 于是包围盒、地板高度、网格与地面、导航边界、手柄位姿都不动——拖动过程中世界并没有
   * 真的改变，那些跟着跳只会让参考物失去参照。
   *
   * 传回 null 表示回到 {@link points}（松手、取消拖动）。
   */
  @Input() preview: OctoMapCloudPreview | null = null;

  /**
   * 手柄的工作方式：`'off'` 不显示，`'translate'` 拖位移，`'rotate'` 拖旋转。
   *
   * 手柄是**另一个入口**，不改变 `points` 本身：拖动过程中只做画面预览，松手时
   * 通过 {@link cloudTranslated} / {@link cloudRotated} 把结果交给宿主；宿主改完
   * 数据、换一份新的 `points` 进来，画面才落到真实的坐标上。所以这个开关必须有人
   * 接那两个输出，否则云会「拖得动、松手弹回去」。
   */
  @Input() gizmoMode: OctoMapGizmoMode = 'off';

  /**
   * 手柄摆在哪：位置 + 云当前的整体朝向。null 时退回到包围盒中心、朝向恒等。
   *
   * 位置由宿主给（不是地图自己算包围盒中心）：云转过之后包围盒中心会漂，而宿主
   * 记账用的支点不会——两边不一致的话每转一次松手画面就跳一下。见
   * {@link OctoMapGizmoPose}。
   */
  @Input() gizmoPose: OctoMapGizmoPose | null = null;

  /**
   * 圈出当前选中的那一份点云（世界包围盒）；null 表示不画。
   *
   * 只在场景里拼了多份云、且手柄打开时才有意义——手柄只动其中一份，看框才知道
   * 动的是哪份。手柄收起来时宿主会传 null（选中本身还在，只是没东西可操作），
   * 地图跟着不画。地图不知道那是什么，只管画一个盒子。
   */
  @Input() selectionBox: OctoMapSelectionBox | null = null;

  /**
   * 拖手柄时要不要让渲染出来的云跟着动（预览）。
   *
   * 单份点云时当然要——那是「看得见的拖动」。多份点云拼在一个渲染对象里时，
   * 预览动的是**整片**：别的云会一起被拖走，松手又弹回去，看着像全部选中了。
   * 那种场合宿主关掉它，只让手柄和读数跟着手指走。
   */
  @Input() gizmoPreview = true;

  /**
   * `points` 换新时要不要把相机重新对到云上。
   *
   * 换文件时要；对**同一份云**做整体变换（旋转、平移、改角度）时不要——相机是用
   * 户自己调好的，每改一次就跳回默认机位会很烦。宿主知道这次是哪一种。
   */
  @Input() fitOnPointsChange = true;

  /**
   * `points` 换新时要不要把参考物（网格 + 地面平面）重新贴到云脚下。
   *
   * 换文件、换坐标系时要；对**同一份云**做整体变换时不要——参考物钉在原地，云在
   * 它上面滑过去，用户才看得出挪了多少。参考物跟着一起挪的话整幅画平移一下，看着
   * 像什么都没发生。
   *
   * 不重定时地面平面仍然会**长到盖住**挪走的云（它是放狗、设终点的射线靶面），
   * 只是中心不动。
   */
  @Input() refitReferenceOnPointsChange = true;

  /**
   * 手柄左上角那段只读读数（宿主格式化好的文本，可以有换行）。null 时不显示。
   *
   * 内容是宿主的事：地图不知道「偏移了多少」「转了多少度」这种语义，它只知道云被
   * 动过（见 {@link cloudTranslating} / {@link cloudTranslated} /
   * {@link cloudRotating} / {@link cloudRotated}）。
   */
  @Input() gizmoReadout: string | null = null;

  /** 点云的绘制方式：原始点云或立体格栅。 */
  @Input() renderMode: OctoMapRenderMode = 'voxel';

  /** 体素边长（世界单位）。为 null 时由包围盒推导。 */
  @Input() voxelSize: number | null = null;

  /** 视口的背景/清屏颜色。 */
  @Input() backgroundColor = DEFAULT_BACKGROUND;

  /** 点云没有逐点颜色时使用的兜底颜色。 */
  @Input() pointColor = DEFAULT_POINT_COLOR;

  /** 点大小（世界单位，仅点云模式）。为 null 时自动推导。 */
  @Input() pointSize: number | null = null;

  /** 是否显示参考网格。 */
  @Input() showGrid = true;

  /**
   * 是否显示规划网格能覆盖的范围。场景超限时无视它，强制显示。
   *
   * 显式标注 `boolean`：`DEFAULT_OCTO_MAP_SETTINGS` 是用 `satisfies` 收尾的，各值
   * 都保留字面量类型，所以 `= DEFAULT_OCTO_MAP_SETTINGS.showNavLimit` 会被推成
   * `true`，父组件绑 `false` 就编译不过。
   */
  @Input() showNavLimit: boolean = DEFAULT_OCTO_MAP_SETTINGS.showNavLimit;

  /**
   * 是否画出规划出来的路径。关掉只是隐藏，规划结果和行进都不受影响。
   *
   * 同样必须显式标注 `boolean`（与 {@link showNavLimit} 同一个坑，见
   * [[default-settings-literal-type]]）。
   */
  @Input() showPath: boolean = DEFAULT_OCTO_MAP_SETTINGS.showPath;

  /**
   * 是否把路径的每个顶点标成一颗珠子。与 {@link showPath} 各管各的：那一项只管管子。
   *
   * 同样必须显式标注 `boolean`（与 {@link showNavLimit} 同一个坑，见
   * [[default-settings-literal-type]]）——这里的默认值恰好是 `false`，不标注就再也
   * 写不进 `true`。
   */
  @Input() showPathPoints: boolean = DEFAULT_OCTO_MAP_SETTINGS.showPathPoints;

  /** 参考网格的大小（世界单位）。 */
  @Input() gridSize = 10;

  /** 每个网格单元的细分数。 */
  @Input() gridDivisions = 10;

  /** 点云变化时自动让相机适配点云。 */
  @Input() fitView = true;

  /** 让相机绕场景缓慢旋转。 */
  @Input() autoRotate = false;

  /** 当前是否显示已刷（障碍）颜色。 */
  @Input() showColoring = true;

  /** 禁行区域（已刷障碍）的颜色。 */
  @Input() forbiddenColor = '#ef4444';

  /** 已持久化的已刷障碍，在（重新）构建后重新应用。 */
  @Input() painted: OctoMapPaintedVoxels | null = null;

  /** 鼠标交互在地图上的解释方式。 */
  @Input() interactionMode: OctoMapInteractionMode = 'view';

  /**
   * 障碍刷的半径（世界单位）。默认值与 {@link DEFAULT_OCTO_MAP_SETTINGS} 一致，不抄
   * 字面量：首次绑定会被 `ngOnChanges` 跳过（见记忆 `ngOnChanges-skips-first-binding`），
   * 所以这里的初值必须就是那个默认值。**显式标注 `number`** 则是因为默认设置用
   * `satisfies` 收尾、各值保留字面量类型（见记忆 `default-settings-literal-type`）。
   */
  @Input() brushRadius: number = DEFAULT_OCTO_MAP_SETTINGS.brushRadius;

  /** 小狗能迈过/爬过的最大高度（世界单位）。 */
  @Input() maxStepHeight = 0.5;

  /**
   * 小狗一步能跨过的无支撑水平跨度上限（世界单位），0 = 不跨。地上的小坑靠它过去。
   */
  @Input() crossWidth = 0.125;

  /**
   * 「填充基准范围」（单位：导航格），只影响「贴云点面」那一档，见
   * {@link OctoMapMapSettings.fillBaseCells}。
   *
   * 显式标注 `number` 是因为 `DEFAULT_OCTO_MAP_SETTINGS` 用 `satisfies` 收尾、各值
   * 保留字面量类型，不标注就会被推成 `8`。
   */
  @Input() fillBaseCells: number = DEFAULT_OCTO_MAP_SETTINGS.fillBaseCells;

  /**
   * 终点的接受范围半径（世界单位）。路径末端落在这个半径之外就按「没找到路径」
   * 处理，并发出 `(pathFailed)`；终点周围画一圈同样大小的圆环标出这条边界。
   */
  @Input() goalRadius = 0.5;

  /** 小狗的碰撞半径（足迹宽度的一半，世界单位）。 */
  @Input() dogRadius = 0.25;

  /** 小狗的净空高度（世界单位）。 */
  @Input() dogHeight = 0.8;

  /** 是否显示小狗的碰撞足迹圆。 */
  @Input() showDogCollision = true;

  /** 小狗模型的缩放系数（1 = 原始大小）。 */
  @Input() dogScale = 1;

  /** 是否让小狗模型自动缩放到与碰撞足迹同宽（此时 dogScale 不生效）。 */
  @Input() dogFitCollision = false;

  /** 外部模型的朝向补偿，单位：度（模型正面相对 +X 偏了多少）。 */
  @Input() dogModelHeading = 0;

  /** 小狗放置、拖拽和停下时的朝向，单位：度（0 = 面向世界 +X）。 */
  @Input() dogHeading = 0;

  /** 高于此高度的点云点被隐藏（null=全部显示）。 */
  @Input() maxHeight: number | null = null;

  /** 低于此高度的点云点被隐藏（null=全部显示）。 */
  @Input() minHeight: number | null = null;

  /** 可行走地面是否延伸到点云包围盒之外。 */
  @Input() groundExtendsOutside = true;

  /**
   * 地面平面沿 X 轴向包围盒外延展的长度（单边，世界单位）。
   *
   * 显式标注 `: number`：`DEFAULT_OCTO_MAP_SETTINGS` 用 `satisfies` 收尾、各值保留
   * 字面量类型，抄初值会被推成 `0.9`，父组件传别的数就编译不过（与
   * {@link pathAlgorithm} 同一个坑，见 [[default-settings-literal-type]]）。
   */
  @Input() groundExtendX: number = DEFAULT_OCTO_MAP_SETTINGS.groundExtendX;

  /** 地面平面沿 Z 轴向包围盒外延展的宽度（单边，世界单位）。 */
  @Input() groundExtendZ: number = DEFAULT_OCTO_MAP_SETTINGS.groundExtendZ;

  /**
   * 用哪种方式寻路，见 {@link OctoMapPathAlgorithm}。
   *
   * 显式标注 `OctoMapPathAlgorithm`：`DEFAULT_OCTO_MAP_SETTINGS` 用 `satisfies` 收尾，
   * 各值保留字面量类型，抄初值会被推成 `'surfaceGraph'`，父组件换一种就编译不过
   * （与 {@link showNavLimit} 同一个坑，见 [[default-settings-literal-type]]）。
   */
  @Input() pathAlgorithm: OctoMapPathAlgorithm = DEFAULT_OCTO_MAP_SETTINGS.pathAlgorithm;

  /** 点击时射线拾取的点数上限（点云模式的安全保护）。 */
  @Input() maxPickingPoints = 1_000_000;

  // ---- 命令型输入 --------------------------------------------------------------
  //
  // 父组件 `emit()` 一下就执行一次，名字与原来的公开方法一致，所以父组件那边的
  // 绑定看起来只是换了个方向。接线在 {@link connectCommands} 里。
  //
  // **这些实例必须始终保持同一个引用。** 订阅是按实例建立的，父组件每次变更检测
  // 都重新 new 一个的话订阅当场就断了、命令静默失效（还会顺带每轮都触发一次
  // ngOnChanges）。父组件用一个 `readonly` 字段持有它们来保证这一点。
  //
  // 不写 `readonly`：Angular 是直接给输入属性赋值的，和它冲突（本组件其余 30 个
  // 输入也都没写，只有 `@Output()` 是 readonly）。默认值也不能省——声明成 `!:` 的
  // 话未绑定时是 undefined，订阅时当场抛错。

  /** 从小狗到终点运行 A* 并绘制路径（不行走）。 */
  @Input() findPath = new EventEmitter<void>();

  /** 让小狗沿当前路径开始行进。 */
  @Input() startWalk = new EventEmitter<void>();

  /** 跳到路径上的某个位置（[0, 1]）。 */
  @Input() seekWalk = new EventEmitter<number>();

  /** 暂停行进。 */
  @Input() pauseWalk = new EventEmitter<void>();

  /** 从暂停处继续行进。 */
  @Input() resumeWalk = new EventEmitter<void>();

  /** 移除小狗、终点和路径，便于用户从头重新部署。 */
  @Input() clearDeployment = new EventEmitter<void>();

  /** 把当前几何中所有被判定为障碍的体素都标记为禁行。 */
  @Input() markAllObstacles = new EventEmitter<void>();

  /** 清空已刷（禁行）障碍。 */
  @Input() clearObstacles = new EventEmitter<void>();

  /** 清掉外部模型，恢复内置几何体小狗。 */
  @Input() clearDogModel = new EventEmitter<void>();

  // 下面四个是取值型：payload 是「回填函数」，子组件算出结果就调它，见
  // {@link OctoMapReply}。`loadDogModel` 是唯一异步的一条。

  /**
   * 用外部模型文件替换小狗的内置几何体。`url` 可以是 blob/object URL 或静态
   * 资源路径。不传 `reply` 时失败静默。
   */
  @Input() loadDogModel = new EventEmitter<OctoMapDogModelRequest>();

  /** 取回用于导出的编辑后点云（每体素一个点，或原始点）。 */
  @Input() exportPointCloud = new EventEmitter<OctoMapReply<OctoMapPointCloud | null>>();

  /** 取回重采样到体素点阵上的点云（非体素模式为 null）。 */
  @Input() regularizeCloud = new EventEmitter<OctoMapReply<OctoMapPointCloud | null>>();

  /**
   * 取回当前俯视投影的全部输入（点位置、对齐包围盒、分辨率）。
   *
   * 给的是**输入**而不是算好的图：算图的那一步在 `projection.util.ts` 的纯函数里，
   * 调用方（投影弹窗）自己决定要占用图还是高度图。没有可投影的云点时回填 null。
   */
  @Input() projectionSource = new EventEmitter<OctoMapReply<OctoMapProjectionSource | null>>();

  /** WebGL 场景和控制器创建完成后发出一次。 */
  @Output() readonly mapReady = new EventEmitter<OctoMapReadyDetail>();

  /** 渲染的点云变化时发出。 */
  @Output() readonly pointsChanged = new EventEmitter<OctoMapPointsChangedDetail>();

  /**
   * 用户拖动平移手柄松手时发出：整片云这一下挪了多少（增量，世界坐标）。
   *
   * 只有拖动**结束时**发一次——过程中地图自己做了视觉预览，没必要让宿主每帧
   * 重建上百万个点。
   */
  @Output() readonly cloudTranslated = new EventEmitter<OctoMapCloudTranslation>();

  /**
   * 拖动平移手柄**过程中**发出：从按下那一刻算起挪了多少（相对量，世界坐标）。
   *
   * 给 {@link gizmoReadout} 那种「边拖边报数」的显示用；判据、松手后的落账
   * 一律走 {@link cloudTranslated}。一次拖动会发很多次（跟着指针走），接的人自己
   * 掂量要不要每帧都画。
   */
  @Output() readonly cloudTranslating = new EventEmitter<OctoMapCloudTranslation>();

  /**
   * 用户拖动旋转手柄松手时发出：云现在的整体朝向（**绝对值**，度，`'XYZ'`）。
   *
   * 与 {@link cloudTranslated} 相反，它不是增量：手柄拖出来的就是「转到哪儿」，
   * 宿主直接写进设置即可（增量要做四元数合成，那是地图这边的事）。
   */
  @Output() readonly cloudRotated = new EventEmitter<OctoMapCloudRotation>();

  /**
   * 拖动旋转手柄**过程中**发出：叠加之后的总朝向（绝对值，度，`'XYZ'`）。
   *
   * 口径同 {@link cloudTranslating}：只给读数用，落账一律走 {@link cloudRotated}。
   */
  @Output() readonly cloudRotating = new EventEmitter<OctoMapCloudRotation>();

  /** 用户点击点/体素（射线拾取）时发出。 */
  @Output() readonly pointClicked = new EventEmitter<OctoMapPointClickedDetail>();

  /** 导航路径变化时发出（点数，清空时为 null）。 */
  @Output() readonly pathChanged = new EventEmitter<number | null>();

  /**
   * 寻路失败时发出，带上原因。比 `pathChanged` 的 0 更具体——父组件据此能区分
   * 「搜不到路」和「搜到了但没走到用户点的位置」。
   */
  @Output() readonly pathFailed = new EventEmitter<OctoMapPathFailedDetail>();

  /** 小狗在路径上的位置（及其状态）变化时发出。 */
  @Output() readonly walkProgress = new EventEmitter<OctoMapWalkProgress>();

  /** 小狗被放置（或移动）到地面时发出。 */
  @Output() readonly dogPlaced = new EventEmitter<void>();

  /** 终点被放置（或移动）到地面时发出。 */
  @Output() readonly goalPlaced = new EventEmitter<void>();

  /** 已刷（禁行）障碍集合变化时发出。 */
  @Output() readonly paintedChanged = new EventEmitter<OctoMapPaintedVoxels>();

  /**
   * 刷障碍时这一笔**没刷到任何点**时发出：笔刷在拖拽中扫出了点云（或当前是「点云」
   * 显示模式，压根没有体素可刷）。判据与其余三个前置条件见 `reportBrushMiss`。
   *
   * 一次按下到抬起之间**最多一次**（见 `brushMissed`）；「空处按下」不发——那是要转
   * 相机；擦除不发——在没有障碍的地方擦是常事。父组件拿它给用户一句话
   * （见 `OctoMapBrushMissDetail`）。
   */
  @Output() readonly brushMiss = new EventEmitter<OctoMapBrushMissDetail>();

  /** 用户右键退出编辑器模式（回到视图模式）时发出。 */
  @Output() readonly interactionModeChange = new EventEmitter<OctoMapInteractionMode>();

  /** 发生渲染/几何错误时发出。 */
  @Output() readonly error = new EventEmitter<Error>();

  /**
   * 指针下那个云点的读数，显示在视口右下角；没指着东西时为 null。
   *
   * 用信号而不是普通字段：探测发生在 requestAnimationFrame 里，信号能自己把 OnPush
   * 的这一帧标脏，不必再去碰变更检测。
   */
  protected readonly hover = signal<OctoMapHoverInfo | null>(null);

  private readonly controller = inject(Octomap3dPcd);
  private readonly subscriptions: Subscription[] = [];
  /** 已排队的悬停探测帧；0 = 没有排队。 */
  private hoverFrame = 0;
  /** 最近一次 pointermove 事件，供每帧那一次探测取用。 */
  private hoverEvent: PointerEvent | null = null;
  private resizeObserver!: ResizeObserver;
  private viewInitialized = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private brushing = false;
  /**
   * 这一笔（一次按下到抬起之间）已经因为「刷不到点」提示过了吗。
   *
   * 一次拖拽会按 pointermove 的频率刷几十下，不记这个就会刷屏。**在按下那一支清零**，
   * 所以「一笔一次」的口径是按下到抬起：下一次按下又能提示一次。`pointerup` 不必清
   * ——`pointerup` 到下一次 `pointerdown` 之间根本不会走到刷笔那条路（`brushing` 已置 false）。
   */
  private brushMissed = false;
  private draggingDog = false;
  /** 这一次按下落在平移手柄上：随后的 `click` 不该再去拾取/取消选中。 */
  private gizmoPressed = false;
  /** 右键按下的位置，用于区分取消点击与平移。 */
  private rightDownX = 0;
  private rightDownY = 0;
  /** 右键按下且移动超过拖拽阈值时为 true。 */
  private rightDragged = false;
  /** “移动”编辑器抓住的体素，等待放置点击。 */
  private moveSourceKey: string | null = null;

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.dragStartX = event.clientX;
    this.dragStartY = event.clientY;
    // 平移手柄优先。TransformControls 的 pointerdown 比这里先注册（见
    // `Octomap3dPcdGlobal.createMoveGizmo`），命中手柄时它已经把 `dragging`
    // 置真——这一下得整让出去，否则按住箭头的同时还会去刷笔、抓狗或拾取。
    if (this.controller.global.gizmoDragging) {
      this.gizmoPressed = true;
      return;
    }
    if (event.button === 2) {
      this.rightDownX = event.clientX;
      this.rightDownY = event.clientY;
      this.rightDragged = false;
    }
    // 刷绑定在左键，但仅当按下命中体素时。
    // 空处的左键按下留给 OrbitControls，以便旋转相机。
    if (
      (this.interactionMode === 'brush' || this.interactionMode === 'erase') &&
      event.button === 0 &&
      this.brushAtPointer(event)
    ) {
      this.brushing = true;
      this.brushMissed = false;
      this.controller.global.setControlsEnabled(false);
      return;
    }
    // 视图模式下，左键按在小狗上会抓住它，以便拖拽。
    if (
      this.interactionMode === 'view' &&
      event.button === 0 &&
      this.controller.dog.pick(event)
    ) {
      this.draggingDog = true;
      this.controller.dog.select();
      this.controller.clearPath();
      this.controller.global.setControlsEnabled(false);
    }
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    // 读数只在空闲悬停时更新：按住键多半是在转相机、拖狗或刷障碍，这时既没必要
    // 每帧做一次射线拾取，读数跟着乱跳也碍事。
    if (event.buttons === 0) {
      this.scheduleHover(event);
    }
    // 右键拖拽是平移相机，因此不能算作取消点击。
    if ((event.buttons & 2) !== 0) {
      const dx = event.clientX - this.rightDownX;
      const dy = event.clientY - this.rightDownY;
      if (dx * dx + dy * dy > DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
        this.rightDragged = true;
      }
    }
    if (this.draggingDog) {
      const groundPoint = this.controller.grille.pickGroundPoint(event);
      if (groundPoint) {
        this.controller.moveDog(groundPoint);
      }
      return;
    }
    // 点云编辑器的悬停反馈（添加/删除/移动预览）。
    if (
      this.interactionMode === 'addPoint' ||
      this.interactionMode === 'deletePoint' ||
      this.interactionMode === 'movePoint'
    ) {
      this.updateEditorHover(event);
      return;
    }
    if (this.interactionMode !== 'brush' && this.interactionMode !== 'erase') {
      return;
    }
    // 让刷区域圆保持在光标下，即使拖拽尚未开始。
    const groundPoint = this.controller.grille.pickGroundPoint(event);
    if (groundPoint) {
      this.controller.global.updateBrushCursor(groundPoint, this.brushRadius);
    }
    if (this.brushing && (event.buttons & 1)) {
      this.brushAtPointer(event);
    }
  };

  private readonly onPointerLeave = (): void => {
    this.controller.grille.clearEditorFeedback(this.renderOptions());
    this.clearHover();
  };

  /**
   * 排一次悬停探测（每帧最多一次）。
   *
   * 跟着 pointermove 直接拾取会把帧率拖垮：点云模式下一次射线拾取要遍历上百万个
   * 点（见 `Octomap3dPcdGrille.probe`），而 pointermove 一帧能来十几个。攒到
   * 下一帧统一算，鼠标划得再快也只算一遍。
   */
  private scheduleHover(event: PointerEvent): void {
    this.hoverEvent = event;
    if (this.hoverFrame) {
      return;
    }
    this.hoverFrame = requestAnimationFrame(() => {
      this.hoverFrame = 0;
      const latest = this.hoverEvent;
      this.hoverEvent = null;
      if (!latest) {
        return;
      }
      const info = this.controller.grille.probe(latest, this.maxPickingPoints);
      // 同一个点上反复算出来的读数逐位相同，不判等的话每帧都要走一次变更检测
      // （鼠标停在原地也会）。
      if (!isSameHover(this.hover(), info)) {
        this.hover.set(info);
      }
    });
  }

  /** 收起读数浮框，并丢掉还没算的那一帧。 */
  private clearHover(): void {
    this.hoverEvent = null;
    if (this.hoverFrame) {
      cancelAnimationFrame(this.hoverFrame);
      this.hoverFrame = 0;
    }
    this.hover.set(null);
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    this.brushing = false;
    this.draggingDog = false;
    this.controller.global.setControlsEnabled(true);
    // 手柄那一下的 `click` 紧跟着本事件；若这次没有 `click`（松手落在画布外），
    // 标志得自己失效，否则会吞掉下一次真正的点击。
    if (this.gizmoPressed) {
      setTimeout(() => {
        this.gizmoPressed = false;
      }, 0);
    }
    // 未做其它事的右键点击会取消进行中的编辑。右键
    // 拖拽是相机操作，因此退出模式属于误伤。
    if (event.button === 2 && !this.rightDragged) {
      this.cancelEditorMode();
    }
  };

  private readonly onContextMenu = (event: MouseEvent): void => {
    // 这里从不需要浏览器菜单；该手势是否同时取消
    // 编辑器模式在 pointerup 时决定，那时已知拖拽距离。
    event.preventDefault();
  };

  /** 退出添加/删除/移动编辑器模式，让地图回到普通视图。 */
  private cancelEditorMode(): void {
    if (
      this.interactionMode === 'addPoint' ||
      this.interactionMode === 'deletePoint' ||
      this.interactionMode === 'movePoint'
    ) {
      this.interactionModeChange.emit('view');
    }
  }

  private readonly onClick = (event: MouseEvent): void => {
    const dx = event.clientX - this.dragStartX;
    const dy = event.clientY - this.dragStartY;
    // 忽略结束拖拽手势的点击。
    if (dx * dx + dy * dy > DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
      return;
    }
    // 按在手柄上的那一下（哪怕几乎没动）不算点击，别去拾取或取消选中。
    if (this.gizmoPressed) {
      this.gizmoPressed = false;
      return;
    }
    if (this.interactionMode === 'view') {
      // 点击小狗保持其选中；点击空处则取消选中，
      // 并继续执行点拾取。
      if (this.controller.dog.pick(event)) {
        this.controller.dog.select();
      } else {
        this.controller.dog.deselect();
        this.controller.grille.pick(event, this.renderMode, this.maxPickingPoints);
      }
    } else if (this.interactionMode === 'addPoint') {
      this.addPointAt(event);
    } else if (this.interactionMode === 'deletePoint') {
      this.deletePointAt(event);
    } else if (this.interactionMode === 'movePoint') {
      this.movePointAt(event);
    }
  };

  private readonly onDblClick = (event: MouseEvent): void => {
    if (this.interactionMode === 'placeDog') {
      this.placeOnGround(event, 'dog');
    } else if (this.interactionMode === 'placeGoal') {
      this.placeOnGround(event, 'goal');
    }
  };

  ngAfterViewInit(): void {
    this.viewInitialized = true;

    const el = this.viewportRef.nativeElement;
    const width = el.clientWidth || 1;
    const height = el.clientHeight || 1;

    // 在首次构建前把控制器事件转发到 @Output 发射器，
    // 以免错过初始的 pointsChanged。
    this.subscriptions.push(
      this.controller.grille.pointsChanged.subscribe((detail) => {
        // 点云换了，读数指向的可能已经是不存在的点——重挂时就先收起来，鼠标再动
        // 一下会重新算。
        this.clearHover();
        this.pointsChanged.emit(detail);
      }),
      this.controller.grille.pointClicked.subscribe((detail) => this.pointClicked.emit(detail)),
      this.controller.grille.paintedChanged.subscribe((painted) => this.paintedChanged.emit(painted)),
      this.controller.grille.error.subscribe((err) => this.error.emit(err)),
      this.controller.path.pathChanged.subscribe((count) => this.pathChanged.emit(count)),
      this.controller.path.pathFailed.subscribe((detail) => this.pathFailed.emit(detail)),
      this.controller.dog.walkStateChanged.subscribe((progress) => this.walkProgress.emit(progress)),
      // 拖动过程中只做画面预览（动渲染对象，不动数据）；松手才把增量交给宿主。
      this.controller.global.gizmoDragged.subscribe(([x, y, z]) => {
        if (this.gizmoPreview) {
          this.controller.grille.setPreviewOffset(x, y, z);
        }
        this.cloudTranslating.emit({ x, y, z });
      }),
      this.controller.global.gizmoCommitted.subscribe(([x, y, z]) =>
        this.cloudTranslated.emit({ x, y, z }),
      ),
      // 旋转同一个套路，只是报的是**总朝向**：预览要的是增量（画面上的云已经转过
      // 一次了），读数要的是总量（宿主直接显示）。
      this.controller.global.gizmoRotating.subscribe(({ delta, pivot, euler }) => {
        if (this.gizmoPreview) {
          this.controller.grille.setPreviewRotation(delta, pivot);
        }
        this.cloudRotating.emit({ x: euler[0], y: euler[1], z: euler[2] });
      }),
      this.controller.global.gizmoRotated.subscribe(([x, y, z]) =>
        this.cloudRotated.emit({ x, y, z }),
      ),
    );

    // 和上面那批同一个时机：父组件最早的 emit 来自用户事件或 fetch 回调，都在
    // 首轮变更检测之后，而 Angular 保证子组件的 ngAfterViewInit 先于父组件。
    this.connectCommands();

    this.controller.global.init(el, this.backgroundColor, this.autoRotate);
    this.controller.global.rebuildGrid(this.showGrid, this.gridSize, this.gridDivisions);
    this.controller.rebuild(
      this.points,
      this.renderOptions(),
      true,
      this.groundExtent(),
      this.fitOnPointsChange,
      this.refitReferenceOnPointsChange,
    );
    // 同一条「首次绑定被 ngOnChanges 早退」：`gizmoMode` / `gizmoPose` 的第一份值
    // 只能在这里补。
    this.syncGizmo();
    // 同一个时机：选中框的第一份值也得自己补一刀（`init` 刚把场景建出来）。
    this.controller.global.setSelectionBox(this.selectionBox);
    // 首次绑定会被 ngOnChanges 的 `viewInitialized` 早退整个跳过（上面那批命令和
    // 这里都属于「必须自己补一刀」的情形）。放在 rebuild 之后：那时控制器已经拿到
    // 包围盒，而这个开关决定的是那条线要不要露出来。
    this.controller.path.setNavLimitVisible(this.showNavLimit);
    // 同一条早退：首次绑定的 `showPath` 也轮不到 ngOnChanges。此刻 rebuild 刚清过
    // 路径、没有管子可藏，这一刀只是把开关记进控制器，等规划完成后 `drawPath` 照着它
    // 决定露不露面。
    this.controller.path.setPathVisible(this.showPath);
    // 同一条早退：首次绑定的 `showPathPoints` 也轮不到 ngOnChanges。它同样是「记进
    // 控制器」就够——此刻还没有折线，真正画出珠子的是规划完成后那次 `drawPath`。
    this.controller.path.setPathPointsVisible(this.showPathPoints);
    // 同理：首次绑定的 `pathAlgorithm` 也会被上面那个早退跳过。必须在 rebuild 之后
    // 再切——`setAlgorithm` 只换规划器，不碰表面图，但换了之后要等下一次「找路径」
    // 才生效，所以这里早切晚切都不影响这一帧的画面。
    this.controller.path.setAlgorithm(this.pathAlgorithm);

    this.resizeObserver = new ResizeObserver(() => this.controller.global.handleResize());
    this.resizeObserver.observe(el);

    const dom = this.controller.global.renderer.domElement;
    dom.addEventListener('pointerdown', this.onPointerDown);
    dom.addEventListener('pointermove', this.onPointerMove);
    dom.addEventListener('pointerup', this.onPointerUp);
    dom.addEventListener('pointercancel', this.onPointerUp);
    dom.addEventListener('pointerleave', this.onPointerLeave);
    dom.addEventListener('click', this.onClick);
    dom.addEventListener('dblclick', this.onDblClick);
    dom.addEventListener('contextmenu', this.onContextMenu);

    this.mapReady.emit({
      width,
      height,
      pointCount: this.controller.grille.currentPointCount,
      boundingBox: this.controller.grille.boundingBox,
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (!this.viewInitialized) {
      return;
    }

    // 数据或体素分辨率变化时完全重建。
    if (changes['points']) {
      this.controller.rebuild(
        this.points,
        this.renderOptions(),
        true,
        this.groundExtent(),
        this.fitOnPointsChange,
        this.refitReferenceOnPointsChange,
      );
      // 云没了手柄也得收起来——它会孤零零地悬在原点。云换了位置时宿主的
      // `gizmoPose` 也会跟着变，但那一次不一定和这里同一拍，先按新的包围盒兜一次。
      this.syncGizmo();
    } else if (changes['preview']) {
      // 只改画面，不重建世界：体素模式挪选中那份的实例矩阵，点云模式整份重画
      // （见 `Octomap3dPcdGrille.applyPreview`）。包围盒、地板、网格与手柄都不动。
      this.controller.grille.applyPreview(
        this.preview,
        this.renderOptions(),
        this.points,
      );
    } else if (
      changes['renderMode'] ||
      changes['voxelSize'] ||
      changes['maxHeight'] ||
      changes['minHeight']
    ) {
      this.controller.rebuild(this.points, this.renderOptions(), false, this.groundExtent());
    } else if (changes['pointColor']) {
      if (this.renderMode === 'voxel') {
        this.controller.rebuild(this.points, this.renderOptions(), false, this.groundExtent());
      } else {
        this.controller.grille.applyMaterial(this.renderOptions());
      }
    }

    // 在上述任何重建之后重新应用已持久化的已刷障碍。
    if (changes['painted']) {
      this.controller.restorePainted(this.painted, this.renderOptions());
    }

    // 仅重新着色（不重建几何）。
    if (changes['showColoring'] || changes['forbiddenColor']) {
      this.refreshColoring();
    }
    if (changes['backgroundColor']) {
      this.controller.global.setBackgroundColor(this.backgroundColor);
    }
    if (changes['showGrid'] || changes['gridSize'] || changes['gridDivisions']) {
      this.controller.global.rebuildGrid(this.showGrid, this.gridSize, this.gridDivisions);
    }
    if (changes['showNavLimit']) {
      this.controller.path.setNavLimitVisible(this.showNavLimit);
    }
    if (changes['showPath']) {
      this.controller.path.setPathVisible(this.showPath);
    }
    if (changes['showPathPoints']) {
      // 与上面那条**各判各的键**：两项本来就是独立开关，合并成一个 `||` 会让「只动
      // 这一项」时进不来（并且会把两个语义不同的东西绑在一起）。
      this.controller.path.setPathPointsVisible(this.showPathPoints);
    }
    if (changes['pathAlgorithm']) {
      this.controller.path.setAlgorithm(this.pathAlgorithm);
    }
    if (changes['pointSize']) {
      this.controller.grille.applyMaterial(this.renderOptions());
    }
    if (changes['autoRotate']) {
      this.controller.global.setAutoRotate(this.autoRotate);
    }
    // 模式、位姿各判各的键：宿主拖动时只有位姿变，切开关时只有模式变。
    if (changes['gizmoMode'] || changes['gizmoPose']) {
      this.syncGizmo();
    }
    // 选中框不随重建走：它圈的是「哪一份云」，与渲染对象无关。
    if (changes['selectionBox']) {
      this.controller.global.setSelectionBox(this.selectionBox);
    }
    if (changes['interactionMode']) {
      this.controller.global.setBrushCursorVisible(
        this.interactionMode === 'brush' || this.interactionMode === 'erase',
      );
      this.moveSourceKey = null;
      this.controller.grille.clearEditorFeedback(this.renderOptions());
    }
    // 三个条件**必须取或**：`SimpleChanges` 只记录值真的变了的键，只判
    // `groundExtendsOutside` 的话，用户拖两根拉杆时那个键根本不出现——面板上的
    // 数字在动、地面一动不动，功能是死的。同一个机制还咬异步的 `restoreSettings`
    // （配置文件里只改了延展量，`groundExtendsOutside` 值没变就进不来这里）。
    if (
      changes['groundExtendsOutside'] ||
      changes['groundExtendX'] ||
      changes['groundExtendZ']
    ) {
      this.controller.updateGroundPlane(this.groundExtent());
    }
    if (changes['dogRadius'] || changes['dogHeight'] || changes['showDogCollision']) {
      this.controller.setDogCollision(this.dogRadius, this.dogHeight, this.showDogCollision);
    }
    if (changes['dogScale']) {
      this.controller.dog.setScale(this.dogScale);
    }
    if (changes['dogFitCollision']) {
      this.controller.dog.setFitToCollision(this.dogFitCollision);
    }
    if (changes['dogHeading']) {
      this.controller.dog.setHeading(this.dogHeading);
    }
    if (changes['goalRadius']) {
      // 直接转给路径控制器，不走 syncMarkerScale()：那个函数管的是锥和管的尺寸
      // 参考（小狗足迹 + 体素下限），半径是导航容差，混进去会让它的语义变模糊。
      this.controller.path.setGoalRadius(this.goalRadius);
    }
    if (changes['fillBaseCells']) {
      // 也只是记下来：表面图要等下一次「找路径」才按新窗口重建（见 setFillBaseCells）。
      this.controller.path.setFillBaseCells(this.fillBaseCells);
    }
    if (changes['dogModelHeading']) {
      this.controller.dog.setModelHeading(this.dogModelHeading);
    }
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach((subscription) => subscription.unsubscribe());
    this.resizeObserver?.disconnect();
    // 排着队的那一帧要撤掉，否则组件销毁后它还会去碰已经释放的控制器。
    this.clearHover();
    const dom = this.controller.global.renderer?.domElement;
    dom?.removeEventListener('pointerdown', this.onPointerDown);
    dom?.removeEventListener('pointermove', this.onPointerMove);
    dom?.removeEventListener('pointerup', this.onPointerUp);
    dom?.removeEventListener('pointercancel', this.onPointerUp);
    dom?.removeEventListener('pointerleave', this.onPointerLeave);
    dom?.removeEventListener('click', this.onClick);
    dom?.removeEventListener('dblclick', this.onDblClick);
    dom?.removeEventListener('contextmenu', this.onContextMenu);
    this.controller.dispose();
  }

  /** 让相机重新适配当前点云（公共 API）。 */
  resetCamera(): void {
    this.controller.global.fitCamera(this.controller.grille.boundingBox);
  }

  /**
   * 手柄只在「有云」且宿主选了模式时露出来。
   *
   * 不跟 `interactionMode` 绑：那是宿主的一个显式开关，打开就该看得见。手柄自己
   * 的按下不会漏给刷笔/拖狗（见 `onPointerDown`），所以和工具模式并存是安全的。
   *
   * 位姿每次都跟着设一遍（而不是只判 `gizmoPose` 变化）：`rebuild` 会按包围盒把
   * 锚点摆一次，宿主给了位姿时得以它为准。
   */
  private syncGizmo(): void {
    const mode = this.points === null ? 'off' : this.gizmoMode;
    this.controller.global.setMoveGizmoMode(mode === 'off' ? 'translate' : mode);
    this.controller.global.setMoveGizmoVisible(mode !== 'off');
    if (mode !== 'off') {
      if (this.gizmoPose) {
        this.controller.global.setGizmoPose(
          this.gizmoPose.position,
          this.gizmoPose.rotation,
        );
      } else {
        this.controller.global.moveGizmoTo(this.controller.grille.boundingBox);
      }
    }
  }

  /**
   * 把父组件发来的命令接到控制器上。
   *
   * 父组件 `emit()` 一下就等于原来调一个方法：`EventEmitter` 底层就是 `Subject`，
   * `next()` 是同步的，所以 emit 返回时这里的回调已经跑完了——命令并没有因为换了
   * 注册方式就变成异步。取值型那几条把结果回填给父组件给的回调，同样是同步的
   * （`loadDogModel` 除外，它本来就异步）。
   *
   * 订阅句柄统一进 `this.subscriptions`，销毁时那一次 `unsubscribe` 就够了。
   */
  private connectCommands(): void {
    this.subscriptions.push(
      // 唯一的异步命令：url 随请求下来，加载完用 reply 把错误串回填。`reply` 缺省
      // 时（启动时按记住的文件名恢复那条路）失败静默。
      this.loadDogModel.subscribe(({ url, reply }) => {
        void this.applyDogModel(url).then((error) => reply?.(error));
      }),
      this.clearDogModel.subscribe(() => this.controller.dog.clearModel()),
      this.findPath.subscribe(() =>
        this.controller.findPath(
          this.maxStepHeight,
          this.crossWidth,
          this.dogRadius,
          this.dogHeight,
          this.groundExtendsOutside,
        ),
      ),
      this.startWalk.subscribe(() => this.controller.startWalk()),
      this.seekWalk.subscribe((progress) => this.controller.seekWalk(progress)),
      this.pauseWalk.subscribe(() => this.controller.pauseWalk()),
      this.resumeWalk.subscribe(() => this.controller.resumeWalk()),
      this.clearDeployment.subscribe(() => this.controller.resetDeployment()),
      this.markAllObstacles.subscribe(() => this.controller.markAllObstacles(this.renderOptions())),
      this.clearObstacles.subscribe(() =>
        this.controller.grille.clearObstacles(this.renderOptions()),
      ),
      // 取值型：算出来直接回填给父组件。
      this.exportPointCloud.subscribe((reply) => reply(this.controller.toPointCloud())),
      this.regularizeCloud.subscribe((reply) => reply(this.controller.toRegularCloud())),
      this.projectionSource.subscribe((reply) => reply(this.controller.projectionSource())),
    );
  }

  /**
   * 用外部模型文件替换小狗的内置几何体。`url` 可以是 blob/object URL 或静态
   * 资源路径。返回 null 表示成功，否则是可显示的失败原因。
   */
  private async applyDogModel(url: string): Promise<string | null> {
    try {
      const gltf = await new GLTFLoader().loadAsync(url);
      this.controller.dog.setCustomModel(gltf.scene);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private brushAtPointer(event: MouseEvent | PointerEvent): boolean {
    const pick = this.controller.grille.pickVoxel(event);
    if (!pick) {
      // 射线没打到任何体素。**按下**时这一支要把左键让给 OrbitControls（空处拖拽 = 转
      // 相机，见 `onPointerDown`），所以不能提示——否则每转一次相机都会弹一句。
      this.reportBrushMiss();
      return false;
    }
    if (this.interactionMode === 'erase') {
      // 擦除不看返回值：在没有障碍的地方擦本来就是常事，提示只会变成噪音。
      this.controller.erase(pick.center, this.brushRadius, this.renderOptions());
      return true;
    }
    const { occupied } = this.controller.brush(pick.center, this.brushRadius, this.renderOptions());
    if (occupied === 0) {
      this.reportBrushMiss();
    }
    return true;
  }

  /**
   * 「这一笔没刷到点」→ 报一次（一笔最多一次，见 `brushMissed`）。
   *
   * 三个前置条件，每一个都在挡掉一类误报：
   *
   * - `interactionMode === 'brush'`：擦除不报（在没有障碍的地方擦是常事）；
   * - `brushing`：**按下那一刻它还是 false**（`onPointerDown` 在 `brushAtPointer` 返回
   *   true 之后才置位），所以「空处按下」不会报——那是要转相机。只有**已经在拖**的
   *   时候才报，那时笔刷扫出了点云，这一段确实什么都没刷上；
   * - `!brushMissed`：一次拖拽会按 pointermove 的频率刷几十下，不挡就是刷屏。
   *
   * 判据的来历值得记一笔：设计时定的是「范围内的已占用体素数 `occupied === 0`」，但
   * `pickVoxel` 是**对着体素网格做射线拾取**的，命中就意味着那个体素存在——所以
   * `occupied >= 1` 恒成立，光靠它这条提示是**恒零的死代码**（`q:\tmp` 那类探针的
   * 老毛病）。真正够得着的触发点是 `pick === null`：要么笔刷扫出了点云，要么当前是
   * 「点云」显示模式（压根没有体素可刷）。`occupied === 0` 那一条照旧留着——它是控制
   * 器那一层的真话，将来 `pickVoxel` 若改成吸附到附近的体素，它立刻就变成正主。
   */
  private reportBrushMiss(): void {
    if (this.interactionMode !== 'brush' || !this.brushing || this.brushMissed) {
      return;
    }
    this.brushMissed = true;
    // 报**实际**的体素大小（`voxelSize` 那个输入可以是 null = 自动），文案里要拿它
    // 说明「笔刷半径才几格」，见 `OctoMapBrushMissDetail`。
    this.brushMiss.emit({
      radius: this.brushRadius,
      voxelSize: this.controller.grille.grid?.voxelSize ?? 0,
    });
  }

  private placeOnGround(event: MouseEvent, kind: 'dog' | 'goal'): void {
    // 终点和小狗都优先落在扫描出来的表面上（地板、桌面、台阶顶、墙面……），
    // 打不中任何东西时才退回地面平面。标记与小狗都放在射线打到的那一点上——
    // 不对齐到体素，寻路会在 findPath 时把它映射到体素。
    //
    // 小狗以前只认地面平面，那是个 bug：射线落到地面上的 XZ，和你点的那片云
    // 所在的 XZ **不是一回事**。云点离地越高，交点偏得越远（实测离地 1~1.5m
    // 时中位数偏 1.76m，天花板附近偏 3.4m）；而地面平面就只有包围盒加一圈延展
    // （默认 0.9 m，见设置里的「延展长度/宽度」）那么大，交点跑出那块矩形时
    // pickGroundPoint 直接返回 null——点击被
    // **静默丢掉**，十个云点里就有一个（全是 0.9m 以上的墙面和高家具，房扫里
    // 最显眼的那一片）。手感就是「点云上放不下狗」。
    const surface = this.controller.grille.pickSurfacePoint(event, this.maxPickingPoints);
    const point = surface ?? this.controller.grille.pickGroundPoint(event);
    if (!point) {
      return;
    }
    if (kind === 'dog') {
      this.controller.placeDog(point);
      this.dogPlaced.emit();
    } else {
      this.controller.placeGoal(point);
      this.goalPlaced.emit();
    }
  }

  /** 下一个添加/移动的体素将落在哪：点击面的邻居，否则为地面。 */
  private resolvePlacementTarget(event: MouseEvent | PointerEvent): [number, number, number] | null {
    const face = this.controller.grille.pickVoxelFace(event);
    if (face) {
      const vs = this.controller.grille.grid?.voxelSize ?? 0;
      return [
        face.center[0] + face.normal[0] * vs,
        face.center[1] + face.normal[1] * vs,
        face.center[2] + face.normal[2] * vs,
      ];
    }
    return this.controller.grille.pickGroundPoint(event);
  }

  /** 编辑器模式激活时刷新悬停预览/着色。 */
  private updateEditorHover(event: PointerEvent): void {
    const options = this.renderOptions();
    if (this.interactionMode === 'addPoint') {
      this.controller.grille.setPreviewPosition(this.resolvePlacementTarget(event));
    } else if (this.interactionMode === 'deletePoint') {
      const pick = this.controller.grille.pickVoxel(event);
      this.controller.grille.setVoxelHighlight(pick?.key ?? null, options);
    } else if (this.interactionMode === 'movePoint') {
      if (!this.moveSourceKey) {
        const pick = this.controller.grille.pickVoxel(event);
        this.controller.grille.setVoxelHighlight(pick?.key ?? null, options);
      } else {
        this.controller.grille.setPreviewPosition(this.resolvePlacementTarget(event));
      }
    }
  }

  private addPointAt(event: MouseEvent): void {
    const target = this.resolvePlacementTarget(event);
    if (target) {
      this.controller.addVoxel(target, this.renderOptions());
    }
  }

  private deletePointAt(event: MouseEvent): void {
    const pick = this.controller.grille.pickVoxel(event);
    if (pick) {
      this.controller.removeVoxel(pick.key, this.renderOptions());
    }
  }

  private movePointAt(event: MouseEvent): void {
    // 第一次点击抓住源体素；第二次点击放置它。
    if (!this.moveSourceKey) {
      const pick = this.controller.grille.pickVoxel(event);
      if (pick) {
        this.moveSourceKey = pick.key;
        // 手持体素期间将其染成绿色。
        this.controller.grille.setVoxelHighlight(pick.key, this.renderOptions(), '#22c55e');
      }
      return;
    }
    const sourceKey = this.moveSourceKey;
    this.moveSourceKey = null;
    const target = this.resolvePlacementTarget(event);
    if (target) {
      this.controller.moveVoxel(sourceKey, target, this.renderOptions());
    } else {
      // 落在空处：取消移动并清除手持着色。
      this.controller.grille.clearEditorFeedback(this.renderOptions());
    }
  }

  private refreshColoring(): void {
    if (this.renderMode === 'voxel') {
      this.controller.grille.refreshColors(this.renderOptions());
    } else {
      this.controller.grille.applyMaterial(this.renderOptions());
    }
  }

  private renderOptions(): OctoMapRenderOptions {
    return {
      renderMode: this.renderMode,
      voxelSize: this.voxelSize,
      pointSize: this.pointSize,
      pointColor: this.pointColor,
      fitView: this.fitView,
      showColoring: this.showColoring,
      forbiddenColor: this.forbiddenColor,
      maxHeight: this.maxHeight,
      minHeight: this.minHeight,
    };
  }

  /**
   * 把三个输入拼成地面延展设置。
   *
   * **每次现场拼、不缓存成字段**：配置文件是异步读的（`SystemManagerComponent`
   * 的 `restoreSettings` 要 fetch），它会在这之后才写回设置。缓存一份的话，
   * `ngOnChanges` 里各处引用的就是旧值，改配置后第一次画出来的平面会是错的。
   * 与 {@link renderOptions} 同一个路数。
   */
  private groundExtent(): OctoMapGroundExtent {
    return {
      outside: this.groundExtendsOutside,
      x: this.groundExtendX,
      z: this.groundExtendZ,
    };
  }
}
