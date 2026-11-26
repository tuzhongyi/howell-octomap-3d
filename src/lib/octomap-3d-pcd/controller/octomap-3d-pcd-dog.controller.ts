import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import * as THREE from 'three';
import { OctomapWalkProgress, OctomapWalkState } from '../octomap-3d-pcd.model';
import { Octomap3dPcdGlobal } from './octomap-3d-pcd-global.controller';

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
@Injectable()
export class Octomap3dPcdDog {
  /** 地面上的世界坐标起点，作为寻路起点使用。 */
  startPosition: [number, number, number] | null = null;

  /**
   * 小狗的挂载节点：原点在脚底，**+X 恒为正前方**。模型（内置几何体或外部
   * 模型）挂在它下面，外部模型会先被 {@link modelPivot} 转正，因此朝向、
   * 前端位置和指示三角形都以 +X 为准，与模型自带的坐标轴无关。
   */
  private dog: THREE.Group | null = null;
  /**
   * 加载进来的外部模型本体；null 表示内置几何体。用不用外部模型、以及重建挂载
   * 节点时拿什么装回去，都只看这一个字段。
   *
   * 早先这里另有一个布尔标志位，两份状态各写各的，{@link remove}（重置部署）
   * 就漏了一处：模型被释放了标志位还立着，用户点一次「重置」小狗就变回内置几何
   * 体。同理，引用本身不能丢——不然重建时也没东西可装。
   */
  private customModel: THREE.Object3D | null = null;
  private selectionRing: THREE.Mesh | null = null;
  /**
   * 模型朝向补偿，单位：度——外部模型自带的正面相对 +X 偏了多少，加载后按
   * 这个角度转回来。只影响外部模型，内置几何体本来就是 +X 朝前。
   */
  private modelHeadingDeg = 0;
  /** 套在模型外面的补偿节点，用来把模型自带的正面方向转到 +X。 */
  private modelPivot: THREE.Group | null = null;
  /** 足迹碰撞体：半径 = 碰撞半径、高 = 通行高度的圆柱。 */
  private collisionVolume: THREE.Mesh | null = null;
  /** 贴着足迹正面、指示小狗正前方的三角形。 */
  private collisionArrow: THREE.Mesh | null = null;
  private collisionVisible = true;
  private collisionRadius = 0.25;
  private collisionHeight = 0.8;
  /** 小狗模型整体的缩放系数，内置几何体和外部模型共用。 */
  private scale = 1;
  /** 是否用碰撞足迹反推模型缩放（打开时 {@link scale} 不参与）。 */
  private fitToCollision = false;
  /** 放置、拖拽和停下时的朝向，单位：度（0 = 面向 +X）。 */
  private headingDeg = 0;
  /** 开始行进后朝向被锁住，只有重新计算路径或重新放狗才解锁。 */
  private headingLocked = false;
  /** 模型在缩放为 1 时的水平占地（最长边），量过一次就缓存；换模型时清空。 */
  private footprint: number | null = null;
  private path: [number, number, number][] = [];
  private segmentLengths: number[] = [];
  private totalLength = 0;
  private traveled = 0;
  private walking = false;
  private paused = false;
  /** 每当小狗在路径上的位置变化（或被拖动）时上报。 */
  readonly walkStateChanged = new Subject<OctomapWalkProgress>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly onFrame = (delta: number): void => this.update(delta);

  constructor(private readonly global: Octomap3dPcdGlobal) {
    this.global.addFrameListener(this.onFrame);
  }

  /** 小狗当前是否已放置在场景中。 */
  get placed(): boolean {
    return this.dog !== null;
  }

  /**
   * 碰撞足迹的底面半径（世界单位），与「碰撞半径」设置同值。场景里跟小狗同量级
   * 的装饰（终点锥、路径管）按它取参考尺寸。
   */
  get footprintRadius(): number {
    return this.collisionRadius;
  }

  /** 碰撞足迹的通行高度（世界单位），与「通行高度」设置同值。 */
  get footprintHeight(): number {
    return this.collisionHeight;
  }

