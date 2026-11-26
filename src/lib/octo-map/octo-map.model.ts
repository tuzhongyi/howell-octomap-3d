/**
 * PCD 解析器与 OctoMapComponent 之间共享的数据契约。
 */

/** 由 {@link OctoMapComponent} 渲染的三维点云。 */
export interface OctoMapPointCloud {
  /** 交错的 XYZ 坐标，长度 = pointCount * 3。 */
  positions: Float32Array;
  /** 可选的交错 RGB 颜色（0..1），长度 = pointCount * 3。 */
  colors?: Float32Array;
  /** 可选的交错法线，长度 = pointCount * 3。 */
  normals?: Float32Array;
  /** 点数。 */
  pointCount: number;
}

/** 当前点云的轴对齐包围盒，单位：世界单位。 */
export interface OctoMapBoundingBox {
  min: [number, number, number];
  max: [number, number, number];
  center: [number, number, number];
  size: [number, number, number];
  radius: number;
}

/** (mapReady) 发出的负载。 */
export interface OctoMapReadyDetail {
  width: number;
  height: number;
  pointCount: number;
  boundingBox: OctoMapBoundingBox | null;
}

/** (pointsChanged) 发出的负载。 */
export interface OctoMapPointsChangedDetail {
  pointCount: number;
  boundingBox: OctoMapBoundingBox | null;
  /**
   * 参考物（灰色地面平面 + 参考网格）所在的世界 Y；没有点云时为 null。
   *
   * 与控制器里那个 `groundLevel` **不是一回事**：那个是「这份云现在的 1% 分位高度」，
   * 每次重建都重算，平移一下云它就跟着走了；这个只在**锚定那一刻**取一次，之后云怎么
   * 挪都钉着不动——也就是用户眼睛看到的那块灰色平面在哪。
   *
   * 宿主用它当「贴合地面」的基准（见 `SystemManagerComponent.alignCloudTranslation`）：
   * 要贴的是看得见的那块平面，跟着云走的那个数贴上去永远差 0。
   */
  groundPlaneLevel: number | null;
  /**
   * 实际用来建体素的格边长（米）；点渲染时、以及没有点云时为 null。
   *
   * 与 {@link requestedVoxelSize} 不等，说明地图为了守住体素上限把格子自动放大了：
   * 设置面板上写的是要求值，画面上是这一个。宿主拿两者比较，在工具栏上说一句——
   * 不解释的话，面板读数与看到的粗细就是两句互相矛盾的话。
   */
  voxelSize: number | null;
  /** 按设置换算出来的格边长（米），也就是没被放大的那个数；点渲染时为 null。 */
  requestedVoxelSize: number | null;
}

/**
 * 用户拖动整体平移手柄之后，整片云挪了多少（世界坐标，单位同点云）。
 *
 * 是**增量**不是位置：宿主自己累加进它的偏移量里。拖动期间云已经在画面上跟着走
 * 了，宿主拿到这个值只负责把数据改对，不必再做一次视觉位移。
 */
export interface OctoMapCloudTranslation {
  x: number;
  y: number;
  z: number;
}

/**
 * 旋转手柄报出来的**总**旋转：欧拉角，单位度，`'XYZ'` 顺序（与 three.js 的
 * `Euler(..., 'XYZ')` 一致），各分量落在（-180, 180]。
 *
 * 与 {@link OctoMapCloudTranslation} 相反，它是**绝对值**不是增量：手柄转的是一次
 * 整体朝向，「当前转了多少」才是宿主需要记下来的东西（增量得做四元数合成，宿主那边
 * 没有这套数学）。拖动过程中的实时值同样按这个口径报，宿主直接显示即可。
 */
export interface OctoMapCloudRotation {
  x: number;
  y: number;
  z: number;
}

/** 手柄的摆放：抓在世界的哪个点、以什么朝向为起点。 */
export interface OctoMapGizmoPose {
  /**
   * 手柄抓的世界坐标，也是**旋转的支点**。
   *
   * 宿主给的通常不是包围盒中心，而是「云的旋转支点」（见
   * `SystemManagerComponent.gizmoPose`）：云转过之后它的包围盒中心会漂，而支点不会，
   * 松手重建时云是按支点算的——两者不一致的话每转一次画面就跳一下。
   */
  position: [number, number, number];
  /** 云当前的整体旋转（度，`'XYZ'`）。旋转手柄以它为起点，拖动结果是在它之上叠加。 */
  rotation: [number, number, number];
}

