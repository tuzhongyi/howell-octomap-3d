import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { OctoMapBoundingBox, OctoMapGizmoMode, OctoMapSelectionBox } from '../octomap-3d-pcd.model';
import { OctoMapGroundExtent, groundPlaneRect } from './octomap-3d-pcd-ground-plane';

/**
 * 平移手柄的吸附步长（米）：1 cm。
 *
 * 面板上那三个偏移滑杆撤掉之后，拖动手柄是**唯一**的位移入口，而拖出来的值原本是
 * 连续的——松手时想「再挪 2 cm」就只能靠手感。吸附到厘米至少让结果是个整齐的数，
 * 也和当初滑杆的 1 cm 步长一致。
 */
const MOVE_GIZMO_SNAP = 0.01;

/**
 * 旋转手柄的吸附步长（度）：1°。
 *
 * 与平移的 1 cm 同一个来历：拖动原本是连续的，吸附一下至少让结果是个整齐的数。
 * 1° 细到能修「地面歪了 3°」，90° / 180° 这类整角也能靠拖着走到——`TransformControls`
 * 吸的是**这一段拖动累计的角度**，不是每帧的增量，所以拖到位就是精确值。
 */
const ROTATE_GIZMO_SNAP_DEG = 1;

const _euler = new THREE.Euler();

/**
 * 四元数 → 欧拉角（度，`'XYZ'`，与 `adjustCloud` 那边逐位同一套顺序）。
 *
 * 抹掉浮点数末几位：手柄拖到 90° 时算出来是 90.00000000000003 的话，设置里、读数上、
 * 配置文件里看到的都是这个尾巴。1e-6 度远小于 1° 的吸附步长，不会吃掉任何真实值。
 */
function eulerDegreesOf(q: THREE.Quaternion): [number, number, number] {
  _euler.setFromQuaternion(q, 'XYZ');
  const degrees = (rad: number) => Math.round((rad * 180) / Math.PI * 1e6) / 1e6 + 0;
  return [degrees(_euler.x), degrees(_euler.y), degrees(_euler.z)];
}

/**
 * 负责 Three.js 场景图——渲染器、相机、控制器、网格和灯光——
 * 以及渲染循环和尺寸变化处理。所有“场景级”的东西都在这里。
 */
@Injectable()
export class Octomap3dPcdGlobal {
  scene!: THREE.Scene;
  camera!: THREE.PerspectiveCamera;
  renderer!: THREE.WebGLRenderer;

  private controls!: OrbitControls;
  private grid!: THREE.GridHelper;
  /**
   * 参考物（网格 + 地面平面）的锚点：世界坐标，Y 就是锚定那一刻的地板高度。
   *
   * 它**不跟着点云走**：只有 `anchorReference(..., refit = true)` 才重定。平移手柄
   * 拖的是点云，云在参考物上滑过去——不动的参照物才看得出挪了多少；参考物要是跟着
   * 一起挪，整幅画面平移一下、看着像什么都没发生（用户报过）。
   */
  private readonly referenceAnchor = new THREE.Vector3();
  /** 锚点定过没有。没定过时网格/平面就按包围盒中心当场摆一次（首次 rebuild）。 */
  private referenceAnchored = false;
  private ambientLight!: THREE.AmbientLight;
  private directionalLight!: THREE.DirectionalLight;
  private viewport: HTMLElement | null = null;
  private animationId: number | null = null;
  private disposed = false;
  private readonly frameListeners = new Set<(delta: number) => void>();
  private lastTime = 0;
  /** y=0 处的参考地面；可被射线拾取以放置小狗/终点。 */
  groundPlane: THREE.Mesh | null = null;

  private brushCursor: THREE.Mesh | null = null;
  private brushCursorEnabled = false;

  /**
   * 选中那一份云的包围盒外框（多份云拼在一个场景里时才用）。
   *
   * 只由宿主给：地图不知道「哪份云」是什么，只知道要在哪儿画一个盒子。它跟着
   * 世界坐标走，重建点云、拖手柄都不移动它——移动它的宿主会重新给一份。
   */
  private selectionBox: THREE.Box3Helper | null = null;