  /** 把小狗放置在地面上的空闲世界坐标位置（A），并停止行进。 */
  placeAt(position: [number, number, number]): void {
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
  moveTo(position: [number, number, number]): void {
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
  setCustomModel(model: THREE.Object3D): void {
    // 先存下来，buildRig() 里才会按补偿角把模型转正。
    this.customModel = model;
    this.buildRig(model);
  }

  /** 清掉外部模型，回到内置几何体小狗（位置同样继承）。 */
  clearModel(): void {
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
  setModelHeading(degrees: number): void {
    this.modelHeadingDeg = Number.isFinite(degrees) ? degrees : 0;
    this.applyModelHeading();
    // 模型转过了，水平占地得重新量。
    this.footprint = null;
    this.applyScale();
  }

  /** 让小狗回到起点位置，并停止正在进行的行进。朝向同时解锁。 */
  resetToStart(): void {
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
  pick(event: MouseEvent): boolean {
    // 只有已经在场景里的小狗才可被拾取：还没放狗时模型不在场景中，
    // 命中它会凭空召唤出一只小狗。
    const dog = this.sceneDog;
    if (!dog) {
      return false;
    }
    const rect = this.global.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.global.camera);
    return this.raycaster.intersectObject(dog, true).length > 0;
  }

  /** 在小狗下方显示选择环。 */
  select(): void {
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
  deselect(): void {
    if (this.selectionRing) {
      this.selectionRing.visible = false;
    }
  }

  /** 显示或隐藏小狗的碰撞体。 */
  setCollisionVisible(visible: boolean): void {
    this.collisionVisible = visible;
    this.syncCollisionVolume();
  }

  /** 更新碰撞体半径（足迹圆柱的底面半径，世界单位）。 */
  setCollisionRadius(radius: number): void {
    this.collisionRadius = radius;
    this.syncCollisionVolume();
    // 贴合模式下模型大小由碰撞足迹决定，半径一改模型就得跟着变。
    this.applyScale();
  }

  /** 更新碰撞体高度（圆柱的通行高度，世界单位）。 */
  setCollisionHeight(height: number): void {
    this.collisionHeight = height;
    this.syncCollisionVolume();
  }

  /**
   * 更新小狗模型的缩放系数（1 = 原始大小）。只影响外观：碰撞范围和寻路
   * 仍由碰撞半径与通行高度决定，不随模型缩放变化。
   */
  setScale(scale: number): void {
    this.scale = Number.isFinite(scale) && scale > 0 ? scale : 1;
    this.applyScale();
  }

  /**
   * 打开/关闭「模型对齐碰撞足迹」。打开时模型被等比例缩放到水平占地正好等于
   * 碰撞足迹（2 × 碰撞半径），`setScale` 的系数不再参与；等比例意味着高度不会
   * 跟着对齐通行高度。
   */
  setFitToCollision(enabled: boolean): void {
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
  setHeading(degrees: number): void {
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
  frontPosition(): [number, number, number] | null {
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
  remove(): void {
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
  setPath(path: [number, number, number][]): void {
    const route =
      this.dog && path.length > 0
        ? [[this.dog.position.x, this.dog.position.y, this.dog.position.z] as [
            number,
            number,
            number,
          ], ...path]
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
  startWalking(): void {
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
  pause(): void {
    if (this.walking && !this.paused) {
      this.paused = true;
      this.emitWalkState();
    }
  }

  /** 从暂停位置恢复自动前进。 */
  resume(): void {
    if (this.walking && this.paused) {
      this.paused = false;
      this.emitWalkState();
    }
  }

  /** 当前行进是否已暂停。 */
  get isPaused(): boolean {
    return this.paused;
  }

  /** 把小狗拖动到已存路径的指定比例（0..1）处。 */
  seek(fraction: number): void {
    if (this.path.length < 2) {
      return;
    }
    const clamped = Math.min(1, Math.max(0, fraction));
    this.traveled = clamped * this.totalLength;
    this.updateDogPosition();
    this.emitWalkState();
  }

  /** 停止并丢弃当前路径，但不移动小狗。停下后朝向复位。 */
  stop(): void {
    this.walking = false;
    this.paused = false;
    this.path = [];
    this.segmentLengths = [];
    this.totalLength = 0;
    this.traveled = 0;
    this.resetHeading();
    this.emitWalkState();
  }

  dispose(): void {
    this.global.removeFrameListener(this.onFrame);
    this.remove();
    if (this.selectionRing) {
      this.global.scene.remove(this.selectionRing);
      this.selectionRing.geometry.dispose();
      (this.selectionRing.material as THREE.Material).dispose();
      this.selectionRing = null;
    }
    if (this.collisionVolume) {
      this.global.scene.remove(this.collisionVolume);
      this.collisionVolume.geometry.dispose();
      (this.collisionVolume.material as THREE.Material).dispose();
      this.collisionVolume = null;
    }
    if (this.collisionArrow) {
      this.global.scene.remove(this.collisionArrow);
      this.collisionArrow.geometry.dispose();
      (this.collisionArrow.material as THREE.Material).dispose();
      this.collisionArrow = null;
    }
  }

  /**
   * 用 `model` 重建整只小狗：外层挂载 group（原点在脚底、+X 为正前方）里套
   * 一层补偿节点，模型再挂到补偿节点下。多这一层是为了让模型自带的坐标轴
   * 与「+X 即正前方」这个约定解耦——朝向、前端位置和指示三角形都只看外层。
   */
  private buildRig(model: THREE.Object3D): void {
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
  private applyModelHeading(): void {
    if (!this.modelPivot) {
      return;
    }
    // 内置几何体本来就是 +X 朝前，补偿角只对外部模型生效。
    const degrees = this.customModel ? this.modelHeadingDeg : 0;
    this.modelPivot.rotation.y = THREE.MathUtils.degToRad(-degrees);
  }

  /** 构建一个小型程序化小车（原点在脚底，前方沿 +X）。 */
  private buildDog(): THREE.Group {
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
    const legSpots: [number, number, number][] = [
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

  private disposeObject(object: THREE.Object3D): void {
    object.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    });
  }

  private updateSelectionRing(): void {
    if (this.selectionRing && this.dog) {
      // 抬 0.02 是为了不与地面平面 z-fighting；抬升量是相对小狗脚下的地面，
      // 不是相对世界原点——地面高度来自扫描出的地板，不一定是 y=0。
      this.selectionRing.position.set(this.dog.position.x, this.dog.position.y + 0.02, this.dog.position.z);
    }
    this.syncCollisionVolume();
  }

  /** 已经在场景里的小狗；没放过狗时为 null（模型只是被记着，不显示）。 */
  private get sceneDog(): THREE.Group | null {
    return this.dog && this.dog.parent === this.global.scene ? this.dog : null;
  }

  /**
   * 放过狗之后才把模型放进场景。还没放置时模型只是被记着——例如刷新页面后
   * 自动恢复的外部模型，直接进场景会以世界原点杵在画面里，盖住点云。
   */
  private attachIfPlaced(): void {
    if (this.dog && this.startPosition) {
      this.global.scene.add(this.dog);
    }
  }

  /** 把当前缩放系数作用到小狗模型和选择环上。 */
  private applyScale(): void {
    // 贴合模式下由 footprint 反推系数（量不出来时退回手动系数，至少不是 0）。
    const factor = this.fitToCollision ? (this.fitFactor() ?? this.scale) : this.scale;
    this.dog?.scale.setScalar(factor);
    this.selectionRing?.scale.setScalar(factor);
  }

  /** 让模型水平占地正好等于碰撞足迹所需的等比系数；量不出占地时为 null。 */
  private fitFactor(): number | null {
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
  private modelFootprint(): number | null {
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
  private resetHeading(): void {
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
  private headingRadians(): number {
    if (!this.dog) {
      return 0;
    }
    const forward = new THREE.Vector3(1, 0, 0).applyQuaternion(this.dog.quaternion);
    return Math.atan2(-forward.z, forward.x);
  }

  /** 创建/更新碰撞体（足迹圆柱）和指示正前方的三角形，使其匹配当前状态。 */
  private syncCollisionVolume(): void {
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
      geometry.setAttribute(
        'position',
        new THREE.Float32BufferAttribute([1, 0, 0.35, 1, 0, -0.35, 1.5, 0, 0], 3),
      );
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
    this.collisionVolume.scale.set(
      this.collisionRadius,
      this.collisionHeight,
      this.collisionRadius,
    );
    // 底面贴着小狗脚下，而不是世界原点：地面高度是扫描出来的（见
    // Octomap3dPcdGrille.groundLevel），写死 0 会让整个碰撞体悬在
    // 地面之上——扫描的地板压在 y=0 以下时，狗站在地上而圆柱浮在空中。
    this.collisionVolume.position.set(
      dog.position.x,
      dog.position.y + this.collisionHeight / 2,
      dog.position.z,
    );

    this.collisionArrow.visible = true;
    this.collisionArrow.scale.setScalar(this.collisionRadius);
    // 贴着地面画（和选择环同高），避免和地面 z-fighting。
    this.collisionArrow.position.set(dog.position.x, dog.position.y + 0.02, dog.position.z);
    this.collisionArrow.quaternion.setFromAxisAngle(UP, this.headingRadians());
  }

  private update(delta: number): void {
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
  private updateDogPosition(): void {
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
  private positionAt(distance: number): [number, number, number] {
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
  private emitWalkState(): void {
    const state: OctomapWalkState =
      this.path.length < 2
        ? 'idle'
        : this.paused
          ? 'paused'
          : this.walking
            ? 'walking'
            : 'ready';
    const progress = this.totalLength > 0 ? this.traveled / this.totalLength : 0;
    this.walkStateChanged.next({ progress, state, headingLocked: this.headingLocked });
  }
}