/**
 * 手柄的工作方式。
 *
 * - `'off'`：不显示。
 * - `'translate'`：三根箭头 + 平面方块，拖出世界坐标的位移。
 * - `'rotate'`：三个圆环 + 一圈绕视线的，拖出绕世界轴的旋转。
 *
 * 一个手柄同一时刻只能是一种模式（`TransformControls` 的限制），所以这里是单选而不是
 * 两个开关：两个都想要时由宿主决定谁优先。
 */
export type OctoMapGizmoMode = 'off' | 'translate' | 'rotate';

/**
 * 圈出「当前选中的那一份」的轴对齐包围盒（世界坐标）。
 *
 * 场景里拼了多份点云时才有意义：手柄只作用于其中一份，而关掉手柄之后就没有任何
 * 东西提示选的是哪份了，这圈线负责补上。地图不知道「哪份云」，只画一个盒子。
 */
export interface OctoMapSelectionBox {
  min: [number, number, number];
  max: [number, number, number];
}

/**
 * 拖动整体变换手柄时的预览：把合并点云里从 `start` 起的 `count` 个点当成一个刚体，
 * 按 `rotation` / `translation` 再挪一下。
 *
 * 交接的是**增量**而不是一整份预览世界：多份云拼在一个 `InstancedMesh`（或一个
 * `BufferGeometry`）里，重画一次要把所有点重新体素化（几十毫秒），跟着指针走必然卡；
 * 而没选中的那份一个点都没动，本来就不该重画。地图按这个负载只改选中的那部分。
 *
 * 增量由宿主的 `relativeAdjustmentTransform` 从「拖之前」与「拖之后」两份整体变换
 * 算出来——地图不知道旋转角、偏移量这些概念，只知道「这一批实例刚体挪一下」。
 */
export interface OctoMapCloudPreview {
  /** 选中那份在合并点云里的起始点号。 */
  start: number;
  /** 它有多少个点。 */
  count: number;
  /** 行主序 3×3 旋转。 */
  rotation: readonly number[];
  translation: readonly [number, number, number];
  /**
   * 点云模式的兜底：那边没有实例矩阵可挪，只能重画一份世界。体素模式传 null。
   */
  points: OctoMapPointCloud | null;
}

/** (pointClicked) 发出的负载。 */
export interface OctoMapPointClickedDetail {
  /** 射线拾取到的点索引，未命中时为 -1。 */
  index: number;
  /** 射线拾取到的点的世界坐标，未命中时为 null。 */
  point: [number, number, number] | null;
}

/**
 * 指针悬停在云点上时的读数，用于视口右下角的浮框。
 *
 * 点云模式下是那个点自己的坐标；立体格栅模式下是体素中心——格栅画出来的每一个
 * 方块就是一个体素，鼠标指着的其实是整格，报格心才和删除/移动用的是同一个位置。
 */
export interface OctoMapHoverInfo {
  /** 世界坐标。 */
  position: [number, number, number];
  /** 相对扫描出的地板高度（见 `OctoMapGrilleController.groundLevel`）。 */
  height: number;
  /** 立体格栅模式下该体素是否为已刷的禁行障碍；点云模式下无此概念，为 null。 */
  forbidden: boolean | null;
}

/**
 * 已刷（禁行）障碍体素的集合，可序列化，因而能持久化并在网格重建后重新应用。
 * `voxelSize` + `min` 标识这些键所属的网格。
 */
export interface OctoMapPaintedVoxels {
  voxelSize: number;
  min: [number, number, number];
  keys: string[];
}

/** 点云的绘制方式：原始点或实体体素网格。 */
export type OctoMapRenderMode = 'points' | 'voxel';

/**
 * 一次俯视投影的全部输入（`(projectionSource)` 的负载，也是
 * {@link OctoMapComponent.projectionSource} 的答复类型）。
 *
 * 它住在模型的这一边，是因为它是**地图交出去的契约**：组件只负责按当前视图拼出这三样
 * （点、对齐用的包围盒、分辨率），把点压成图的那一步在消费方
 * （`common/utils/projection.util.ts` 的纯函数）。原先它和那些纯函数住在一起，
 * 于是地图反过来依赖 `common/utils`——把类型放回这里，`octo-map/` 才能整目录搬走。
 */
export interface OctoMapProjectionSource {
  /** 交错的 XYZ 坐标。 */
  positions: Float32Array;
  /** 投影网格对齐到它的 min[0] / min[2]，尺寸也由它推出。 */
  bounds: OctoMapBoundingBox;
  /** 分辨率（世界单位），即一格多宽。 */
  resolution: number;
}

