# UI 视觉层变更说明（visual layer only）

## 目标
把 `stronghold-atlas-ui-kit` 的飞鸟图谱**只当作装饰素材与线稿语言**，加进现有界面；
不改布局、不改几何、不改任何交互与网络逻辑。

## 插入点
- 唯一改动位置：`app_qml/qml/Pages/SessionPage.qml` 主视觉区内已有的装饰层（原先放 `FlightAtlasBackground`）。
- 该层 `z: 0`、`enabled: false`、位于所有可点控件之下，锚点 `anchors.fill: parent`（不进入任何 Layout，不改子项尺寸/约束）。
- 动效走项目已有的动效档位（`page.motionTier` / `page.ambient`），不新增设置项、快捷键、菜单或页面。

## 明确不动的东西（本文件即承诺）
- 窗口尺寸/缩放行为、所有 Layout 容器、边距、间距、对齐、控件位置与顺序、z-order（装饰层除外）。
- 三个页面的路由、标签、按钮、输入框、快捷键、焦点顺序。
- 会话生命周期、好友列表行为、设置持久化、错误处理。
- Steam P2P / 网络层、后端契约、view-model。
- 不把套件里的 index.html / AtlasShellExample.qml 当作产品结构（它们是孤立演示）。

## 素材
- `qml/assets/bird-atlas-hero.png`、`qml/assets/bird-scene-vector-trace.svg`、
  `qml/assets/bird-study-sheet.svg`：来自套件 `assets/`，保持原始几何，按 `PreserveAspectFit` 显示，不拉伸。
- 组件：`Components/AtlasDecorLayer.qml`、`AtlasBackdrop.qml`、`AtlasHero.qml`（套件 `qml/components/` 原样迁移）。
- 来源记录：套件的 `ASSET_PROVENANCE.md`（未改动即用）。