  /**
   * 整片云的手柄：平移（三根箭头）或旋转（三个圆环），同一时刻只有一种模式。
   * 宿主打开「允许移动」/「允许旋转」时露出来。
   *
   * 它拖的是一个**不渲染的锚点**，不是点云本身：点云的几何是逐点算出来的，
   * 拖它等于每帧重算上百万个点。锚点只记位置与朝向，增量交给 {@link gizmoDragged}
   * / {@link gizmoRotating} 让地图做视觉预览、{@link gizmoCommitted} /
   * {@link gizmoRotated} 让宿主改数据。
   */
  private moveGizmo: TransformControls | null = null;
  /** 手柄拖动的锚点（位置由宿主的 `gizmoPose` 给，兜底是包围盒中心）。 */
  private gizmoAnchor: THREE.Object3D | null = null;
  /** 这一次拖动开始时锚点的位置与朝向，用来把绝对变换换成增量。 */
  private readonly gizmoStartPosition = new THREE.Vector3();
  private readonly gizmoStartQuaternion = new THREE.Quaternion();
  /** 拖动中途被强行关掉手柄时，别再补发一次提交。 */
  private gizmoArmed = false;

  /** 拖动过程中整片云挪了多少（世界坐标，米）；地图据此做预览。 */
  readonly gizmoDragged = new Subject<[number, number, number]>();
  /** 松手后的累计位移；宿主把它累加进自己的偏移量。 */
  readonly gizmoCommitted = new Subject<[number, number, number]>();
  /**
   * 拖动旋转手柄**过程中**的一次上报。
   *
   * `delta` 是「相对这次按下那一刻」的增量（世界坐标），只够做画面预览；`euler` 是
   * 叠加之后**总**的朝向（度），宿主拿去显示读数——宿主手上没有四元数那套数学，
   * 增量交给它反而没法用。
   */
  readonly gizmoRotating = new Subject<{
    delta: THREE.Quaternion;
    pivot: THREE.Vector3;
    euler: [number, number, number];
  }>();
  /** 松手后那次旋转的**总**朝向（度，`'XYZ'`）；宿主直接写进设置。 */
  readonly gizmoRotated = new Subject<[number, number, number]>();

  init(viewport: HTMLElement, backgroundColor: string, autoRotate: boolean): void {
    this.viewport = viewport;
    const width = viewport.clientWidth || 1;
    const height = viewport.clientHeight || 1;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(backgroundColor);

    this.camera = new THREE.PerspectiveCamera(60, width / height, 0.01, 10000);
    // 没有点云时不会调用 fitCamera，相机就会停在默认的 (0,0,0)——正好是
    // 任何放在原点的东西的内部。先给一个能看见原点的默认机位。
    this.camera.position.set(5, 4, 5);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height, false);
    this.renderer.setClearColor(backgroundColor);
    viewport.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
    this.controls.autoRotate = autoRotate;
    this.controls.autoRotateSpeed = 1;