/**
 * 「这一笔没刷到点」的读数（`(brushMiss)` 的负载）。
 *
 * 背景：`brushAt` 只能标记**已经占用的体素**，空处没有点可标——所以笔刷从点云上扫出去
 * 之后，那一段是**静默无效**的，而这件事本身很反直觉（用户看到的是「我明明划过去了」）。
 * 所以要把「刷不上」说出来，而说的时候得能报出笔刷多大，用户才知道自己试的是什么。
 *
 * - `radius`：当前笔刷半径（米）；
 * - `voxelSize`：**实际**用的体素边长（米），笔刷半径 ÷ 它就是判定的尺度。自动模式
 *   （输入为 null）下这两个数只有网格自己知道，所以由组件从这里报出来。
 */
export interface OctoMapBrushMissDetail {
  radius: number;
  voxelSize: number;
}

/**
 * 用哪种方式寻路。
 *
 * 每个取值对应 `OctoMapPathPlanner` 的一个子类，两者的**搜索、平滑、起终点吸附完全
 * 共用**，只差「表面图怎么建」这一步。所以切换它换掉的是「小狗走的那张面是什么」，
 * 而不是搜索算法本身。
 *
 * `'surfaceGraph'`：每一列保留它全部的真实竖直占用段；**一个点都没有的列**补一个
 * 常数高度（`groundLevel`）的虚拟地面 run。跨台阶、上桌面靠这一套，
 * {@link OctoMapMapSettings.groundExtendsOutside} 的「封边」那半边也靠它工作——那一项
 * 管的是**开关**，与视觉地面的大小（`groundExtendX` / `groundExtendZ`）是两件事，
 * 详见它的字段说明。
 *
 * 这不是一个纯技术选项：真图上 81% 的列是空的，真实地面那层只占 19%、连不成一张面，
 * 于是唯一连通且零竖直代价的网络就是那层常数平面——小狗实际走在比云点低 0.17 m 的
 * 一层平面上，用户把云点铲平补全，在那层上一点痕迹都不留。
 *
 * `'cloudFit'`：虚拟地面 run **不再用常数**，而是从切比雪夫距离最近的那些有点的列
 * 认领它们的面高（多源 BFS，半径由点云自己的稀疏度推），于是小狗走在**云点那张面**
 * 上——铲平、补全云点会直接改变路线。认领的高度若比同一邻域内最低的真实地板高出一
 * 个量级（门楣、架子、桌面下方的晕圈），就退回 `groundLevel`，见
 * `OctoMapNavSurface` 的 `FILL_MAX_RISE`。
 *
 * 它不是 `'surfaceGraph'` 的升级版，是一个**取舍**：填充只覆盖有点的列半径之内的空列
 * （真图上是空列的 13.7%，R = 2），所以它补的是扫描的缺口，**不是**把整张地板重建出
 * 来。远离任何点的地方仍旧退回常数地面，`groundExtendsOutside` 的语义因此保留。
 */
export type OctoMapPathAlgorithm = 'surfaceGraph' | 'cloudFit';

/**
 * 寻路失败的原因。
 *
 * `gap` 与另外三个的分界值得说清楚：搜不过去，而**缺的就是高度**——终点
 * **站在一个站得住的面上**，那个面与小狗能走到最近处差着一次跨越高度以上。它是
 * `unreachable` 里最可操作的一种——不是「没路」，是「迈不上去」——所以单列出来，
 * 提示里会点名落差并要求调大「跨越高度」。终点压根没落在任何能站的面上（点在墙上、
 * 点在障碍里、点在天花板上）仍然是 `unreachable`：那种情况加高度也说不到点子上。
 *
 * `dogStuck` 是同一个「缺高度」的另一头，**建议却不一样**，所以不并进 `gap`：小狗
 * 自己站的地方整个悬在地面之上（一坨东西的顶上、柜子面），它四周哪个方向下去都超过
 * 跨越高度。这时把「跨越高度」拖大并不一定够（真图上量过：这一档要 0.69~0.77 m
 * 才通，而小狗离地只有 0.50~0.71 m），而**把它挪到地面**上每次都通。所以这个原因
 * 报的是「它在多高的地方下不来」，建议是挪狗，不是拖滑杆。
 *
 * `goalTooHigh` 是第三种「缺高度」，**建议又不一样**，所以也不并进 `gap`：终点
 * **浮在那一列所有面之上**（点在半空里，比如点在一面薄墙、一条窄带的正上方）。
 * 它跟 `gap` 的区别是几何上的、不用猜：`gap` 的终点 Y **落在**某一列某个 run 的
 * `[lo, hi]` 之内（或在其下方），也就是终点**站在一个真面子上**，只是那个面小狗
 * 够不到；`goalTooHigh` 的终点 Y 在**该列最高 run 的顶再加一格容差之上**——那一列
 * 压根没有面接着它。
 *
 * 为什么单独报：这时吸附（`mapPoint` 第 2 段「竖直面上的点落到它脚下的地面」）
 * 会把终点一路拽到地面上，于是路径末端明明在地面、却因为**水平**距离在 `goalRadius`
 * 之内而报成功——真图上量到过一条 7 顶点全在 Y = −6.836、终点在 Y = −1.020 的
 * 「成功」路径，丢了 5.8 m。`findPath` 现在对浮空终点改量**三维**，这一条本来就
 * 拦得住；仍然单独报是为了**说清**：不报的话用户拿到的是一句「末端离终点 5.8 m，
 * 超出终点范围 0.5 m」，照着它去拖「终点范围」滑杆等于把边界扩到 5.8 m——那就不再
 * 是边界了。所以这个原因报的是「你要去的地方离你点的高度差着一次跨越高度以上」，
 * 处置是**挪终点或者先搭出能站的面**，拖「跨越高度」滑杆救不回来——半空里没有面
 * 可以迈。
 */
