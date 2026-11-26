# howell-octomap-3d

OctoMap 三维寻路组件（基于 Three.js 点云），作为 Angular 组件库供其他项目引用。

## 安装

构建产物放在 `release` 分支上，其他项目通过 GitHub 安装：

```bash
npm install github:tuzhongyi/howell-octomap-3d#release
```

peerDependencies 需要宿主自己安装：

- `@angular/core` ^21.0.0
- `rxjs` ^7.8.0
- `three` ^0.185.0

## 使用

```ts
import { OctoMapComponent, OctoMapPointCloud } from 'howell-octomap-3d';
```

组件选择器：`app-octo-map`。点云通过 `points` 输入传入，状态变化通过 `@Output()` 上报。

## 开发

```bash
npm install
npm run build    # 产物输出到 dist/
```

## 发布

1. 修改 `package.json` 里的 `version`
2. `npm run build`
3. 把 `dist/` 的内容提交到 `release` 分支并推送

`release` 分支只放构建产物，不要在上面直接开发；源码以 `main` 为准。
