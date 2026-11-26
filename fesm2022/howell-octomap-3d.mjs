import * as i0 from '@angular/core';
import { Injectable, EventEmitter, signal, inject, Output, Input, ViewChild, ChangeDetectionStrategy, Component } from '@angular/core';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Subject } from 'rxjs';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

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
function groundPlaneRect(bbox, extent, anchor) {
    // 兜底不是防御性编程：`config.service.ts` 把 `octomap.config.json` 裸断言成
    // `OctomapMapSettings`，手写资产里的 `"groundExtendX": "0.9"`（字符串）或 `null`
    // 会一路进到 `scale.set()` 里变成 NaN，而 NaN 的比例会让**整个平面消失**——
    // 连带着放狗/刷障碍的射线靶面一起没。负数同理（`Math.max` 之前先夹住）。
    const side = (v) => (Number.isFinite(v) ? Math.max(v, 0) : 0);
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
function eulerDegreesOf(q) {
    _euler.setFromQuaternion(q, 'XYZ');
    const degrees = (rad) => Math.round((rad * 180) / Math.PI * 1e6) / 1e6 + 0;
    return [degrees(_euler.x), degrees(_euler.y), degrees(_euler.z)];
}
/**
 * 负责 Three.js 场景图——渲染器、相机、控制器、网格和灯光——
 * 以及渲染循环和尺寸变化处理。所有“场景级”的东西都在这里。
 */
class Octomap3dPcdGlobal {
    scene;
    camera;
    renderer;
    controls;
    grid;
    /**
     * 参考物（网格 + 地面平面）的锚点：世界坐标，Y 就是锚定那一刻的地板高度。
     *
     * 它**不跟着点云走**：只有 `anchorReference(..., refit = true)` 才重定。平移手柄
     * 拖的是点云，云在参考物上滑过去——不动的参照物才看得出挪了多少；参考物要是跟着
     * 一起挪，整幅画面平移一下、看着像什么都没发生（用户报过）。
     */
    referenceAnchor = new THREE.Vector3();
    /** 锚点定过没有。没定过时网格/平面就按包围盒中心当场摆一次（首次 rebuild）。 */
    referenceAnchored = false;
    ambientLight;
    directionalLight;
    viewport = null;
    animationId = null;
    disposed = false;
    frameListeners = new Set();
    lastTime = 0;
    /** y=0 处的参考地面；可被射线拾取以放置小狗/终点。 */
    groundPlane = null;
    brushCursor = null;
    brushCursorEnabled = false;
    /**
     * 选中那一份云的包围盒外框（多份云拼在一个场景里时才用）。
     *
     * 只由宿主给：地图不知道「哪份云」是什么，只知道要在哪儿画一个盒子。它跟着
     * 世界坐标走，重建点云、拖手柄都不移动它——移动它的宿主会重新给一份。
     */
    selectionBox = null;
    /**
     * 整片云的手柄：平移（三根箭头）或旋转（三个圆环），同一时刻只有一种模式。
     * 宿主打开「允许移动」/「允许旋转」时露出来。
     *
     * 它拖的是一个**不渲染的锚点**，不是点云本身：点云的几何是逐点算出来的，
     * 拖它等于每帧重算上百万个点。锚点只记位置与朝向，增量交给 {@link gizmoDragged}
     * / {@link gizmoRotating} 让地图做视觉预览、{@link gizmoCommitted} /
     * {@link gizmoRotated} 让宿主改数据。
     */
    moveGizmo = null;
    /** 手柄拖动的锚点（位置由宿主的 `gizmoPose` 给，兜底是包围盒中心）。 */
    gizmoAnchor = null;
    /** 这一次拖动开始时锚点的位置与朝向，用来把绝对变换换成增量。 */
    gizmoStartPosition = new THREE.Vector3();
    gizmoStartQuaternion = new THREE.Quaternion();
    /** 拖动中途被强行关掉手柄时，别再补发一次提交。 */
    gizmoArmed = false;
    /** 拖动过程中整片云挪了多少（世界坐标，米）；地图据此做预览。 */
    gizmoDragged = new Subject();
    /** 松手后的累计位移；宿主把它累加进自己的偏移量。 */
    gizmoCommitted = new Subject();
    /**
     * 拖动旋转手柄**过程中**的一次上报。
     *
     * `delta` 是「相对这次按下那一刻」的增量（世界坐标），只够做画面预览；`euler` 是
     * 叠加之后**总**的朝向（度），宿主拿去显示读数——宿主手上没有四元数那套数学，
     * 增量交给它反而没法用。
     */
    gizmoRotating = new Subject();
    /** 松手后那次旋转的**总**朝向（度，`'XYZ'`）；宿主直接写进设置。 */
    gizmoRotated = new Subject();
    init(viewport, backgroundColor, autoRotate) {
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
    setBackgroundColor(color) {
        this.scene.background = new THREE.Color(color);
        this.renderer.setClearColor(color);
    }
    setAutoRotate(enabled) {
        this.controls.autoRotate = enabled;
    }
    /** 临时禁用/启用轨道控制器（刷时使用）。 */
    setControlsEnabled(enabled) {
        this.controls.enabled = enabled;
    }
    /**
     * 建三轴平移手柄。默认关闭且不可见——宿主打开「允许移动」时才露出来。
     *
     * 拖动只改锚点的位置，不碰点云；`dragging-changed` 在这里把轨道控制器关掉，
     * 松手再打开，否则拖手柄时相机也会跟着转。
     */
    createMoveGizmo() {
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
            const dragging = event.value === true;
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
    get gizmoDragging() {
        return this.moveGizmo?.dragging === true;
    }
    /**
     * 把手柄挪到点云包围盒中心（宿主没给 `gizmoPose` 时的兜底）。
     *
     * 放在中心而不是地面或原点：手柄拖的是「整片云」，抓在云的重心上最直觉。
     */
    moveGizmoTo(bbox) {
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
    setGizmoPose(position, rotationDeg) {
        const anchor = this.gizmoAnchor;
        if (!anchor || this.moveGizmo?.dragging) {
            return;
        }
        anchor.position.set(position[0], position[1], position[2]);
        anchor.rotation.set(THREE.MathUtils.degToRad(rotationDeg[0]), THREE.MathUtils.degToRad(rotationDeg[1]), THREE.MathUtils.degToRad(rotationDeg[2]), 'XYZ');
    }
    /** 切换手柄模式（平移 / 旋转）。`'off'` 与隐藏等价，见 {@link setMoveGizmoVisible}。 */
    setMoveGizmoMode(mode) {
        const gizmo = this.moveGizmo;
        if (!gizmo || mode === 'off' || gizmo.mode === mode) {
            return;
        }
        gizmo.setMode(mode);
    }
    /** 显示/隐藏手柄。 */
    setMoveGizmoVisible(visible) {
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
            }
            else {
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
    setSelectionBox(box) {
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
            this.selectionBox.material.dispose();
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
    setBrushCursorVisible(visible) {
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
    updateBrushCursor(point, radius) {
        if (!this.brushCursor || !this.brushCursorEnabled) {
            return;
        }
        this.brushCursor.visible = true;
        this.brushCursor.scale.setScalar(Math.max(radius, 1e-3));
        this.brushCursor.position.set(point[0], point[1] + 0.02, point[2]);
    }
    rebuildGrid(showGrid, gridSize, gridDivisions) {
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
     * `OctomapPointsChangedDetail.groundPlaneLevel`。
     */
    get referenceLevel() {
        return this.referenceAnchored ? this.referenceAnchor.y : null;
    }
    /**
     * 重定参考物的锚点。
     *
     * `refit = true`：换了一份点云、或者换了一套坐标系——参考物重新贴到新点云脚下。
     * `refit = false`：同一份云被转了一下/挪了一下，参考物**钉在原地**。没有点云
     * （`bbox` 为 null）时把锚点作废，下一份云重新定。
     */
    anchorReference(bbox, groundLevel, refit) {
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
    alignGrid(bbox) {
        if (!bbox) {
            return;
        }
        if (this.grid) {
            this.grid.position.copy(this.referenceAnchor);
        }
    }
    fitCamera(bbox) {
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
    frameAnchorOf(bbox, groundLevel) {
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
    updateGroundPlane(bbox, extent, groundLevel) {
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
    updateLights(bbox) {
        if (!bbox) {
            return;
        }
        const center = new THREE.Vector3(bbox.center[0], bbox.center[1], bbox.center[2]);
        const radius = Math.max(bbox.radius, 1e-6);
        this.directionalLight.position.set(center.x + radius, center.y + radius * 2, center.z + radius);
        this.directionalLight.target.position.copy(center);
    }
    /** 注册每帧回调（接收距上一帧经过的秒数）。 */
    addFrameListener(listener) {
        this.frameListeners.add(listener);
    }
    removeFrameListener(listener) {
        this.frameListeners.delete(listener);
    }
    handleResize() {
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
    dispose() {
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
            this.groundPlane.material.dispose();
            this.groundPlane = null;
        }
        if (this.brushCursor) {
            this.brushCursor.geometry.dispose();
            this.brushCursor.material.dispose();
            this.brushCursor = null;
        }
        if (this.selectionBox) {
            this.scene.remove(this.selectionBox);
            this.selectionBox.geometry.dispose();
            this.selectionBox.material.dispose();
            this.selectionBox = null;
        }
    }
    animate = () => {
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
    static ɵfac = i0.ɵɵngDeclareFactory({ minVersion: "12.0.0", version: "21.2.26", ngImport: i0, type: Octomap3dPcdGlobal, deps: [], target: i0.ɵɵFactoryTarget.Injectable });
    static ɵprov = i0.ɵɵngDeclareInjectable({ minVersion: "12.0.0", version: "21.2.26", ngImport: i0, type: Octomap3dPcdGlobal });
}
i0.ɵɵngDeclareClassMetadata({ minVersion: "12.0.0", version: "21.2.26", ngImport: i0, type: Octomap3dPcdGlobal, decorators: [{
            type: Injectable
        }] });

/** 行进速度，世界单位/秒。 */
const DOG_SPEED = 4;
/** 竖直向上的世界轴，绕它旋转即在地面上转向。 */
const UP = new THREE.Vector3(0, 1, 0);
/**
 * 负责机器狗——一个代替四足机器人的小型程序化小车。它被放置在
 * 起点（A），沿计算出的路径运动，并可在场景中被选中和拖拽。
 *
 * 小狗的 group 原点位于脚底，因此把它放到地面点上时，它会站在
 * 地形上。
 */
class Octomap3dPcdDog {
    global;
    /** 地面上的世界坐标起点，作为寻路起点使用。 */
    startPosition = null;
    /**
     * 小狗的挂载节点：原点在脚底，**+X 恒为正前方**。模型（内置几何体或外部
     * 模型）挂在它下面，外部模型会先被 {@link modelPivot} 转正，因此朝向、
     * 前端位置和指示三角形都以 +X 为准，与模型自带的坐标轴无关。
     */
    dog = null;
    /**
     * 加载进来的外部模型本体；null 表示内置几何体。用不用外部模型、以及重建挂载
     * 节点时拿什么装回去，都只看这一个字段。
     *
     * 早先这里另有一个布尔标志位，两份状态各写各的，{@link remove}（重置部署）
     * 就漏了一处：模型被释放了标志位还立着，用户点一次「重置」小狗就变回内置几何
     * 体。同理，引用本身不能丢——不然重建时也没东西可装。
     */
    customModel = null;
    selectionRing = null;
    /**
     * 模型朝向补偿，单位：度——外部模型自带的正面相对 +X 偏了多少，加载后按
     * 这个角度转回来。只影响外部模型，内置几何体本来就是 +X 朝前。
     */
    modelHeadingDeg = 0;
    /** 套在模型外面的补偿节点，用来把模型自带的正面方向转到 +X。 */
    modelPivot = null;
    /** 足迹碰撞体：半径 = 碰撞半径、高 = 通行高度的圆柱。 */
    collisionVolume = null;
    /** 贴着足迹正面、指示小狗正前方的三角形。 */
    collisionArrow = null;
    collisionVisible = true;
    collisionRadius = 0.25;
    collisionHeight = 0.8;
    /** 小狗模型整体的缩放系数，内置几何体和外部模型共用。 */
    scale = 1;
    /** 是否用碰撞足迹反推模型缩放（打开时 {@link scale} 不参与）。 */
    fitToCollision = false;
    /** 放置、拖拽和停下时的朝向，单位：度（0 = 面向 +X）。 */
    headingDeg = 0;
    /** 开始行进后朝向被锁住，只有重新计算路径或重新放狗才解锁。 */
    headingLocked = false;
    /** 模型在缩放为 1 时的水平占地（最长边），量过一次就缓存；换模型时清空。 */
    footprint = null;
    path = [];
    segmentLengths = [];
    totalLength = 0;
    traveled = 0;
    walking = false;
    paused = false;
    /** 每当小狗在路径上的位置变化（或被拖动）时上报。 */
    walkStateChanged = new Subject();
    raycaster = new THREE.Raycaster();
    pointer = new THREE.Vector2();
    onFrame = (delta) => this.update(delta);
    constructor(global) {
        this.global = global;
        this.global.addFrameListener(this.onFrame);
    }
    /** 小狗当前是否已放置在场景中。 */
    get placed() {
        return this.dog !== null;
    }
    /**
     * 碰撞足迹的底面半径（世界单位），与「碰撞半径」设置同值。场景里跟小狗同量级
     * 的装饰（终点锥、路径管）按它取参考尺寸。
     */
    get footprintRadius() {
        return this.collisionRadius;
    }
    /** 碰撞足迹的通行高度（世界单位），与「通行高度」设置同值。 */
    get footprintHeight() {
        return this.collisionHeight;
    }
    /** 把小狗放置在地面上的空闲世界坐标位置（A），并停止行进。 */
    placeAt(position) {
        this.startPosition = position;
        // 重新放狗是一次全新的部署，朝向从滑块重新生效。
        this.headingLocked = false;
        this.stop();
        if (!this.dog) {
            // 重建时要用回外部模型：重置部署只该清掉这一次的部署，不该顺手把模型
            // 也换掉。buildRig() 会自己清掉占地缓存并重新套用缩放。
            this.buildRig(this.customModel ?? this.buildDog());
        }
        const dog = this.dog;
        if (dog) {
            // group 原点位于脚底，因此把它放到地面点上时，
            // 小狗会站在地面上。
            dog.position.set(position[0], position[1], position[2]);
            // 刚建好的小狗是单位四元数，而上面的 stop() 跑在重建之前、
            // 那时还没有模型可用，所以这里得再应用一次朝向。
            this.resetHeading();
            this.attachIfPlaced();
            this.updateSelectionRing();
        }
    }
    /** 把小狗移动到新的地面位置（拖拽它时使用）。 */
    moveTo(position) {
        this.startPosition = position;
        this.stop();
        if (this.dog) {
            this.dog.position.set(position[0], position[1], position[2]);
            this.attachIfPlaced();
            this.updateSelectionRing();
        }
    }
    /**
     * 用外部模型（GLTF 等）替换内置的几何体小狗。已有位置（放置点）会被继承，
     * 因此模型的原点应当放在脚底，否则会浮空或半埋。模型自带的正面方向不必是
     * +X——用 {@link setModelHeading} 把它转正即可。还没放过狗时模型只是被
     * 记下，等放狗时才进场景——否则刷新页面后它会以世界原点出现在画面里。
     */
    setCustomModel(model) {
        // 先存下来，buildRig() 里才会按补偿角把模型转正。
        this.customModel = model;
        this.buildRig(model);
    }
    /** 清掉外部模型，回到内置几何体小狗（位置同样继承）。 */
    clearModel() {
        if (!this.customModel) {
            return;
        }
        this.customModel = null;
        this.buildRig(this.buildDog());
    }
    /**
     * 更新模型朝向补偿（单位：度）：外部模型自带的正面相对 +X 偏了多少，就按
     * 这个角度把它转回来，好让模型的鼻子和指示三角形、路径前端指向同一侧。
     */
    setModelHeading(degrees) {
        this.modelHeadingDeg = Number.isFinite(degrees) ? degrees : 0;
        this.applyModelHeading();
        // 模型转过了，水平占地得重新量。
        this.footprint = null;
        this.applyScale();
    }
    /** 让小狗回到起点位置，并停止正在进行的行进。朝向同时解锁。 */
    resetToStart() {
        // 重新计算路径会先把小狗送回起点，从这里起朝向重新可调。解锁必须在
        // stop() 之前，它内部的 emitWalkState 才会带上新状态。
        this.headingLocked = false;
        this.stop();
        if (this.dog && this.startPosition) {
            this.dog.position.set(this.startPosition[0], this.startPosition[1], this.startPosition[2]);
            this.resetHeading();
            this.updateSelectionRing();
        }
    }
    /** 射线拾取测试指针事件是否命中到小狗。 */
    pick(event) {
        // 只有已经在场景里的小狗才可被拾取：还没放狗时模型不在场景中，
        // 命中它会凭空召唤出一只小狗。
        const dog = this.sceneDog;
        if (!dog) {
            return false;
        }
        const rect = this.global.renderer.domElement.getBoundingClientRect();
        this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
        this.raycaster.setFromCamera(this.pointer, this.global.camera);
        return this.raycaster.intersectObject(dog, true).length > 0;
    }
    /** 在小狗下方显示选择环。 */
    select() {
        if (!this.selectionRing) {
            const geometry = new THREE.RingGeometry(0.55, 0.7, 48);
            geometry.rotateX(-Math.PI / 2);
            const material = new THREE.MeshBasicMaterial({
                color: 0x22d3ee,
                transparent: true,
                opacity: 0.9,
                side: THREE.DoubleSide,
                depthTest: false,
            });
            this.selectionRing = new THREE.Mesh(geometry, material);
            this.selectionRing.renderOrder = 999;
            this.global.scene.add(this.selectionRing);
            this.applyScale();
        }
        this.selectionRing.visible = true;
        this.updateSelectionRing();
    }
    /** 隐藏选择环。 */
    deselect() {
        if (this.selectionRing) {
            this.selectionRing.visible = false;
        }
    }
    /** 显示或隐藏小狗的碰撞体。 */
    setCollisionVisible(visible) {
        this.collisionVisible = visible;
        this.syncCollisionVolume();
    }
    /** 更新碰撞体半径（足迹圆柱的底面半径，世界单位）。 */
    setCollisionRadius(radius) {
        this.collisionRadius = radius;
        this.syncCollisionVolume();
        // 贴合模式下模型大小由碰撞足迹决定，半径一改模型就得跟着变。
        this.applyScale();
    }
    /** 更新碰撞体高度（圆柱的通行高度，世界单位）。 */
    setCollisionHeight(height) {
        this.collisionHeight = height;
        this.syncCollisionVolume();
    }
    /**
     * 更新小狗模型的缩放系数（1 = 原始大小）。只影响外观：碰撞范围和寻路
     * 仍由碰撞半径与通行高度决定，不随模型缩放变化。
     */
    setScale(scale) {
        this.scale = Number.isFinite(scale) && scale > 0 ? scale : 1;
        this.applyScale();
    }
    /**
     * 打开/关闭「模型对齐碰撞足迹」。打开时模型被等比例缩放到水平占地正好等于
     * 碰撞足迹（2 × 碰撞半径），`setScale` 的系数不再参与；等比例意味着高度不会
     * 跟着对齐通行高度。
     */
    setFitToCollision(enabled) {
        this.fitToCollision = enabled;
        this.applyScale();
    }
    /**
     * 更新小狗放置、拖拽和停下时的朝向（单位：度；0 = 面向世界 +X，俯视
     * 逆时针为正，即 90° 面向 −Z）。
     *
     * 行进开始后朝向由路径接管并被锁住，此时只记住新值不立即应用——重新
     * 计算路径或重新放狗解锁后才会生效。
     */
    setHeading(degrees) {
        this.headingDeg = Number.isFinite(degrees) ? degrees : 0;
        if (this.headingLocked) {
            return;
        }
        this.resetHeading();
    }
    /**
     * 小狗「前端」的世界坐标：放置点沿当前朝向前进一个碰撞半径。寻路从这里
     * 起算，路径就不会从小狗身体中间穿过。还没放狗时为 null。
     */
    frontPosition() {
        if (!this.startPosition) {
            return null;
        }
        const radians = THREE.MathUtils.degToRad(this.headingDeg);
        return [
            this.startPosition[0] + Math.cos(radians) * this.collisionRadius,
            this.startPosition[1],
            this.startPosition[2] - Math.sin(radians) * this.collisionRadius,
        ];
    }
    /** 从场景中移除小狗（下次 placeAt 时用同一只模型重建）。 */
    remove() {
        this.stop();
        this.startPosition = null;
        this.headingLocked = false;
        this.deselect();
        if (this.dog) {
            this.global.scene.remove(this.dog);
            // 外部模型不销毁：下次放狗还要把它装回新的挂载节点，dispose 掉几何体和
            // 材质就找不回来了。先摘出来，剩下的挂载节点（以及内置几何体）照常释放。
            this.customModel?.removeFromParent();
            this.disposeObject(this.dog);
            this.dog = null;
            this.modelPivot = null;
        }
        this.syncCollisionVolume();
    }
    /**
     * 保存新计算出的路径，准备行进或被拖动。小狗**留在原地**（放置点），调用它
     * 会清除正在进行的行进。
     *
     * 传进来的折线是从碰撞体正前方起笔的，而小狗站在碰撞体中心，两者差一个碰撞
     * 半径。这个距离补在行进路线的最前面：行进一开始小狗是先迈出这一步走到线上，
     * 而不是瞬移过去。**引段只用于行进，不在绘制的折线里**——画出来的线就是从碰
     * 撞体前缘起笔的。
     */
    setPath(path) {
        const route = this.dog && path.length > 0
            ? [[this.dog.position.x, this.dog.position.y, this.dog.position.z], ...path]
            : path;
        this.path = route;
        this.segmentLengths = [];
        this.totalLength = 0;
        for (let i = 0; i < route.length - 1; i++) {
            const a = route[i];
            const b = route[i + 1];
            const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
            this.segmentLengths.push(len);
            this.totalLength += len;
        }
        this.traveled = 0;
        this.walking = false;
        this.paused = false;
        // 路径是按当前朝向的前端点算出来的，重算即重新获得朝向控制权。
        this.headingLocked = false;
        if (this.dog) {
            // 位置一个字都不动：小狗留在放置点上，朝向前端点起步。
            this.resetHeading();
            this.updateSelectionRing();
        }
        this.emitWalkState();
    }
    /** 从当前位置开始（或重新开始）沿已存路径自动前进。 */
    startWalking() {
        if (this.path.length < 2) {
            return;
        }
        if (this.traveled >= this.totalLength) {
            this.traveled = 0;
            this.updateDogPosition();
        }
        this.walking = true;
        this.paused = false;
        // 从这里起朝向交给路径，滑块不再生效，直到重新计算路径。
        this.headingLocked = true;
        this.emitWalkState();
    }
    /** 暂停自动前进（小狗保持原位）。 */
    pause() {
        if (this.walking && !this.paused) {
            this.paused = true;
            this.emitWalkState();
        }
    }
    /** 从暂停位置恢复自动前进。 */
    resume() {
        if (this.walking && this.paused) {
            this.paused = false;
            this.emitWalkState();
        }
    }
    /** 当前行进是否已暂停。 */
    get isPaused() {
        return this.paused;
    }
    /** 把小狗拖动到已存路径的指定比例（0..1）处。 */
    seek(fraction) {
        if (this.path.length < 2) {
            return;
        }
        const clamped = Math.min(1, Math.max(0, fraction));
        this.traveled = clamped * this.totalLength;
        this.updateDogPosition();
        this.emitWalkState();
    }
    /** 停止并丢弃当前路径，但不移动小狗。停下后朝向复位。 */
    stop() {
        this.walking = false;
        this.paused = false;
        this.path = [];
        this.segmentLengths = [];
        this.totalLength = 0;
        this.traveled = 0;
        this.resetHeading();
        this.emitWalkState();
    }
    dispose() {
        this.global.removeFrameListener(this.onFrame);
        this.remove();
        if (this.selectionRing) {
            this.global.scene.remove(this.selectionRing);
            this.selectionRing.geometry.dispose();
            this.selectionRing.material.dispose();
            this.selectionRing = null;
        }
        if (this.collisionVolume) {
            this.global.scene.remove(this.collisionVolume);
            this.collisionVolume.geometry.dispose();
            this.collisionVolume.material.dispose();
            this.collisionVolume = null;
        }
        if (this.collisionArrow) {
            this.global.scene.remove(this.collisionArrow);
            this.collisionArrow.geometry.dispose();
            this.collisionArrow.material.dispose();
            this.collisionArrow = null;
        }
    }
    /**
     * 用 `model` 重建整只小狗：外层挂载 group（原点在脚底、+X 为正前方）里套
     * 一层补偿节点，模型再挂到补偿节点下。多这一层是为了让模型自带的坐标轴
     * 与「+X 即正前方」这个约定解耦——朝向、前端位置和指示三角形都只看外层。
     */
    buildRig(model) {
        const position = this.dog ? this.dog.position.clone() : null;
        if (this.dog) {
            this.global.scene.remove(this.dog);
            // 重新放狗时传进来的正是旧挂载节点里那只模型，先摘出来再销毁旧节点，否则
            // disposeObject 会连着它一起释放掉，挂到新节点上的就只剩一副空壳。
            model.removeFromParent();
            this.disposeObject(this.dog);
        }
        this.modelPivot = new THREE.Group();
        this.modelPivot.add(model);
        this.dog = new THREE.Group();
        this.dog.add(this.modelPivot);
        // 换了对象，三维尺寸完全不同，占地必须重新量。
        this.footprint = null;
        if (position) {
            this.dog.position.copy(position);
        }
        this.applyModelHeading();
        this.applyScale();
        this.resetHeading();
        this.attachIfPlaced();
        this.updateSelectionRing();
    }
    /** 把模型朝向补偿转到补偿节点上，让模型的正面对齐外层挂载点的 +X。 */
    applyModelHeading() {
        if (!this.modelPivot) {
            return;
        }
        // 内置几何体本来就是 +X 朝前，补偿角只对外部模型生效。
        const degrees = this.customModel ? this.modelHeadingDeg : 0;
        this.modelPivot.rotation.y = THREE.MathUtils.degToRad(-degrees);
    }
    /** 构建一个小型程序化小车（原点在脚底，前方沿 +X）。 */
    buildDog() {
        const group = new THREE.Group();
        const bodyMaterial = new THREE.MeshStandardMaterial({
            color: '#f97316',
            roughness: 0.55,
            metalness: 0.15,
        });
        const headMaterial = new THREE.MeshStandardMaterial({
            color: '#fb923c',
            roughness: 0.5,
            metalness: 0.1,
        });
        const legMaterial = new THREE.MeshStandardMaterial({
            color: '#c2410c',
            roughness: 0.6,
            metalness: 0.1,
        });
        const noseMaterial = new THREE.MeshStandardMaterial({
            color: '#111827',
            roughness: 0.4,
        });
        const body = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.25, 0.3), bodyMaterial);
        body.position.set(0, 0.375, 0);
        group.add(body);
        const head = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.18, 0.24), headMaterial);
        head.position.set(0.5, 0.41, 0);
        group.add(head);
        const nose = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 16), noseMaterial);
        nose.position.set(0.62, 0.45, 0);
        group.add(nose);
        const legGeometry = new THREE.BoxGeometry(0.07, 0.25, 0.07);
        const legSpots = [
            [0.3, 0.125, 0.11],
            [0.3, 0.125, -0.11],
            [-0.3, 0.125, 0.11],
            [-0.3, 0.125, -0.11],
        ];
        for (const [x, y, z] of legSpots) {
            const leg = new THREE.Mesh(legGeometry, legMaterial);
            leg.position.set(x, y, z);
            group.add(leg);
        }
        return group;
    }
    disposeObject(object) {
        object.traverse((child) => {
            if (child instanceof THREE.Mesh) {
                child.geometry.dispose();
                child.material.dispose();
            }
        });
    }
    updateSelectionRing() {
        if (this.selectionRing && this.dog) {
            // 抬 0.02 是为了不与地面平面 z-fighting；抬升量是相对小狗脚下的地面，
            // 不是相对世界原点——地面高度来自扫描出的地板，不一定是 y=0。
            this.selectionRing.position.set(this.dog.position.x, this.dog.position.y + 0.02, this.dog.position.z);
        }
        this.syncCollisionVolume();
    }
    /** 已经在场景里的小狗；没放过狗时为 null（模型只是被记着，不显示）。 */
    get sceneDog() {
        return this.dog && this.dog.parent === this.global.scene ? this.dog : null;
    }
    /**
     * 放过狗之后才把模型放进场景。还没放置时模型只是被记着——例如刷新页面后
     * 自动恢复的外部模型，直接进场景会以世界原点杵在画面里，盖住点云。
     */
    attachIfPlaced() {
        if (this.dog && this.startPosition) {
            this.global.scene.add(this.dog);
        }
    }
    /** 把当前缩放系数作用到小狗模型和选择环上。 */
    applyScale() {
        // 贴合模式下由 footprint 反推系数（量不出来时退回手动系数，至少不是 0）。
        const factor = this.fitToCollision ? (this.fitFactor() ?? this.scale) : this.scale;
        this.dog?.scale.setScalar(factor);
        this.selectionRing?.scale.setScalar(factor);
    }
    /** 让模型水平占地正好等于碰撞足迹所需的等比系数；量不出占地时为 null。 */
    fitFactor() {
        const footprint = this.modelFootprint();
        const target = this.collisionRadius * 2;
        if (footprint === null || target <= 0) {
            return null;
        }
        return target / footprint;
    }
    /**
     * 模型在缩放为 1 时的水平占地（X/Z 包围盒的较长边）。内置几何体和外部模型
     * 都能量，量不出来（空模型、退化包围盒）时返回 null。
     */
    modelFootprint() {
        if (!this.dog) {
            return null;
        }
        if (this.footprint !== null) {
            return this.footprint;
        }
        // 包围盒要把当前缩放和朝向先摘掉再量：否则拉伸过的模型会被量成自己的
        // 缩放结果，转过角度的模型会被量成它自己的外接盒（45° 时 X/Z 尺寸偏大
        // → 反推出来的缩放偏小）。平移不影响尺寸，小狗在世界里的位置无所谓。
        const scale = this.dog.scale.clone();
        const quaternion = this.dog.quaternion.clone();
        this.dog.scale.setScalar(1);
        this.dog.quaternion.identity();
        const size = new THREE.Box3().setFromObject(this.dog).getSize(new THREE.Vector3());
        this.dog.scale.copy(scale);
        this.dog.quaternion.copy(quaternion);
        const footprint = Math.max(size.x, size.z);
        if (!Number.isFinite(footprint) || footprint <= 0) {
            return null;
        }
        this.footprint = footprint;
        return footprint;
    }
    /**
     * 把小狗的朝向复位到配置的初始朝向（绕竖直轴旋转，保持直立）。不看
     * {@link headingLocked}：锁只拦用户的调整，行进结束、停下这些内部回落
     * 照常生效。
     */
    resetHeading() {
        this.dog?.quaternion.setFromAxisAngle(UP, THREE.MathUtils.degToRad(this.headingDeg));
        // 指示正前方的三角形是按小狗的偏航角画的，朝向一变就得跟着重画。这里
        // 不能省：拖滑块和 stop() 都只改朝向、不动位置，没有别的路径会碰巧
        // 调到 syncCollisionVolume()，漏了箭头就会留在旧方向。
        this.syncCollisionVolume();
    }
    /**
     * 小狗当前朝向的偏航角（弧度），把模型 +X 轴投影到地面上算出来。行进中
     * 模型会随坡面俯仰，三角形只跟着水平方向转，不跟着翘。
     */
    headingRadians() {
        if (!this.dog) {
            return 0;
        }
        const forward = new THREE.Vector3(1, 0, 0).applyQuaternion(this.dog.quaternion);
        return Math.atan2(-forward.z, forward.x);
    }
    /** 创建/更新碰撞体（足迹圆柱）和指示正前方的三角形，使其匹配当前状态。 */
    syncCollisionVolume() {
        // 小狗不在场景里（还没放狗）时不画碰撞体，否则它会留在原点。
        const dog = this.sceneDog;
        if (!this.collisionVisible || !dog) {
            if (this.collisionVolume) {
                this.collisionVolume.visible = false;
            }
            if (this.collisionArrow) {
                this.collisionArrow.visible = false;
            }
            return;
        }
        if (!this.collisionVolume) {
            // 单位圆柱（底面半径 1、高 1）。用圆柱而不是长方体，是为了跟寻路里按
            // 真实距离外扩障碍的那一套对齐（判据是「到最近障碍的欧氏距离 ≤ 半径」，
            // 等距线是圆）——底面为 2r 正方形的长方体，方角会外扩到 √2 倍半径，画出
            // 来比实际预留的避障范围大 41%。
            const geometry = new THREE.CylinderGeometry(1, 1, 1, 32);
            const material = new THREE.MeshBasicMaterial({
                color: 0xf97316,
                transparent: true,
                opacity: 0.25,
                side: THREE.DoubleSide,
                depthTest: false,
            });
            this.collisionVolume = new THREE.Mesh(geometry, material);
            this.collisionVolume.renderOrder = 998;
            this.global.scene.add(this.collisionVolume);
        }
        if (!this.collisionArrow) {
            // 单位几何体：底边贴着足迹正面（x = 1），顶点朝 +X 伸出一点。整体按
            // 碰撞半径等比缩放，形状才不会走样。
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute([1, 0, 0.35, 1, 0, -0.35, 1.5, 0, 0], 3));
            const material = new THREE.MeshBasicMaterial({
                color: 0xf97316,
                transparent: true,
                opacity: 0.95,
                side: THREE.DoubleSide,
                depthTest: false,
            });
            this.collisionArrow = new THREE.Mesh(geometry, material);
            this.collisionArrow.renderOrder = 999;
            this.global.scene.add(this.collisionArrow);
        }
        this.collisionVolume.visible = true;
        // 圆柱绕竖直轴是对称的，转不转一个样，正前方改由三角形表示。
        this.collisionVolume.scale.set(this.collisionRadius, this.collisionHeight, this.collisionRadius);
        // 底面贴着小狗脚下，而不是世界原点：地面高度是扫描出来的（见
        // Octomap3dPcdGrille.groundLevel），写死 0 会让整个碰撞体悬在
        // 地面之上——扫描的地板压在 y=0 以下时，狗站在地上而圆柱浮在空中。
        this.collisionVolume.position.set(dog.position.x, dog.position.y + this.collisionHeight / 2, dog.position.z);
        this.collisionArrow.visible = true;
        this.collisionArrow.scale.setScalar(this.collisionRadius);
        // 贴着地面画（和选择环同高），避免和地面 z-fighting。
        this.collisionArrow.position.set(dog.position.x, dog.position.y + 0.02, dog.position.z);
        this.collisionArrow.quaternion.setFromAxisAngle(UP, this.headingRadians());
    }
    update(delta) {
        if (!this.dog || !this.walking || this.paused) {
            return;
        }
        this.traveled = Math.min(this.traveled + DOG_SPEED * delta, this.totalLength);
        this.updateDogPosition();
        if (this.traveled >= this.totalLength) {
            this.walking = false;
            // 走到终点停下：朝向复位，不再停在最后一段的偏航上。
            this.resetHeading();
        }
        this.emitWalkState();
    }
    /** 把小狗放到路径上指定距离处，并朝向切线方向。 */
    updateDogPosition() {
        if (!this.dog) {
            return;
        }
        const point = this.positionAt(this.traveled);
        this.dog.position.set(point[0], point[1], point[2]);
        // 朝向行进方向（小狗的前方是 +X）：略微向前看一点。
        const ahead = this.positionAt(Math.min(this.traveled + 0.05, this.totalLength));
        const dx = ahead[0] - point[0];
        const dy = ahead[1] - point[1];
        const dz = ahead[2] - point[2];
        if (dx * dx + dy * dy + dz * dz > 1e-8) {
            const direction = new THREE.Vector3(dx, dy, dz).normalize();
            this.dog.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), direction);
        }
        this.updateSelectionRing();
    }
    /** 插值出路径上指定距离处的世界坐标点。 */
    positionAt(distance) {
        if (this.path.length === 0) {
            return [0, 0, 0];
        }
        if (distance <= 0) {
            return this.path[0];
        }
        let remaining = distance;
        for (let i = 0; i < this.path.length - 1; i++) {
            const segment = this.segmentLengths[i];
            if (remaining <= segment || i === this.path.length - 2) {
                const a = this.path[i];
                const b = this.path[i + 1];
                const t = segment > 0 ? Math.min(1, remaining / segment) : 0;
                return [
                    a[0] + (b[0] - a[0]) * t,
                    a[1] + (b[1] - a[1]) * t,
                    a[2] + (b[2] - a[2]) * t,
                ];
            }
            remaining -= segment;
        }
        return this.path[this.path.length - 1];
    }
    /** 把当前进度 + 状态推送给订阅者。 */
    emitWalkState() {
        const state = this.path.length < 2
            ? 'idle'
            : this.paused
                ? 'paused'
                : this.walking
                    ? 'walking'
                    : 'ready';
        const progress = this.totalLength > 0 ? this.traveled / this.totalLength : 0;
        this.walkStateChanged.next({ progress, state, headingLocked: this.headingLocked });
    }
    static ɵfac = i0.ɵɵngDeclareFactory({ minVersion: "12.0.0", version: "21.2.26", ngImport: i0, type: Octomap3dPcdDog, deps: [{ token: Octomap3dPcdGlobal }], target: i0.ɵɵFactoryTarget.Injectable });
    static ɵprov = i0.ɵɵngDeclareInjectable({ minVersion: "12.0.0", version: "21.2.26", ngImport: i0, type: Octomap3dPcdDog });
}
i0.ɵɵngDeclareClassMetadata({ minVersion: "12.0.0", version: "21.2.26", ngImport: i0, type: Octomap3dPcdDog, decorators: [{
            type: Injectable
        }], ctorParameters: () => [{ type: Octomap3dPcdGlobal }] });

/**
 * PCD 解析器与 Octomap3dPcdComponent 之间共享的数据契约。
 */
/**
 * `assets/config/octomap.config.json` 里必须出现的键，也就是
 * {@link OctomapMapSettings} 的全部。
 *
 * 类型写成 `(keyof OctomapMapSettings)[]` 是为了抓错别字：写一个不存在的键名直接是
 * 编译错。另一头（漏项、以及「文件里真写了这些键没有」）编译期看不见，由
 * `config.service.spec.ts` 拿真实的 JSON 对账。
 */
const MAP_CONFIG_KEYS = [
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
const DEFAULT_OCTOMAP_SETTINGS = {
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
};

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
const MAX_FREE_CELLS = 8_000_000;
/**
 * 导航网格的分辨率（世界单位），固定不变，与用于渲染的体素大小无关。保持这个精细
 * （且固定）的分辨率，意味着无论绘制的体素多粗，门和狭窄缝隙对规划器都仍然可见。
 *
 * 注意它现在和默认的 `voxelSize` 数值相同（都是 0.05），但这仍然只是巧合——本常量
 * 不从 `voxelSize` 推导，也不跟着它变。
 */
const NAV_CELL_SIZE = 0.05;
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
const CELL_SAFETY = NAV_CELL_SIZE / 2;
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
function navGridSize(bbox, start, goal, dogRadius) {
    const cell = NAV_CELL_SIZE;
    // 第二项是**世界单位**的膨胀半径（碰撞半径 + 安全余量）再加 2 格通道。改动前
    // 这里是格数 `(ceil(r / cell) + 2) * cell`——膨胀圈数被量化过的那个数。现在膨胀
    // 是精确距离场，不再有「圈数」，量化的台阶也从这条链路上消失了。
    const margin = Math.max(Math.max(bbox.size[0], bbox.size[2], 1e-3) * 0.15 + cell * 2, dogRadius + CELL_SAFETY + cell * 2);
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

/**
 * 同一个 run 内相邻两点的最大竖直间距（世界单位）。
 *
 * 扫描出来的地面自带 1~3 cm 的起伏（见 `Octomap3dPcdPathPlanner` 里 `MIN_STEP_HEIGHT` 的
 * 注释），不合并的话一个平面会被噪声切成好几层，小狗在同一个地板上会有几十个
 * 「不同的高度」。
 *
 * 取 3 cm 是两头权衡：再小 → 噪声把平面切碎；再大 → 桌面会和它底下那层并成一块，
 * 于是「站在桌上」和「站在桌下」变成同一个 run。
 *
 * 可站判定里也用同一个值当「连成一片」的容差（{@link Octomap3dPcdNavSurface.standable}）：
 * 一个 run 的底端离局部表面比这更近，就算是我脚下的面的一部分，而不是悬空的一块。
 */
const RUN_GAP = 0.03;
/**
 * 跨越候选的**格距**上限，12 格 = 0.6 m（{@link OctomapNavConfig.crossWidth}）。
 *
 * 设置面板的滑杆最大只到 0.3 m（6 格），这里是给手改配置文件留的兜底：格距每加一格，
 * 每个节点要枚举的候选邻居数按平方涨（`π·d²`），而 A* 每扩展一个节点都要走一遍，
 * 顺着它涨下去就是页面卡死。超出的部分**砍掉**而不是报错——它是个性能护栏，不是语义
 * 的一部分。
 */
const MAX_CROSS_CELLS = 12;
/**
 * 直线段算「贴着表面走」的竖直容差（米），只用在 {@link Octomap3dPcdNavSurface.segmentClear}。
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
 * {@link OctomapMapSettings.fillBaseCells} 的上限（格）：认领高度最多拿多大的邻域当基准。
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
function fillEmptyColumns(colLo, nx, nz, occupied, baseCells) {
    const cellCount = nx * nz;
    const out = new Float32Array(cellCount).fill(NaN);
    if (occupied === 0 || occupied === cellCount) {
        // 两个「可证明」的恒等域，直接短路，连 BFS 都不必跑：一个源都没有（点云还没
        // 载入、或全在网格外）时没有任何东西可认领；全都有点时空列根本不存在。
        return out;
    }
    const radius = Math.max(FILL_RADIUS_MIN, Math.min(FILL_RADIUS_MAX, Math.ceil(Math.sqrt(cellCount / occupied) / 2)));
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
                    if (cand < out[n] - 1e-9 ||
                        (Math.abs(cand - out[n]) <= 1e-9 && src[cur] >= 0 && src[cur] < src[n])) {
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
class Octomap3dPcdNavSurface {
    nx;
    nz;
    minX;
    minZ;
    cell;
    groundLevel;
    /** run 的下端点（世界 Y），按 run id 索引。 */
    lo;
    /** run 的上端点。**上端点就是站上去以后脚下的那个高度**。 */
    hi;
    /** 每列 run 的 id 区间：列 `c` 的 run 是 `[runOffset[c], runOffset[c + 1])`。 */
    runOffset;
    /** run 所在的列（格索引 `ix + iz * nx`）。反查列是热路径，值得这 4 字节。 */
    cellOf;
    /** 1 = 这列一个点都没有，是 {@link build} 补出来的虚拟地面。 */
    virtualRun;
    config = null;
    /** 可站判定的记忆：0 未知 / 1 可站 / 2 不可站。按 run id 索引。 */
    standableMemo;
    /** 净空判定要扫的邻域偏移（格），在 {@link configure} 里按半径算一次。 */
    discDx = new Int32Array(0);
    discDz = new Int32Array(0);
    /** 跨越宽度的候选偏移——{@link forEachNeighbor} 在八邻之外多走的那一圈。 */
    crossDx = new Int32Array(0);
    crossDz = new Int32Array(0);
    /** 第 `k` 个跨越偏移要跨过的中间格，在下面三个数组里的区间是 `[k, k+1)`。 */
    crossMidOffset = new Int32Array(1);
    crossMidDx = new Int32Array(0);
    crossMidDz = new Int32Array(0);
    /** 中间格在跨段上的位置比例（0 = 起点那列，1 = 终点那列），用来插值脚下的高度。 */
    crossMidT = new Float32Array(0);
    /** 点云包围盒占的格范围，`groundExtendsOutside` 为 false 时用来封边。 */
    bx0 = 0;
    bx1 = -1;
    bz0 = 0;
    bz1 = -1;
    get nodeCount() {
        return this.hi.length;
    }
    constructor(nx, nz, minX, minZ, cell, groundLevel, lo, hi, runOffset, cellOf, virtualRun) {
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
     * `fillBaseCells` 是设置里的「填充基准范围」（见 {@link OctomapMapSettings.fillBaseCells}），
     * 只在 `fillFromNeighbors` 打开时有意义：它放大那道高度守卫的**基准邻域**，于是更
     * 多的空列会因为「认领到的面比这一带的本地地面高太多」而被拒、退回 `groundLevel`。
     * 它是**建图参数**，跟 `step` / `crossWidth` 那些不同——后者要到 `configure` 才拿得到，
     * 而填充在 `build` 里就把高度定死了（这也是 `FILL_MAX_RISE` 刻意不跟 `step` 挂钩的
     * 原因之一，见那条注释的末段）。
     */
    static build(positions, nx, nz, minX, minZ, cell, groundLevel, fillFromNeighbors = false, fillBaseCells = DEFAULT_OCTOMAP_SETTINGS.fillBaseCells) {
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
        return new Octomap3dPcdNavSurface(nx, nz, minX, minZ, cell, groundLevel, loBuf.slice(0, runCount), hiBuf.slice(0, runCount), runOffset, cellBuf.slice(0, runCount), virtualBuf.slice(0, runCount));
    }
    /**
     * 换一套小狗参数（碰撞半径、通行高度、跨越高度、地面范围、禁行列）。
     *
     * 单独一个方法而不是塞进 {@link build}：run 的结构只跟点云走，而参数每次拖滑块
     * 都在变。分开之后调用方能缓存 build 的结果，只重跑这一步。
     */
    configure(config) {
        this.config = config;
        // 判定结果全部作废。长度够就复用（拖滑块时不必重新分配），不够才新建。
        if (this.standableMemo.length < this.nodeCount) {
            this.standableMemo = new Uint8Array(this.nodeCount);
        }
        else {
            this.standableMemo.fill(0);
        }
        const r = config.clearanceRadius / this.cell;
        const reach = Math.ceil(r);
        const r2 = r * r;
        const dxs = [];
        const dzs = [];
        for (let dz = -reach; dz <= reach; dz++) {
            for (let dx = -reach; dx <= reach; dx++) {
                // `<=` 而不是 `<`：判据要与「以格心为心、半径 (r + 安全余量)/cell 的浮点圆盘」
                // 逐位相同（碰撞半径滑块上的一厘米要真的是一厘米），见 `octomap-3d-pcd-path-grid.ts`
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
        }
        else {
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
    buildCrossOffsets(crossWidth) {
        const limit = Math.min(1 + Math.max(crossWidth, 0) / this.cell, MAX_CROSS_CELLS);
        const reach = Math.ceil(limit);
        const dxs = [];
        const dzs = [];
        const midDxs = [];
        const midDzs = [];
        const midTs = [];
        const offsets = [0];
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
    worldOf(runId) {
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
    standable(runId) {
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
     * 八邻之外还有一圈**跨越**的邻居（{@link OctomapNavConfig.crossWidth}）：格距在
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
    forEachNeighbor(runId, visit) {
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
    crossClear(cx, cz, h, targetH, k) {
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
            if (!cfg.groundExtendsOutside &&
                (x < this.bx0 || x > this.bx1 || z < this.bz0 || z > this.bz1)) {
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
     * 用途是**把锯齿拉直**（见 `Octomap3dPcdPathPlanner` 的 `SMOOTH_CHORD_CELLS`）：A* 的
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
    segmentClear(from, to) {
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
            if (!cfg.groundExtendsOutside &&
                (ix < this.bx0 || ix > this.bx1 || iz < this.bz0 || iz > this.bz1)) {
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
            }
            else {
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
    mapPoint(x, y, z) {
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
     * 签名被 spec 压着不能动。调用方见 `Octomap3dPcdPathPlanner.plan` 里 `goalTooHigh` 那段。
     */
    columnTop(x, z) {
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
    scanRings(fx, fz, r0, r1, visit) {
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
    testStandable(runId) {
        const cfg = this.cfg;
        const cell = this.cellOf[runId];
        if (cfg.banned && cfg.banned[cell]) {
            return false;
        }
        const ix = cell % this.nx;
        const iz = (cell / this.nx) | 0;
        if (!cfg.groundExtendsOutside &&
            (ix < this.bx0 || ix > this.bx1 || iz < this.bz0 || iz > this.bz1)) {
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
    get cfg() {
        const cfg = this.config;
        if (!cfg) {
            throw new Error('Octomap3dPcdNavSurface 还没 configure 就被查询了');
        }
        return cfg;
    }
}

/** A* 开放集合使用的最小二叉堆。 */
class MinHeap {
    compare;
    items = [];
    constructor(compare) {
        this.compare = compare;
    }
    get size() {
        return this.items.length;
    }
    push(item) {
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
    pop() {
        if (this.items.length === 0) {
            return undefined;
        }
        const top = this.items[0];
        const last = this.items.pop();
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
const MIN_STEP_HEIGHT = 0.01;
/**
 * 一条**跨越边**（格距 ≥ 2 格，见 `Octomap3dPcdNavSurface` 的 `crossWidth`）的额外代价，
 * 单位是格。
 *
 * 不加这一项，A* 对「走过去」和「跳过去」是**无所谓**的：边权是格心之间的水平距离，
 * 一次 3 格的跨越和三次 1 格的迈步都是 3。而跨越那一段只按墙规则采样（见
 * `Octomap3dPcdNavSurface.crossClear`），**不做**脚印判定，比走更松——于是泛化成本一样、
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
 * {@link Octomap3dPcdNavSurface.segmentClear} 约束，所以别往长了放。
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
/** 什么都没规划出来时的那份结果（五个字段都取空值）。 */
function emptyPlan() {
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
 * `OctomapMapSettings.pathAlgorithm` 能选：现有那条（每列一个常数虚拟地面）与新的
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
 * 里直接 `new` 就能跑，和 `Octomap3dPcdVoxelGrid` / `Octomap3dPcdNavSurface` 一个路子。
 */
class Octomap3dPcdPathPlanner {
    /** 上一次建的表面图，键见 {@link navSurface}。 */
    surface = null;
    surfaceKey = null;
    /**
     * 「小狗这一坨整个悬在地面之上」的判据里，`lowest` 允许比 `groundLevel` 高出多少。
     *
     * 这个门槛**不是**随便留的余量：它成立的前提是「虚拟地面 run 一定落在 `groundLevel`
     * 上」，于是「这一坨里有没有贴地的列」等价于「`lowest` 够不够得着 `groundLevel`」。
     * 默认给一格（`cell`）——地面自己的噪声有一两厘米，门槛取 0 会把站在地面上的小狗
     * 也判成悬空。
     *
     * `'cloudFit'` 必须覆盖它：填充过的空列读的是**局部**地板高度，上面那条等价关系就
     * 断了（见 {@link Octomap3dPcdPathCloudFit.islandFloatMargin}）。
     */
    islandFloatMargin(cell, _step) {
        return cell;
    }
    /**
     * 规划一条从 `start` 到 `goal`（世界坐标）的路线，避开所有占用的体素。
     *
     * 步骤是：建表面图 → 起终点各吸附到一个能站的节点 → 在节点图上 A* → 落回世界
     * 坐标 → 拉直。前两步和第三步都在 `Octomap3dPcdNavSurface` 里，落回坐标与拉直在这里。
     *
     * 这里**什么都不记在实例上**（除了表面图缓存）：结果整份返回，由调用方决定怎么
     * 用它。所以同一个规划器可以被连着调、被两个不同的起点终点交叉调，互不干扰。
     */
    plan(req) {
        const step = Math.max(req.maxStepHeight, MIN_STEP_HEIGHT);
        const cell = req.cell;
        const surface = this.navSurface(req.positions, req.nx, req.nz, req.minX, req.minZ, cell, req.groundLevel, req.fillBaseCells);
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
        // 终点**浮在半空**吗（见 `OctomapPathFailureReason` 的 `goalTooHigh`）。
        //
        // 不拦的话它会被**静默地**变成一条成功的路边小事：`mapPoint` 第 3 段把终点一路
        // 吸附到地面上，路径忠实地走到终点正下方，于是 `0.139 m < goalRadius 0.5 m`
        // → **报成功**。真图上量到过一条这样的「成功」：7 个顶点全在 Y = −6.836，终点
        // 在 Y = −1.020，丢了 5.816 m。（`findPath` 现在对浮空终点量**三维**，这一条
        // 已经不会再漏成「成功」；仍然报 `goalTooHigh` 是为了给出**这一句**建议——只说
        // 「末端离终点 5.8 m」会把用户引到「终点范围」那根滑杆上去。）
        //
        // 「那一列有没有面接着终点」——量一次、两处用：这儿判 `goalTooHigh`，调用方判
        // 接受范围量几维（见 `OctomapPathPlan.goalOnFace`）。它是下面第 1 条的**取反**，
        // 所以两处的容差天生一致，不会出现「这边说浮空、那边说在面上」。
        //
        // 容差**取 `cell` 不是随手取的**——它正是 `mapPoint` 第 1 段认「点到的那个面」
        // 用的容差（`|hi − Y| <= cell`），所以这条判据不可能跟吸附的结果打架：吸附认下来
        // 的那个面，这里一定不判它浮空。容差也**必须这么小**，否则「终点比那一列最高的
        // 面只高出一格多」这种正是要拦的情形会漏过去。`columnTop` 越界时给 `-Infinity`，
        // 于是那儿连面都没有 → `goalOnFace` 为 false。
        const goalOnFace = req.goal[1] <= surface.columnTop(req.goal[0], req.goal[2]) + cell;
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
        let heightGap = null;
        let dogStuck = false;
        let nodes = this.astarNodes(surface, startNode, goalNode);
        if (!nodes) {
            // 当终点落在墙上或墙后、或落在小狗进不去的房间里时，它吸附到的那个节点
            // 可能不可达。此时改为吸附到从起点真正可达的最近节点，而不是放弃，这样
            // 只要小狗站得住，就总能给出一条路线。
            const { node: reachable, lowest } = this.nearestReachableNode(surface, startNode, req.goal[0], req.goal[2]);
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
            }
            else if (lowest > req.groundLevel + this.islandFloatMargin(cell, step) &&
                // 还得**确认真的是小狗站在那儿**：搜索是从碰撞体前方的探测点起算的（见
                // `Octomap3dPcd.findPath` 里的 frontPosition），它可能落在小狗旁边的一级
                // 台沿上——小狗自己站在地板上，探测点却在 0.52 m 的坎上。那时按这个探测点报
                // 「小狗站在离地 0.52 m 的地方」是在说一件用户看不见的事，而原来的「差 X m」
                // 才是对的（量过：真图上就有两条这样的行，两种口径差 0.48 m）。
                //
                // 判据取「探测点落到的那个面就在小狗脚下这个高度」：表面优先摆放时两者本来
                // 就重合（差在噪声以内），探测点悬在台沿外时则相差一个坎的高度。
                Math.abs(surface.hi[startNode] - req.start[1]) <= cell) {
                // 另一面：卡住的不是终点，是**小狗自己**。它这一片最低的节点也高过地面一格
                // 以上，就是说它站的那一坨整个悬在地面之上，往任何一个方向下去都超过跨越
                // 高度——桩子顶、垛子、柜面。`placeOnGround` 是表面优先的，正好容易把它放在
                // 这种地方：用户点的两个点明明一样高、看着就在同一层，图上却是两个互不相通
                // 的小岛（真图上这一档 8/8 都是这个原因，每个小岛 2~118 个节点，都够不到地面）。
                //
                // 报的是**小狗自己离地多高**（`start[1]`，用户眼睛看到的那个高度），不是终点与
                // 哪个面的差：这种情形里两头齐平，差出来接近 0，说了等于没说。而这个数是「它在
                // 多高的地方下不来」，**不是**滑杆该拖到的位置——真图上量过（见
                // `Octomap3dPcdPath.dogStuck`）：要 0.69~0.77 m 才通，小狗离地却只有
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
     * 顶点仍然用它后面的邻点保证过——{@link Octomap3dPcdNavSurface.segmentClear} 就是那条判据。
     *
     * 保留的第一个点是 A* 的起点（小狗身前那个探测点），最后一个点是终点；中间的锯齿都是
     * 等价的走法，换掉不影响「这条路能不能走」。**代价也不再是最优的那条**：拉直只会让
     * 折线变短（省掉的都是绕出来的长度），所以它不会比 A* 的结果更长。
     */
    smoothPath(surface, points) {
        if (points.length <= 2) {
            return points;
        }
        // 弦长上限按**实际走过的距离**量，不是按顶点个数：一条跨越边就能跨 12 格，按个数
        // 数的话 12 个顶点最长能拉出 7 m 的弦。
        const maxChord = SMOOTH_CHORD_CELLS * surface.cell;
        const out = [points[0]];
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
    onSurface(surface, node) {
        const band = surface.hi[node];
        const seen = new Set([surface.cellOf[node]]);
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
     * 的参数：点云换了，`Octomap3dPcd.rebuild()` 会把 `positions` 换成新引用，
     * 键自然失效；网格随起终点或边距变化（见 `navGridSize`）时格数与原点一变，
     * 也一样失效。
     *
     * 小狗参数（跨越高度、碰撞半径、禁行列…）**不在键里**：它们走
     * {@link Octomap3dPcdNavSurface.configure}，那一步只重算可站判定，比重建便宜得多。
     *
     * 缓存挂在**实例**上，所以每个算法各持一份：`'surfaceGraph'` 和 `'cloudFit'` 建出来
     * 的表面图本来就不同，键里不需要再放算法名。代价是同时用过两种算法时两份都常驻
     * （8M 列那档约 13 MB），所以外壳是按需建的，不会一上来把两个都 `new` 出来。
     */
    navSurface(positions, nx, nz, minX, minZ, cell, groundLevel, fillBaseCells) {
        const key = this.surfaceKey;
        const cached = this.surface;
        if (cached &&
            key &&
            key.positions === positions &&
            key.nx === nx &&
            key.nz === nz &&
            key.minX === minX &&
            key.minZ === minZ &&
            key.cell === cell &&
            key.groundLevel === groundLevel &&
            key.fillBaseCells === fillBaseCells) {
            return cached;
        }
        const surface = this.buildSurface(positions, nx, nz, minX, minZ, cell, groundLevel, fillBaseCells);
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
     * `Octomap3dPcdVoxelGrid.remove`），刷满场时两者一样，没刷过时这个是零成本。
     */
    bannedColumns(grid, nx, nz, minX, minZ, cell) {
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
    astarNodes(surface, startNode, goalNode) {
        const nx = surface.nx;
        const goalCell = surface.cellOf[goalNode];
        const goalX = (goalCell % nx) + 0.5;
        const goalZ = ((goalCell / nx) | 0) + 0.5;
        const heuristic = (node) => {
            const cell = surface.cellOf[node];
            return Math.hypot((cell % nx) + 0.5 - goalX, ((cell / nx) | 0) + 0.5 - goalZ);
        };
        const count = surface.nodeCount;
        const gScore = new Float32Array(count).fill(Infinity);
        const cameFrom = new Int32Array(count).fill(-1);
        const closed = new Uint8Array(count);
        gScore[startNode] = 0;
        const open = new MinHeap((a, b) => a[0] - b[0]);
        open.push([heuristic(startNode), startNode]);
        while (open.size > 0) {
            const [, current] = open.pop();
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
                const tentative = currentG +
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
        const nodes = [];
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
    nearestReachableNode(surface, startNode, goalX, goalZ) {
        const nx = surface.nx;
        const distanceSq = (node) => {
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

/**
 * 第二种寻路：表面图还是同一张，只是**虚拟地面不用常数了**——每个没点的列从切比雪夫
 * 距离最近的、有点的列认领它的面高（见 `Octomap3dPcdNavSurface.build` 的 `fillFromNeighbors`）。
 *
 * 与 {@link Octomap3dPcdPathSurfaceGraph} 的关系是**只差建图这一步**：搜索、平滑、
 * 起终点吸附、失败判定全是基类那一份。要不要它取决于用户想量哪件事——`'surfaceGraph'`
 * 答的是「在名义地面上怎么走」，它答的是「**在云点这张面上**怎么走」，于是铲平坑洼、
 * 补全一片云点会直接反映到路线上。
 *
 * 两个已知的取舍，选它之前要知道：
 *
 * - **补的是缺口，不是重建地板**。填充只覆盖有点的列 `R` 格之内（半径按点云自己的稀疏
 *   度推，真图上是 2 格、覆盖空列的 13.7%），远离任何点的地方仍旧退回 `groundLevel`。
 *   所以整片没扫到的房间不会因为切到这一档就长出地板来。
 * - **可站判定的墙带整体上移**。虚拟地面从 `groundLevel` 抬到真实地板的高度（真图上
 *   0.17 m）之后，`(面高 + 跨越高度, 面高 + 通行高度]` 那道「挡路但不挡头」的墙带跟着
 *   上移，于是哪些家具开始挡路会变（`q:\tmp` 上量过的那道悬崖，见 nav-wall-band-cliff）。
 *   这是这个算法**想要**的后果，但它意味着路线会与另一档不同，不算回归。
 */
class Octomap3dPcdPathCloudFit extends Octomap3dPcdPathPlanner {
    algorithm = 'cloudFit';
    /** 与基类的差别只有那个 `true`：打开「空列从邻居取面高」。 */
    buildSurface(positions, nx, nz, minX, minZ, cell, groundLevel, fillBaseCells) {
        return Octomap3dPcdNavSurface.build(positions, nx, nz, minX, minZ, cell, groundLevel, true, fillBaseCells);
    }
    /**
     * 门槛从「一格」换成「一个跨越高度」，因为填充把基类那条前提拿掉了：
     * 基类的判据是「这一坨里有没有高度 ≈ `groundLevel` 的列」，而填充过的空列读的是
     * **局部**地板高度（真图上 0.3 m 上下），不再是 `groundLevel`。
     *
     * 后果是真图上的**假阳性**：小狗站在一片连通性不好的真实地板上（0.3 m），它的岛里
     * 一个贴 `groundLevel` 的列都没有，`lowest − groundLevel = 0.36 m > 一格` 成立 →
     * 报「小狗站在离地 0.36 m 的地方下不来」，而它明明站在地板上。
     *
     * 换成跨越高度之后判的是**这件事本身**：从这一坨最低的面下去、够不够得着名义地面。
     * `lowest − groundLevel > 跨越高度` 就是这只狗迈不下去，与文案给的建议（「把它挪到
     * 地面上」）口径一致；而 `groundLevel` 与真实地板之间那 0.17 m 的落差不再顶到门槛上。
     *
     * 副作用是「矮一点的高台不再报 `dogStuck`」（比如离地 0.4 m 而跨越高度 0.5 m）——那
     * 情形下小狗本来就迈得下去，不报才对。
     */
    islandFloatMargin(_cell, step) {
        return step;
    }
}

/**
 * 现有那条寻路：**每列一个常数虚拟地面**的表面图上做 A*。
 *
 * 这是从 `Octomap3dPcdPath` 里原样搬过来的那一套，行为一个字节没动（重构前后
 * 的真图基线逐点相同，见 `q:\tmp\path-baseline.mjs`）。保留它不只是为了对照：它带来
 * 的两件事是别的建图方式不好替代的——空列一定有节点（`groundExtendsOutside` 因此
 * 能工作，小狗可以绕到建筑外面去），以及平面上的代价处处相同（因此不会为了抄近路
 * 而跳着走）。
 *
 * 它的代价则记在 {@link OctomapPathAlgorithm} 上：那些虚拟地面 run 的高度是个**常数**，
 * 跟它旁边有没有地板无关。
 */
class Octomap3dPcdPathSurfaceGraph extends Octomap3dPcdPathPlanner {
    algorithm = 'surfaceGraph';
    /**
     * 末位那个 `fillBaseCells` **收下但不用**：这一档根本不填（`fillFromNeighbors` 关着），
     * 没有认领高度、也就没有那道「拿多大邻域当基准」的守卫。参数留着只是为了满足基类的
     * 签名——按算法的实际需要收参数，比在基类上开一个「哪些算法用得上」的开关干净。
     */
    buildSurface(positions, nx, nz, minX, minZ, cell, groundLevel, _fillBaseCells) {
        return Octomap3dPcdNavSurface.build(positions, nx, nz, minX, minZ, cell, groundLevel);
    }
}

/**
 * 终点锥和路径管相对小狗碰撞足迹的比例。系数取自改动前写死的尺寸与默认足迹
 * （碰撞半径 0.25、通行高度 0.8）之比——锥底半径 0.15/0.25、管半径 0.05/0.25，
 * 所以默认参数下算出来的尺寸和当时一模一样，只是从此跟着「碰撞半径」滑动条走。
 */
const CONE_RADIUS_RATIO = 0.6;
const TUBE_RADIUS_RATIO = 0.2;
/**
 * 路径点珠子相对路径管的半径比。取 1 就正好和管子一样粗，而球心与管轴重合——那是
 * **埋在管子里面**、一个像素都看不见。1.8 让珠子从管壁上鼓出来一圈，像绳子上的结。
 */
const PATH_POINT_RADIUS_RATIO = 1.8;
/**
 * 终点锥的高径比，沿用旧锥的 0.4 / 0.15。锁住形状是为了让锥只看碰撞半径：半径
 * 一路调小，锥等比缩小，而不会摊成一个饼。
 */
const CONE_ASPECT = 0.4 / 0.15;
/**
 * 场景下限：装饰不小于渲染体素的这个倍数。大场景的体素颗粒本身就有几十厘米，
 * 装饰比它还细就看不见了；小场景这一项通常取不到，尺寸全由小狗决定。
 */
const CONE_VOXEL_RATIO = 0.6;
const TUBE_VOXEL_RATIO = 0.4;
/**
 * 终点范围圆环的段数。它是单位圆再靠 scale 缩放的，段数只决定圆看着有多圆；
 * 64 段让默认半径下每段约占屏幕 6 px，肉眼看不出折角。
 */
const GOAL_RANGE_SEGMENTS = 64;
/**
 * 规划上限范围那条边界线的颜色：平时是一个中性的灰（它只是又一次「参考物」，
 * 该像参考网格那样退到背景里），超限时换成洋红——要和旁边的用色都能区分开：
 * 终点范围是青 `#22d3ee`、路径是黄 `#facc15`、障碍是红 `#ef4444`、碰撞体是
 * 橙 `#f97316`。洋红是这套色板里唯一还没被占的醒目色。
 */
const NAV_LIMIT_COLOR = '#94a3b8';
const NAV_LIMIT_EXCEEDED_COLOR = '#d946ef';
// 小狗的碰撞半径和通行高度来自设置，因此可以缩小半径来打开狭窄的门洞（或降低
// 高度以从低矮的悬空物下方钻过）。
/**
 * 持有导航终点、渲染出的路径，以及**这一次**规划的失败缘由。
 *
 * 规划本身**不在这里**：真正搜路的是一组 `Octomap3dPcdPathPlanner`，按
 * {@link OctomapMapSettings.pathAlgorithm} 选一个（见 {@link setAlgorithm}）。这个类
 * 是它们的外壳，管三件事：
 *
 * 1. **建网格参数**（{@link navGridSize}，与绘制规划范围框共用同一份推导）并判上限；
 * 2. **画和清**——终点锥、终点范围圆环、路径管、规划范围框（都在这个文件里，因为
 *    它们碰 THREE，而规划器不碰）；
 * 3. **失败缘由**——{@link navLimitExceeded} / {@link heightGap} / {@link dogStuck} /
 *    {@link goalTooHigh} 四个字段加 {@link failedReason}。规划器把后三个整份返回，
 *    这里无条件抄回。
 *
 * 拆开是因为「小狗走的那张面」现在是个**可选**的东西（见 {@link OctomapPathAlgorithm}），
 * 而搜索、平滑、起终点吸附那一套与它无关、且各自都有一堆量出来的坑，不该跟着复制。
 *
 * 不变的部分是每一步的「站不站得住」判据（「身子那一带不许有几何」，从**脚下的那个
 * 面**起量而不是从地面起量，见 `Octomap3dPcdNavSurface.standable`），以及一个旋钮同时管住
 * 上爬和下跳这件事。
 */
class Octomap3dPcdPath {
    global;
    /** 发出路径点数量（0 = 未找到，null = 已清除）。 */
    pathChanged = new Subject();
    /**
     * 寻路失败时发出，带上失败原因。
     *
     * 与 {@link pathChanged} 分工不同：那个是「画出来的路径变成了什么」的公共契约
     * （三态，任何变化都发），这个是「这次规划为什么没成」的一次性报告。父组件据此
     * 给出比一句笼统的「找不到路径」更有用的提示。
     */
    pathFailed = new Subject();
    /** 地面上的世界坐标终点位置，用作寻路目标。 */
    goalPosition = null;
    /**
     * 终点的接受范围半径。规划器**不用**它——它只决定「算出来的路径算不算成功」，
     * 由 {@link Octomap3dPcd.findPath} 读取判定，同时也是圆环的画法尺寸。
     * 与 {@link goalPosition} 一样公开只读：改它走 {@link setGoalRadius}。
     *
     * 初值直接取默认设置，不抄字面量：`Octomap3dPcdComponent.ngOnChanges` 在首次绑定
     * 时因为 `viewInitialized` 还是 false 而整个跳过，所以这里**必须**等于默认值，
     * 否则用户没动过这一项时就悄悄用了另一个数。
     */
    goalRadius = DEFAULT_OCTOMAP_SETTINGS.goalRadius;
    /**
     * 「填充基准范围」（单位：格），见 {@link OctomapMapSettings.fillBaseCells}；改它走
     * {@link setFillBaseCells}。
     *
     * 和 {@link goalRadius} 一样是**字段**而不是 {@link computePath} 的第 12 个位置参数：
     * 那个签名有「十一个位置参数、一条不增删」的约定（它被 spec 里的 `null as never` 和
     * `octomap-3d-pcd-path-straight.cases.ts` 依赖着），而这个设置与「这次查询用什么参数」不同，
     * 它是「这张表面图怎么建」——建完就缓存在规划器上，不进每次调用的参数表。
     *
     * 初值直接取默认设置，不抄字面量：`Octomap3dPcdComponent.ngOnChanges` 在首次绑定时因为
     * `viewInitialized` 还是 false 而整个跳过，所以这里**必须**等于默认值，否则用户没动过
     * 这一项时就悄悄用了另一个数。
     */
    fillBaseCells = DEFAULT_OCTOMAP_SETTINGS.fillBaseCells;
    /**
     * 上一次 {@link computePath} 是否因为规划网格超过 `MAX_FREE_CELLS` 而放弃。
     *
     * **每次调用都会重写**，所以不存在读到陈旧值的可能。用字段而不是改返回值：
     * `computePath` 返回 null 的原因有好几个（搜不到、端点吸附失败），而调用方只
     * 关心「这次是不是尺寸问题」——为它把返回值改成判别式联合会牵动一堆无关分支。
     *
     * 注意它说的是**那一次调用**，而不是「场景太大」：调用的网格还要算上起点和终点，
     * 所以终点摆得极远时它也会置位，而场景本身可能装得下。画出来的框用的是后一个
     * 判据（见 {@link navLimitRect}）。
     */
    navLimitExceeded = false;
    /**
     * 上一次 {@link computePath} 里「终点够不着」的**落差**（世界单位，取绝对值）；
     * 没发生就是 null。和 {@link navLimitExceeded} 一样**每次调用都会重写**。
     *
     * 只在「搜不过去、退到最近的可达节点」这条路上置位，两种情形取其一（见
     * {@link computePath}）：
     *
     * - **终点那一头够不着**（`gap`）：终点映射出的节点**站得住**、落在一片面上，而它与
     *   最近可达节点的高度差**超过了**这一次的跨越高度——小狗不是不知道终点在哪，是迈不
     *   上去那个台面。这个数**照着拖滑杆就有用**；
     * - **小狗这一头下不来**（`dogStuck`，见 {@link dogStuck}）：它自己站的那一片整个悬在
     *   地面之上，四周每个方向下去都超过跨越高度。这时量的是**小狗离地多高**，那是个
     *   说明，不是滑杆该拖到的位置。
     * - **终点吸到了地面上**（`goalTooHigh`，见 {@link goalTooHigh}）：终点**浮在那一列
     *   所有面之上**，最后落脚的节点（吸附到的那一个，或者 A* 够不着之后退而求其次的那
     *   一个）在地面上，丢掉的高度就是这个数。同样是「说明」——半空里没有面可迈，滑杆拖
     *   多大都不通。
     *
     * 第三种是**在吸附之后、搜索之前**就量出来的（前两种要等搜索失败），因为「吸掉了多少
     * 高度」这件事本身就是失败的理由：不拦的话路径会忠实地走到终点正下方，而调用方只量
     * 水平距离，于是报一条「成功」。（A* 够不着那一支在**搜索失败之后**再量一次，同一个
     * 判据、换一个高度，理由见 {@link goalTooHigh}。）
     *
     * 没超过就不置位：那说明落差一步就能迈过去，末端只是没走到那么准，`'outOfRange'`
     * 那句「差 X m」才是对的解释。判据放在这里而不是调用方，是因为只有这里知道这一次用
     * 的跨越高度。
     */
    heightGap = null;
    /**
     * 上一条那两种情形里，卡住的是**小狗自己**吗？与 {@link heightGap} 同时置位、同时
     * 清掉，只有它决定调用方报 `'gap'` 还是 `'dogStuck'`——两者的建议不同，见
     * {@link failedReason}。
     *
     * 判据是「从起点节点洪水填出来的那一片，**最低**的节点也在 `groundLevel` 之上超过一
     * 格」：它那一小片面整个悬空，怎么走都下不到地面。还要再确认一次「真的是小狗站在那儿」
     * （`hi[startNode]` 与小狗自己的高度差在一格以内），因为搜索是从碰撞体**前方**的探测
     * 点起算的，那个点可能落在小狗旁边的一级台沿上（见 {@link computePath} 里那段）。
     *
     * 这一句话覆盖不了的情形：**终点自己也在一座孤岛上**。那时「挪狗到地面」也到不了终点
     * （终点那一片从地面同样上不去），该动的是终点或者「跨越高度」。文案因此只说「再试」，
     * 不点名一个能拖到的数字、也不保证挪狗一定通——真图上量过的那一档（B.8，8/8 挪狗通）
     * 里，那些终点从地面爬得上去。
     */
    dogStuck = false;
    /**
     * 终点是不是**浮在那一列所有面之上**（点在半空里）？与 {@link heightGap} 一样每次
     * 调用都会重写。
     *
     * 它和 {@link dogStuck} 是同一层的开关：`heightGap` 只说明「差多少」，这一个决定
     * 调用方报 `'gap'` / `'dogStuck'` / `'goalTooHigh'` 里的哪一个——三者的建议不同，
     * 见 {@link failedReason}。
     *
     * 判据（放在 `Octomap3dPcdPathPlanner.plan` 里，只有那儿同时拿得到终点、列顶与跨越高度）
     * 是两条**与**关系：终点落脚的那个节点比终点低了一次跨越高度还多，**且**终点比那一列
     * 最高的面还高出一格。第二条是防误伤的那一条：点墙面时终点远高于它落到的地面、恒有
     * 第一条成立，但那时列顶（那堵墙）比终点高，第二条不成立——所以这个开关不会把「点墙
     * 面」打掉。
     *
     * 这**两条**在 `plan` 里量两处：一处量吸附节点（吸附当场就掉下去了），一处量 A* 够不
     * 着之后退而求其次的那个节点（吸附看着没事，但那个面走不到，真正落脚的在地面上）。
     * 只量第一处会漏掉后者：`mapPoint` 第 3 段可以跳到**隔壁列**一个可站的面上去，那时光
     * 看吸附甚至没有下降（真图上量到过 −0.019 m：往上跳），而退下来的落脚点离终点 5.8 m。
     */
    goalTooHigh = false;
    /**
     * 终点**有面接着**吗——它的 Y 落在那一列最高的那个面上（含一格容差）。与
     * {@link heightGap} 一样每次调用都会重写，由 `Octomap3dPcdPathPlanner.plan` 交付。
     *
     * {@link Octomap3dPcd.findPath} 拿它决定**接受范围量几维**：没有面接着终点时
     * 量三维（终点浮在半空，路径末端必须真的走到那个点上，停在正下方不算到），有面接着
     * 时只量水平（点墙面、点桌面这一类命中里，路径末端本来就该落在终点脚下的那个面上，
     * 竖直那一维归落差判据管）。理由详见那个方法，以及
     * `Octomap3dPcdPathPlanner` 里 `goalOnFace` 的注释。
     *
     * 它同时也是范围指示物的画法依据，见 {@link resizeGoalMarkers}。
     */
    goalOnFace = false;
    goalMarker = null;
    /**
     * 终点周围的接受范围指示物：三个同心圆（水平那个 + 两个竖直的）组成的球轮廓。
     *
     * 竖直那两个只在**终点浮在半空**时显示——那时接受范围是一个球；终点有面接着时
     * 竖直那一维根本不计入（见 {@link goalOnFace}），显示成球会骗人，只留水平那个圆。
     * 这个开关在 {@link resizeGoalMarkers} 里跟着 `goalOnFace` 走。
     */
    goalRange = null;
    pathLine = null;
    /**
     * 路径点的珠子（设置面板路径页那个「标出路径点」）。一次 `InstancedMesh` 画完全部顶点，
     * 见 {@link drawPathPointMarkers}。
     */
    pathPointMarkers = null;
    /** 场景里那根管子照着它画出来的折线；尺寸变了要照着原样重画，所以得留着。 */
    pathPoints = null;
    /** 规划上限范围那条边界线，平面水平、贴地。 */
    navLimitBox = null;
    /** 当前点云包围盒；画上限范围要用（它跟着点云变，所以得留着）。 */
    bounds = null;
    /** 边界线要贴的那层地面高度（跟路径、参考网格用的是同一个）。 */
    groundLevel = 0;
    /**
     * 设置面板上「显示规划范围」那个开关。超限时无视它，见 {@link refreshNavLimit}。
     *
     * 初值取默认设置而不是抄字面量（首次绑定会被 `ngOnChanges` 跳过，这里必须是那个
     * 默认值）；显式标注 `boolean` 则是因为 `DEFAULT_OCTOMAP_SETTINGS` 用 `satisfies`
     * 收尾、各值保留字面量类型，不标注就会被推成 `true`。
     */
    navLimitVisible = DEFAULT_OCTOMAP_SETTINGS.showNavLimit;
    /**
     * 设置面板路径页上「显示路径」那个开关的当前值。新画的管子按它决定露不露面（见
     * {@link drawPath}）——`setPathVisible` 只改得到**已经**画出来的那根。
     */
    pathVisible = DEFAULT_OCTOMAP_SETTINGS.showPath;
    /**
     * 设置面板路径页上「标出路径点」那个开关。
     *
     * 与 {@link pathVisible} **互不干涉**：那个只管管子，这个只管珠子（见
     * `OctomapMapSettings.showPathPoints`）。两个都是布尔显示开关，谁也管不着谁。
     *
     * 显式标注 `boolean`：`DEFAULT_OCTOMAP_SETTINGS` 用 `satisfies` 收尾、各值保留
     * 字面量类型，不标注就会被推成 `false`（那个默认值恰好是 `false`，于是写不进去
     * `true`）。
     */
    pathPointsVisible = DEFAULT_OCTOMAP_SETTINGS.showPathPoints;
    /** 小狗碰撞足迹的底面半径，装饰尺寸的主参考。 */
    dogRadius = 0.25;
    /** 小狗的通行高度，决定路径管悬浮的高度。 */
    dogHeight = 0.8;
    /** 渲染体素大小，装饰尺寸的下限；还没有网格时为 0。 */
    voxelSize = 0;
    /**
     * 当前选中的寻路方式，见 {@link setAlgorithm}。
     *
     * 初值取默认设置而不是抄字面量（首次绑定会被 `ngOnChanges` 跳过，这里必须是那个
     * 默认值）；标注 `OctomapPathAlgorithm` 则是因为 `DEFAULT_OCTOMAP_SETTINGS` 用
     * `satisfies` 收尾、各值保留字面量类型。
     */
    algorithm = DEFAULT_OCTOMAP_SETTINGS.pathAlgorithm;
    /**
     * 已经建出来的规划器，按算法缓存。
     *
     * 惰性建而不是构造时把两个都 `new` 出来：每个规划器各持一份自己的表面图缓存
     * （8M 列那档约 13 MB），而同一时刻只有一个在跑。缓存住实例是为了切回旧算法时
     * 不必重建表面图——用户来回对比两条路时，点云一动没动。
     */
    planners = new Map();
    constructor(global) {
        this.global = global;
    }
    /**
     * 更新终点锥与路径管的尺寸参考：小狗的碰撞足迹（半径、通行高度）和场景的
     * 渲染体素大小。
     *
     * 这两样装饰不该是固定尺寸——同一个 0.4 m 的锥，摆在 0.65 m 的椅子上占掉大半
     * 屏，放进几十米的扫描里又只是个小点。它们跟着碰撞足迹走，因为那是用户直接调
     * 的量（「碰撞半径」「通行高度」），也正是寻路里把障碍外扩、让小狗不蹭墙的同一
     * 个数（见 `OctomapPathGrid.CELL_SAFETY`）。体素大小只作下限，见 {@link CONE_VOXEL_RATIO}。
     *
     * 参数没变就直接返回：设置面板上任何一项改动都会走到这里，而为一次无关的重建
     * 重画一根几万个顶点的管不值得。
     */
    setScaleReference(dogRadius, dogHeight, voxelSize) {
        if (dogRadius === this.dogRadius &&
            dogHeight === this.dogHeight &&
            voxelSize === this.voxelSize) {
            return;
        }
        this.dogRadius = dogRadius;
        this.dogHeight = dogHeight;
        this.voxelSize = voxelSize;
        this.resizeGoalMarkers();
        // 碰撞半径还决定了网格的边距（见 navGridSize），所以上限范围也跟着它变。
        this.refreshNavLimit();
        // 管粗和悬浮高度都变了，已经画出来的那根得重画——拖动「碰撞半径」或「通行
        // 高度」时，它就是这么实时跟着变的。
        this.drawPath();
    }
    /**
     * 记住当前点云的范围（以及它贴着的那层地面），据此重画规划上限范围的边界线。
     *
     * 由 `Octomap3dPcd.rebuild()` 在点云变化后调用，跟 `alignGrid` / 地面平面
     * 是同一时机——三者都是「场景换了、参考物跟着换」。
     */
    setBounds(bbox, groundLevel) {
        this.bounds = bbox;
        this.groundLevel = groundLevel;
        this.refreshNavLimit();
    }
    /**
     * 设置面板上「显示规划范围」的开关。
     *
     * 只影响「平时画不画」：场景超限时无论如何都会画出来（见 {@link refreshNavLimit}），
     * 那正是这条线最有用的时刻，不能让它被一个显示开关挡住。
     */
    setNavLimitVisible(visible) {
        if (visible === this.navLimitVisible) {
            return;
        }
        this.navLimitVisible = visible;
        this.refreshNavLimit();
    }
    /**
     * 设置面板路径页上「显示路径」那个开关。
     *
     * **只动管子的 `visible`，不动 {@link pathPoints}**：关掉只是让它从画面上消失，规划
     * 结果还在，所以行进不受影响、打开时也不用重新规划。也不走 {@link drawPath} 重画一遍
     * ——那会白白丢掉并重建管子的几何（它是 `TubeGeometry`，顶点数按折线长度算），只是
     * 藏起来而已。
     *
     * 同值早返回的理由与 {@link setNavLimitVisible} 同：父组件的绑定在首次绑定时还会再补
     * 一次（`ngOnChanges` 跳过首次绑定）。
     */
    setPathVisible(visible) {
        if (visible === this.pathVisible) {
            return;
        }
        this.pathVisible = visible;
        if (this.pathLine) {
            this.pathLine.visible = visible;
        }
    }
    /**
     * 设置面板路径页上「标出路径点」那个开关：把折线的每个顶点标成一颗珠子。
     *
     * 与 {@link setPathVisible} 的**实现方式正好相反**，这不是不一致而是同一件事的两面：
     * 管子那一份几何与点数、尺寸都无关，藏起来就是对的做法；而珠子的**个数**就是点数、
     * **半径**就是尺寸参考，任何一头变了都得重建，没有「留着不画」的意义。所以这里走
     * {@link drawPathPointMarkers}，与管子同生共死（`render` / 尺寸变化都从那儿过）。
     *
     * 同值早返回的理由与 {@link setPathVisible} 同：父组件的绑定在首次绑定时还会再补一次
     * （`ngOnChanges` 跳过首次绑定）。
     */
    setPathPointsVisible(visible) {
        if (visible === this.pathPointsVisible) {
            return;
        }
        this.pathPointsVisible = visible;
        this.drawPathPointMarkers();
    }
    /**
     * 换一种寻路方式（设置面板上那个下拉，见 {@link OctomapPathAlgorithm}）。
     *
     * **不会自动重规划**：和这个面板上其它每一项一样，改完要重新点「找路径」才生效
     * （面板上那句提示说的就是这件事）。这里只决定下一次用哪个规划器。
     *
     * 同值早返回：设置面板上任何一项改动都会走到各个 setter，而父组件的绑定在首次
     * 绑定时还会再补一次（`ngOnChanges` 会跳过首次绑定）——不早返回就会白建一个
     * 规划器，连带一张表面图。
     */
    setAlgorithm(algorithm) {
        if (algorithm === this.algorithm) {
            return;
        }
        this.algorithm = algorithm;
    }
    /** 当前算法对应的规划器，按需建、建好留着（见 {@link planners}）。 */
    planner() {
        let planner = this.planners.get(this.algorithm);
        if (!planner) {
            planner = createPlanner(this.algorithm);
            this.planners.set(this.algorithm, planner);
        }
        return planner;
    }
    /**
     * 在地面上放置（或移动）终点标记——一个倒置的圆锥，外加标出接受范围的三个圆。
     *
     * 那三个圆不只是装饰：路径末端落在接受范围之外就会被判为寻路失败，用户得看得见这条
     * 边界在哪儿，才知道该把「终点范围」调多大。而且**范围是个球**（见 {@link goalOnFace}），
     * 所以画法也得跟着是球——竖直那两圈在终点浮空时才是判定的一部分，有面接着时收起来，
     * 详见 {@link resizeGoalMarkers}。
     */
    setGoal(position) {
        this.goalPosition = position;
        // 换了终点，上一次那个「有没有面接着」的判断就作废了（放终点不触发规划，要等
        // 用户按寻路）。先当作**浮空**——那是接受范围的一般形状（球），等下一次规划
        // 拿到真值再收成平环。宁可多画两圈，也别拿上一个终点的结论罩住这一个。
        this.goalOnFace = false;
        if (!this.goalMarker) {
            // 单位锥（底面半径 1、高 1），实际尺寸交给 scale，见 resizeGoalMarkers()。
            // rotateX(π) 把顶点翻到 −Y，锥尖朝下，好点在终点上。
            const geometry = new THREE.ConeGeometry(1, 1, 32);
            geometry.rotateX(Math.PI);
            const material = new THREE.MeshBasicMaterial({ color: '#22d3ee', depthTest: false });
            this.goalMarker = new THREE.Mesh(geometry, material);
            this.goalMarker.renderOrder = 1000;
            this.global.scene.add(this.goalMarker);
        }
        if (!this.goalRange) {
            // 三个单位圆（半径 1、64 段），同样交给 scale，见 resizeGoalMarkers()。三个
            // 圆共用「圆心在原点、半径 1」的写法，只是各自的平面不同：水平那个在 XZ 上，
            // 另两个分别绕 X、绕 Z 立起来，合起来读作一个球的轮廓。
            //
            // 用线而不是 RingGeometry：线的屏幕宽度恒为 1 px，半径调到下限（1 cm）也
            // 看得见；环形网格缩放后环宽跟着缩，1 cm 时环宽不到 1 mm，等于没有。顺带
            // 省掉「半径变了要重建几何」——缩放即可。
            const circle = (x, y, z) => new THREE.BufferGeometry().setFromPoints(Array.from({ length: GOAL_RANGE_SEGMENTS }, (_, i) => {
                const angle = (i / GOAL_RANGE_SEGMENTS) * Math.PI * 2;
                return new THREE.Vector3(x(angle), y(angle), z(angle));
            }));
            this.goalRange = new THREE.Group();
            for (const geometry of [
                circle(Math.cos, () => 0, Math.sin),
                circle(Math.cos, Math.sin, () => 0),
                circle(() => 0, Math.cos, Math.sin),
            ]) {
                const material = new THREE.LineBasicMaterial({ color: '#22d3ee', depthTest: false });
                const ring = new THREE.LineLoop(geometry, material);
                ring.renderOrder = 1000;
                this.goalRange.add(ring);
            }
            this.global.scene.add(this.goalRange);
        }
        this.resizeGoalMarkers();
    }
    /** 从场景中移除终点标记和范围圆环，并忘记终点位置。 */
    clearGoal() {
        this.goalPosition = null;
        if (this.goalMarker) {
            this.global.scene.remove(this.goalMarker);
            this.goalMarker.geometry.dispose();
            this.goalMarker.material.dispose();
            this.goalMarker = null;
        }
        if (this.goalRange) {
            this.global.scene.remove(this.goalRange);
            // 三个圆各有各的几何与材质，得逐个拆——`Group` 自己不持有这两样。
            for (const child of this.goalRange.children) {
                const ring = child;
                ring.geometry.dispose();
                ring.material.dispose();
            }
            this.goalRange = null;
        }
    }
    /**
     * 设置终点的接受范围半径（世界单位），圆环随之实时变。
     *
     * 参数没变就直接返回：设置面板上任何一项改动都会走到这里。
     */
    setGoalRadius(radius) {
        if (radius === this.goalRadius) {
            return;
        }
        this.goalRadius = radius;
        this.resizeGoalMarkers();
    }
    /**
     * 设置「填充基准范围」（单位：格）。
     *
     * 只记下来，**不重建表面图**：建图是 `plan()` 里按需做的，而这里正是它的缓存键里
     * 的一项（见 `Octomap3dPcdPathPlanner.navSurface`）——下次点「找路径」时键一对不上就自然
     * 重建，代价落在真正需要它的那一次调用上，而不是拖滑杆的每一帧上。
     *
     * 参数没变就直接返回：设置面板上任何一项改动都会走到这里。
     */
    setFillBaseCells(cells) {
        if (cells === this.fillBaseCells) {
            return;
        }
        this.fillBaseCells = cells;
    }
    /**
     * 根据有序的世界坐标点列表，将路径绘制（或清除）为一根粗管。粗细和悬浮高度
     * 由 {@link setScaleReference} 记下的参考尺寸算出，见 {@link tubeRadius}。
     */
    render(points) {
        this.clearLine();
        this.pathPoints = points && points.length >= 2 ? points : null;
        this.drawPath();
        this.pathChanged.next(points ? points.length : null);
    }
    /**
     * 刚跑完的这次 {@link computePath} 没给出可用路径时，该报哪个原因。
     *
     * 这是**唯一**能分出「找不到路径」各种缘由的地方：三个字段都在这里，而调用方手上只
     * 有一句话和一条折线。`'outOfRange'` 不在这里——那要等调用方量完末端离终点多远才知
     * 道，它比这里这几种都靠后。
     *
     * 顺序是有讲究的：尺寸超限时规划器压根没建图，落差必然是 null，可万一将来不是，报
     * 尺寸仍然更对——那是用户改参数也挪不动的根因（见 {@link navLimitExceeded}）。
     * {@link goalTooHigh} 紧跟在 {@link dogStuck} 之后，位置不算讲究（这两件事不可能同时
     * 成立：一个要求终点浮空，另一个要求吸附成功且终点节点就在小狗脚下那片）。
     */
    failedReason() {
        if (this.navLimitExceeded) {
            return 'tooLarge';
        }
        if (this.dogStuck) {
            return 'dogStuck';
        }
        if (this.goalTooHigh) {
            return 'goalTooHigh';
        }
        return this.heightGap !== null ? 'gap' : 'unreachable';
    }
    /**
     * 通知未找到可行进路线：清掉线、报告 0，并说明失败原因。
     *
     * `distance` 是路径末端到终点的距离，只有 `outOfRange` 有；另外两种压根没算出
     * 路径（或算了也没走到），无从谈起，传 null。落差（`gap`）直接读
     * {@link heightGap}，不从参数过——调用方必须紧接着 `computePath` 调它，否则
     * 读到的是上一次的落差。眼下的唯一调用方 `Octomap3dPcd.findPath` 就是这个
     * 顺序。
     *
     * 两个事件都在这里发，是「我们失败了」的**唯一出口**。顺序有讲究：父组件的
     * {@link pathChanged} 处理器会先把状态写成笼统的「找不到路径」，紧接着
     * {@link pathFailed} 用更具体的原因把它覆盖掉。
     */
    noPath(reason, distance) {
        this.clearLine();
        this.pathChanged.next(0);
        this.pathFailed.next({ reason, distance, heightGap: this.heightGap });
    }
    /** 清除路径线并通知当前不显示路径。 */
    clear() {
        this.clearLine();
        this.pathChanged.next(null);
    }
    /**
     * 规划一条从 `start` 到 `goal`（世界坐标）的空闲空间路线，避开所有占用的
     * 体素。返回有序的世界坐标点列表（沿地形表面走，可以一级级爬上台阶和桌面，
     * 也能一步跨过地上的小坑），或 null。
     *
     * `crossWidth` 是「跨越宽度」（见 {@link OctomapMapSettings.crossWidth}）：无支撑的
     * 那一段不超过它就允许一步跨过去，0 表示只走相邻格。
     *
     * `groundLevel` 是扫描出的地板高度，由点云那一侧（`Octomap3dPcdGrille`）
     * 算好传进来：地面平面和参考网格用的也是同一个值，路径因此画在可见的地面上，
     * 而不是世界原点那一层。没有点的那一列按它补出来——**这是 `'surfaceGraph'` 的
     * 说法**，别的算法可以拿它当「附近没有源时才用的兜底」（见 `OctomapPathAlgorithm`）。
     *
     * 签名保持**十一个位置参数**、一条不增删：这个类的构造签名和它一起被 spec 里的
     * `null as never` 依赖着，改成对象会牵动一堆无关分支。真正的请求对象在
     * {@link Octomap3dPcdPathPlanner.plan} 那一层。
     *
     * 这里只做四件事：算网格参数、判上限、转发给当前算法、把失败标志抄回来。**建表面图
     * 与搜索都在规划器里**（见 {@link planner}）——它们的每一处阈值都是量出来的，而
     * 「小狗走的那张面」是可选的，两者不该搅在一起。
     */
    computePath(grid, positions, bbox, start, goal, maxStepHeight, crossWidth, dogRadius, dogHeight, groundExtendsOutside, groundLevel) {
        const cell = NAV_CELL_SIZE;
        const { nx, nz, minX, minZ } = navGridSize(bbox, start, goal, dogRadius);
        // 每次调用都重写，不留陈旧值——否则上一次的尺寸失败会污染下一次的报错。
        this.navLimitExceeded = false;
        this.heightGap = null;
        this.dogStuck = false;
        this.goalTooHigh = false;
        this.goalOnFace = false;
        if (nx * nz > MAX_FREE_CELLS) {
            this.navLimitExceeded = true;
            // 超限状态变了，边界线要跟着换成警示色并强制显示。
            //
            // **只在这一支里调**：正常规划完了也调一次，会把上一次留下的洋红框立刻刷回
            // 灰色——而「超限过」这件事在界面上本来就是靠那个颜色说的，框不褪色是有意的。
            this.refreshNavLimit();
            return null;
        }
        const plan = this.planner().plan({
            grid,
            positions,
            bbox,
            start,
            goal,
            maxStepHeight,
            crossWidth,
            fillBaseCells: this.fillBaseCells,
            dogRadius,
            dogHeight,
            groundExtendsOutside,
            groundLevel,
            nx,
            nz,
            minX,
            minZ,
            cell,
        });
        // 四个字段**无条件**抄回，不看有没有折线：只在成功时抄的话，上一次的落差会活到
        // 下一次，`failedReason()` 就会拿一个不相干的旧值给这次失败报 `'gap'`。
        this.heightGap = plan.heightGap;
        this.dogStuck = plan.dogStuck;
        this.goalTooHigh = plan.goalTooHigh;
        // `goalOnFace` 改的还是**画法**（球还是平环，见 `resizeGoalMarkers`），所以抄完
        // 得顺手重画一次——否则终点浮空这件事要等下一次挪终点才在界面上显出来。
        this.goalOnFace = plan.goalOnFace;
        this.resizeGoalMarkers();
        return plan.points;
    }
    /**
     * 释放这个控制器建在场景里的所有对象。
     *
     * 不手写拆解而是转给 `clearLine` / `clearGoal`：终点那边的装饰（锥和范围圆环）
     * 会越加越多，抄一份拆解逻辑在这里，加新装饰时就必然漏掉这一处。`clearGoal`
     * 顺手把 `goalPosition` 也清了，整个 provider 都要销毁，无所谓。
     *
     * 上限范围那条线没有归进上面两个（它不属于终点那一家），照 `groundPlane` /
     * `brushCursor` 的写法在这里自己拆——几何体和材质都要 dispose，字段置 null。
     */
    dispose() {
        this.clearLine();
        this.clearGoal();
        if (this.navLimitBox) {
            this.global.scene.remove(this.navLimitBox);
            this.navLimitBox.geometry.dispose();
            this.navLimitBox.material.dispose();
            this.navLimitBox = null;
        }
        this.bounds = null;
    }
    // --- 辅助方法 ---------------------------------------------------------------
    /**
     * 规划器能覆盖的范围——以点云占地为中心、保持长宽比的那个矩形，单位世界坐标。
     * 返回的 `exceeded` 说的是「这块地本身**装不下**」。
     *
     * 求法是二分一个放大系数 `s`，取 `s = min(1, s_max)`，`s_max` 是「网格格数刚好
     * 不超过 `MAX_FREE_CELLS`」的最大系数：
     *
     * - 没超限 → `s = 1` → 框正好套在**点云加边距**上。也就是 A* 网格的真实矩形，
     *   小、贴着场景，顺带把「规划器会往点云外扩一圈边距」这件本来只存在于代码里的
     *   事画了出来。
     * - 超限 → `s < 1` → 框落在点云**里面**，一眼就能看出「扫描比能规划的范围还大」。
     *
     * 两种情形读的是同一条语义（「这条线就是规划器的边界」），而不是两个不同的东西。
     * 这正是**不**直接画「上限面积那个大矩形」的原因：上限是 8M 格 ≈ 141×141 m，
     * 正常场景里会是一个远远伸到屏幕外的大方框，既没信息量又挡视线。
     *
     * 用二分而不是解析解：格数是 `ceil` 出来的，解析解会差一两格；而 `navGridSize`
     * 很廉价，为它推闭式解不值。系数封顶在 1（而不是放到比 1 更大去找那个「能规划
     * 的最大范围」）是为了让这条线在正常场景里也**贴着点云**，成为一个可对照的参考。
     */
    navLimitRect() {
        const bbox = this.bounds;
        if (!bbox) {
            return null;
        }
        const cell = NAV_CELL_SIZE;
        // 把点云占地按 s 绕中心缩一下，再问这个更小的范围要多少格。
        const gridAt = (s) => {
            const halfX = (bbox.size[0] * s) / 2;
            const halfY = (bbox.size[1] * s) / 2;
            const halfZ = (bbox.size[2] * s) / 2;
            const scaled = {
                min: [bbox.center[0] - halfX, bbox.center[1] - halfY, bbox.center[2] - halfZ],
                max: [bbox.center[0] + halfX, bbox.center[1] + halfY, bbox.center[2] + halfZ],
                center: bbox.center,
                size: [halfX * 2, halfY * 2, halfZ * 2],
                radius: bbox.radius * s,
            };
            return navGridSize(scaled, null, null, this.dogRadius);
        };
        let grid = gridAt(1);
        const exceeded = grid.nx * grid.nz > MAX_FREE_CELLS;
        if (exceeded) {
            // `gridAt(0)` 一定装得下：范围退化成一个点时，格数只剩边距那一圈（几十格）。
            // 所以 [0, 1] 这个区间必有解，二分不需要额外的兜底。
            let lo = 0;
            let hi = 1;
            for (let i = 0; i < 40; i++) {
                const mid = (lo + hi) / 2;
                const m = gridAt(mid);
                if (m.nx * m.nz > MAX_FREE_CELLS) {
                    hi = mid;
                }
                else {
                    lo = mid;
                }
            }
            grid = gridAt(lo);
        }
        // 画的是**网格本身**（`minX` 起 `nx` 格），不是名义上的「包围盒 + 边距」：格数
        // 是 ceil 出来的，网格总会比名义范围多处不到一格的零头，而这条线要画的就是
        // 规划器真正覆盖到的地方。
        return {
            center: [grid.minX + (grid.nx * cell) / 2, grid.minZ + (grid.nz * cell) / 2],
            sizeX: grid.nx * cell,
            sizeZ: grid.nz * cell,
            exceeded,
        };
    }
    /**
     * 按当前的点云范围、碰撞半径和显示开关，重画（或藏起）规划上限范围那条边界线。
     *
     * 可见性是三者的或：用户开了开关、场景本身装不下、或者上次规划就是因为尺寸放弃
     * 的。中间那项就是用户要的「场景太大就把它画出来」——它不依赖开关，因为那正是
     * 这条线最有用的时刻。
     */
    refreshNavLimit() {
        const rect = this.navLimitRect();
        if (!rect) {
            // 没有点云：把线藏起来，而不是销毁。点云是随时可以换的，销毁意味着下次
            // 又要重建一遍几何和材质。
            if (this.navLimitBox) {
                this.navLimitBox.visible = false;
            }
            return;
        }
        if (!this.navLimitBox) {
            // 单位正方形（边长 1，中心在原点），实际尺寸交给 scale——和终点范围圆环
            // 同一个手法：线的屏幕宽度恒为 1 px，缩放不改变线宽。
            const geometry = new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(-0.5, 0, -0.5),
                new THREE.Vector3(0.5, 0, -0.5),
                new THREE.Vector3(0.5, 0, 0.5),
                new THREE.Vector3(-0.5, 0, 0.5),
            ]);
            const material = new THREE.LineBasicMaterial({
                color: NAV_LIMIT_COLOR,
                depthTest: false,
            });
            this.navLimitBox = new THREE.LineLoop(geometry, material);
            this.navLimitBox.renderOrder = 1000;
            this.global.scene.add(this.navLimitBox);
        }
        const exceeded = rect.exceeded || this.navLimitExceeded;
        this.navLimitBox.scale.set(rect.sizeX, 1, rect.sizeZ);
        this.navLimitBox.position.set(rect.center[0], this.groundLevel, rect.center[1]);
        this.navLimitBox.visible = this.navLimitVisible || exceeded;
        this.navLimitBox.material.color.set(exceeded ? NAV_LIMIT_EXCEEDED_COLOR : NAV_LIMIT_COLOR);
    }
    /** 终点锥的底面半径：跟碰撞半径走，不小于按渲染体素算出的下限。 */
    coneRadius() {
        return Math.max(this.dogRadius * CONE_RADIUS_RATIO, this.voxelSize * CONE_VOXEL_RATIO);
    }
    /** 终点锥的高：由半径按固定高径比推出，尺寸怎么变形状都不走样。 */
    coneHeight() {
        return this.coneRadius() * CONE_ASPECT;
    }
    /** 路径管的半径，与锥同一套参考（碰撞半径 + 体素下限）。 */
    tubeRadius() {
        return Math.max(this.dogRadius * TUBE_RADIUS_RATIO, this.voxelSize * TUBE_VOXEL_RATIO);
    }
    /** 路径点珠子的半径：由管半径按固定比例推出，于是两者永远同粗同细。 */
    beadRadius() {
        return this.tubeRadius() * PATH_POINT_RADIUS_RATIO;
    }
    /**
     * 把终点锥调成当前参考尺寸（悬浮到终点上方、锥尖刚好触地），并把范围指示物
     * 摆到终点上、缩到当前半径、按 {@link goalOnFace} 决定竖不竖起来。
     *
     * 两者各自判空：锥和圆环是两个独立字段，任何一个缺失都不该拖住另一个更新。
     */
    resizeGoalMarkers() {
        const goal = this.goalPosition;
        if (!goal) {
            return;
        }
        if (this.goalMarker) {
            const height = this.coneHeight();
            this.goalMarker.scale.set(this.coneRadius(), height, this.coneRadius());
            this.goalMarker.position.set(goal[0], goal[1] + height / 2, goal[2]);
        }
        if (this.goalRange) {
            // 圆环以终点为心，不随锥的尺寸参考变——它标的是接受范围，跟小狗多大、体素
            // 多粗都无关。
            this.goalRange.scale.setScalar(this.goalRadius);
            this.goalRange.position.set(goal[0], goal[1], goal[2]);
            // 竖直那两圈（子节点 1、2）只在终点**浮在半空**时露面：那时接受范围是个球，
            // 三个圆一起才是它的轮廓；终点有面接着时竖直那一维不计入判定
            // （见 `goalOnFace`），摆一个球出来等于把接受范围画大了。
            const solid = !this.goalOnFace;
            for (let i = 1; i < this.goalRange.children.length; i++) {
                this.goalRange.children[i].visible = solid;
            }
        }
    }
    /** 照着 {@link pathPoints} 重画路径管。尺寸变了要重画时也走这里。 */
    drawPath() {
        this.disposeLine();
        const points = this.pathPoints;
        if (!points) {
            return;
        }
        // 将管悬浮在小狗身体中心的高度，使其清晰地处于地面之上，而不是埋在地面里。
        const centerHeight = this.dogHeight / 2;
        const pts = points.map(([x, y, z]) => new THREE.Vector3(x, y + centerHeight, z));
        const curve = new THREE.CatmullRomCurve3(pts);
        const geometry = new THREE.TubeGeometry(curve, Math.max(points.length * 6, 6), this.tubeRadius(), 8, false);
        // 渲染在体素/地面之上，让路线保持清晰可见。
        const material = new THREE.MeshBasicMaterial({ color: '#facc15', depthTest: false });
        this.pathLine = new THREE.Mesh(geometry, material);
        this.pathLine.renderOrder = 1000;
        this.pathLine.frustumCulled = false;
        // 每画一根都要问一次开关：规划完成后这条路径是新管子，`setPathVisible` 改不到它。
        this.pathLine.visible = this.pathVisible;
        this.global.scene.add(this.pathLine);
        // 珠子的个数与半径都是照着折线现算的，所以每次重画管子都跟着重画一遍。
        this.drawPathPointMarkers();
    }
    /** 丢掉当前路径：场景里的管和暂存的折线一起清。 */
    clearLine() {
        this.disposeLine();
        this.pathPoints = null;
    }
    /**
     * 照着 {@link pathPoints} 重画路径点的珠子。
     *
     * 三处调它，都是为了同一件事——「折线或尺寸参考变了」：{@link drawPath}（管子跟着变）、
     * {@link setScaleReference}（那边转给 `drawPath`）、{@link setPathPointsVisible}。
     *
     * 先拆后建而不是「改改实例数」：`InstancedMesh` 的实例数是构造时定死的，折线一变就
     * 得新建一个对象。顺带把「开关关着」「没有折线」这两种情况收进同一个出口——它们要做的
     * 正是「拆掉旧的、什么都不建」。
     */
    drawPathPointMarkers() {
        this.disposePathPointMarkers();
        const points = this.pathPoints;
        if (!points || !this.pathPointsVisible) {
            return;
        }
        // 高度和管子用同一个偏移（见 drawPath）：CatmullRomCurve3 是**插值**曲线，管子的
        // 中心线正好穿过每个控制点，所以珠子照原坐标摆上去就骑在管心上。
        const centerHeight = this.dogHeight / 2;
        // 球段数取 10 × 8：珠子只有管径的 1.8 倍大，屏幕上是几十个像素，再细分纯属浪费
        // ——长路径上千个顶点，每个顶点的面数都要乘上去。
        const geometry = new THREE.SphereGeometry(this.beadRadius(), 10, 8);
        const material = new THREE.MeshBasicMaterial({ color: '#ffffff', depthTest: false });
        const mesh = new THREE.InstancedMesh(geometry, material, points.length);
        // 比管子（1000）高一级：两者都不做深度测试，谁盖住谁**全看这个数**，而球心与管轴
        // 重合、球本来是在管子**里面**的。
        mesh.renderOrder = 1001;
        mesh.frustumCulled = false;
        const matrix = new THREE.Matrix4();
        points.forEach(([x, y, z], index) => {
            matrix.makeTranslation(x, y + centerHeight, z);
            mesh.setMatrixAt(index, matrix);
        });
        mesh.instanceMatrix.needsUpdate = true;
        this.pathPointMarkers = mesh;
        this.global.scene.add(mesh);
    }
    /** 只销毁场景里的珠子，留着折线与管子给重画用。 */
    disposePathPointMarkers() {
        if (this.pathPointMarkers) {
            this.global.scene.remove(this.pathPointMarkers);
            this.pathPointMarkers.geometry.dispose();
            this.pathPointMarkers.material.dispose();
            this.pathPointMarkers = null;
        }
    }
    /** 只销毁场景里的管子和点标记，留着暂存的折线给重画用。 */
    disposeLine() {
        if (this.pathLine) {
            this.global.scene.remove(this.pathLine);
            this.pathLine.geometry.dispose();
            this.pathLine.material.dispose();
            this.pathLine = null;
        }
        // 珠子归折线这一家：`clearLine` / `dispose` 都从这里过，拆解点只有这一个。
        this.disposePathPointMarkers();
    }
    static ɵfac = i0.ɵɵngDeclareFactory({ minVersion: "12.0.0", version: "21.2.26", ngImport: i0, type: Octomap3dPcdPath, deps: [{ token: Octomap3dPcdGlobal }], target: i0.ɵɵFactoryTarget.Injectable });
    static ɵprov = i0.ɵɵngDeclareInjectable({ minVersion: "12.0.0", version: "21.2.26", ngImport: i0, type: Octomap3dPcdPath });
}
i0.ɵɵngDeclareClassMetadata({ minVersion: "12.0.0", version: "21.2.26", ngImport: i0, type: Octomap3dPcdPath, decorators: [{
            type: Injectable
        }], ctorParameters: () => [{ type: Octomap3dPcdGlobal }] });
/**
 * 按算法建规划器。新的寻路方式在**这里**加一支，其余地方一行不动——外壳只认
 * {@link Octomap3dPcdPathPlanner} 这个抽象，不认具体是哪一个。
 *
 * 写成模块级函数而不是外壳的方法：它是构造期的一次分派，跟这个实例的状态无关，
 * 也就没有理由为了它去实例化一个 `Octomap3dPcdPath`。
 *
 * `default` 兜底回 `'surfaceGraph'` 而不是抛错：算法名可能来自配置文件
 * （`octomap.config.json`），那里写错一个词不该让寻路整个炸掉——退回默认的那套
 * 至少画得出路。**类型收紧了就该把这支删掉**，让它变成编译错（那时候 `default`
 * 就是死代码，而这里的声音本该由类型系统发）。
 */
function createPlanner(algorithm) {
    switch (algorithm) {
        case 'surfaceGraph':
            return new Octomap3dPcdPathSurfaceGraph();
        case 'cloudFit':
            return new Octomap3dPcdPathCloudFit();
        default:
            return new Octomap3dPcdPathSurfaceGraph();
    }
}

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
function cloudFloorY(positions) {
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

/**
 * 查看器一次愿意渲染的体素上限。与 `buildVoxels` 共用同一个数字，避免两处
 * 上限各自漂移：抽稀结果超过它，查看器同样会拒绝。
 *
 * 查看器自己遇到超限不再直接报错：它把格边长翻倍重试，直到落进这个数以内
 * （见 `octomap-3d-pcd-point.controller.ts` 的 `buildVoxels`），并在工具栏说明实际用了哪一档。
 */
const MAX_VOXEL_COUNT = 2_000_000;
/**
 * 数值体素键在单轴上的格数（每轴可表示 ±65536 格）。三轴各占 17 位，合起来
 * 约 2^51，仍在 2^53 以内，因此用 double 做键精确无碰撞。**不能放宽**：21/21/21
 * 会到 2^63，double 失去整数精确性，不同格子会算出同一个键。
 */
const KEY_RANGE = 65536;
const KEY_SHIFT_Y = 2 ** 17;
const KEY_SHIFT_X = 2 ** 34;
const KEY_OFFSET = 65536;
/** 累加器超过体素上限时抛出，便于调用方区分并提示换用更大的体素尺寸。 */
class VoxelLimitError extends Error {
    /** 触发时的体素数量。 */
    cellCount;
    /** 允许的上限。 */
    maxCells;
    constructor(cellCount, maxCells) {
        super(`体素数量超过上限 (${cellCount} > ${maxCells})`);
        this.name = 'VoxelLimitError';
        this.cellCount = cellCount;
        this.maxCells = maxCells;
    }
}
/**
 * 把大点云按体素抽稀成小点云，语义与查看器的 `buildVoxels` 对齐：
 * 每格的颜色取**格内平均**，输出的点落在**格中心**，而不是「每格留第一个点」。
 *
 * 原点固定为 `[0, 0, 0]`（而不是包围盒最小值），因此是单遍处理——不需要为了
 * 求包围盒先把几十 GB 的数据扫一遍，这在流式读取里是决定性的。
 *
 * 输出用格中心（而非某个原始点）是刻意的，这让结果尺寸可预测：把抽稀结果交给
 * 查看器、用同一个体素尺寸再体素化一次时，每个点最多只会落到 0 或 1 格之外，
 * 因此**格数只会持平或略减，绝不会增长**——抽稀到不超过上限，就一定不会撞上
 * 查看器自己的上限。略减的原因是浮点：查看器以包围盒最小值为原点，而这个值
 * 本身就是一个格中心（即它自己的格边界），于是每个抽稀点都恰好压在边界上，
 * 极少数相邻格会因舍入而合并（实测约 0.02%）。
 */
class VoxelAccumulator {
    voxelSize;
    maxCells;
    /** 数值体素键 → 槽位下标，槽位按首次出现顺序分配。 */
    slots = new Map();
    /** 各格的整数格坐标；与 `slots` 一一对应。 */
    cellX;
    cellY;
    cellZ;
    /** 各格的颜色分量之和与点数，仅在带颜色时累加。 */
    sumR;
    sumG;
    sumB;
    hits;
    used = 0;
    beyondRange = 0;
    constructor(voxelSize, maxCells = MAX_VOXEL_COUNT) {
        if (!(voxelSize > 0)) {
            throw new Error(`体素尺寸必须是正数 (${voxelSize})`);
        }
        this.voxelSize = voxelSize;
        this.maxCells = maxCells;
        const capacity = 1024;
        this.cellX = new Int32Array(capacity);
        this.cellY = new Int32Array(capacity);
        this.cellZ = new Int32Array(capacity);
        this.sumR = new Float64Array(capacity);
        this.sumG = new Float64Array(capacity);
        this.sumB = new Float64Array(capacity);
        this.hits = new Int32Array(capacity);
    }
    /** 已占用的体素数量。 */
    get cellCount() {
        return this.used;
    }
    /** 因坐标超出可表示范围而被丢弃的点数。 */
    get outOfRangeCount() {
        return this.beyondRange;
    }
    /** 把一个点并入它所属的体素。`r`/`g`/`b` 仅在 `hasColor` 为真时参与平均。 */
    add(x, y, z, r, g, b, hasColor) {
        const ix = Math.floor(x / this.voxelSize);
        const iy = Math.floor(y / this.voxelSize);
        const iz = Math.floor(z / this.voxelSize);
        // 取反的写法顺带挡掉 NaN（NaN 的比较恒为 false）。
        if (!(ix >= -KEY_RANGE && ix < KEY_RANGE) ||
            !(iy >= -KEY_RANGE && iy < KEY_RANGE) ||
            !(iz >= -KEY_RANGE && iz < KEY_RANGE)) {
            this.beyondRange += 1;
            return;
        }
        const key = (ix + KEY_OFFSET) * KEY_SHIFT_X + (iy + KEY_OFFSET) * KEY_SHIFT_Y + (iz + KEY_OFFSET);
        let slot = this.slots.get(key);
        if (slot === undefined) {
            if (this.used === this.cellX.length) {
                this.grow();
            }
            slot = this.used++;
            this.slots.set(key, slot);
            this.cellX[slot] = ix;
            this.cellY[slot] = iy;
            this.cellZ[slot] = iz;
            // 新格子的大小恰好等于上限时，再收一个点就已经越界了，此刻中止——
            // 比跑完整份数据再报错快得多（几秒 vs 几分钟），也不会先吃掉几百 MB 内存。
            if (this.used > this.maxCells) {
                throw new VoxelLimitError(this.used, this.maxCells);
            }
        }
        if (hasColor) {
            this.sumR[slot] += r;
            this.sumG[slot] += g;
            this.sumB[slot] += b;
            this.hits[slot] += 1;
        }
    }
    /**
     * 导出抽稀后的点云：每格一个点，位于格中心；带颜色时为格内平均色。
     * 输出顺序是各格首次出现的顺序，因此对同一份输入稳定可复现。
     */
    toCloud(hasColors) {
        const count = this.used;
        if (count === 0) {
            throw new Error('抽稀后没有任何点');
        }
        const size = this.voxelSize;
        const positions = new Float32Array(count * 3);
        const colors = hasColors ? new Float32Array(count * 3) : null;
        for (let slot = 0; slot < count; slot++) {
            const offset = slot * 3;
            positions[offset] = (this.cellX[slot] + 0.5) * size;
            positions[offset + 1] = (this.cellY[slot] + 0.5) * size;
            positions[offset + 2] = (this.cellZ[slot] + 0.5) * size;
            if (colors) {
                // 没有颜色点的格子（理论上不会出现）保持黑色，而不是除以零。
                const hits = this.hits[slot];
                if (hits > 0) {
                    colors[offset] = this.sumR[slot] / hits;
                    colors[offset + 1] = this.sumG[slot] / hits;
                    colors[offset + 2] = this.sumB[slot] / hits;
                }
            }
        }
        const cloud = { positions, pointCount: count };
        if (colors) {
            cloud.colors = colors;
        }
        return cloud;
    }
    /** 槽位数组容量翻倍。 */
    grow() {
        const capacity = this.cellX.length * 2;
        this.cellX = growInt32(this.cellX, capacity);
        this.cellY = growInt32(this.cellY, capacity);
        this.cellZ = growInt32(this.cellZ, capacity);
        this.hits = growInt32(this.hits, capacity);
        this.sumR = growFloat64(this.sumR, capacity);
        this.sumG = growFloat64(this.sumG, capacity);
        this.sumB = growFloat64(this.sumB, capacity);
    }
}
function growInt32(source, capacity) {
    const next = new Int32Array(capacity);
    next.set(source);
    return next;
}
function growFloat64(source, capacity) {
    const next = new Float64Array(capacity);
    next.set(source);
    return next;
}

/**
 * 由点云构建的常驻体素网格。每个占用单元映射到渲染的
 * InstancedMesh 中的一个实例索引，并带有基准颜色以及
 * 供刷选和寻路使用的禁行（障碍）标记。
 *
 * 单元用紧凑的 `${ix},${iy},${iz}` 键寻址；单元的世界
 * 坐标位置由{@link min} + {@link voxelSize} 推导。
 */
class Octomap3dPcdVoxelGrid {
    /** 网格最小角的世界坐标位置（与点云边界一致）。 */
    min;
    /** 一个体素的边长（世界单位）。 */
    voxelSize;
    /** 已刷障碍单元（{@link cells} 的子集）。 */
    forbidden = new Set();
    cells = new Map();
    byInstance = new Map();
    baseColors = new Map();
    constructor(min, voxelSize) {
        this.min = min;
        this.voxelSize = voxelSize;
    }
    static key(ix, iy, iz) {
        return `${ix},${iy},${iz}`;
    }
    static parse(key) {
        const [ix, iy, iz] = key.split(',').map(Number);
        return { ix, iy, iz };
    }
    add(ix, iy, iz, instanceId, baseColor) {
        const key = Octomap3dPcdVoxelGrid.key(ix, iy, iz);
        this.cells.set(key, instanceId);
        this.byInstance.set(instanceId, key);
        this.baseColors.set(key, baseColor);
    }
    /** 添加一个单元（已存在时不做任何事），返回其键。 */
    addCell(ix, iy, iz, baseColor) {
        const key = Octomap3dPcdVoxelGrid.key(ix, iy, iz);
        if (this.cells.has(key)) {
            return key;
        }
        this.cells.set(key, this.cells.size);
        this.baseColors.set(key, baseColor);
        return key;
    }
    /** 移除一个单元及其全部辅助数据。存在时返回 true。 */
    remove(key) {
        const instanceId = this.cells.get(key);
        if (instanceId === undefined) {
            return false;
        }
        this.cells.delete(key);
        this.byInstance.delete(instanceId);
        this.baseColors.delete(key);
        this.forbidden.delete(key);
        return true;
    }
    /** 在添加/移除操作后重新分配紧凑的实例 id（0..size-1）。 */
    compact() {
        this.byInstance.clear();
        let id = 0;
        for (const key of this.cells.keys()) {
            this.cells.set(key, id);
            this.byInstance.set(id, key);
            id++;
        }
    }
    has(key) {
        return this.cells.has(key);
    }
    baseColor(key) {
        return this.baseColors.get(key);
    }
    instanceId(key) {
        return this.cells.get(key);
    }
    keyOfInstance(instanceId) {
        return this.byInstance.get(instanceId);
    }
    get size() {
        return this.cells.size;
    }
    worldToVoxel(x, y, z) {
        return {
            ix: Math.floor((x - this.min[0]) / this.voxelSize),
            iy: Math.floor((y - this.min[1]) / this.voxelSize),
            iz: Math.floor((z - this.min[2]) / this.voxelSize),
        };
    }
    /** 单元的世界坐标中心。 */
    center(key) {
        const { ix, iy, iz } = Octomap3dPcdVoxelGrid.parse(key);
        return [
            this.min[0] + (ix + 0.5) * this.voxelSize,
            this.min[1] + (iy + 0.5) * this.voxelSize,
            this.min[2] + (iz + 0.5) * this.voxelSize,
        ];
    }
    /** 距世界点最近的占用单元（逐层扩展搜索），没有则为 null。 */
    nearest(x, y, z) {
        if (this.cells.size === 0) {
            return null;
        }
        const { ix, iy, iz } = this.worldToVoxel(x, y, z);
        for (let r = 0; r < 256; r++) {
            for (let dx = -r; dx <= r; dx++) {
                for (let dy = -r; dy <= r; dy++) {
                    for (let dz = -r; dz <= r; dz++) {
                        if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) {
                            continue;
                        }
                        const key = Octomap3dPcdVoxelGrid.key(ix + dx, iy + dy, iz + dz);
                        if (this.cells.has(key)) {
                            return key;
                        }
                    }
                }
            }
        }
        return null;
    }
    /** 一个单元的 26 邻接占用邻居。 */
    neighbors(key) {
        const { ix, iy, iz } = Octomap3dPcdVoxelGrid.parse(key);
        const result = [];
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dz = -1; dz <= 1; dz++) {
                    if (dx === 0 && dy === 0 && dz === 0) {
                        continue;
                    }
                    const neighbor = Octomap3dPcdVoxelGrid.key(ix + dx, iy + dy, iz + dz);
                    if (this.cells.has(neighbor)) {
                        result.push(neighbor);
                    }
                }
            }
        }
        return result;
    }
    /** 遍历每个占用单元及其实例 id 和基准颜色。 */
    *entries() {
        for (const [key, instanceId] of this.cells) {
            yield { key, instanceId, base: this.baseColors.get(key) };
        }
    }
}

const AUTO_VOXEL_DIVISIONS = 64;
/**
 * 体素超过上限时最多自动放大几档（每档翻倍）。
 *
 * 0.05 m 起算，八档能放大到 12.8 m——再密的云也够用了；设这个上限是为了让病态输入
 * （坐标反复落在极端值上）不会在这里无限转。
 */
const MAX_VOXEL_FIT_STEPS = 8;
/**
 * 负责渲染出的点云/体素网格以及射线拾取与刷交互。
 * 所有针对“点”的操作都在这里。
 */
class Octomap3dPcdGrille {
    global;
    pointsChanged = new Subject();
    pointClicked = new Subject();
    paintedChanged = new Subject();
    error = new Subject();
    currentPointCount = 0;
    boundingBox = null;
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
    referenceLevel = null;
    /** 常驻体素结构——导航/障碍空间。点云模式下为 null。 */
    grid = null;
    /** 原始交错的 XYZ 坐标，保留用于精细分辨率导航。 */
    positions = null;
    /**
     * 实际用来建体素的格边长、以及按设置算出来的格边长（米）；点渲染时为 null。
     *
     * 两者不等 = 为了守住 {@link MAX_VOXEL_COUNT} 自动放大了。报给宿主（见
     * {@link emitPointsChanged}），由它在工具栏上说明一句。
     */
    renderedVoxelSize = null;
    requestedVoxelSize = null;
    /**
     * 上一次自动放大得到的那一档，见 {@link buildVoxels} 里对缓存键的说明。
     *
     * 换一份点云、改原点、或者改要求值都会让它作废；同一份云上改颜色、改障碍不值得
     * 把前面几档再撞一遍（每一档都是一遍几百万点的扫描）。
     */
    voxelFit = null;
    pointsObject = null;
    voxelObject = null;
    hasColors = false;
    /** 原始逐点颜色，与{@link positions} 保持同步以便导出。 */
    rawColors = null;
    /**
     * 上一次 {@link rebuild} 收到的**未过滤**坐标。
     *
     * {@link positions} 是高度过滤之后的（点号已经变了），而拖动预览按宿主给的「合并
     * 点云点号」取点——只有在原始那份上，索引才和宿主的范围对得上。
     */
    sourcePositions = null;
    /** 正在预览的实例，见 {@link applyPreview}。 */
    previewInstances = null;
    /** 在待添加/移动的放置位置显示的半透明立方体。 */
    previewMesh = null;
    /** 当前被编辑器悬停/手持高亮着色的体素。 */
    highlightKey = null;
    raycaster = new THREE.Raycaster();
    pointer = new THREE.Vector2();
    constructor(global) {
        this.global = global;
    }
    rebuild(points, options, fit) {
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
        this.rawColors = this.hasColors ? cloud.colors : null;
        if (options.renderMode === 'voxel') {
            this.buildVoxels(cloud, options);
        }
        else {
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
    setPreviewOffset(x, y, z) {
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
    setPreviewRotation(delta, pivot) {
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
    applyPreview(preview, options, fallback) {
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
    collectPreviewInstances(start, count) {
        const grid = this.grid;
        const positions = this.sourcePositions;
        const total = Math.floor(positions.length / 3);
        const begin = Math.max(0, Math.min(total, start));
        const end = Math.max(begin, Math.min(total, start + count));
        const ids = [];
        const centers = [];
        const seen = new Set();
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
            centers.push(min[0] + (ix + 0.5) * voxelSize, min[1] + (iy + 0.5) * voxelSize, min[2] + (iz + 0.5) * voxelSize);
        }
        return { ids: Int32Array.from(ids), centers: Float32Array.from(centers), start, count };
    }
    /** 把预览那批实例按增量摆好：朝向大家一样，只有平移逐实例不同。 */
    movePreviewInstances(rotation, translation) {
        const state = this.previewInstances;
        const mesh = this.voxelObject;
        if (!state || !mesh) {
            return;
        }
        const [r0, r1, r2, r3, r4, r5, r6, r7, r8] = rotation;
        // 旋转部分建一次，逐实例只改写平移那三个元素（`elements` 是列主序，12..14 是平移）。
        const matrix = new THREE.Matrix4().set(r0, r1, r2, 0, r3, r4, r5, 0, r6, r7, r8, 0, 0, 0, 0, 1);
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
    restorePreview() {
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
    applyMaterial(options) {
        if (!this.pointsObject) {
            return;
        }
        const material = this.pointsObject.material;
        material.size = this.resolvePointSize(options.pointSize);
        material.color.set(options.pointColor);
        material.vertexColors = this.hasColors;
        material.needsUpdate = true;
    }
    /** 不重建几何体即可为所有体素重新着色（保留障碍）。 */
    refreshColors(options) {
        if (!this.grid || !this.voxelObject) {
            return;
        }
        const forbiddenColor = new THREE.Color(options.forbiddenColor);
        const show = this.isShowing(options);
        const color = new THREE.Color();
        for (const { key, instanceId, base } of this.grid.entries()) {
            if (show && this.grid.forbidden.has(key)) {
                color.copy(forbiddenColor);
            }
            else {
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
    brushAt(x, y, z, radius, options) {
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
    eraseAt(x, y, z, radius, options) {
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
    clearObstacles(options) {
        if (!this.grid) {
            return;
        }
        this.grid.forbidden.clear();
        this.refreshColors(options);
        this.emitPainted();
    }
    /** 一次性把所有占用体素标记为禁行障碍。 */
    markAllForbidden(options) {
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
    restorePainted(painted, options) {
        if (!this.grid || !this.voxelObject) {
            return;
        }
        this.grid.forbidden.clear();
        if (painted) {
            const sameGrid = painted.voxelSize === this.grid.voxelSize &&
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
    addVoxel(world, options) {
        if (!this.grid) {
            return;
        }
        const { ix, iy, iz } = this.grid.worldToVoxel(world[0], world[1], world[2]);
        const key = Octomap3dPcdVoxelGrid.key(ix, iy, iz);
        if (this.grid.has(key)) {
            return;
        }
        const color = new THREE.Color(options.pointColor);
        const base = [color.r, color.g, color.b];
        this.grid.addCell(ix, iy, iz, base);
        this.appendPoint(world, base);
        this.rebuildVoxelMesh(options);
        this.emitPointsChanged();
    }
    /** 按网格键移除一个体素（及其来源点）。 */
    removeVoxel(key, options) {
        if (!this.grid || !this.grid.remove(key)) {
            return;
        }
        this.removePointsInCell(key);
        this.rebuildVoxelMesh(options);
        this.emitPointsChanged();
    }
    /** 把体素从其键移动到新的世界坐标位置。 */
    moveVoxel(key, world, options) {
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
    toPointCloud() {
        if (!this.positions || this.positions.length < 3) {
            return null;
        }
        const cloud = {
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
    toRegularCloud() {
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
        const cloud = { positions, pointCount: count };
        if (colors) {
            cloud.colors = colors;
        }
        return cloud;
    }
    /**
     * 这份云的地板高度。规则本身在 `cloud-floor.util.ts` 的 `cloudFloorY` 里——宿主
     * 的「贴合地面」用的是同一个函数，两边必须是同一个数（差一厘米就是挪歪）。
     */
    estimateGroundLevel(positions) {
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
    projectionSource() {
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
    pickVoxelFace(event) {
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
    setPreviewPosition(world) {
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
    setVoxelHighlight(key, options, color = '#fb923c') {
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
    clearEditorFeedback(options) {
        this.setPreviewPosition(null);
        this.setVoxelHighlight(null, options);
    }
    /** 对点击做射线拾取并发出拾取到的点/体素（无拖拽阈值）。 */
    pick(event, renderMode, maxPickingPoints) {
        const target = renderMode === 'voxel' ? this.voxelObject : this.pointsObject;
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
        }
        else {
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
    probe(event, maxPickingPoints) {
        const target = this.voxelObject ?? this.pointsObject;
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
    pickVoxel(event) {
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
    pickGroundPoint(event) {
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
    pickPointUnderCursor(target) {
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
        const point = new THREE.Vector3(positions[bestIndex], positions[bestIndex + 1], positions[bestIndex + 2]).applyMatrix4(target.matrixWorld);
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
    pickSurfacePoint(event, maxPickingPoints) {
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
    dispose() {
        if (this.pointsObject) {
            this.global.scene.remove(this.pointsObject);
            this.pointsObject.geometry.dispose();
            this.pointsObject.material.dispose();
            this.pointsObject = null;
        }
        if (this.voxelObject) {
            this.global.scene.remove(this.voxelObject);
            this.voxelObject.geometry.dispose();
            this.voxelObject.material.dispose();
            this.voxelObject = null;
        }
        if (this.previewMesh) {
            this.global.scene.remove(this.previewMesh);
            this.previewMesh.geometry.dispose();
            this.previewMesh.material.dispose();
            this.previewMesh = null;
        }
        this.highlightKey = null;
        // 实例矩阵跟着 mesh 一起没了，预览的记账也一并作废：下一份点的预览会从头算。
        this.previewInstances = null;
        this.sourcePositions = null;
    }
    /** 返回移除了[minHeight, maxHeight] 范围之外的点后的点云。 */
    filterCloud(cloud, maxHeight, minHeight) {
        if (maxHeight === null && minHeight === null) {
            return cloud;
        }
        const positions = cloud.positions;
        const colors = cloud.colors;
        const normals = cloud.normals;
        const hasColors = !!colors && colors.length === positions.length;
        const hasNormals = !!normals && normals.length === positions.length;
        const outPositions = [];
        const outColors = [];
        const outNormals = [];
        for (let i = 0; i < positions.length; i += 3) {
            const y = positions[i + 1];
            if ((maxHeight !== null && y > maxHeight) || (minHeight !== null && y < minHeight)) {
                continue;
            }
            outPositions.push(positions[i], positions[i + 1], positions[i + 2]);
            if (hasColors) {
                outColors.push(colors[i], colors[i + 1], colors[i + 2]);
            }
            if (hasNormals) {
                outNormals.push(normals[i], normals[i + 1], normals[i + 2]);
            }
        }
        return {
            positions: new Float32Array(outPositions),
            colors: hasColors ? new Float32Array(outColors) : undefined,
            normals: hasNormals ? new Float32Array(outNormals) : undefined,
            pointCount: outPositions.length / 3,
        };
    }
    buildPoints(cloud, options) {
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
    buildVoxels(cloud, options) {
        const bb = this.boundingBox;
        const min = [bb.min[0], bb.min[1], bb.min[2]];
        const positions = cloud.positions;
        const colors = this.hasColors ? cloud.colors : undefined;
        const requested = this.resolveVoxelSize(options.voxelSize);
        // 同一份点云、同一个原点、同一个要求值，上次放大到哪一档，这次直接从那一档起试：
        // 改颜色、改障碍都会重建，没必要每一遍都把前面几档再撞一次。缓存键用**未过滤**
        // 那朵云（`sourcePositions`）加高度范围，而不是过滤后的数组：开了高度过滤时每遍
        // 都会生成新数组，按数组身份记的话缓存永远不中，拖一次高度滑杆就要全撞一遍。
        const cached = this.voxelFit;
        let voxelSize = cached &&
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
            this.error.next(new Error(`体素数量过多（已放大到 ${voxelSize} m 仍超过 ${MAX_VOXEL_COUNT} 格），请增大 voxelSize`));
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
            matrix.makeTranslation(min[0] + (cell.ix + 0.5) * voxelSize, min[1] + (cell.iy + 0.5) * voxelSize, min[2] + (cell.iz + 0.5) * voxelSize);
            mesh.setMatrixAt(index, matrix);
            const key = Octomap3dPcdVoxelGrid.key(cell.ix, cell.iy, cell.iz);
            const base = colors
                ? [cell.r / cell.n, cell.g / cell.n, cell.b / cell.n]
                : [fallback.r, fallback.g, fallback.b];
            grid.add(cell.ix, cell.iy, cell.iz, index, base);
            if (show && grid.forbidden.has(key)) {
                color.copy(forbiddenColor);
            }
            else {
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
    collectVoxelCells(positions, colors, min, voxelSize) {
        const cells = new Map();
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
    carryForbidden(voxelSize, min) {
        const previous = this.grid;
        const sameGrid = previous &&
            previous.voxelSize === voxelSize &&
            previous.min[0] === min[0] &&
            previous.min[1] === min[1] &&
            previous.min[2] === min[2];
        return sameGrid ? new Set(previous.forbidden) : new Set();
    }
    isShowing(options) {
        return options.showColoring;
    }
    emitPainted() {
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
    appendPoint(world, color) {
        if (this.positions) {
            const next = new Float32Array(this.positions.length + 3);
            next.set(this.positions);
            next[next.length - 3] = world[0];
            next[next.length - 2] = world[1];
            next[next.length - 1] = world[2];
            this.positions = next;
        }
        else {
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
    removePointsInCell(key) {
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
        const keep = [];
        const keepColors = [];
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
    rebuildVoxelMesh(options) {
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
            this.voxelObject.material.dispose();
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
            }
            else {
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
    hidePreview() {
        if (this.previewMesh) {
            this.previewMesh.visible = false;
        }
    }
    /** 把体素实例恢复为其正常颜色（禁行色或基准色）。 */
    paintNormal(instanceId, key, options) {
        const color = new THREE.Color();
        if (this.isShowing(options) && this.grid?.forbidden.has(key)) {
            color.set(options.forbiddenColor);
        }
        else {
            const base = this.grid?.baseColor(key) ?? [1, 1, 1];
            color.setRGB(base[0], base[1], base[2]);
        }
        this.voxelObject?.setColorAt(instanceId, color);
    }
    setVoxelColor(key, color) {
        const instanceId = this.grid?.instanceId(key);
        if (instanceId === undefined || !this.voxelObject) {
            return;
        }
        this.voxelObject.setColorAt(instanceId, color);
    }
    updatePointer(event) {
        const rect = this.global.renderer.domElement.getBoundingClientRect();
        this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
        this.raycaster.setFromCamera(this.pointer, this.global.camera);
    }
    resolvePointSize(pointSize) {
        if (pointSize !== null) {
            return pointSize;
        }
        if (this.boundingBox) {
            return Math.max(this.boundingBox.radius * 0.01, 0.001);
        }
        return 0.02;
    }
    resolveVoxelSize(voxelSize) {
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
    toBoundingBox(box) {
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
    setReferenceLevel(level) {
        if (level === this.referenceLevel) {
            return;
        }
        this.referenceLevel = level;
        this.emitPointsChanged();
    }
    emitPointsChanged() {
        this.pointsChanged.next({
            pointCount: this.currentPointCount,
            boundingBox: this.boundingBox,
            groundPlaneLevel: this.referenceLevel,
            voxelSize: this.renderedVoxelSize,
            requestedVoxelSize: this.requestedVoxelSize,
        });
    }
    static ɵfac = i0.ɵɵngDeclareFactory({ minVersion: "12.0.0", version: "21.2.26", ngImport: i0, type: Octomap3dPcdGrille, deps: [{ token: Octomap3dPcdGlobal }], target: i0.ɵɵFactoryTarget.Injectable });
    static ɵprov = i0.ɵɵngDeclareInjectable({ minVersion: "12.0.0", version: "21.2.26", ngImport: i0, type: Octomap3dPcdGrille });
}
i0.ɵɵngDeclareClassMetadata({ minVersion: "12.0.0", version: "21.2.26", ngImport: i0, type: Octomap3dPcdGrille, decorators: [{
            type: Injectable
        }], ctorParameters: () => [{ type: Octomap3dPcdGlobal }] });

/**
 * 将场景级（{@link Octomap3dPcdGlobal}）、点相关（{@link Octomap3dPcdGrille}）、
 * 导航（{@link Octomap3dPcdPath}）和小狗（{@link Octomap3dPcdDog}）
 * 控制器串联成一个门面，使组件只需调用这里，而不必自己把它们接在一起。
 */
class Octomap3dPcd {
    grille;
    global;
    dog;
    path;
    constructor(grille, global, dog, path) {
        this.grille = grille;
        this.global = global;
        this.dog = dog;
        this.path = path;
    }
    /**
     * 重建点云，然后刷新灯光并（可选）重新适配相机。
     *
     * 三个「要不要跟着换」的开关，默认一致、实际只有一处会分叉：
     *
     * - `fit`：**几何推导**（包围盒、地板高度）——只有「换个渲染方式」这类原地重画
     *   才会给 false，因为它读的是同一份 positions。
     * - `refitCamera`：相机。同一份云挪个位置时不给——机位是用户自己调好的，每改
     *   一次就跳回默认视角没人受得了。
     * - `refitReference`：参考物（网格 + 地面平面）的锚点。只有**换了一份云**或
     *   **换了一套坐标系**才重定；原地转/挪时钉着不动，云在它上面滑过去，用户才看
     *   得出挪了多少（参考物跟着走的话，整幅画一起平移，看着像什么都没发生）。
     */
    rebuild(points, options, fit, ground, refitCamera = fit, refitReference = refitCamera) {
        this.grille.rebuild(points, options, fit);
        // 平移手柄抓的是整片云的重心，云换了位置它就得跟着走。
        this.global.moveGizmoTo(this.grille.boundingBox);
        this.global.updateLights(this.grille.boundingBox);
        this.global.anchorReference(this.grille.boundingBox, this.grille.groundLevel, refitReference);
        // 锚点定完才知道那块灰平面在哪：回填给 grille，宿主靠它做「贴合地面」。
        this.grille.setReferenceLevel(this.global.referenceLevel);
        this.global.updateGroundPlane(this.grille.boundingBox, ground, this.grille.groundLevel);
        this.global.alignGrid(this.grille.boundingBox);
        // 规划上限范围的边界线**不**归参考物那一套（见上面 `refitReference`）：它画的
        // 是「规划能到哪儿」，是点云的属性，云挪到哪儿它就跟到哪儿——钉住反而会让那条
        // 线罩不住云。
        this.path.setBounds(this.grille.boundingBox, this.grille.groundLevel);
        // 换了点云，渲染体素大小（自动时由包围盒算出）跟着变，锥和管的下限也变。
        this.syncMarkerScale();
        if (options.fitView && refitCamera) {
            this.global.fitCamera(this.grille.boundingBox);
        }
    }
    /** 调整地面大小，使其与当前的“地面向外延伸”设置匹配。 */
    updateGroundPlane(ground) {
        this.global.updateGroundPlane(this.grille.boundingBox, ground, this.grille.groundLevel);
    }
    /**
     * 在体素中心周围刷上障碍。返回值原样来自
     * {@link Octomap3dPcdPoint.brushAt}——`occupied === 0` 就是「这一带没有点」，
     * 调用方拿它决定要不要提示（见 `OctomapBrushMissDetail`）。
     */
    brush(center, radius, options) {
        return this.grille.brushAt(center[0], center[1], center[2], radius, options);
    }
    /** 擦除体素中心周围的障碍（反向刷）。返回值见 {@link brush}；擦除侧不提示。 */
    erase(center, radius, options) {
        return this.grille.eraseAt(center[0], center[1], center[2], radius, options);
    }
    /** 将持久化的已刷集合重新应用到当前网格（不匹配时为空操作）。 */
    restorePainted(painted, options) {
        this.grille.restorePainted(painted, options);
    }
    /** 将小狗放置到空闲的地面位置（A）并清除残留的路径。 */
    placeDog(position) {
        this.dog.placeAt(position);
        this.path.clear();
    }
    /** 设置地面上的目的地（B）并清除残留的路径。 */
    placeGoal(position) {
        this.path.setGoal(position);
        this.dog.stop();
        this.path.clear();
    }
    /** 将小狗移动到新的地面位置（拖动它时使用）。 */
    moveDog(position) {
        this.dog.moveTo(position);
        this.path.clear();
    }
    /** 丢弃当前路径，不动小狗和终点。 */
    clearPath() {
        this.dog.stop();
        this.path.clear();
    }
    /** 移除小狗、终点和路径，以便用户从头重新部署。 */
    resetDeployment() {
        this.dog.remove();
        this.path.clearGoal();
        this.path.clear();
    }
    /** 更新小狗的碰撞体（半径 + 高度 + 可见性）。 */
    setDogCollision(radius, height, visible) {
        this.dog.setCollisionRadius(radius);
        this.dog.setCollisionHeight(height);
        this.dog.setCollisionVisible(visible);
        // 终点锥和路径管都按碰撞足迹取尺寸，改了半径/高度它们要跟着变。
        this.syncMarkerScale();
    }
    /** 一次性将每个占用的体素标记为禁行障碍。 */
    markAllObstacles(options) {
        this.grille.markAllForbidden(options);
    }
    /**
     * 从小狗到终点运行 A* 并绘制路径（不行进）。路径沿地面跟随地形，能一步跨过
     * 地上的小坑（见 {@link OctomapMapSettings.crossWidth}）。
     */
    findPath(maxStepHeight, crossWidth, dogRadius, dogHeight, groundExtendsOutside) {
        const params = { maxStepHeight, crossWidth, dogRadius, dogHeight };
        // 每次重新规划都从小狗的起点位置开始，而不是上一次行进或拖动后它停下的
        // 位置。
        this.dog.resetToStart();
        const grid = this.grille.grid;
        const positions = this.grille.positions;
        const bbox = this.grille.boundingBox;
        const start = this.dog.startPosition;
        const goal = this.path.goalPosition;
        if (!grid || !bbox || !start || !goal) {
            this.dog.stop();
            this.path.clear();
            console.log(`[寻路] 没算：${!grid || !bbox ? '点云还没加载' : '小狗和终点没放齐'}`);
            return;
        }
        // 从「方向前端」起算：起点沿小狗的朝向偏移一个碰撞半径，正贴着碰撞体
        // （圆柱）的表面，路径就不会从小狗身体中间穿过。
        const front = this.dog.frontPosition() ?? start;
        // 在 octomap 的*空闲*空间中规划，避开占用的体素。
        const points = this.path.computePath(grid, positions, bbox, front, goal, maxStepHeight, crossWidth, dogRadius, dogHeight, groundExtendsOutside, this.grille.groundLevel);
        if (!points || points.length < 2) {
            this.dog.stop();
            // 报哪个原因由规划器自己定（尺寸超限 > 小狗下不来 > 终点浮空 > 终点够不着 >
            // 搜不到，见 `Octomap3dPcdPath.failedReason`）：那四个字段都在它手上，
            // 这里只有一句话和一条折线。
            this.logPlan(start, goal, null, this.failureText(), params);
            this.path.noPath(this.path.failedReason(), null);
            return;
        }
        // 末端落在终点的接受范围之外：按没找到处理。规划器会尽量给出一条路，终点
        // 落在障碍里时它退而求其次吸附到最近站得住的地方（搜不过去时还会改用「可达
        // 的最近点」兜底），结果可能离用户点的位置任意远——那条路径画出来看着像模像
        // 样，狗其实没走到地方。
        //
        // 接受范围是一个**球**，不是地平面上的一圈——量三维。只量水平会让「停在终点
        // **正下方**」也算走到：终点悬在半空（点在一面薄墙、一条窄带的正上方）时，
        // `mapPoint` 会把它一路吸附到地面上，路径忠实地走到那个投影，水平差几厘米
        // → 判成成功，而狗离终点还差着好几米。用户看到的就是「路径找到了终点的投影」。
        //
        // 唯一的例外是**终点有面接着**（`goalOnFace`，终点是射线打在墙面、桌面、台阶
        // 立面上的原始命中点）：那时路径末端本来就该落在终点脚下的那个面上，竖直那一
        // 维归上面那条「落差」判据管——量三维会把「点墙面」这个常见手势一律判失败。
        // 两个分支与规划器里 `goalTooHigh` 那两条判据同源，见
        // `Octomap3dPcdPathPlanner` 的 `goalOnFace`。
        const end = points[points.length - 1];
        const distance = this.path.goalOnFace
            ? Math.hypot(end[0] - goal[0], end[2] - goal[2])
            : Math.hypot(end[0] - goal[0], end[1] - goal[1], end[2] - goal[2]);
        if (this.path.heightGap !== null) {
            // 高度那两种（终点够不着 / 小狗自己下不来）优先于「差多远」：这两种情形里末端离
            // 得远只是**症状**，根因是高度——报「差 0.3 m」会把用户引到「终点范围」那根滑杆
            // 上，而该动的是「跨越高度」，或者干脆把小狗挪个地方。走到这儿说明路径是画得出
            // 来的（末端是退而求其次的那个点），高度那两句话不报就只剩一句「路径 N 个点」，
            // 用户看着狗停在桌子底下，只会以为是自己没点准。
            //
            // 距离给 null：这里要用户动的不是终点范围，再报一个水平距离只会把人往那根滑杆上
            // 引（见 OctomapPathFailedDetail.distance）。到底哪一句由规划器定。
            this.dog.stop();
            this.logPlan(start, goal, points, this.failureText(), params);
            this.path.noPath(this.path.failedReason(), null);
            return;
        }
        if (distance > this.path.goalRadius) {
            this.dog.stop();
            this.logPlan(start, goal, points, `失败：路径没走到终点（末端离终点 ${distance.toFixed(2)} m，超出终点范围 ${this.path.goalRadius.toFixed(2)} m）`, params);
            this.path.noPath('outOfRange', distance);
            return;
        }
        this.logPlan(start, goal, points, '成功', params);
        // 折线第一点就是碰撞体正前方，绘制与行进共用它。setPath 会把小狗挪到
        // 那里待命——放置点仍记在 startPosition 里，因此重新规划时它会先回到
        // 放置点再算一次，不会每次往前叠一个半径。
        this.dog.setPath(points);
        this.syncMarkerScale();
        this.path.render(points);
    }
    /**
     * 把这一次规划量到的几个距离打到控制台：**直线**、**能走多远**、**还差多少**。
     *
     * 界面上只说一句话（「路径没走到终点（差 X m）」之类），而这三个数一起看才能分清
     * 两种完全不同的失败：一种是**压根没算出折线**（`points` 为 null），另一种是**算出
     * 来了但只走了一半**——后者在界面上什么都不画（`noPath` 会清掉线），看着和「找不到
     * 路径」一模一样。而它恰恰是最容易被误判的一种：小狗明明往前走了几步，屏幕上却一片
     * 空白。
     *
     * `能走` 量的是折线末端到**小狗**的水平距离（问的是「往里走了多远」），不是折线的
     * 总长——绕路的路径这两个数会差出不少，所以路径总长另给一个数。末端到终点那一段
     * 就是界面上的「还差 X m」。
     */
    logPlan(start, goal, points, outcome, params) {
        // 三个数各自的**量法**必须写在名字里，否则它们看着会互相打架。
        //
        // 「能走」量的是**折线本身的长度**——小狗真要迈过的距离。曾经它量的是
        // 「小狗 → 折线末端」的水平直线距离，于是和旁边的「路径长」对不上：折线
        // 不是从小狗脚下起算的，A* 用的是身前一个碰撞半径处的探测点（见 findPath），
        // 两个原点混在一起就会印出「能走 1.14 m（路径长 0.87 m）」这种看着不可能的行。
        // 起点挪了这一下也一并报出来，它正是那两个数对不上的原因。
        const straight = Math.hypot(goal[0] - start[0], goal[2] - start[2]);
        let walked = 0;
        let short = straight;
        let detail = '';
        if (points && points.length >= 2) {
            const end = points[points.length - 1];
            short = Math.hypot(goal[0] - end[0], goal[2] - end[2]);
            for (let i = 1; i < points.length; i++) {
                walked += Math.hypot(points[i][0] - points[i - 1][0], points[i][2] - points[i - 1][2]);
            }
            const lead = Math.hypot(points[0][0] - start[0], points[0][2] - start[2]);
            // 半格以下不提：折线本来就落在格心上，起点的吸附误差总有那么大。
            const leadText = lead > this.path.goalRadius / 5 ? `，起点在小狗前方 ${lead.toFixed(2)} m` : '';
            detail = `（${points.length} 点${leadText}）`;
        }
        console.log(`[寻路] 直线 ${straight.toFixed(2)} m ｜ 能走 ${walked.toFixed(2)} m ｜ 还差 ${short.toFixed(2)} m ｜ ${outcome}${detail}`);
        console.log(`[寻路] 跨越高度 ${params.maxStepHeight.toFixed(2)} ｜ 跨越宽度 ${params.crossWidth.toFixed(2)} ｜ 碰撞半径 ${params.dogRadius.toFixed(2)} ｜ 通行高度 ${params.dogHeight.toFixed(2)} ｜ 终点范围 ${this.path.goalRadius.toFixed(2)} m`);
    }
    /**
     * 规划失败的原因 → 控制台上那句话。
     *
     * 界面上那几句文案在 `SystemManagerComponent` 里（要带操作建议，是给用户看的）；
     * 这里只求排查时一眼认得，所以短。数从
     * {@link Octomap3dPcdPath.heightGap} 现取——它紧跟着 `computePath` 才有效。
     */
    failureText() {
        const gap = this.path.heightGap ?? 0;
        switch (this.path.failedReason()) {
            case 'tooLarge':
                return '失败：场景太大，规划网格超限';
            case 'dogStuck':
                return `失败：小狗站在离地 ${gap.toFixed(2)} m 的地方，下不到地面`;
            case 'gap':
                return `失败：落差 ${gap.toFixed(2)} m，超过跨越高度`;
            case 'goalTooHigh':
                return `失败：终点浮在那一列最高的面之上，吸附丢了 ${gap.toFixed(2)} m`;
            default:
                return '失败：找不到路径（这一片走不到终点）';
        }
    }
    /** 让小狗沿存储的路径开始行进。 */
    startWalk() {
        this.dog.startWalking();
    }
    /** 将小狗拖拽定位到存储路径的某个比例（0..1）处。 */
    seekWalk(progress) {
        this.dog.seek(progress);
    }
    /** 在行进途中暂停小狗。 */
    pauseWalk() {
        this.dog.pause();
    }
    /** 让小狗从暂停的行进中恢复。 */
    resumeWalk() {
        this.dog.resume();
    }
    /** 在世界坐标位置添加一个体素（供点云编辑器使用）。 */
    addVoxel(world, options) {
        this.grille.addVoxel(world, options);
    }
    /** 按网格 key 移除一个体素（供点云编辑器使用）。 */
    removeVoxel(key, options) {
        this.grille.removeVoxel(key, options);
    }
    /** 将体素从其网格 key 移动到新的世界坐标位置（点云编辑器）。 */
    moveVoxel(key, world, options) {
        this.grille.moveVoxel(key, world, options);
    }
    /** 以全分辨率返回编辑后的点云，用于导出。 */
    toPointCloud() {
        return this.grille.toPointCloud();
    }
    /** 将当前点云重采样为每个占用的体素中心一个点。 */
    toRegularCloud() {
        return this.grille.toRegularCloud();
    }
    /** 当前俯视投影的全部输入（点位置、对齐包围盒、分辨率）。 */
    projectionSource() {
        return this.grille.projectionSource();
    }
    /**
     * 把小狗的碰撞足迹和当前的渲染体素大小交给路径控制器，让它按这个尺寸画终点
     * 锥和路径管。
     *
     * 体素大小取自网格：点云模式下没有网格（也就没有路径），此时退回 0，尺寸全由
     * 小狗决定。
     */
    syncMarkerScale() {
        this.path.setScaleReference(this.dog.footprintRadius, this.dog.footprintHeight, this.grille.grid?.voxelSize ?? 0);
    }
    dispose() {
        this.grille.dispose();
        this.dog.dispose();
        this.path.dispose();
        this.global.dispose();
    }
    static ɵfac = i0.ɵɵngDeclareFactory({ minVersion: "12.0.0", version: "21.2.26", ngImport: i0, type: Octomap3dPcd, deps: [{ token: Octomap3dPcdGrille }, { token: Octomap3dPcdGlobal }, { token: Octomap3dPcdDog }, { token: Octomap3dPcdPath }], target: i0.ɵɵFactoryTarget.Injectable });
    static ɵprov = i0.ɵɵngDeclareInjectable({ minVersion: "12.0.0", version: "21.2.26", ngImport: i0, type: Octomap3dPcd });
}
i0.ɵɵngDeclareClassMetadata({ minVersion: "12.0.0", version: "21.2.26", ngImport: i0, type: Octomap3dPcd, decorators: [{
            type: Injectable
        }], ctorParameters: () => [{ type: Octomap3dPcdGrille }, { type: Octomap3dPcdGlobal }, { type: Octomap3dPcdDog }, { type: Octomap3dPcdPath }] });
const Octomap3dPcdProviders = [
    Octomap3dPcdGrille,
    Octomap3dPcdGlobal,
    Octomap3dPcdDog,
    Octomap3dPcdPath,
    Octomap3dPcd,
];

const DEFAULT_BACKGROUND = '#0b1016';
const DEFAULT_POINT_COLOR = '#4fc3f7';
const DRAG_THRESHOLD_PX = 4;
/** 两份悬停读数是否指向同一个点（都为 null 时也算相同）。 */
function isSameHover(a, b) {
    if (!a || !b) {
        return a === b;
    }
    return (a.forbidden === b.forbidden &&
        a.position[0] === b.position[0] &&
        a.position[1] === b.position[1] &&
        a.position[2] === b.position[2]);
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
class Octomap3dPcdComponent {
    viewportRef;
    /** 要渲染的点云。传 null 清空视口。 */
    points = null;
    /**
     * 拖动中的整体变换预览：把合并点云里的一段点当成刚体挪一下（见
     * {@link OctomapCloudPreview}）。非 null 时**只改画面**，其余一概不碰。
     *
     * 多份点云拼成了一份渲染对象（手柄只该动其中一份），整份对象一挪会把别的云也
     * 带走，所以这里只动选中那一份：体素模式改写它占的那些实例矩阵，点云模式重画一份
     * 世界。与普通的 `points` 换新**刻意不同**：不走 {@link Octomap3dPcd.rebuild}，
     * 于是包围盒、地板高度、网格与地面、导航边界、手柄位姿都不动——拖动过程中世界并没有
     * 真的改变，那些跟着跳只会让参考物失去参照。
     *
     * 传回 null 表示回到 {@link points}（松手、取消拖动）。
     */
    preview = null;
    /**
     * 手柄的工作方式：`'off'` 不显示，`'translate'` 拖位移，`'rotate'` 拖旋转。
     *
     * 手柄是**另一个入口**，不改变 `points` 本身：拖动过程中只做画面预览，松手时
     * 通过 {@link cloudTranslated} / {@link cloudRotated} 把结果交给宿主；宿主改完
     * 数据、换一份新的 `points` 进来，画面才落到真实的坐标上。所以这个开关必须有人
     * 接那两个输出，否则云会「拖得动、松手弹回去」。
     */
    gizmoMode = 'off';
    /**
     * 手柄摆在哪：位置 + 云当前的整体朝向。null 时退回到包围盒中心、朝向恒等。
     *
     * 位置由宿主给（不是地图自己算包围盒中心）：云转过之后包围盒中心会漂，而宿主
     * 记账用的支点不会——两边不一致的话每转一次松手画面就跳一下。见
     * {@link OctomapGizmoPose}。
     */
    gizmoPose = null;
    /**
     * 圈出当前选中的那一份点云（世界包围盒）；null 表示不画。
     *
     * 只在场景里拼了多份云、且手柄打开时才有意义——手柄只动其中一份，看框才知道
     * 动的是哪份。手柄收起来时宿主会传 null（选中本身还在，只是没东西可操作），
     * 地图跟着不画。地图不知道那是什么，只管画一个盒子。
     */
    selectionBox = null;
    /**
     * 拖手柄时要不要让渲染出来的云跟着动（预览）。
     *
     * 单份点云时当然要——那是「看得见的拖动」。多份点云拼在一个渲染对象里时，
     * 预览动的是**整片**：别的云会一起被拖走，松手又弹回去，看着像全部选中了。
     * 那种场合宿主关掉它，只让手柄和读数跟着手指走。
     */
    gizmoPreview = true;
    /**
     * `points` 换新时要不要把相机重新对到云上。
     *
     * 换文件时要；对**同一份云**做整体变换（旋转、平移、改角度）时不要——相机是用
     * 户自己调好的，每改一次就跳回默认机位会很烦。宿主知道这次是哪一种。
     */
    fitOnPointsChange = true;
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
    refitReferenceOnPointsChange = true;
    /**
     * 手柄左上角那段只读读数（宿主格式化好的文本，可以有换行）。null 时不显示。
     *
     * 内容是宿主的事：地图不知道「偏移了多少」「转了多少度」这种语义，它只知道云被
     * 动过（见 {@link cloudTranslating} / {@link cloudTranslated} /
     * {@link cloudRotating} / {@link cloudRotated}）。
     */
    gizmoReadout = null;
    /** 点云的绘制方式：原始点云或立体格栅。 */
    renderMode = 'voxel';
    /** 体素边长（世界单位）。为 null 时由包围盒推导。 */
    voxelSize = null;
    /** 视口的背景/清屏颜色。 */
    backgroundColor = DEFAULT_BACKGROUND;
    /** 点云没有逐点颜色时使用的兜底颜色。 */
    pointColor = DEFAULT_POINT_COLOR;
    /** 点大小（世界单位，仅点云模式）。为 null 时自动推导。 */
    pointSize = null;
    /** 是否显示参考网格。 */
    showGrid = true;
    /**
     * 是否显示规划网格能覆盖的范围。场景超限时无视它，强制显示。
     *
     * 显式标注 `boolean`：`DEFAULT_OCTOMAP_SETTINGS` 是用 `satisfies` 收尾的，各值
     * 都保留字面量类型，所以 `= DEFAULT_OCTOMAP_SETTINGS.showNavLimit` 会被推成
     * `true`，父组件绑 `false` 就编译不过。
     */
    showNavLimit = DEFAULT_OCTOMAP_SETTINGS.showNavLimit;
    /**
     * 是否画出规划出来的路径。关掉只是隐藏，规划结果和行进都不受影响。
     *
     * 同样必须显式标注 `boolean`（与 {@link showNavLimit} 同一个坑，见
     * [[default-settings-literal-type]]）。
     */
    showPath = DEFAULT_OCTOMAP_SETTINGS.showPath;
    /**
     * 是否把路径的每个顶点标成一颗珠子。与 {@link showPath} 各管各的：那一项只管管子。
     *
     * 同样必须显式标注 `boolean`（与 {@link showNavLimit} 同一个坑，见
     * [[default-settings-literal-type]]）——这里的默认值恰好是 `false`，不标注就再也
     * 写不进 `true`。
     */
    showPathPoints = DEFAULT_OCTOMAP_SETTINGS.showPathPoints;
    /** 参考网格的大小（世界单位）。 */
    gridSize = 10;
    /** 每个网格单元的细分数。 */
    gridDivisions = 10;
    /** 点云变化时自动让相机适配点云。 */
    fitView = true;
    /** 让相机绕场景缓慢旋转。 */
    autoRotate = false;
    /** 当前是否显示已刷（障碍）颜色。 */
    showColoring = true;
    /** 禁行区域（已刷障碍）的颜色。 */
    forbiddenColor = '#ef4444';
    /** 已持久化的已刷障碍，在（重新）构建后重新应用。 */
    painted = null;
    /** 鼠标交互在地图上的解释方式。 */
    interactionMode = 'view';
    /**
     * 障碍刷的半径（世界单位）。默认值与 {@link DEFAULT_OCTOMAP_SETTINGS} 一致，不抄
     * 字面量：首次绑定会被 `ngOnChanges` 跳过（见记忆 `ngOnChanges-skips-first-binding`），
     * 所以这里的初值必须就是那个默认值。**显式标注 `number`** 则是因为默认设置用
     * `satisfies` 收尾、各值保留字面量类型（见记忆 `default-settings-literal-type`）。
     */
    brushRadius = DEFAULT_OCTOMAP_SETTINGS.brushRadius;
    /** 小狗能迈过/爬过的最大高度（世界单位）。 */
    maxStepHeight = 0.5;
    /**
     * 小狗一步能跨过的无支撑水平跨度上限（世界单位），0 = 不跨。地上的小坑靠它过去。
     */
    crossWidth = 0.125;
    /**
     * 「填充基准范围」（单位：导航格），只影响「贴云点面」那一档，见
     * {@link OctomapMapSettings.fillBaseCells}。
     *
     * 显式标注 `number` 是因为 `DEFAULT_OCTOMAP_SETTINGS` 用 `satisfies` 收尾、各值
     * 保留字面量类型，不标注就会被推成 `8`。
     */
    fillBaseCells = DEFAULT_OCTOMAP_SETTINGS.fillBaseCells;
    /**
     * 终点的接受范围半径（世界单位）。路径末端落在这个半径之外就按「没找到路径」
     * 处理，并发出 `(pathFailed)`；终点周围画一圈同样大小的圆环标出这条边界。
     */
    goalRadius = 0.5;
    /** 小狗的碰撞半径（足迹宽度的一半，世界单位）。 */
    dogRadius = 0.25;
    /** 小狗的净空高度（世界单位）。 */
    dogHeight = 0.8;
    /** 是否显示小狗的碰撞足迹圆。 */
    showDogCollision = true;
    /** 小狗模型的缩放系数（1 = 原始大小）。 */
    dogScale = 1;
    /** 是否让小狗模型自动缩放到与碰撞足迹同宽（此时 dogScale 不生效）。 */
    dogFitCollision = false;
    /** 外部模型的朝向补偿，单位：度（模型正面相对 +X 偏了多少）。 */
    dogModelHeading = 0;
    /** 小狗放置、拖拽和停下时的朝向，单位：度（0 = 面向世界 +X）。 */
    dogHeading = 0;
    /** 高于此高度的点云点被隐藏（null=全部显示）。 */
    maxHeight = null;
    /** 低于此高度的点云点被隐藏（null=全部显示）。 */
    minHeight = null;
    /** 可行走地面是否延伸到点云包围盒之外。 */
    groundExtendsOutside = true;
    /**
     * 地面平面沿 X 轴向包围盒外延展的长度（单边，世界单位）。
     *
     * 显式标注 `: number`：`DEFAULT_OCTOMAP_SETTINGS` 用 `satisfies` 收尾、各值保留
     * 字面量类型，抄初值会被推成 `0.9`，父组件传别的数就编译不过（与
     * {@link pathAlgorithm} 同一个坑，见 [[default-settings-literal-type]]）。
     */
    groundExtendX = DEFAULT_OCTOMAP_SETTINGS.groundExtendX;
    /** 地面平面沿 Z 轴向包围盒外延展的宽度（单边，世界单位）。 */
    groundExtendZ = DEFAULT_OCTOMAP_SETTINGS.groundExtendZ;
    /**
     * 用哪种方式寻路，见 {@link OctomapPathAlgorithm}。
     *
     * 显式标注 `OctomapPathAlgorithm`：`DEFAULT_OCTOMAP_SETTINGS` 用 `satisfies` 收尾，
     * 各值保留字面量类型，抄初值会被推成 `'surfaceGraph'`，父组件换一种就编译不过
     * （与 {@link showNavLimit} 同一个坑，见 [[default-settings-literal-type]]）。
     */
    pathAlgorithm = DEFAULT_OCTOMAP_SETTINGS.pathAlgorithm;
    /** 点击时射线拾取的点数上限（点云模式的安全保护）。 */
    maxPickingPoints = 1_000_000;
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
    findPath = new EventEmitter();
    /** 让小狗沿当前路径开始行进。 */
    startWalk = new EventEmitter();
    /** 跳到路径上的某个位置（[0, 1]）。 */
    seekWalk = new EventEmitter();
    /** 暂停行进。 */
    pauseWalk = new EventEmitter();
    /** 从暂停处继续行进。 */
    resumeWalk = new EventEmitter();
    /** 移除小狗、终点和路径，便于用户从头重新部署。 */
    clearDeployment = new EventEmitter();
    /** 把当前几何中所有被判定为障碍的体素都标记为禁行。 */
    markAllObstacles = new EventEmitter();
    /** 清空已刷（禁行）障碍。 */
    clearObstacles = new EventEmitter();
    /** 清掉外部模型，恢复内置几何体小狗。 */
    clearDogModel = new EventEmitter();
    // 下面四个是取值型：payload 是「回填函数」，子组件算出结果就调它，见
    // {@link OctomapReply}。`loadDogModel` 是唯一异步的一条。
    /**
     * 用外部模型文件替换小狗的内置几何体。`url` 可以是 blob/object URL 或静态
     * 资源路径。不传 `reply` 时失败静默。
     */
    loadDogModel = new EventEmitter();
    /** 取回用于导出的编辑后点云（每体素一个点，或原始点）。 */
    exportPointCloud = new EventEmitter();
    /** 取回重采样到体素点阵上的点云（非体素模式为 null）。 */
    regularizeCloud = new EventEmitter();
    /**
     * 取回当前俯视投影的全部输入（点位置、对齐包围盒、分辨率）。
     *
     * 给的是**输入**而不是算好的图：算图的那一步在 `projection.util.ts` 的纯函数里，
     * 调用方（投影弹窗）自己决定要占用图还是高度图。没有可投影的云点时回填 null。
     */
    projectionSource = new EventEmitter();
    /** WebGL 场景和控制器创建完成后发出一次。 */
    mapReady = new EventEmitter();
    /** 渲染的点云变化时发出。 */
    pointsChanged = new EventEmitter();
    /**
     * 用户拖动平移手柄松手时发出：整片云这一下挪了多少（增量，世界坐标）。
     *
     * 只有拖动**结束时**发一次——过程中地图自己做了视觉预览，没必要让宿主每帧
     * 重建上百万个点。
     */
    cloudTranslated = new EventEmitter();
    /**
     * 拖动平移手柄**过程中**发出：从按下那一刻算起挪了多少（相对量，世界坐标）。
     *
     * 给 {@link gizmoReadout} 那种「边拖边报数」的显示用；判据、松手后的落账
     * 一律走 {@link cloudTranslated}。一次拖动会发很多次（跟着指针走），接的人自己
     * 掂量要不要每帧都画。
     */
    cloudTranslating = new EventEmitter();
    /**
     * 用户拖动旋转手柄松手时发出：云现在的整体朝向（**绝对值**，度，`'XYZ'`）。
     *
     * 与 {@link cloudTranslated} 相反，它不是增量：手柄拖出来的就是「转到哪儿」，
     * 宿主直接写进设置即可（增量要做四元数合成，那是地图这边的事）。
     */
    cloudRotated = new EventEmitter();
    /**
     * 拖动旋转手柄**过程中**发出：叠加之后的总朝向（绝对值，度，`'XYZ'`）。
     *
     * 口径同 {@link cloudTranslating}：只给读数用，落账一律走 {@link cloudRotated}。
     */
    cloudRotating = new EventEmitter();
    /** 用户点击点/体素（射线拾取）时发出。 */
    pointClicked = new EventEmitter();
    /** 导航路径变化时发出（点数，清空时为 null）。 */
    pathChanged = new EventEmitter();
    /**
     * 寻路失败时发出，带上原因。比 `pathChanged` 的 0 更具体——父组件据此能区分
     * 「搜不到路」和「搜到了但没走到用户点的位置」。
     */
    pathFailed = new EventEmitter();
    /** 小狗在路径上的位置（及其状态）变化时发出。 */
    walkProgress = new EventEmitter();
    /** 小狗被放置（或移动）到地面时发出。 */
    dogPlaced = new EventEmitter();
    /** 终点被放置（或移动）到地面时发出。 */
    goalPlaced = new EventEmitter();
    /** 已刷（禁行）障碍集合变化时发出。 */
    paintedChanged = new EventEmitter();
    /**
     * 刷障碍时这一笔**没刷到任何点**时发出：笔刷在拖拽中扫出了点云（或当前是「点云」
     * 显示模式，压根没有体素可刷）。判据与其余三个前置条件见 `reportBrushMiss`。
     *
     * 一次按下到抬起之间**最多一次**（见 `brushMissed`）；「空处按下」不发——那是要转
     * 相机；擦除不发——在没有障碍的地方擦是常事。父组件拿它给用户一句话
     * （见 `OctomapBrushMissDetail`）。
     */
    brushMiss = new EventEmitter();
    /** 用户右键退出编辑器模式（回到视图模式）时发出。 */
    interactionModeChange = new EventEmitter();
    /** 发生渲染/几何错误时发出。 */
    error = new EventEmitter();
    /**
     * 指针下那个云点的读数，显示在视口右下角；没指着东西时为 null。
     *
     * 用信号而不是普通字段：探测发生在 requestAnimationFrame 里，信号能自己把 OnPush
     * 的这一帧标脏，不必再去碰变更检测。
     */
    hover = signal(null, ...(ngDevMode ? [{ debugName: "hover" }] : /* istanbul ignore next */ []));
    controller = inject(Octomap3dPcd);
    subscriptions = [];
    /** 已排队的悬停探测帧；0 = 没有排队。 */
    hoverFrame = 0;
    /** 最近一次 pointermove 事件，供每帧那一次探测取用。 */
    hoverEvent = null;
    resizeObserver;
    viewInitialized = false;
    dragStartX = 0;
    dragStartY = 0;
    brushing = false;
    /**
     * 这一笔（一次按下到抬起之间）已经因为「刷不到点」提示过了吗。
     *
     * 一次拖拽会按 pointermove 的频率刷几十下，不记这个就会刷屏。**在按下那一支清零**，
     * 所以「一笔一次」的口径是按下到抬起：下一次按下又能提示一次。`pointerup` 不必清
     * ——`pointerup` 到下一次 `pointerdown` 之间根本不会走到刷笔那条路（`brushing` 已置 false）。
     */
    brushMissed = false;
    draggingDog = false;
    /** 这一次按下落在平移手柄上：随后的 `click` 不该再去拾取/取消选中。 */
    gizmoPressed = false;
    /** 右键按下的位置，用于区分取消点击与平移。 */
    rightDownX = 0;
    rightDownY = 0;
    /** 右键按下且移动超过拖拽阈值时为 true。 */
    rightDragged = false;
    /** “移动”编辑器抓住的体素，等待放置点击。 */
    moveSourceKey = null;
    onPointerDown = (event) => {
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
        if ((this.interactionMode === 'brush' || this.interactionMode === 'erase') &&
            event.button === 0 &&
            this.brushAtPointer(event)) {
            this.brushing = true;
            this.brushMissed = false;
            this.controller.global.setControlsEnabled(false);
            return;
        }
        // 视图模式下，左键按在小狗上会抓住它，以便拖拽。
        if (this.interactionMode === 'view' &&
            event.button === 0 &&
            this.controller.dog.pick(event)) {
            this.draggingDog = true;
            this.controller.dog.select();
            this.controller.clearPath();
            this.controller.global.setControlsEnabled(false);
        }
    };
    onPointerMove = (event) => {
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
        if (this.interactionMode === 'addPoint' ||
            this.interactionMode === 'deletePoint' ||
            this.interactionMode === 'movePoint') {
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
    onPointerLeave = () => {
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
    scheduleHover(event) {
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
    clearHover() {
        this.hoverEvent = null;
        if (this.hoverFrame) {
            cancelAnimationFrame(this.hoverFrame);
            this.hoverFrame = 0;
        }
        this.hover.set(null);
    }
    onPointerUp = (event) => {
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
    onContextMenu = (event) => {
        // 这里从不需要浏览器菜单；该手势是否同时取消
        // 编辑器模式在 pointerup 时决定，那时已知拖拽距离。
        event.preventDefault();
    };
    /** 退出添加/删除/移动编辑器模式，让地图回到普通视图。 */
    cancelEditorMode() {
        if (this.interactionMode === 'addPoint' ||
            this.interactionMode === 'deletePoint' ||
            this.interactionMode === 'movePoint') {
            this.interactionModeChange.emit('view');
        }
    }
    onClick = (event) => {
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
            }
            else {
                this.controller.dog.deselect();
                this.controller.grille.pick(event, this.renderMode, this.maxPickingPoints);
            }
        }
        else if (this.interactionMode === 'addPoint') {
            this.addPointAt(event);
        }
        else if (this.interactionMode === 'deletePoint') {
            this.deletePointAt(event);
        }
        else if (this.interactionMode === 'movePoint') {
            this.movePointAt(event);
        }
    };
    onDblClick = (event) => {
        if (this.interactionMode === 'placeDog') {
            this.placeOnGround(event, 'dog');
        }
        else if (this.interactionMode === 'placeGoal') {
            this.placeOnGround(event, 'goal');
        }
    };
    ngAfterViewInit() {
        this.viewInitialized = true;
        const el = this.viewportRef.nativeElement;
        const width = el.clientWidth || 1;
        const height = el.clientHeight || 1;
        // 在首次构建前把控制器事件转发到 @Output 发射器，
        // 以免错过初始的 pointsChanged。
        this.subscriptions.push(this.controller.grille.pointsChanged.subscribe((detail) => {
            // 点云换了，读数指向的可能已经是不存在的点——重挂时就先收起来，鼠标再动
            // 一下会重新算。
            this.clearHover();
            this.pointsChanged.emit(detail);
        }), this.controller.grille.pointClicked.subscribe((detail) => this.pointClicked.emit(detail)), this.controller.grille.paintedChanged.subscribe((painted) => this.paintedChanged.emit(painted)), this.controller.grille.error.subscribe((err) => this.error.emit(err)), this.controller.path.pathChanged.subscribe((count) => this.pathChanged.emit(count)), this.controller.path.pathFailed.subscribe((detail) => this.pathFailed.emit(detail)), this.controller.dog.walkStateChanged.subscribe((progress) => this.walkProgress.emit(progress)), 
        // 拖动过程中只做画面预览（动渲染对象，不动数据）；松手才把增量交给宿主。
        this.controller.global.gizmoDragged.subscribe(([x, y, z]) => {
            if (this.gizmoPreview) {
                this.controller.grille.setPreviewOffset(x, y, z);
            }
            this.cloudTranslating.emit({ x, y, z });
        }), this.controller.global.gizmoCommitted.subscribe(([x, y, z]) => this.cloudTranslated.emit({ x, y, z })), 
        // 旋转同一个套路，只是报的是**总朝向**：预览要的是增量（画面上的云已经转过
        // 一次了），读数要的是总量（宿主直接显示）。
        this.controller.global.gizmoRotating.subscribe(({ delta, pivot, euler }) => {
            if (this.gizmoPreview) {
                this.controller.grille.setPreviewRotation(delta, pivot);
            }
            this.cloudRotating.emit({ x: euler[0], y: euler[1], z: euler[2] });
        }), this.controller.global.gizmoRotated.subscribe(([x, y, z]) => this.cloudRotated.emit({ x, y, z })));
        // 和上面那批同一个时机：父组件最早的 emit 来自用户事件或 fetch 回调，都在
        // 首轮变更检测之后，而 Angular 保证子组件的 ngAfterViewInit 先于父组件。
        this.connectCommands();
        this.controller.global.init(el, this.backgroundColor, this.autoRotate);
        this.controller.global.rebuildGrid(this.showGrid, this.gridSize, this.gridDivisions);
        this.controller.rebuild(this.points, this.renderOptions(), true, this.groundExtent(), this.fitOnPointsChange, this.refitReferenceOnPointsChange);
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
    ngOnChanges(changes) {
        if (!this.viewInitialized) {
            return;
        }
        // 数据或体素分辨率变化时完全重建。
        if (changes['points']) {
            this.controller.rebuild(this.points, this.renderOptions(), true, this.groundExtent(), this.fitOnPointsChange, this.refitReferenceOnPointsChange);
            // 云没了手柄也得收起来——它会孤零零地悬在原点。云换了位置时宿主的
            // `gizmoPose` 也会跟着变，但那一次不一定和这里同一拍，先按新的包围盒兜一次。
            this.syncGizmo();
        }
        else if (changes['preview']) {
            // 只改画面，不重建世界：体素模式挪选中那份的实例矩阵，点云模式整份重画
            // （见 `Octomap3dPcdGrille.applyPreview`）。包围盒、地板、网格与手柄都不动。
            this.controller.grille.applyPreview(this.preview, this.renderOptions(), this.points);
        }
        else if (changes['renderMode'] ||
            changes['voxelSize'] ||
            changes['maxHeight'] ||
            changes['minHeight']) {
            this.controller.rebuild(this.points, this.renderOptions(), false, this.groundExtent());
        }
        else if (changes['pointColor']) {
            if (this.renderMode === 'voxel') {
                this.controller.rebuild(this.points, this.renderOptions(), false, this.groundExtent());
            }
            else {
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
            this.controller.global.setBrushCursorVisible(this.interactionMode === 'brush' || this.interactionMode === 'erase');
            this.moveSourceKey = null;
            this.controller.grille.clearEditorFeedback(this.renderOptions());
        }
        // 三个条件**必须取或**：`SimpleChanges` 只记录值真的变了的键，只判
        // `groundExtendsOutside` 的话，用户拖两根拉杆时那个键根本不出现——面板上的
        // 数字在动、地面一动不动，功能是死的。同一个机制还咬异步的 `restoreSettings`
        // （配置文件里只改了延展量，`groundExtendsOutside` 值没变就进不来这里）。
        if (changes['groundExtendsOutside'] ||
            changes['groundExtendX'] ||
            changes['groundExtendZ']) {
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
    ngOnDestroy() {
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
    resetCamera() {
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
    syncGizmo() {
        const mode = this.points === null ? 'off' : this.gizmoMode;
        this.controller.global.setMoveGizmoMode(mode === 'off' ? 'translate' : mode);
        this.controller.global.setMoveGizmoVisible(mode !== 'off');
        if (mode !== 'off') {
            if (this.gizmoPose) {
                this.controller.global.setGizmoPose(this.gizmoPose.position, this.gizmoPose.rotation);
            }
            else {
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
    connectCommands() {
        this.subscriptions.push(
        // 唯一的异步命令：url 随请求下来，加载完用 reply 把错误串回填。`reply` 缺省
        // 时（启动时按记住的文件名恢复那条路）失败静默。
        this.loadDogModel.subscribe(({ url, reply }) => {
            void this.applyDogModel(url).then((error) => reply?.(error));
        }), this.clearDogModel.subscribe(() => this.controller.dog.clearModel()), this.findPath.subscribe(() => this.controller.findPath(this.maxStepHeight, this.crossWidth, this.dogRadius, this.dogHeight, this.groundExtendsOutside)), this.startWalk.subscribe(() => this.controller.startWalk()), this.seekWalk.subscribe((progress) => this.controller.seekWalk(progress)), this.pauseWalk.subscribe(() => this.controller.pauseWalk()), this.resumeWalk.subscribe(() => this.controller.resumeWalk()), this.clearDeployment.subscribe(() => this.controller.resetDeployment()), this.markAllObstacles.subscribe(() => this.controller.markAllObstacles(this.renderOptions())), this.clearObstacles.subscribe(() => this.controller.grille.clearObstacles(this.renderOptions())), 
        // 取值型：算出来直接回填给父组件。
        this.exportPointCloud.subscribe((reply) => reply(this.controller.toPointCloud())), this.regularizeCloud.subscribe((reply) => reply(this.controller.toRegularCloud())), this.projectionSource.subscribe((reply) => reply(this.controller.projectionSource())));
    }
    /**
     * 用外部模型文件替换小狗的内置几何体。`url` 可以是 blob/object URL 或静态
     * 资源路径。返回 null 表示成功，否则是可显示的失败原因。
     */
    async applyDogModel(url) {
        try {
            const gltf = await new GLTFLoader().loadAsync(url);
            this.controller.dog.setCustomModel(gltf.scene);
            return null;
        }
        catch (error) {
            return error instanceof Error ? error.message : String(error);
        }
    }
    brushAtPointer(event) {
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
    reportBrushMiss() {
        if (this.interactionMode !== 'brush' || !this.brushing || this.brushMissed) {
            return;
        }
        this.brushMissed = true;
        // 报**实际**的体素大小（`voxelSize` 那个输入可以是 null = 自动），文案里要拿它
        // 说明「笔刷半径才几格」，见 `OctomapBrushMissDetail`。
        this.brushMiss.emit({
            radius: this.brushRadius,
            voxelSize: this.controller.grille.grid?.voxelSize ?? 0,
        });
    }
    placeOnGround(event, kind) {
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
        }
        else {
            this.controller.placeGoal(point);
            this.goalPlaced.emit();
        }
    }
    /** 下一个添加/移动的体素将落在哪：点击面的邻居，否则为地面。 */
    resolvePlacementTarget(event) {
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
    updateEditorHover(event) {
        const options = this.renderOptions();
        if (this.interactionMode === 'addPoint') {
            this.controller.grille.setPreviewPosition(this.resolvePlacementTarget(event));
        }
        else if (this.interactionMode === 'deletePoint') {
            const pick = this.controller.grille.pickVoxel(event);
            this.controller.grille.setVoxelHighlight(pick?.key ?? null, options);
        }
        else if (this.interactionMode === 'movePoint') {
            if (!this.moveSourceKey) {
                const pick = this.controller.grille.pickVoxel(event);
                this.controller.grille.setVoxelHighlight(pick?.key ?? null, options);
            }
            else {
                this.controller.grille.setPreviewPosition(this.resolvePlacementTarget(event));
            }
        }
    }
    addPointAt(event) {
        const target = this.resolvePlacementTarget(event);
        if (target) {
            this.controller.addVoxel(target, this.renderOptions());
        }
    }
    deletePointAt(event) {
        const pick = this.controller.grille.pickVoxel(event);
        if (pick) {
            this.controller.removeVoxel(pick.key, this.renderOptions());
        }
    }
    movePointAt(event) {
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
        }
        else {
            // 落在空处：取消移动并清除手持着色。
            this.controller.grille.clearEditorFeedback(this.renderOptions());
        }
    }
    refreshColoring() {
        if (this.renderMode === 'voxel') {
            this.controller.grille.refreshColors(this.renderOptions());
        }
        else {
            this.controller.grille.applyMaterial(this.renderOptions());
        }
    }
    renderOptions() {
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
    groundExtent() {
        return {
            outside: this.groundExtendsOutside,
            x: this.groundExtendX,
            z: this.groundExtendZ,
        };
    }
    static ɵfac = i0.ɵɵngDeclareFactory({ minVersion: "12.0.0", version: "21.2.26", ngImport: i0, type: Octomap3dPcdComponent, deps: [], target: i0.ɵɵFactoryTarget.Component });
    static ɵcmp = i0.ɵɵngDeclareComponent({ minVersion: "17.0.0", version: "21.2.26", type: Octomap3dPcdComponent, isStandalone: true, selector: "howell-octomap-3d-pcd", inputs: { points: "points", preview: "preview", gizmoMode: "gizmoMode", gizmoPose: "gizmoPose", selectionBox: "selectionBox", gizmoPreview: "gizmoPreview", fitOnPointsChange: "fitOnPointsChange", refitReferenceOnPointsChange: "refitReferenceOnPointsChange", gizmoReadout: "gizmoReadout", renderMode: "renderMode", voxelSize: "voxelSize", backgroundColor: "backgroundColor", pointColor: "pointColor", pointSize: "pointSize", showGrid: "showGrid", showNavLimit: "showNavLimit", showPath: "showPath", showPathPoints: "showPathPoints", gridSize: "gridSize", gridDivisions: "gridDivisions", fitView: "fitView", autoRotate: "autoRotate", showColoring: "showColoring", forbiddenColor: "forbiddenColor", painted: "painted", interactionMode: "interactionMode", brushRadius: "brushRadius", maxStepHeight: "maxStepHeight", crossWidth: "crossWidth", fillBaseCells: "fillBaseCells", goalRadius: "goalRadius", dogRadius: "dogRadius", dogHeight: "dogHeight", showDogCollision: "showDogCollision", dogScale: "dogScale", dogFitCollision: "dogFitCollision", dogModelHeading: "dogModelHeading", dogHeading: "dogHeading", maxHeight: "maxHeight", minHeight: "minHeight", groundExtendsOutside: "groundExtendsOutside", groundExtendX: "groundExtendX", groundExtendZ: "groundExtendZ", pathAlgorithm: "pathAlgorithm", maxPickingPoints: "maxPickingPoints", findPath: "findPath", startWalk: "startWalk", seekWalk: "seekWalk", pauseWalk: "pauseWalk", resumeWalk: "resumeWalk", clearDeployment: "clearDeployment", markAllObstacles: "markAllObstacles", clearObstacles: "clearObstacles", clearDogModel: "clearDogModel", loadDogModel: "loadDogModel", exportPointCloud: "exportPointCloud", regularizeCloud: "regularizeCloud", projectionSource: "projectionSource" }, outputs: { mapReady: "mapReady", pointsChanged: "pointsChanged", cloudTranslated: "cloudTranslated", cloudTranslating: "cloudTranslating", cloudRotated: "cloudRotated", cloudRotating: "cloudRotating", pointClicked: "pointClicked", pathChanged: "pathChanged", pathFailed: "pathFailed", walkProgress: "walkProgress", dogPlaced: "dogPlaced", goalPlaced: "goalPlaced", paintedChanged: "paintedChanged", brushMiss: "brushMiss", interactionModeChange: "interactionModeChange", error: "error" }, providers: [...Octomap3dPcdProviders], viewQueries: [{ propertyName: "viewportRef", first: true, predicate: ["viewport"], descendants: true, static: true }], usesOnChanges: true, ngImport: i0, template: "<div #viewport class=\"octomap-3d-pcd__viewport\">\n  <!--\n    \u624B\u67C4\u7684\u8BFB\u6570\uFF08\u4F4D\u79FB / \u65CB\u8F6C\uFF09\u3002\u5185\u5BB9\u7531\u5BBF\u4E3B\u7ED9\uFF08\u5730\u56FE\u4E0D\u77E5\u9053\u300C\u504F\u79FB\u4E86\u591A\u5C11\u300D\u300C\u8F6C\u4E86\u591A\u5C11\u5EA6\u300D\n    \u8FD9\u79CD\u8BED\u4E49\uFF09\uFF0C\u4F4D\u7F6E\u9009\u5DE6\u4E0A\uFF1A\u53F3\u4E0B\u90A3\u5757\u662F\u60AC\u505C\u8BFB\u6570\uFF0C\u4E24\u8005\u4E0D\u80FD\u6253\u67B6\u3002\n  -->\n  @if (points && gizmoMode !== 'off' && gizmoReadout) {\n    <div class=\"octomap-3d-pcd__gizmo-readout\">{{ gizmoReadout }}</div>\n  }\n  @if (hover(); as info) {\n    <div class=\"octomap-3d-pcd__readout\">\n      <div class=\"octomap-3d-pcd__readout-head\">\n        {{ renderMode === 'voxel' ? '\u4F53\u7D20\u4E2D\u5FC3' : '\u4E91\u70B9' }}\n      </div>\n      <div class=\"octomap-3d-pcd__readout-row\">\n        <span class=\"octomap-3d-pcd__readout-key\">X</span>\n        <span class=\"octomap-3d-pcd__readout-value\">{{ info.position[0].toFixed(3) }} m</span>\n      </div>\n      <div class=\"octomap-3d-pcd__readout-row\">\n        <span class=\"octomap-3d-pcd__readout-key\">Y</span>\n        <span class=\"octomap-3d-pcd__readout-value\">{{ info.position[1].toFixed(3) }} m</span>\n      </div>\n      <div class=\"octomap-3d-pcd__readout-row\">\n        <span class=\"octomap-3d-pcd__readout-key\">Z</span>\n        <span class=\"octomap-3d-pcd__readout-value\">{{ info.position[2].toFixed(3) }} m</span>\n      </div>\n      <div class=\"octomap-3d-pcd__readout-row\">\n        <span class=\"octomap-3d-pcd__readout-key\">\u79BB\u5730</span>\n        <span class=\"octomap-3d-pcd__readout-value\">{{ info.height.toFixed(3) }} m</span>\n      </div>\n      @if (info.forbidden !== null) {\n        <div class=\"octomap-3d-pcd__readout-row\">\n          <span class=\"octomap-3d-pcd__readout-key\">\u969C\u788D</span>\n          <span\n            class=\"octomap-3d-pcd__readout-value\"\n            [class.octomap-3d-pcd__readout-value--danger]=\"info.forbidden\"\n          >\n            {{ info.forbidden ? '\u662F' : '\u5426' }}\n          </span>\n        </div>\n      }\n    </div>\n  }\n</div>\n", styles: [":host{display:block;width:100%;height:100%}.octomap-3d-pcd__viewport{width:100%;height:100%;overflow:hidden;position:relative}.octomap-3d-pcd__viewport canvas{display:block;width:100%;height:100%}.octomap-3d-pcd__readout{position:absolute;right:12px;bottom:12px;z-index:1;min-width:132px;padding:8px 10px;border:1px solid #232b3a;border-radius:6px;background:#141a24e0;font-size:12px;line-height:1.6;pointer-events:none}.octomap-3d-pcd__readout-head{margin-bottom:4px;color:#8b98ad;font-size:11px}.octomap-3d-pcd__readout-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px}.octomap-3d-pcd__readout-key{color:#8b98ad}.octomap-3d-pcd__readout-value{color:#e6edf7;font-variant-numeric:tabular-nums}.octomap-3d-pcd__readout-value--danger{color:#ef4444}.octomap-3d-pcd__gizmo-readout{position:absolute;left:12px;top:12px;z-index:1;padding:5px 9px;border:1px solid #232b3a;border-radius:6px;background:#141a24e0;color:#e6edf7;font-size:12px;line-height:1.5;white-space:pre-line;font-variant-numeric:tabular-nums;pointer-events:none}\n"], changeDetection: i0.ChangeDetectionStrategy.OnPush });
}
i0.ɵɵngDeclareClassMetadata({ minVersion: "12.0.0", version: "21.2.26", ngImport: i0, type: Octomap3dPcdComponent, decorators: [{
            type: Component,
            args: [{ selector: 'howell-octomap-3d-pcd', imports: [], providers: [...Octomap3dPcdProviders], changeDetection: ChangeDetectionStrategy.OnPush, template: "<div #viewport class=\"octomap-3d-pcd__viewport\">\n  <!--\n    \u624B\u67C4\u7684\u8BFB\u6570\uFF08\u4F4D\u79FB / \u65CB\u8F6C\uFF09\u3002\u5185\u5BB9\u7531\u5BBF\u4E3B\u7ED9\uFF08\u5730\u56FE\u4E0D\u77E5\u9053\u300C\u504F\u79FB\u4E86\u591A\u5C11\u300D\u300C\u8F6C\u4E86\u591A\u5C11\u5EA6\u300D\n    \u8FD9\u79CD\u8BED\u4E49\uFF09\uFF0C\u4F4D\u7F6E\u9009\u5DE6\u4E0A\uFF1A\u53F3\u4E0B\u90A3\u5757\u662F\u60AC\u505C\u8BFB\u6570\uFF0C\u4E24\u8005\u4E0D\u80FD\u6253\u67B6\u3002\n  -->\n  @if (points && gizmoMode !== 'off' && gizmoReadout) {\n    <div class=\"octomap-3d-pcd__gizmo-readout\">{{ gizmoReadout }}</div>\n  }\n  @if (hover(); as info) {\n    <div class=\"octomap-3d-pcd__readout\">\n      <div class=\"octomap-3d-pcd__readout-head\">\n        {{ renderMode === 'voxel' ? '\u4F53\u7D20\u4E2D\u5FC3' : '\u4E91\u70B9' }}\n      </div>\n      <div class=\"octomap-3d-pcd__readout-row\">\n        <span class=\"octomap-3d-pcd__readout-key\">X</span>\n        <span class=\"octomap-3d-pcd__readout-value\">{{ info.position[0].toFixed(3) }} m</span>\n      </div>\n      <div class=\"octomap-3d-pcd__readout-row\">\n        <span class=\"octomap-3d-pcd__readout-key\">Y</span>\n        <span class=\"octomap-3d-pcd__readout-value\">{{ info.position[1].toFixed(3) }} m</span>\n      </div>\n      <div class=\"octomap-3d-pcd__readout-row\">\n        <span class=\"octomap-3d-pcd__readout-key\">Z</span>\n        <span class=\"octomap-3d-pcd__readout-value\">{{ info.position[2].toFixed(3) }} m</span>\n      </div>\n      <div class=\"octomap-3d-pcd__readout-row\">\n        <span class=\"octomap-3d-pcd__readout-key\">\u79BB\u5730</span>\n        <span class=\"octomap-3d-pcd__readout-value\">{{ info.height.toFixed(3) }} m</span>\n      </div>\n      @if (info.forbidden !== null) {\n        <div class=\"octomap-3d-pcd__readout-row\">\n          <span class=\"octomap-3d-pcd__readout-key\">\u969C\u788D</span>\n          <span\n            class=\"octomap-3d-pcd__readout-value\"\n            [class.octomap-3d-pcd__readout-value--danger]=\"info.forbidden\"\n          >\n            {{ info.forbidden ? '\u662F' : '\u5426' }}\n          </span>\n        </div>\n      }\n    </div>\n  }\n</div>\n", styles: [":host{display:block;width:100%;height:100%}.octomap-3d-pcd__viewport{width:100%;height:100%;overflow:hidden;position:relative}.octomap-3d-pcd__viewport canvas{display:block;width:100%;height:100%}.octomap-3d-pcd__readout{position:absolute;right:12px;bottom:12px;z-index:1;min-width:132px;padding:8px 10px;border:1px solid #232b3a;border-radius:6px;background:#141a24e0;font-size:12px;line-height:1.6;pointer-events:none}.octomap-3d-pcd__readout-head{margin-bottom:4px;color:#8b98ad;font-size:11px}.octomap-3d-pcd__readout-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px}.octomap-3d-pcd__readout-key{color:#8b98ad}.octomap-3d-pcd__readout-value{color:#e6edf7;font-variant-numeric:tabular-nums}.octomap-3d-pcd__readout-value--danger{color:#ef4444}.octomap-3d-pcd__gizmo-readout{position:absolute;left:12px;top:12px;z-index:1;padding:5px 9px;border:1px solid #232b3a;border-radius:6px;background:#141a24e0;color:#e6edf7;font-size:12px;line-height:1.5;white-space:pre-line;font-variant-numeric:tabular-nums;pointer-events:none}\n"] }]
        }], propDecorators: { viewportRef: [{
                type: ViewChild,
                args: ['viewport', { static: true }]
            }], points: [{
                type: Input
            }], preview: [{
                type: Input
            }], gizmoMode: [{
                type: Input
            }], gizmoPose: [{
                type: Input
            }], selectionBox: [{
                type: Input
            }], gizmoPreview: [{
                type: Input
            }], fitOnPointsChange: [{
                type: Input
            }], refitReferenceOnPointsChange: [{
                type: Input
            }], gizmoReadout: [{
                type: Input
            }], renderMode: [{
                type: Input
            }], voxelSize: [{
                type: Input
            }], backgroundColor: [{
                type: Input
            }], pointColor: [{
                type: Input
            }], pointSize: [{
                type: Input
            }], showGrid: [{
                type: Input
            }], showNavLimit: [{
                type: Input
            }], showPath: [{
                type: Input
            }], showPathPoints: [{
                type: Input
            }], gridSize: [{
                type: Input
            }], gridDivisions: [{
                type: Input
            }], fitView: [{
                type: Input
            }], autoRotate: [{
                type: Input
            }], showColoring: [{
                type: Input
            }], forbiddenColor: [{
                type: Input
            }], painted: [{
                type: Input
            }], interactionMode: [{
                type: Input
            }], brushRadius: [{
                type: Input
            }], maxStepHeight: [{
                type: Input
            }], crossWidth: [{
                type: Input
            }], fillBaseCells: [{
                type: Input
            }], goalRadius: [{
                type: Input
            }], dogRadius: [{
                type: Input
            }], dogHeight: [{
                type: Input
            }], showDogCollision: [{
                type: Input
            }], dogScale: [{
                type: Input
            }], dogFitCollision: [{
                type: Input
            }], dogModelHeading: [{
                type: Input
            }], dogHeading: [{
                type: Input
            }], maxHeight: [{
                type: Input
            }], minHeight: [{
                type: Input
            }], groundExtendsOutside: [{
                type: Input
            }], groundExtendX: [{
                type: Input
            }], groundExtendZ: [{
                type: Input
            }], pathAlgorithm: [{
                type: Input
            }], maxPickingPoints: [{
                type: Input
            }], findPath: [{
                type: Input
            }], startWalk: [{
                type: Input
            }], seekWalk: [{
                type: Input
            }], pauseWalk: [{
                type: Input
            }], resumeWalk: [{
                type: Input
            }], clearDeployment: [{
                type: Input
            }], markAllObstacles: [{
                type: Input
            }], clearObstacles: [{
                type: Input
            }], clearDogModel: [{
                type: Input
            }], loadDogModel: [{
                type: Input
            }], exportPointCloud: [{
                type: Input
            }], regularizeCloud: [{
                type: Input
            }], projectionSource: [{
                type: Input
            }], mapReady: [{
                type: Output
            }], pointsChanged: [{
                type: Output
            }], cloudTranslated: [{
                type: Output
            }], cloudTranslating: [{
                type: Output
            }], cloudRotated: [{
                type: Output
            }], cloudRotating: [{
                type: Output
            }], pointClicked: [{
                type: Output
            }], pathChanged: [{
                type: Output
            }], pathFailed: [{
                type: Output
            }], walkProgress: [{
                type: Output
            }], dogPlaced: [{
                type: Output
            }], goalPlaced: [{
                type: Output
            }], paintedChanged: [{
                type: Output
            }], brushMiss: [{
                type: Output
            }], interactionModeChange: [{
                type: Output
            }], error: [{
                type: Output
            }] } });

/*
 * howell-octomap-3d 的公开入口。
 *
 * 只导出组件、公开类型与默认设置。`controller/` 与 `utils/` 是内部实现，
 * 宿主不应该直接依赖。
 */

/**
 * Generated bundle index. Do not edit.
 */

export { DEFAULT_OCTOMAP_SETTINGS, MAP_CONFIG_KEYS, Octomap3dPcdComponent };
//# sourceMappingURL=howell-octomap-3d.mjs.map