export type OctoMapPathFailureReason =
  'unreachable' | 'outOfRange' | 'tooLarge' | 'gap' | 'dogStuck' | 'goalTooHigh';

/** 寻路失败时 `(pathFailed)` 发出的负载。 */
export interface OctoMapPathFailedDetail {
  /**
   * `unreachable` = 搜不到；`outOfRange` = 搜到了但末端落在终点范围之外；
   * `tooLarge` = 压根没搜——场景太大，规划网格超过上限（见 `MAX_FREE_CELLS`）；
   * `gap` = 搜不过去，而缺的是高度——终点那个面与小狗能走到的地方差着一个迈不过去的
   * 落差（见 {@link heightGap}）；`dogStuck` = 同一种「缺高度」，但卡住的是**小狗自己**
   * ——它站的地方整片悬在地面之上（见 {@link heightGap}）；`goalTooHigh` = 同一种
   * 「缺高度」，但**终点自己浮在半空**——它比那一列最高的面还高出一个跨越高度以上，
   * 压根没有面接着它（见 {@link heightGap}）。
   *
   * `tooLarge` 单列出来是因为它和另外几个的**处置方式完全不同**：另外几个要么改
   * 参数、要么挪终点，而这个是场景本身超出了能规划的范围，用户既改不动也挪不动，
   * 只能知道「框在哪儿」——所以它对应的提示会指向「显示规划范围」那个开关。
   */
  reason: OctoMapPathFailureReason;
  /**
   * 路径末端到终点的距离（世界单位）；只有 `outOfRange` 时有值，其余为 null。
   *
   * 量的是**三维**距离，还是**只量水平**，取决于终点有没有面接着：终点浮在半空
   * 时量三维（停在正下方不算走到，那正是接受范围是个球的意思）；终点有面接着
   * （点在墙面、桌面、台阶立面上）时只量水平——那时路径末端本来就该落在终点脚下
   * 的那个面上，量三维会一律误判成「差一个立面高度」。判别式与画法都在
   * `OctoMapPathController.goalOnFace`，理由详见 `OctoMapController.findPath`。
   */
  distance: number | null;
  /**
   * 那一次迈不过去的高度（世界单位，取绝对值）；只有 `gap` 和 `dogStuck` 时有值，
   * 其余为 null。两处量的是不同的两头（见 `OctoMapPathController.computePath`），
   * **含义也不一样，别当成同一件事报**：
   *
   * - `gap`：终点那个面到「最近可达处」的高度差。它一定大于跨越高度，而且**照着它
   *   拖滑杆就有用**——缺的正是这一下；
   * - `dogStuck`：小狗**自己离地面多高**。它是「小狗在哪儿」的说明，不是滑杆该拖到
   *   的位置：真图上量过这一档，要 0.69~0.77 m 才走得通，而小狗离地只有 0.50~0.71 m。
   *   所以 `dogStuck` 的提示给的是「把它挪到地面上」，不拿这个数当承诺。
   * - `goalTooHigh`：**吸附替终点丢掉了多少高度**（终点 Y 减它吸附到的那个节点的
   *   `hi`）。它一定大于跨越高度，但**不是**滑杆该拖到的位置：这是「吸附干了什么」的
   *   说明，不是「缺多高」的承诺。真图上量到的那一条是 5.816 m 且落点已经在地面上，
   *   而半空里没有面可迈，滑杆拖多大都还是空。处置是挪终点。
   *
   *   注意它跟 `gap` 的**量法**也不一样：`gap` 量的是两个**面**之间（终点的面与最近
   *   可达的面），`goalTooHigh` 量的是终点与它**落脚的那个面**——因为这里缺的不是
   *   面与面之间的高度，是「吸上去的那一下」本身。
   */
  heightGap: number | null;
}