    // 必须在组件自己往画布上挂指针监听**之前**建好（`init` 就在那之前调用）：
    // TransformControls 的 `pointerdown` 要先跑，命中手柄时它会把 `dragging`
    // 置真；组件那边看到这个标志就把这一下整让出去（否则按下箭头的同时还会
    // 去刷笔、拾取或抓狗）。反过来注册的话，组件会先看到一次「普通按下」。
    this.createMoveGizmo();

    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.55);
    this.scene.add(this.ambientLight);

    this.directionalLight = new THREE.DirectionalLight(0xffffff, 1.1);
    this.scene.add(this.directionalLight);
    this.scene.add(this.directionalLight.target);

    this.animate();
  }

  setBackgroundColor(color: string): void {
    this.scene.background = new THREE.Color(color);
    this.renderer.setClearColor(color);
  }

  setAutoRotate(enabled: boolean): void {
    this.controls.autoRotate = enabled;
  }

  /** 临时禁用/启用轨道控制器（刷时使用）。 */
  setControlsEnabled(enabled: boolean): void {
    this.controls.enabled = enabled;
  }

  /**
   * 建三轴平移手柄。默认关闭且不可见——宿主打开「允许移动」时才露出来。
   *
   * 拖动只改锚点的位置，不碰点云；`dragging-changed` 在这里把轨道控制器关掉，
   * 松手再打开，否则拖手柄时相机也会跟着转。
   */
  private createMoveGizmo(): void {
    const gizmo = new TransformControls(this.camera, this.renderer.domElement);
    gizmo.setMode('translate');
    // 世界轴：偏移量与旋转角都是按世界 X/Y/Z 记的，跟点云自己怎么转无关。
    gizmo.setSpace('world');
    gizmo.setTranslationSnap(MOVE_GIZMO_SNAP);
    gizmo.setRotationSnap(THREE.MathUtils.degToRad(ROTATE_GIZMO_SNAP_DEG));
    gizmo.enabled = false;

    const helper = gizmo.getHelper();
    helper.visible = false;
    this.scene.add(helper);

    const anchor = new THREE.Object3D();
    this.scene.add(anchor);
    gizmo.attach(anchor);

    gizmo.addEventListener('dragging-changed', (event) => {
      const dragging = (event as { value?: boolean }).value === true;
      this.controls.enabled = !dragging;
      if (!this.gizmoAnchor) {
        return;
      }
      if (dragging) {
        this.gizmoArmed = true;
        this.gizmoStartPosition.copy(this.gizmoAnchor.position);
        this.gizmoStartQuaternion.copy(this.gizmoAnchor.quaternion);
        return;
      }
      if (!this.gizmoArmed) {
        return;
      }
      this.gizmoArmed = false;
      if (gizmo.mode === 'rotate') {
        this.gizmoRotated.next(eulerDegreesOf(this.gizmoAnchor.quaternion));
        return;
      }
      const delta = this.gizmoAnchor.position.clone().sub(this.gizmoStartPosition);
      this.gizmoCommitted.next([delta.x, delta.y, delta.z]);
    });
    gizmo.addEventListener('objectChange', () => {
      if (!gizmo.dragging || !this.gizmoAnchor) {
        return;
      }
      if (gizmo.mode === 'rotate') {
        // 世界空间里 TransformControls 算的是 `q = Δ · q_start`（见它的 pointerMove），
        // 所以这一趟的增量就是 `q · q_start⁻¹`，而 q 本身就是**叠加之后的总朝向**。
        const delta = this.gizmoAnchor.quaternion
          .clone()
          .multiply(this.gizmoStartQuaternion.clone().invert());
        this.gizmoRotating.next({
          delta,
          pivot: this.gizmoStartPosition.clone(),
          euler: eulerDegreesOf(this.gizmoAnchor.quaternion),
        });
        return;
      }
      const delta = this.gizmoAnchor.position.clone().sub(this.gizmoStartPosition);
      this.gizmoDragged.next([delta.x, delta.y, delta.z]);
    });

    this.gizmoAnchor = anchor;
    this.moveGizmo = gizmo;
  }

  /** 手柄是不是正在被拖（组件用它把这次按下让给手柄）。 */
  get gizmoDragging(): boolean {
    return this.moveGizmo?.dragging === true;
  }

  /**
   * 把手柄挪到点云包围盒中心（宿主没给 `gizmoPose` 时的兜底）。
   *
   * 放在中心而不是地面或原点：手柄拖的是「整片云」，抓在云的重心上最直觉。
   */
  moveGizmoTo(bbox: OctoMapBoundingBox | null): void {
    if (!this.gizmoAnchor || !bbox) {
      return;
    }
    this.gizmoAnchor.position.set(bbox.center[0], bbox.center[1], bbox.center[2]);
  }

  /**
   * 按宿主给的位姿摆手柄：位置是**旋转支点**（不一定是包围盒中心），朝向是云当前
   * 的整体旋转。
   *
   * 朝向必须设对：`TransformControls` 在世界空间里算的是 `q = Δ · q_start`，起点是
   * 锚点当下的四元数。设成云当前的旋转，拖出来的才是「叠加之后的总朝向」，宿主拿到
   * 的数直接就是新设置；设成恒等的话每次拖动都只报这一趟的增量，宿主还得自己合成。
   *
   * 拖动中不抢：那一下的起点已经存进 {@link gizmoStartPosition} /
   * {@link gizmoStartQuaternion}，中途改由输入流触发的重建会把这次拖动弄坏。
   */
  setGizmoPose(position: [number, number, number], rotationDeg: [number, number, number]): void {
    const anchor = this.gizmoAnchor;
    if (!anchor || this.moveGizmo?.dragging) {
      return;
    }
    anchor.position.set(position[0], position[1], position[2]);
    anchor.rotation.set(
      THREE.MathUtils.degToRad(rotationDeg[0]),
      THREE.MathUtils.degToRad(rotationDeg[1]),
      THREE.MathUtils.degToRad(rotationDeg[2]),
      'XYZ',
    );
  }

  /** 切换手柄模式（平移 / 旋转）。`'off'` 与隐藏等价，见 {@link setMoveGizmoVisible}。 */
  setMoveGizmoMode(mode: OctoMapGizmoMode): void {
    const gizmo = this.moveGizmo;
    if (!gizmo || mode === 'off' || gizmo.mode === mode) {
      return;
    }
    gizmo.setMode(mode);
  }

  /** 显示/隐藏手柄。 */
  setMoveGizmoVisible(visible: boolean): void {
    const gizmo = this.moveGizmo;
    if (!gizmo) {
      return;
    }
    if (!visible && gizmo.dragging) {
      // 拖到一半被关掉（用户把「允许移动」/「允许旋转」取消了）：不强制收尾的话，
      // `dragging` 会一直真、轨道控制器永久禁用，指针也再也拖不动相机。
      this.gizmoArmed = false;
      gizmo.dragging = false;
      this.controls.enabled = true;
      // 预览出来的位移/旋转也得撤回：这次改动不一定伴随一次重建，留着就成了
      // 「画面动了、数据没动」。
      if (this.gizmoAnchor) {
        this.gizmoAnchor.position.copy(this.gizmoStartPosition);
        this.gizmoAnchor.quaternion.copy(this.gizmoStartQuaternion);
      }
      if (gizmo.mode === 'rotate') {
        // 报回拖动开始时的总朝向：宿主的读数跟着回到已落账的那个值，地图这边按它
        // 算出的增量是恒等，预览随之复原。
        this.gizmoRotating.next({
          delta: new THREE.Quaternion(),
          pivot: this.gizmoStartPosition.clone(),
          euler: eulerDegreesOf(this.gizmoStartQuaternion),
        });
      } else {
        this.gizmoDragged.next([0, 0, 0]);
      }
    }
    if (!visible) {
      // 关掉之后 pointerHover 不再更新，旧轴会一直「悬停」着。
      gizmo.axis = null;
    }
    gizmo.enabled = visible;
    gizmo.getHelper().visible = visible;
  }

  /**
   * 画/收起选中那份点云的包围盒外框。`null` 表示没有选中（或场景里只有一份云，
   * 那时没有「选哪份」的问题）。
   *
   * 盒子用 `Box3Helper`：它每帧从 `box` 现算位置与缩放，所以这里改 min/max 就够了，
   * 不用重建几何。边框压暗、不写深度，被云挡住时也看得见一角——这正是要它干的事。
   */
  setSelectionBox(box: OctoMapSelectionBox | null): void {
    if (!box) {
      if (this.selectionBox) {
        this.selectionBox.visible = false;
      }
      return;
    }
    if (!this.selectionBox) {
      const material = new THREE.LineBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.85,
        depthTest: false,
      });
      this.selectionBox = new THREE.Box3Helper(new THREE.Box3(), 0x38bdf8);
      // Box3Helper 自己带一份 LineBasicMaterial，换掉以便设透明与不写深度。
      (this.selectionBox.material as THREE.Material).dispose();
      this.selectionBox.material = material;
      // 不写深度、又是半透明，它会排进「透明」那一趟；抬一点渲染顺序，让它压在
      // 手柄、刷笔圆环这些同样半透明的物件之后画，边框不会被别人的线盖掉。
      this.selectionBox.renderOrder = 1;
      this.scene.add(this.selectionBox);
    }
    this.selectionBox.box.min.set(box.min[0], box.min[1], box.min[2]);
    this.selectionBox.box.max.set(box.max[0], box.max[1], box.max[2]);
    this.selectionBox.visible = true;
  }

  /** 显示/隐藏刷范围圆环（仅在刷激活时可见）。 */
  setBrushCursorVisible(visible: boolean): void {
    this.brushCursorEnabled = visible;
    if (visible && !this.brushCursor) {
      const geometry = new THREE.RingGeometry(0.9, 1, 64);
      geometry.rotateX(-Math.PI / 2);
      const material = new THREE.MeshBasicMaterial({
        color: 0x22d3ee,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
        depthTest: false,
      });
      this.brushCursor = new THREE.Mesh(geometry, material);
      this.brushCursor.renderOrder = 999;
      this.scene.add(this.brushCursor);
    }
    // 先隐藏，等下次指针移动再把它定位到光标下方。
    if (this.brushCursor) {
      this.brushCursor.visible = false;
    }
  }

  /** 把刷范围圆环移动到地面点并设为给定半径。 */
  updateBrushCursor(point: [number, number, number], radius: number): void {
    if (!this.brushCursor || !this.brushCursorEnabled) {
      return;
    }
    this.brushCursor.visible = true;
    this.brushCursor.scale.setScalar(Math.max(radius, 1e-3));
    this.brushCursor.position.set(point[0], point[1] + 0.02, point[2]);
  }

  rebuildGrid(showGrid: boolean, gridSize: number, gridDivisions: number): void {
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.dispose();
    }
    this.grid = new THREE.GridHelper(gridSize, gridDivisions, 0x44506a, 0x283244);
    this.grid.visible = showGrid;
    this.grid.position.copy(this.referenceAnchor);
    this.scene.add(this.grid);
  }

  /**
   * 参考物（灰色地面平面 + 参考网格）现在所在的世界 Y；还没锚定（没有点云）时为 null。
   *
   * 给出去的是**用户看到的那块平面**，不是 `grille.groundLevel`（那个跟着云走）。
   * 宿主按它把某一份云「贴到地面」上，两个数混用就会贴歪——见
   * `OctoMapPointsChangedDetail.groundPlaneLevel`。
   */
  get referenceLevel(): number | null {
    return this.referenceAnchored ? this.referenceAnchor.y : null;
  }

  /**
   * 重定参考物的锚点。
   *
   * `refit = true`：换了一份点云、或者换了一套坐标系——参考物重新贴到新点云脚下。
   * `refit = false`：同一份云被转了一下/挪了一下，参考物**钉在原地**。没有点云
   * （`bbox` 为 null）时把锚点作废，下一份云重新定。
   */
  anchorReference(
    bbox: OctoMapBoundingBox | null,
    groundLevel: number,
    refit: boolean,
  ): void {
    if (!bbox) {
      this.referenceAnchored = false;
      return;
    }
    if (!refit && this.referenceAnchored) {
      return;
    }
    this.referenceAnchor.set(bbox.center[0], groundLevel, bbox.center[2]);
    this.referenceAnchored = true;
  }

  /**
   * 让参考网格落在参考物的锚点上，与地面平面共面。
   *
   * 高度必须与 {@link updateGroundPlane} 同源：网格和平面是一对参考物，平面挪到
   * 地板上而网格留在 y=0，两者就会分家——看起来像浮动的地板悬在网格上方。
   *
   * 尺寸（`gridSize`）是用户设的定值，云挪出网格之外是正常的——它本来就只是把
   * 尺子，不负责罩住点云（那是地面平面的活儿，见 {@link updateGroundPlane}）。
   */
  alignGrid(bbox: OctoMapBoundingBox | null): void {
    if (!bbox) {
      return;
    }
    if (this.grid) {
      this.grid.position.copy(this.referenceAnchor);
    }
  }

  fitCamera(bbox: OctoMapBoundingBox | null): void {
    if (!bbox) {
      return;
    }
    const center = new THREE.Vector3(bbox.center[0], bbox.center[1], bbox.center[2]);
    const radius = Math.max(bbox.radius, 1e-6);

    this.controls.target.copy(center);
    const direction = new THREE.Vector3(1, 0.8, 1).normalize();
    this.camera.position.copy(center).addScaledVector(direction, radius * 2.5);
    this.camera.near = radius / 1000;
    this.camera.far = radius * 100;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  /**
   * 参考物的锚点；还没定过（点云刚到、`anchorReference` 还没来得及跑）时就当场按
   * 包围盒中心 + 当前地板高度摆一次，与改动前的行为一致。
   */
  private frameAnchorOf(
    bbox: OctoMapBoundingBox,
    groundLevel: number,
  ): THREE.Vector3 {
    if (!this.referenceAnchored) {
      this.referenceAnchor.set(bbox.center[0], groundLevel, bbox.center[2]);
      this.referenceAnchored = true;
    }
    return this.referenceAnchor;
  }

  /**
   * 按当前的延展设置重画地面平面。
   *
   * 这块平面不只是装饰：它是 `pickGroundPoint` 的射线靶面，也就是放狗、刷障碍、
   * 设终点、加点这四条流程的可点击矩形。平面没覆盖到的地方，点击会被静默丢掉。
   */
  updateGroundPlane(
    bbox: OctoMapBoundingBox | null,
    extent: OctoMapGroundExtent,
    groundLevel: number,
  ): void {
    if (!bbox) {
      if (this.groundPlane) {
        this.groundPlane.visible = false;
      }
      return;
    }
    if (!this.groundPlane) {
      const geometry = new THREE.PlaneGeometry(1, 1);
      geometry.rotateX(-Math.PI / 2);
      const material = new THREE.MeshStandardMaterial({
        color: 0x6b7f9c,
        roughness: 0.9,
        metalness: 0,
        transparent: true,
        opacity: 0.6,
        side: THREE.DoubleSide,
      });
      this.groundPlane = new THREE.Mesh(geometry, material);
      this.scene.add(this.groundPlane);
    }
    // 平面几何体已被旋转到 XZ 面上，因此其局部 X/Z 轴对应世界
    // X/Z——缩放这两个轴（而不是 Y）以覆盖点云范围。
    // 往包围盒外延展多少由用户设置（两根拉杆），尺寸的算法本身在
    // `groundPlaneRect` 那个纯模块里，这里只管把结果贴上去。
    const anchor = this.frameAnchorOf(bbox, groundLevel);
    const { width, depth } = groundPlaneRect(bbox, extent, anchor);
    this.groundPlane.scale.set(width, 1, depth);
    // 贴着锚定那一刻的地板，而不是世界原点——这两者只有在扫描的地板恰好落在
    // y=0 时才是同一个面。平面是放狗（射线拾取）的靶面，挪到这里，狗才站在
    // 真正的地板上，而不是浮在点云中间。
    //
    // 位置**不跟点云走**：云被手柄挪开之后，平面留在原地、靠上面那一步长到盖住
    // 云（否则挪出去那一片就点不着了）。高度也就此成为「世界地板」——把云整体
    // 抬高/降低时，它停在原处，用户才看得出地面基准偏了多少。
    this.groundPlane.position.copy(anchor);
    this.groundPlane.visible = true;
  }

  updateLights(bbox: OctoMapBoundingBox | null): void {
    if (!bbox) {
      return;
    }
    const center = new THREE.Vector3(bbox.center[0], bbox.center[1], bbox.center[2]);
    const radius = Math.max(bbox.radius, 1e-6);
    this.directionalLight.position.set(center.x + radius, center.y + radius * 2, center.z + radius);
    this.directionalLight.target.position.copy(center);
  }

  /** 注册每帧回调（接收距上一帧经过的秒数）。 */
  addFrameListener(listener: (delta: number) => void): void {
    this.frameListeners.add(listener);
  }

  removeFrameListener(listener: (delta: number) => void): void {
    this.frameListeners.delete(listener);
  }

  handleResize(): void {
    const el = this.viewport;
    if (!el) {
      return;
    }
    const width = el.clientWidth || 1;
    const height = el.clientHeight || 1;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.disposed = true;
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
    }
    this.controls?.dispose();
    this.moveGizmo?.dispose();
    this.renderer?.dispose();
    this.renderer?.domElement.remove();
    if (this.groundPlane) {
      this.groundPlane.geometry.dispose();
      (this.groundPlane.material as THREE.Material).dispose();
      this.groundPlane = null;
    }
    if (this.brushCursor) {
      this.brushCursor.geometry.dispose();
      (this.brushCursor.material as THREE.Material).dispose();
      this.brushCursor = null;
    }
    if (this.selectionBox) {
      this.scene.remove(this.selectionBox);
      this.selectionBox.geometry.dispose();
      (this.selectionBox.material as THREE.Material).dispose();
      this.selectionBox = null;
    }
  }

  private animate = (): void => {
    if (this.disposed) {
      return;
    }
    this.animationId = requestAnimationFrame(this.animate);
    const now = performance.now();
    const delta = this.lastTime === 0 ? 0 : (now - this.lastTime) / 1000;
    this.lastTime = now;
    this.controls.update();
    this.frameListeners.forEach((listener) => listener(delta));
    this.renderer.render(this.scene, this.camera);
  };
}
