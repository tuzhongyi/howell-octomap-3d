import * as i0 from '@angular/core';
import { AfterViewInit, OnChanges, OnDestroy, EventEmitter, SimpleChanges } from '@angular/core';

/**
 * PCD 解析器与 Octomap3dPcdComponent 之间共享的数据契约。
 */
/** 由 {@link Octomap3dPcdComponent} 渲染的三维点云。 */
interface OctoMapPointCloud {
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
interface OctoMapBoundingBox {
    min: [number, number, number];
    max: [number, number, number];
    center: [number, number, number];
    size: [number, number, number];
    radius: number;
}
/** (mapReady) 发出的负载。 */
interface OctoMapReadyDetail {
    width: number;
    height: number;
    pointCount: number;
    boundingBox: OctoMapBoundingBox | null;
}
/** (pointsChanged) 发出的负载。 */
interface OctoMapPointsChangedDetail {
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
interface OctoMapCloudTranslation {
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
interface OctoMapCloudRotation {
    x: number;
    y: number;
    z: number;
}
/** 手柄的摆放：抓在世界的哪个点、以什么朝向为起点。 */
interface OctoMapGizmoPose {
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
type OctoMapGizmoMode = 'off' | 'translate' | 'rotate';
/**
 * 圈出「当前选中的那一份」的轴对齐包围盒（世界坐标）。
 *
 * 场景里拼了多份点云时才有意义：手柄只作用于其中一份，而关掉手柄之后就没有任何
 * 东西提示选的是哪份了，这圈线负责补上。地图不知道「哪份云」，只画一个盒子。
 */
interface OctoMapSelectionBox {
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
interface OctoMapCloudPreview {
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
interface OctoMapPointClickedDetail {
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
interface OctoMapHoverInfo {
    /** 世界坐标。 */
    position: [number, number, number];
    /** 相对扫描出的地板高度（见 `Octomap3dPcdGrille.groundLevel`）。 */
    height: number;
    /** 立体格栅模式下该体素是否为已刷的禁行障碍；点云模式下无此概念，为 null。 */
    forbidden: boolean | null;
}
/**
 * 已刷（禁行）障碍体素的集合，可序列化，因而能持久化并在网格重建后重新应用。
 * `voxelSize` + `min` 标识这些键所属的网格。
 */
interface OctoMapPaintedVoxels {
    voxelSize: number;
    min: [number, number, number];
    keys: string[];
}
/** 点云的绘制方式：原始点或实体体素网格。 */
type OctoMapRenderMode = 'points' | 'voxel';
/**
 * 一次俯视投影的全部输入（`(projectionSource)` 的负载，也是
 * {@link Octomap3dPcdComponent.projectionSource} 的答复类型）。
 *
 * 它住在模型的这一边，是因为它是**地图交出去的契约**：组件只负责按当前视图拼出这三样
 * （点、对齐用的包围盒、分辨率），把点压成图的那一步在消费方
 * （`common/utils/projection.util.ts` 的纯函数）。原先它和那些纯函数住在一起，
 * 于是地图反过来依赖 `common/utils`——把类型放回这里，`octomap-3d-pcd/` 才能整目录搬走。
 */
interface OctoMapProjectionSource {
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
interface OctoMapBrushMissDetail {
    radius: number;
    voxelSize: number;
}
/**
 * 用哪种方式寻路。
 *
 * 每个取值对应 `Octomap3dPcdPathPlanner` 的一个子类，两者的**搜索、平滑、起终点吸附完全
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
 * `Octomap3dPcdNavSurface` 的 `FILL_MAX_RISE`。
 *
 * 它不是 `'surfaceGraph'` 的升级版，是一个**取舍**：填充只覆盖有点的列半径之内的空列
 * （真图上是空列的 13.7%，R = 2），所以它补的是扫描的缺口，**不是**把整张地板重建出
 * 来。远离任何点的地方仍旧退回常数地面，`groundExtendsOutside` 的语义因此保留。
 */
type OctoMapPathAlgorithm = 'surfaceGraph' | 'cloudFit';
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
type OctoMapPathFailureReason = 'unreachable' | 'outOfRange' | 'tooLarge' | 'gap' | 'dogStuck' | 'goalTooHigh';
/** 寻路失败时 `(pathFailed)` 发出的负载。 */
interface OctoMapPathFailedDetail {
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
     * `Octomap3dPcdPath.goalOnFace`，理由详见 `Octomap3dPcd.findPath`。
     */
    distance: number | null;
    /**
     * 那一次迈不过去的高度（世界单位，取绝对值）；只有 `gap` 和 `dogStuck` 时有值，
     * 其余为 null。两处量的是不同的两头（见 `Octomap3dPcdPath.computePath`），
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
type OctoMapInteractionMode = 'view' | 'brush' | 'erase' | 'placeDog' | 'placeGoal' | 'addPoint' | 'deletePoint' | 'movePoint';
/** 小狗沿计算出的路径行进的各个状态。 */
type OctoMapWalkState = 'idle' | 'ready' | 'walking' | 'paused';
/** 小狗在路径上的位置快照，变化时发出。 */
interface OctoMapWalkProgress {
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
type OctoMapReply<T> = (result: T) => void;
/**
 * 模型加载请求。
 *
 * `reply` 可以不给——不给就是「失败静默」，用于启动时按记住的文件名恢复模型那条
 * 路：文件不在就安静地退回内置几何体，不打扰用户。
 */
interface OctoMapDogModelRequest {
    /** blob/object URL 或静态资源路径。 */
    url: string;
    /** 收 null（成功）或可显示的失败原因。 */
    reply?: OctoMapReply<string | null>;
}
/**
 * {@link Octomap3dPcdComponent} 使用的可调视图参数。
 *
 * 这一份里的每一项都由父组件**逐项**绑到 `howell-octomap-3d-pcd` 上
 * （`system-manager.component.html` 那 33 条 `[同名]="settings().同名"`，没有改名、
 * 没有中转），也都写在 `assets/config/octomap.config.json` 里——文件与这份接口逐项
 * 对应，由 `config.service.spec.ts` 守着（多一项少一项都会红）。
 *
 * 不进地图的那十一项（上轴那一组、云点整体变换那一组、说明开关）是**宿主应用自己的
 * 设置**，不在这里——宿主自己决定放哪儿（本 demo 放在
 * `src/app/common/model/demo-settings.model.ts` 的 `DemoTabSettings`）。上轴与整体
 * 变换由页面在加载那一刻读一次（点云转好、挪好才交给地图），说明开关由面板与行进栏读。
 */
interface OctoMapMapSettings {
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
     * 默认 8 格（0.4 m）是被量出来的：见 `Octomap3dPcdNavSurface` 的 `fillEmptyColumns`。下限
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
     * 2. **规划**：关掉时把包围盒外那一圈虚拟地面**封住**（`Octomap3dPcdNavSurface`
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
declare const MAP_CONFIG_KEYS: readonly (keyof OctoMapMapSettings)[];
/**
 * 配置文件未提供取值时使用的设置。
 *
 * 这里用 `satisfies` 而非类型标注，因此各值保留字面量类型，可读回为具体默认值
 * （例如 `voxelSize` 是 `number`，而不是 `number | null`）。
 */
declare const DEFAULT_OCTO_MAP_SETTINGS: {
    renderMode: "voxel";
    voxelSize: number;
    pointSize: null;
    backgroundColor: string;
    pointColor: string;
    showGrid: true;
    showNavLimit: true;
    showPath: true;
    showPathPoints: false;
    gridSize: number;
    gridDivisions: number;
    fitView: true;
    autoRotate: false;
    showColoring: true;
    forbiddenColor: string;
    brushRadius: number;
    maxStepHeight: number;
    crossWidth: number;
    fillBaseCells: number;
    goalRadius: number;
    dogRadius: number;
    dogHeight: number;
    showDogCollision: true;
    dogScale: number;
    dogFitCollision: false;
    dogModelHeading: number;
    dogHeading: number;
    maxHeight: null;
    minHeight: null;
    groundExtendsOutside: true;
    groundExtendX: number;
    groundExtendZ: number;
    pathAlgorithm: "surfaceGraph";
};

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
declare class Octomap3dPcdComponent implements AfterViewInit, OnChanges, OnDestroy {
    private readonly viewportRef;
    /** 要渲染的点云。传 null 清空视口。 */
    points: OctoMapPointCloud | null;
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
    preview: OctoMapCloudPreview | null;
    /**
     * 手柄的工作方式：`'off'` 不显示，`'translate'` 拖位移，`'rotate'` 拖旋转。
     *
     * 手柄是**另一个入口**，不改变 `points` 本身：拖动过程中只做画面预览，松手时
     * 通过 {@link cloudTranslated} / {@link cloudRotated} 把结果交给宿主；宿主改完
     * 数据、换一份新的 `points` 进来，画面才落到真实的坐标上。所以这个开关必须有人
     * 接那两个输出，否则云会「拖得动、松手弹回去」。
     */
    gizmoMode: OctoMapGizmoMode;
    /**
     * 手柄摆在哪：位置 + 云当前的整体朝向。null 时退回到包围盒中心、朝向恒等。
     *
     * 位置由宿主给（不是地图自己算包围盒中心）：云转过之后包围盒中心会漂，而宿主
     * 记账用的支点不会——两边不一致的话每转一次松手画面就跳一下。见
     * {@link OctoMapGizmoPose}。
     */
    gizmoPose: OctoMapGizmoPose | null;
    /**
     * 圈出当前选中的那一份点云（世界包围盒）；null 表示不画。
     *
     * 只在场景里拼了多份云、且手柄打开时才有意义——手柄只动其中一份，看框才知道
     * 动的是哪份。手柄收起来时宿主会传 null（选中本身还在，只是没东西可操作），
     * 地图跟着不画。地图不知道那是什么，只管画一个盒子。
     */
    selectionBox: OctoMapSelectionBox | null;
    /**
     * 拖手柄时要不要让渲染出来的云跟着动（预览）。
     *
     * 单份点云时当然要——那是「看得见的拖动」。多份点云拼在一个渲染对象里时，
     * 预览动的是**整片**：别的云会一起被拖走，松手又弹回去，看着像全部选中了。
     * 那种场合宿主关掉它，只让手柄和读数跟着手指走。
     */
    gizmoPreview: boolean;
    /**
     * `points` 换新时要不要把相机重新对到云上。
     *
     * 换文件时要；对**同一份云**做整体变换（旋转、平移、改角度）时不要——相机是用
     * 户自己调好的，每改一次就跳回默认机位会很烦。宿主知道这次是哪一种。
     */
    fitOnPointsChange: boolean;
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
    refitReferenceOnPointsChange: boolean;
    /**
     * 手柄左上角那段只读读数（宿主格式化好的文本，可以有换行）。null 时不显示。
     *
     * 内容是宿主的事：地图不知道「偏移了多少」「转了多少度」这种语义，它只知道云被
     * 动过（见 {@link cloudTranslating} / {@link cloudTranslated} /
     * {@link cloudRotating} / {@link cloudRotated}）。
     */
    gizmoReadout: string | null;
    /** 点云的绘制方式：原始点云或立体格栅。 */
    renderMode: OctoMapRenderMode;
    /** 体素边长（世界单位）。为 null 时由包围盒推导。 */
    voxelSize: number | null;
    /** 视口的背景/清屏颜色。 */
    backgroundColor: string;
    /** 点云没有逐点颜色时使用的兜底颜色。 */
    pointColor: string;
    /** 点大小（世界单位，仅点云模式）。为 null 时自动推导。 */
    pointSize: number | null;
    /** 是否显示参考网格。 */
    showGrid: boolean;
    /**
     * 是否显示规划网格能覆盖的范围。场景超限时无视它，强制显示。
     *
     * 显式标注 `boolean`：`DEFAULT_OCTO_MAP_SETTINGS` 是用 `satisfies` 收尾的，各值
     * 都保留字面量类型，所以 `= DEFAULT_OCTO_MAP_SETTINGS.showNavLimit` 会被推成
     * `true`，父组件绑 `false` 就编译不过。
     */
    showNavLimit: boolean;
    /**
     * 是否画出规划出来的路径。关掉只是隐藏，规划结果和行进都不受影响。
     *
     * 同样必须显式标注 `boolean`（与 {@link showNavLimit} 同一个坑，见
     * [[default-settings-literal-type]]）。
     */
    showPath: boolean;
    /**
     * 是否把路径的每个顶点标成一颗珠子。与 {@link showPath} 各管各的：那一项只管管子。
     *
     * 同样必须显式标注 `boolean`（与 {@link showNavLimit} 同一个坑，见
     * [[default-settings-literal-type]]）——这里的默认值恰好是 `false`，不标注就再也
     * 写不进 `true`。
     */
    showPathPoints: boolean;
    /** 参考网格的大小（世界单位）。 */
    gridSize: number;
    /** 每个网格单元的细分数。 */
    gridDivisions: number;
    /** 点云变化时自动让相机适配点云。 */
    fitView: boolean;
    /** 让相机绕场景缓慢旋转。 */
    autoRotate: boolean;
    /** 当前是否显示已刷（障碍）颜色。 */
    showColoring: boolean;
    /** 禁行区域（已刷障碍）的颜色。 */
    forbiddenColor: string;
    /** 已持久化的已刷障碍，在（重新）构建后重新应用。 */
    painted: OctoMapPaintedVoxels | null;
    /** 鼠标交互在地图上的解释方式。 */
    interactionMode: OctoMapInteractionMode;
    /**
     * 障碍刷的半径（世界单位）。默认值与 {@link DEFAULT_OCTO_MAP_SETTINGS} 一致，不抄
     * 字面量：首次绑定会被 `ngOnChanges` 跳过（见记忆 `ngOnChanges-skips-first-binding`），
     * 所以这里的初值必须就是那个默认值。**显式标注 `number`** 则是因为默认设置用
     * `satisfies` 收尾、各值保留字面量类型（见记忆 `default-settings-literal-type`）。
     */
    brushRadius: number;
    /** 小狗能迈过/爬过的最大高度（世界单位）。 */
    maxStepHeight: number;
    /**
     * 小狗一步能跨过的无支撑水平跨度上限（世界单位），0 = 不跨。地上的小坑靠它过去。
     */
    crossWidth: number;
    /**
     * 「填充基准范围」（单位：导航格），只影响「贴云点面」那一档，见
     * {@link OctoMapMapSettings.fillBaseCells}。
     *
     * 显式标注 `number` 是因为 `DEFAULT_OCTO_MAP_SETTINGS` 用 `satisfies` 收尾、各值
     * 保留字面量类型，不标注就会被推成 `8`。
     */
    fillBaseCells: number;
    /**
     * 终点的接受范围半径（世界单位）。路径末端落在这个半径之外就按「没找到路径」
     * 处理，并发出 `(pathFailed)`；终点周围画一圈同样大小的圆环标出这条边界。
     */
    goalRadius: number;
    /** 小狗的碰撞半径（足迹宽度的一半，世界单位）。 */
    dogRadius: number;
    /** 小狗的净空高度（世界单位）。 */
    dogHeight: number;
    /** 是否显示小狗的碰撞足迹圆。 */
    showDogCollision: boolean;
    /** 小狗模型的缩放系数（1 = 原始大小）。 */
    dogScale: number;
    /** 是否让小狗模型自动缩放到与碰撞足迹同宽（此时 dogScale 不生效）。 */
    dogFitCollision: boolean;
    /** 外部模型的朝向补偿，单位：度（模型正面相对 +X 偏了多少）。 */
    dogModelHeading: number;
    /** 小狗放置、拖拽和停下时的朝向，单位：度（0 = 面向世界 +X）。 */
    dogHeading: number;
    /** 高于此高度的点云点被隐藏（null=全部显示）。 */
    maxHeight: number | null;
    /** 低于此高度的点云点被隐藏（null=全部显示）。 */
    minHeight: number | null;
    /** 可行走地面是否延伸到点云包围盒之外。 */
    groundExtendsOutside: boolean;
    /**
     * 地面平面沿 X 轴向包围盒外延展的长度（单边，世界单位）。
     *
     * 显式标注 `: number`：`DEFAULT_OCTO_MAP_SETTINGS` 用 `satisfies` 收尾、各值保留
     * 字面量类型，抄初值会被推成 `0.9`，父组件传别的数就编译不过（与
     * {@link pathAlgorithm} 同一个坑，见 [[default-settings-literal-type]]）。
     */
    groundExtendX: number;
    /** 地面平面沿 Z 轴向包围盒外延展的宽度（单边，世界单位）。 */
    groundExtendZ: number;
    /**
     * 用哪种方式寻路，见 {@link OctoMapPathAlgorithm}。
     *
     * 显式标注 `OctoMapPathAlgorithm`：`DEFAULT_OCTO_MAP_SETTINGS` 用 `satisfies` 收尾，
     * 各值保留字面量类型，抄初值会被推成 `'surfaceGraph'`，父组件换一种就编译不过
     * （与 {@link showNavLimit} 同一个坑，见 [[default-settings-literal-type]]）。
     */
    pathAlgorithm: OctoMapPathAlgorithm;
    /** 点击时射线拾取的点数上限（点云模式的安全保护）。 */
    maxPickingPoints: number;
    /** 从小狗到终点运行 A* 并绘制路径（不行走）。 */
    findPath: EventEmitter<void>;
    /** 让小狗沿当前路径开始行进。 */
    startWalk: EventEmitter<void>;
    /** 跳到路径上的某个位置（[0, 1]）。 */
    seekWalk: EventEmitter<number>;
    /** 暂停行进。 */
    pauseWalk: EventEmitter<void>;
    /** 从暂停处继续行进。 */
    resumeWalk: EventEmitter<void>;
    /** 移除小狗、终点和路径，便于用户从头重新部署。 */
    clearDeployment: EventEmitter<void>;
    /** 把当前几何中所有被判定为障碍的体素都标记为禁行。 */
    markAllObstacles: EventEmitter<void>;
    /** 清空已刷（禁行）障碍。 */
    clearObstacles: EventEmitter<void>;
    /** 清掉外部模型，恢复内置几何体小狗。 */
    clearDogModel: EventEmitter<void>;
    /**
     * 用外部模型文件替换小狗的内置几何体。`url` 可以是 blob/object URL 或静态
     * 资源路径。不传 `reply` 时失败静默。
     */
    loadDogModel: EventEmitter<OctoMapDogModelRequest>;
    /** 取回用于导出的编辑后点云（每体素一个点，或原始点）。 */
    exportPointCloud: EventEmitter<OctoMapReply<OctoMapPointCloud | null>>;
    /** 取回重采样到体素点阵上的点云（非体素模式为 null）。 */
    regularizeCloud: EventEmitter<OctoMapReply<OctoMapPointCloud | null>>;
    /**
     * 取回当前俯视投影的全部输入（点位置、对齐包围盒、分辨率）。
     *
     * 给的是**输入**而不是算好的图：算图的那一步在 `projection.util.ts` 的纯函数里，
     * 调用方（投影弹窗）自己决定要占用图还是高度图。没有可投影的云点时回填 null。
     */
    projectionSource: EventEmitter<OctoMapReply<OctoMapProjectionSource | null>>;
    /** WebGL 场景和控制器创建完成后发出一次。 */
    readonly mapReady: EventEmitter<OctoMapReadyDetail>;
    /** 渲染的点云变化时发出。 */
    readonly pointsChanged: EventEmitter<OctoMapPointsChangedDetail>;
    /**
     * 用户拖动平移手柄松手时发出：整片云这一下挪了多少（增量，世界坐标）。
     *
     * 只有拖动**结束时**发一次——过程中地图自己做了视觉预览，没必要让宿主每帧
     * 重建上百万个点。
     */
    readonly cloudTranslated: EventEmitter<OctoMapCloudTranslation>;
    /**
     * 拖动平移手柄**过程中**发出：从按下那一刻算起挪了多少（相对量，世界坐标）。
     *
     * 给 {@link gizmoReadout} 那种「边拖边报数」的显示用；判据、松手后的落账
     * 一律走 {@link cloudTranslated}。一次拖动会发很多次（跟着指针走），接的人自己
     * 掂量要不要每帧都画。
     */
    readonly cloudTranslating: EventEmitter<OctoMapCloudTranslation>;
    /**
     * 用户拖动旋转手柄松手时发出：云现在的整体朝向（**绝对值**，度，`'XYZ'`）。
     *
     * 与 {@link cloudTranslated} 相反，它不是增量：手柄拖出来的就是「转到哪儿」，
     * 宿主直接写进设置即可（增量要做四元数合成，那是地图这边的事）。
     */
    readonly cloudRotated: EventEmitter<OctoMapCloudRotation>;
    /**
     * 拖动旋转手柄**过程中**发出：叠加之后的总朝向（绝对值，度，`'XYZ'`）。
     *
     * 口径同 {@link cloudTranslating}：只给读数用，落账一律走 {@link cloudRotated}。
     */
    readonly cloudRotating: EventEmitter<OctoMapCloudRotation>;
    /** 用户点击点/体素（射线拾取）时发出。 */
    readonly pointClicked: EventEmitter<OctoMapPointClickedDetail>;
    /** 导航路径变化时发出（点数，清空时为 null）。 */
    readonly pathChanged: EventEmitter<number | null>;
    /**
     * 寻路失败时发出，带上原因。比 `pathChanged` 的 0 更具体——父组件据此能区分
     * 「搜不到路」和「搜到了但没走到用户点的位置」。
     */
    readonly pathFailed: EventEmitter<OctoMapPathFailedDetail>;
    /** 小狗在路径上的位置（及其状态）变化时发出。 */
    readonly walkProgress: EventEmitter<OctoMapWalkProgress>;
    /** 小狗被放置（或移动）到地面时发出。 */
    readonly dogPlaced: EventEmitter<void>;
    /** 终点被放置（或移动）到地面时发出。 */
    readonly goalPlaced: EventEmitter<void>;
    /** 已刷（禁行）障碍集合变化时发出。 */
    readonly paintedChanged: EventEmitter<OctoMapPaintedVoxels>;
    /**
     * 刷障碍时这一笔**没刷到任何点**时发出：笔刷在拖拽中扫出了点云（或当前是「点云」
     * 显示模式，压根没有体素可刷）。判据与其余三个前置条件见 `reportBrushMiss`。
     *
     * 一次按下到抬起之间**最多一次**（见 `brushMissed`）；「空处按下」不发——那是要转
     * 相机；擦除不发——在没有障碍的地方擦是常事。父组件拿它给用户一句话
     * （见 `OctoMapBrushMissDetail`）。
     */
    readonly brushMiss: EventEmitter<OctoMapBrushMissDetail>;
    /** 用户右键退出编辑器模式（回到视图模式）时发出。 */
    readonly interactionModeChange: EventEmitter<OctoMapInteractionMode>;
    /** 发生渲染/几何错误时发出。 */
    readonly error: EventEmitter<Error>;
    /**
     * 指针下那个云点的读数，显示在视口右下角；没指着东西时为 null。
     *
     * 用信号而不是普通字段：探测发生在 requestAnimationFrame 里，信号能自己把 OnPush
     * 的这一帧标脏，不必再去碰变更检测。
     */
    protected readonly hover: i0.WritableSignal<OctoMapHoverInfo | null>;
    private readonly controller;
    private readonly subscriptions;
    /** 已排队的悬停探测帧；0 = 没有排队。 */
    private hoverFrame;
    /** 最近一次 pointermove 事件，供每帧那一次探测取用。 */
    private hoverEvent;
    private resizeObserver;
    private viewInitialized;
    private dragStartX;
    private dragStartY;
    private brushing;
    /**
     * 这一笔（一次按下到抬起之间）已经因为「刷不到点」提示过了吗。
     *
     * 一次拖拽会按 pointermove 的频率刷几十下，不记这个就会刷屏。**在按下那一支清零**，
     * 所以「一笔一次」的口径是按下到抬起：下一次按下又能提示一次。`pointerup` 不必清
     * ——`pointerup` 到下一次 `pointerdown` 之间根本不会走到刷笔那条路（`brushing` 已置 false）。
     */
    private brushMissed;
    private draggingDog;
    /** 这一次按下落在平移手柄上：随后的 `click` 不该再去拾取/取消选中。 */
    private gizmoPressed;
    /** 右键按下的位置，用于区分取消点击与平移。 */
    private rightDownX;
    private rightDownY;
    /** 右键按下且移动超过拖拽阈值时为 true。 */
    private rightDragged;
    /** “移动”编辑器抓住的体素，等待放置点击。 */
    private moveSourceKey;
    private readonly onPointerDown;
    private readonly onPointerMove;
    private readonly onPointerLeave;
    /**
     * 排一次悬停探测（每帧最多一次）。
     *
     * 跟着 pointermove 直接拾取会把帧率拖垮：点云模式下一次射线拾取要遍历上百万个
     * 点（见 `Octomap3dPcdGrille.probe`），而 pointermove 一帧能来十几个。攒到
     * 下一帧统一算，鼠标划得再快也只算一遍。
     */
    private scheduleHover;
    /** 收起读数浮框，并丢掉还没算的那一帧。 */
    private clearHover;
    private readonly onPointerUp;
    private readonly onContextMenu;
    /** 退出添加/删除/移动编辑器模式，让地图回到普通视图。 */
    private cancelEditorMode;
    private readonly onClick;
    private readonly onDblClick;
    ngAfterViewInit(): void;
    ngOnChanges(changes: SimpleChanges): void;
    ngOnDestroy(): void;
    /** 让相机重新适配当前点云（公共 API）。 */
    resetCamera(): void;
    /**
     * 手柄只在「有云」且宿主选了模式时露出来。
     *
     * 不跟 `interactionMode` 绑：那是宿主的一个显式开关，打开就该看得见。手柄自己
     * 的按下不会漏给刷笔/拖狗（见 `onPointerDown`），所以和工具模式并存是安全的。
     *
     * 位姿每次都跟着设一遍（而不是只判 `gizmoPose` 变化）：`rebuild` 会按包围盒把
     * 锚点摆一次，宿主给了位姿时得以它为准。
     */
    private syncGizmo;
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
    private connectCommands;
    /**
     * 用外部模型文件替换小狗的内置几何体。`url` 可以是 blob/object URL 或静态
     * 资源路径。返回 null 表示成功，否则是可显示的失败原因。
     */
    private applyDogModel;
    private brushAtPointer;
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
    private reportBrushMiss;
    private placeOnGround;
    /** 下一个添加/移动的体素将落在哪：点击面的邻居，否则为地面。 */
    private resolvePlacementTarget;
    /** 编辑器模式激活时刷新悬停预览/着色。 */
    private updateEditorHover;
    private addPointAt;
    private deletePointAt;
    private movePointAt;
    private refreshColoring;
    private renderOptions;
    /**
     * 把三个输入拼成地面延展设置。
     *
     * **每次现场拼、不缓存成字段**：配置文件是异步读的（`SystemManagerComponent`
     * 的 `restoreSettings` 要 fetch），它会在这之后才写回设置。缓存一份的话，
     * `ngOnChanges` 里各处引用的就是旧值，改配置后第一次画出来的平面会是错的。
     * 与 {@link renderOptions} 同一个路数。
     */
    private groundExtent;
    static ɵfac: i0.ɵɵFactoryDeclaration<Octomap3dPcdComponent, never>;
    static ɵcmp: i0.ɵɵComponentDeclaration<Octomap3dPcdComponent, "howell-octomap-3d-pcd", never, { "points": { "alias": "points"; "required": false; }; "preview": { "alias": "preview"; "required": false; }; "gizmoMode": { "alias": "gizmoMode"; "required": false; }; "gizmoPose": { "alias": "gizmoPose"; "required": false; }; "selectionBox": { "alias": "selectionBox"; "required": false; }; "gizmoPreview": { "alias": "gizmoPreview"; "required": false; }; "fitOnPointsChange": { "alias": "fitOnPointsChange"; "required": false; }; "refitReferenceOnPointsChange": { "alias": "refitReferenceOnPointsChange"; "required": false; }; "gizmoReadout": { "alias": "gizmoReadout"; "required": false; }; "renderMode": { "alias": "renderMode"; "required": false; }; "voxelSize": { "alias": "voxelSize"; "required": false; }; "backgroundColor": { "alias": "backgroundColor"; "required": false; }; "pointColor": { "alias": "pointColor"; "required": false; }; "pointSize": { "alias": "pointSize"; "required": false; }; "showGrid": { "alias": "showGrid"; "required": false; }; "showNavLimit": { "alias": "showNavLimit"; "required": false; }; "showPath": { "alias": "showPath"; "required": false; }; "showPathPoints": { "alias": "showPathPoints"; "required": false; }; "gridSize": { "alias": "gridSize"; "required": false; }; "gridDivisions": { "alias": "gridDivisions"; "required": false; }; "fitView": { "alias": "fitView"; "required": false; }; "autoRotate": { "alias": "autoRotate"; "required": false; }; "showColoring": { "alias": "showColoring"; "required": false; }; "forbiddenColor": { "alias": "forbiddenColor"; "required": false; }; "painted": { "alias": "painted"; "required": false; }; "interactionMode": { "alias": "interactionMode"; "required": false; }; "brushRadius": { "alias": "brushRadius"; "required": false; }; "maxStepHeight": { "alias": "maxStepHeight"; "required": false; }; "crossWidth": { "alias": "crossWidth"; "required": false; }; "fillBaseCells": { "alias": "fillBaseCells"; "required": false; }; "goalRadius": { "alias": "goalRadius"; "required": false; }; "dogRadius": { "alias": "dogRadius"; "required": false; }; "dogHeight": { "alias": "dogHeight"; "required": false; }; "showDogCollision": { "alias": "showDogCollision"; "required": false; }; "dogScale": { "alias": "dogScale"; "required": false; }; "dogFitCollision": { "alias": "dogFitCollision"; "required": false; }; "dogModelHeading": { "alias": "dogModelHeading"; "required": false; }; "dogHeading": { "alias": "dogHeading"; "required": false; }; "maxHeight": { "alias": "maxHeight"; "required": false; }; "minHeight": { "alias": "minHeight"; "required": false; }; "groundExtendsOutside": { "alias": "groundExtendsOutside"; "required": false; }; "groundExtendX": { "alias": "groundExtendX"; "required": false; }; "groundExtendZ": { "alias": "groundExtendZ"; "required": false; }; "pathAlgorithm": { "alias": "pathAlgorithm"; "required": false; }; "maxPickingPoints": { "alias": "maxPickingPoints"; "required": false; }; "findPath": { "alias": "findPath"; "required": false; }; "startWalk": { "alias": "startWalk"; "required": false; }; "seekWalk": { "alias": "seekWalk"; "required": false; }; "pauseWalk": { "alias": "pauseWalk"; "required": false; }; "resumeWalk": { "alias": "resumeWalk"; "required": false; }; "clearDeployment": { "alias": "clearDeployment"; "required": false; }; "markAllObstacles": { "alias": "markAllObstacles"; "required": false; }; "clearObstacles": { "alias": "clearObstacles"; "required": false; }; "clearDogModel": { "alias": "clearDogModel"; "required": false; }; "loadDogModel": { "alias": "loadDogModel"; "required": false; }; "exportPointCloud": { "alias": "exportPointCloud"; "required": false; }; "regularizeCloud": { "alias": "regularizeCloud"; "required": false; }; "projectionSource": { "alias": "projectionSource"; "required": false; }; }, { "mapReady": "mapReady"; "pointsChanged": "pointsChanged"; "cloudTranslated": "cloudTranslated"; "cloudTranslating": "cloudTranslating"; "cloudRotated": "cloudRotated"; "cloudRotating": "cloudRotating"; "pointClicked": "pointClicked"; "pathChanged": "pathChanged"; "pathFailed": "pathFailed"; "walkProgress": "walkProgress"; "dogPlaced": "dogPlaced"; "goalPlaced": "goalPlaced"; "paintedChanged": "paintedChanged"; "brushMiss": "brushMiss"; "interactionModeChange": "interactionModeChange"; "error": "error"; }, never, never, true, never>;
}

export { DEFAULT_OCTO_MAP_SETTINGS, MAP_CONFIG_KEYS, Octomap3dPcdComponent };
export type { OctoMapBoundingBox, OctoMapBrushMissDetail, OctoMapCloudPreview, OctoMapCloudRotation, OctoMapCloudTranslation, OctoMapDogModelRequest, OctoMapGizmoMode, OctoMapGizmoPose, OctoMapHoverInfo, OctoMapInteractionMode, OctoMapMapSettings, OctoMapPaintedVoxels, OctoMapPathAlgorithm, OctoMapPathFailedDetail, OctoMapPathFailureReason, OctoMapPointClickedDetail, OctoMapPointCloud, OctoMapPointsChangedDetail, OctoMapProjectionSource, OctoMapReadyDetail, OctoMapRenderMode, OctoMapReply, OctoMapSelectionBox, OctoMapWalkProgress, OctoMapWalkState };
//# sourceMappingURL=howell-octomap-3d.d.ts.map