/** 地图上鼠标交互的解读方式。 */
export type OctoMapInteractionMode =
  'view' | 'brush' | 'erase' | 'placeDog' | 'placeGoal' | 'addPoint' | 'deletePoint' | 'movePoint';

/** 小狗沿计算出的路径行进的各个状态。 */
export type OctoMapWalkState = 'idle' | 'ready' | 'walking' | 'paused';

/** 小狗在路径上的位置快照，变化时发出。 */
export interface OctoMapWalkProgress {
  /** 已行进路径的比例，取值 [0, 1]。 */
  progress: number;
  /** 小狗当前相对路径处于什么状态。 */
  state: OctoMapWalkState;
  /** 朝向是否已被行进锁住；锁住时初始朝向不再生效，直到重新计算路径。 */
  headingLocked: boolean;
}

/**
 * 取值型命令的回填函数：子组件把结果交给它。
 *
 * `@Input()` 上的 `EventEmitter` 只能往下推、传不回值，所以父组件把「拿到结果后
 * 接着做什么」包成这个函数发下去，子组件算完调它。`EventEmitter` 的 `next()` 是
 * 同步的，因此同步命令走这条往返和直接调用没有区别。
 */
export type OctoMapReply<T> = (result: T) => void;

/**
 * 模型加载请求。
 *
 * `reply` 可以不给——不给就是「失败静默」，用于启动时按记住的文件名恢复模型那条
 * 路：文件不在就安静地退回内置几何体，不打扰用户。
 */
export interface OctoMapDogModelRequest {
  /** blob/object URL 或静态资源路径。 */
  url: string;
  /** 收 null（成功）或可显示的失败原因。 */
  reply?: OctoMapReply<string | null>;
}

/**
 * {@link OctoMapComponent} 使用的可调视图参数。
 *
 * 这一份里的每一项都由父组件**逐项**绑到 `app-octo-map` 上
 * （`system-manager.component.html` 那 33 条 `[同名]="settings().同名"`，没有改名、
 * 没有中转），也都写在 `assets/config/octomap.config.json` 里——文件与这份接口逐项
 * 对应，由 `config.service.spec.ts` 守着（多一项少一项都会红）。
 *
 * 不进地图的那十一项（上轴那一组、云点整体变换那一组、说明开关）是**宿主应用自己的
 * 设置**，不在这里——宿主自己决定放哪儿（本 demo 放在
 * `src/app/common/model/demo-settings.model.ts` 的 `DemoTabSettings`）。上轴与整体
 * 变换由页面在加载那一刻读一次（点云转好、挪好才交给地图），说明开关由面板与行进栏读。
 */
