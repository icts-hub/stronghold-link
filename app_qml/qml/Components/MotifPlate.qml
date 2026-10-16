import QtQuick
import "../theme.js" as T
import "../plate/motifs.js" as MO

// 纹样图版：把 motifs.js 的四个组合模板包成一个可复用组件。
//
// 页面只给"用哪个模板 + 种子 + 主纹样偏移比例"，其余（几何、比例、描边、透明度、
// 动画）全部由 motifs.js 的规范决定 —— 通用素材与场景分离，页面里不硬编码装饰。
//
// 动效（对应《纹样设计规范》第十节）：
//   · revealT 从 0→1 时纹样"分层逐步显现"（坐标线先画、圣徽描圆、玫瑰窗分三层）；
//   · 常驻时只有鸟群沿轨迹滑翔（phase 缓慢推进 + flap 轻微振翅），几何本身静止；
//   · 重绘按 ambientFps 限频，静止几何不参与重绘（省 CPU）。
Item {
    id: root

    // "A" 鸟群+圣徽 | "B" 羽翼+拱框 | "C" 鸟群+坐标轨迹 | "D" 玫瑰窗+放射几何
    property string template: "A"
    property int seed: 21
    // 页面切走时置 false：停画省 CPU，与项目其它图版一致
    property bool active: true
    // 切页入场标记（外壳 revealPage 会依次置 false → true）
    property bool revealed: true
    // 常驻动效开关（动效档位为"最低"时外壳会关掉）
    property bool ambient: true
    // 主纹样在画布里的相对位置：页面左半留给标题时给 0.62-0.70
    property real cxRatio: -1
    property real cyRatio: -1
    property real radScale: -1
    // 模板 B 的拱宽缩放（0 表示用模板缺省 1）；页面版心不是正方形时用它把拱收窄或放宽
    property real archScale: -1
    property string sealText: ""
    property string mark: "S"
    property string caption: ""
    // 常驻帧率：鸟群滑翔不需要 60fps
    property int ambientFps: 12

    // 显现进度（0..1）：入场时由 0 缓动到 1
    property real revealT: revealed ? 1 : 0

    Behavior on revealT {
        NumberAnimation { duration: T.DUR_ENTER + 420; easing.type: Easing.OutCubic }
    }

    // 滑翔相位：0..1 循环，只影响鸟的位置与展翼幅度
    property real phase: 0

    Timer {
        interval: Math.max(40, Math.round(1000 / Math.max(1, root.ambientFps)))
        running: root.active && root.ambient && root.visible && root.revealed
                 && root.opacity > 0.01
        repeat: true
        onTriggered: {
            root.phase = (root.phase + 0.0016) % 1
            canvas.requestPaint()
        }
    }

    Canvas {
        id: canvas

        anchors.fill: parent
        renderStrategy: Canvas.Cooperative
        antialiasing: true
        // 背景透出纸色，由外层决定底色（Qt 6 的 Canvas 已经不吃 opaque 属性）

        onPaint: {
            var ctx = getContext("2d")
            ctx.reset()
            ctx.clearRect(0, 0, width, height)
            if (!root.active)
                return
            var opt = {
                seed: root.seed,
                t: Math.max(0.001, root.revealT),
                phase: root.phase,
                flap: Math.sin(root.phase * Math.PI * 2) * 0.5,
                sealText: root.sealText,
                mark: root.mark,
                label: root.caption,
                scale: root.uiScale
            }
            if (root.cxRatio >= 0)
                opt.cxRatio = root.cxRatio
            if (root.cyRatio >= 0)
                opt.cyRatio = root.cyRatio
            if (root.radScale > 0)
                opt.radScale = root.radScale
            if (root.archScale > 0)
                opt.archScale = root.archScale
            MO.template(ctx, root.template, width, height, opt)
        }
    }

    onWidthChanged: canvas.requestPaint()
    onHeightChanged: canvas.requestPaint()
    onRevealTChanged: canvas.requestPaint()
    onTemplateChanged: canvas.requestPaint()
    onActiveChanged: if (active) canvas.requestPaint()
    Component.onCompleted: { syncUiScale(); if (active) canvas.requestPaint() }

    // ── 屏幕补偿：算出这块图版在屏幕上真正的缩放比 ────────────────────────
    // 版面画布整体被 fitScale 缩过，图版自己是不知道的；这里用"映射到窗口坐标后
    // 量宽度"的办法量出实际缩放比（窗口大小一变就重量一次），再交给 motifs.js
    // 去加粗细线、关掉最细的一层装饰。窗口缩到多小都还有清楚的笔触。
    property real uiScale: 1

    function syncUiScale() {
        if (width <= 0 || height <= 0)
            return
        var a = mapToItem(null, 0, 0)
        var b = mapToItem(null, width, 0)
        var s = Math.abs(b.x - a.x) / width
        if (s > 0.05 && Math.abs(s - uiScale) > 0.02) {
            uiScale = s
            canvas.requestPaint()
        }
    }

    onScaleChanged: syncUiScale()

    Connections {
        target: Window.window

        function onWidthChanged() { root.syncUiScale() }
        function onHeightChanged() { root.syncUiScale() }
    }
}