export interface OctoMapMapSettings {
  renderMode: OctoMapRenderMode;
  /** 体素棱长，单位：世界单位；null = 自动推导。 */
  voxelSize: number | null;
  /** 点大小，单位：世界单位（点云模式）；null = 自动推导。 */
  pointSize: number | null;
  backgroundColor: string;
  pointColor: string;
  showGrid: boolean;
  /**
   * 是否显示规划网格能覆盖的范围。
   *
   * 画出来的是**规划器能覆盖的范围**，以点云占地为中心、保持长宽比：没超限时它就
   * 是 A* 网格的真实矩形（点云 + 边距），超限时会缩到点云里面去。超限时无论这个
   * 开关怎么设都会画——那时候它就是「路径为什么没有」的唯一解释。
   */
  showNavLimit: boolean;
  /**
   * 是否画出规划出来的路径。
   *
   * 关掉它之后路径管从场景里消失，但**规划结果不丢**：`pathPoints` 还留着，行进照样
   * 能进行，重新打开立刻原样画回来（不需要再点一次「找路径」）。
   *
   * 开关在设置面板「路径」页，和「显示规划范围」「标出路径点」挨着：它是个**显示参数**，
   * 本来就不属于行进栏那串「放狗 → 设终点 → 找路径 → 进行」的操作。跟着那一页进
   * `octomap.path` 缓存（键表见 `settings-tab-cache.service.ts`）。
   */
  showPath: boolean;
  /**
   * 是否把路径的**点**逐颗标出来——每个顶点一颗白珠子，骑在路径管上。
   *
   * 标的是**拉直之后折线的顶点**（`smoothPath` 一跳能吃掉几十个格点，所以它们**不是**
   * 沿途每一格，而是小狗真正要拐弯的那些点），珠子因此数得出「这条路是几个点连的」。
   * 管子是拿这些点做 `CatmullRomCurve3` 画出来的平滑曲线，光看管子分不出点在哪儿。
   *
   * 珠子的大小跟着**尺寸参考**走（碰撞半径、体素下限），与管子、终点锥同一套，所以
   * 拖「碰撞半径」时它实时变。
   *
   * 与 {@link showPath} **各管各的**：那一项只管路径管，关掉它珠子照样在（正好是
   * 「只看拐点、不看那根粗管子」的姿势）。这一项默认关——它是排查用的，不该改默认观感。
   */
  showPathPoints: boolean;
  gridSize: number;
  gridDivisions: number;
  fitView: boolean;
  autoRotate: boolean;
  /** 当前是否显示已刷（障碍）的颜色。 */
  showColoring: boolean;
  /** 已刷禁行区域（障碍）的颜色。 */
  forbiddenColor: string;
  /**
   * 障碍刷的半径，单位：世界单位。
   *
   * 判定是**索引空间**的球体（`r = ceil(半径 / 体素边长)` 格），而它只能标记**已经
   * 占用的体素**——两个后果要一起看：
   *
   * - 半径比要刷的东西还大，就会**连它一起刷掉**。默认 0.5 m 的球能一口吞掉整条
   *   0.4 m 宽的云梯（真图上量到过：两侧各刷一把，带自己那 8 列全被禁，小狗再也爬不
   *   上去）。所以默认值降到 **0.25 m**：细的东西留得下来；
   * - 但降默认值**治不了根**——任何半径都能吞掉更细的东西，反过来在空处刷也永远是
   *   静默无效（那儿没有点可标）。真正的兜底是「刷不到点就提示」，见
   *   `OctoMapBrushMissDetail`。
   */
  brushRadius: number;
  /**
   * 小狗能跨越的最大高度，单位：世界单位。
   *
   * **上爬与下跳都受它限制**，一个数管两个方向：小狗站着的面与它要去的面之间的
   * 高度差超过它，这一步就走不过去。所以桌子比它高就上不去，也就报 `gap`——把
   * 它调大即可，代价是狗会「爬」更陡的斜面。
   */
  maxStepHeight: number;
  /**
   * 「填充基准范围」，单位：**导航格**（1 格 = `NAV_CELL_SIZE` = 0.05 m）；只被
   * `'cloudFit'` 那一档读。
   *
   * `'cloudFit'` 会给每个没有云点的列认领一个面高（取邻居最低那个 run 的 `lo`），而
   * 认领来的高度**不得超过「这一带的本地地面」再加 0.1 m**——这一项就是这个「一带」
   * 有多大。所以它是个**保守度**旋钮：
   *
   * - **调大 = 更保守**：基准邻域更大，认领到的悬空面更容易被判成「比本地地面高太多」
   *   而退回虚拟地面。代价是真正该补的稀疏缺口也可能补不上，小狗走进那片缺口时会
   *   掉到下面那层虚拟地面上（表面图就是那样，只是缺口处多了一段落差）。
   * - **调小 = 更激进**：只信最近的邻居。麻烦就出在这儿——**一道薄片旁边的最近邻就是
   *   薄片自己**（一面墙、一条 0.4 m 宽的斜坡），于是「本地地面」被算成了坡道的高度，
   *   落差恒为 0，守卫必然放行，填充会沿着薄片挤出一条**平行的可行走幽灵坡道**。那
   *   条坡道刷不上障碍（它没有真实体素可标），小狗就顺着它从薄片**外面**爬上去。
   *
   * 默认 8 格（0.4 m）是被量出来的：见 `OctoMapNavSurface` 的 `fillEmptyColumns`。下限
   * 2 格等于「不放大，只用点云稀疏度推出的半径本身」，也就是加上这个设置之前的行为；
   * 上限 12 格是性能护栏（见 `FILL_BASE_CELLS_MAX`）。两个端点之间是单调的：**调大只
   * 会减少填充列，不会新增、也不会改变任何一列的认领高度**。
   *
   * 与 {@link maxStepHeight} 无关：后者是**小狗**能迈多高，这一项是「一处没扫到的地板
   * 算不算跟旁边同一张面」。用小狗的攀爬能力去决定后一个问题，会把两者一起搅乱。
   * 改完要重新点「找路径」才生效（表面图缓存的键里有它）。
   */
  fillBaseCells: number;
  /**
   * 终点的接受范围半径，单位：世界单位。路径末端落在这个半径之外就按「没找到
   * 路径」处理。
   *
   * 需要它是因为终点位置来自射线的**原始命中点**：打在墙面、桌面、天花板上的
   * 都算数，因此可能落在障碍里或悬在半空。规划时终点会被吸附到最近的**站得住
   * 的面**上，搜不过去时还会退而求其次取「可达的最近点」，那个点可能离终点任意远。
   * 没有这个半径，那条根本没走到用户所点位置的路径会被当成成功画出来。
   *
   * 默认值取两倍碰撞半径，不是「半个导航格」——吸附是在**膨胀后**的判定上做的
   * （按 `dogRadius + CELL_SAFETY` 往外扩），终点落进障碍里时要跨过整个膨胀圈才
   * 够到第一个站得住的列，偏出零点几米是常态。阈值卡在半个格子上，会把「终点放在
   * 桌上、桌高在跨越高度之内」这类本来走得通的情形一律判失败。
   *
   * 与 {@link maxStepHeight} 的分工：这个只管**水平**够不够得着，够不着报
   * `outOfRange`；竖直方向的落差归跨越高度管，迈不过去报 `gap`。
   */
  goalRadius: number;
  /**
   * 小狗一步能跨过去的**无支撑水平跨度**上限，单位：世界单位。地上的坑、沟、扫描
   * 缺口都靠它过去；0 = 不跨，只走相邻的格子。
   *
   * 「无支撑」指的是两端之间那一段里什么都没有：规划图上小狗原本必须**踩到**中间
   * 每一列上，比一个跨越高度还深的坑（坑底那一层自己的高度够不着坑沿）中间就没有
   * 落脚点，于是过不去。有了它，小狗可以一步跨到对岸——跨过去的那一段因此是一条
   * 直线，小狗不踩坑底。
   *
   * 量的是两列**格心**之间、除去两端各占的半格之后剩下的那一段，也就是真的没有支撑
   * 的宽度。所以它是**跨越**宽度，不是「小狗能跳多远」：跨过去之后脚下落在哪一层，
   * 仍然由 {@link maxStepHeight} 管。
   *
   * 默认取碰撞半径的一半。给的是「默认」，不是派生：改了碰撞半径，这项不跟着变。
   */
  crossWidth: number;
  /** 小狗的碰撞半径（其足印宽度的一半），单位：世界单位。 */
  dogRadius: number;
  /**
   * 小狗的通行高度：小狗**脚下的那个面**往上这么高的一段里不许有东西，否则这一列
   * 站不住。
   *
   * 量的是离脚下那个面、不是离地面的高度——这是多层规划带来的区别：站在桌面上
   * （桌面比地面高）时，判的是桌面上方那一段，桌腿和地面都不算数。跨越高度以内的
   * 那一截不算阻挡（那是可以迈上去的台阶），所以门槛、路沿、门口的地坎都不会变成墙。
   */
  dogHeight: number;
  /** 是否显示小狗的碰撞体（足迹圆柱，以及贴着它指示正前方的三角形）。 */
  showDogCollision: boolean;
  /** 小狗模型的缩放系数，1 = 原始大小（只影响外观，不改变碰撞范围）。 */
  dogScale: number;
  /**
   * 是否让小狗模型的占地自动对齐碰撞足迹（此时 {@link dogScale} 不生效）。
   * 按等比缩放，高度因此不一定等于通行高度。
   */
  dogFitCollision: boolean;
  /**
   * 外部模型的朝向补偿，单位：度。模型自带的正面相对 +X 偏了多少，就填多少
   * 把它转正——朝向、路径前端和指示三角形都约定以 +X 为正前方。只影响外部
   * 模型，内置几何体本就是 +X 朝前。
   */
  dogModelHeading: number;
  /**
   * 小狗放置、拖拽和停下时的朝向，单位：度。0 = 面向世界 +X，角度绕竖直轴
   * 按右手定则增大（俯视逆时针），即 90° 面向 −Z。开始行进后朝向由路径
   * 决定并被锁住，需重新计算路径才能再调。
   */
  dogHeading: number;
  /** 高于此高度的云点被隐藏（null = 全部显示）。 */
  maxHeight: number | null;
  /** 低于此高度的云点被隐藏（null = 全部显示）。 */
  minHeight: number | null;
  /**
   * 可行进地面是否延伸到点云包围盒之外。
   *
   * 它同时管**两件独立的事**，改的时候要一起想：
   *
   * 1. **视觉**：视口那块灰平面要不要留外圈边距（`groundPlaneRect`）。这是纯粹的
   *    可点击范围——平面没盖到的地方，放狗/刷障碍/设终点的点击会被静默丢掉。
   * 2. **规划**：关掉时把包围盒外那一圈虚拟地面**封住**（`OctoMapNavSurface`
   *    的 `groundExtendsOutside`），小狗就出不了扫描范围。
   *
   * 而边距的**大小**不在这里，是 {@link groundExtendX} / {@link groundExtendZ}，
   * 且只影响第 1 件事——规划网格那一圈是 `navGridSize` 自己按包围盒和碰撞半径
   * 算的，跟这两个数无关。
   */
  groundExtendsOutside: boolean;
  /**
   * 地面平面沿世界 X 轴向包围盒外延展的长度（**单边**，世界单位）。
   *
   * 只在 `groundExtendsOutside` 为 true 时生效。它只改那块灰平面的大小（即可点击
   * 范围），**不改小狗能走到哪儿**：把狗放到延展出来、但规划网格没覆盖的地方，
   * 仍然会报「找不到路径」。
   */
  groundExtendX: number;
  /** 地面平面沿世界 Z 轴向包围盒外延展的宽度（单边，世界单位）。见 {@link groundExtendX}。 */
  groundExtendZ: number;
  /**
   * 用哪种方式寻路（见 {@link OctoMapPathAlgorithm}）。
   *
   * 与这个接口里别的项不同，它**不属于小狗的形状**，所以不进任何一组设置缓存
   * （分组表见 `settings-tab-cache.service.ts`）——换一种走法不改小狗的尺寸，没有
   * 理由让缓存失效。开关也因此留在行进栏，设置面板「路径」页里没有它。
   */
  pathAlgorithm: OctoMapPathAlgorithm;
}

/**
 * `assets/config/octomap.config.json` 里必须出现的键，也就是
 * {@link OctoMapMapSettings} 的全部。
 *
 * 类型写成 `(keyof OctoMapMapSettings)[]` 是为了抓错别字：写一个不存在的键名直接是
 * 编译错。另一头（漏项、以及「文件里真写了这些键没有」）编译期看不见，由
 * `config.service.spec.ts` 拿真实的 JSON 对账。
 */
export const MAP_CONFIG_KEYS: readonly (keyof OctoMapMapSettings)[] = [
  'renderMode',
  'voxelSize',
  'pointSize',
  'backgroundColor',
  'pointColor',
  'showGrid',
  'showNavLimit',
  'showPath',
  'showPathPoints',
  'gridSize',
  'gridDivisions',
  'fitView',
  'autoRotate',
  'showColoring',
  'forbiddenColor',
  'brushRadius',
  'maxStepHeight',
  'fillBaseCells',
  'goalRadius',
  'crossWidth',
  'dogRadius',
  'dogHeight',
  'showDogCollision',
  'dogScale',
  'dogFitCollision',
  'dogModelHeading',
  'dogHeading',
  'maxHeight',
  'minHeight',
  'groundExtendsOutside',
  'groundExtendX',
  'groundExtendZ',
  'pathAlgorithm',
];

/**
 * 配置文件未提供取值时使用的设置。
 *
 * 这里用 `satisfies` 而非类型标注，因此各值保留字面量类型，可读回为具体默认值
 * （例如 `voxelSize` 是 `number`，而不是 `number | null`）。
 */
export const DEFAULT_OCTO_MAP_SETTINGS = {
  renderMode: 'voxel',
  voxelSize: 0.05,
  pointSize: null,
  backgroundColor: '#0b1016',
  pointColor: '#4fc3f7',
  showGrid: true,
  showNavLimit: true,
  showPath: true,
  showPathPoints: false,
  gridSize: 10,
  gridDivisions: 10,
  fitView: true,
  autoRotate: false,
  showColoring: true,
  forbiddenColor: '#ef4444',
  brushRadius: 0.25,
  maxStepHeight: 0.5,
  crossWidth: 0.125,
  fillBaseCells: 8,
  goalRadius: 0.5,
  dogRadius: 0.25,
  dogHeight: 0.8,
  showDogCollision: true,
  dogScale: 1,
  dogFitCollision: false,
  dogModelHeading: 0,
  dogHeading: 0,
  maxHeight: null,
  minHeight: null,
  groundExtendsOutside: true,
  // 0.9 这个取值不是随手定的：改动前边距是 `max(sizeX, sizeZ) * 0.06`，两者相等
  // 的交叉点正好在 15 m，而这张真图最大边是 15.25 m——新旧差 1.5 cm，等于无感。
  // 比 15 m 小的场景平面会变大（丢点击变少），比它大的会变小。
  groundExtendX: 0.9,
  groundExtendZ: 0.9,
  pathAlgorithm: 'surfaceGraph',
} satisfies OctoMapMapSettings;
