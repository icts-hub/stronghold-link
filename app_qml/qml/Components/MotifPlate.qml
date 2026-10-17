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
    // 常驻帧率：鸟群滑翔不需要 60fps。
    // 鸟群改成"多股 + 远景鸟潮"（一张版心 ~80 只）以后单次重绘变贵，这里从 12 降到 10；
    // 实测 8/10 两档帧时间一样（瓶颈在单次重绘的单价，不在次数），所以取更顺的 10。
    property int ambientFps: 10

    // 显现进度（0..1）：入场时由 0 缓动到 1
    property real revealT: revealed ? 1 : 0

    // revealT 平时由外层"进场"驱动，这里补一段缓动；但转场纹样（模板 D）是切页那 0.9 秒里
    // 自己 0→1→0 地跑，再叠一层 Behavior 就会把上升段拖平（实测 t 还没升起来就已经在回落），
    // 于是那朵玫瑰窗几乎什么都没画出来 —— 所以给它一个开关。
    property bool animateReveal: true

    Behavior on revealT {
        enabled: root.animateReveal

        NumberAnimation { duration: T.DUR_ENTER + 420; easing.type: Easing.OutCubic }
    }

    // 转场纹样要"每一帧都按当前进度画"：Cooperative 会把一串 requestPaint 合并成一次，
    // 动画过程中的中间值就被吞掉了（实测只画到 t=1 和 t=0 两个端点）。
    property int renderMode: Canvas.Cooperative

    // 滑翔相位：0..1 循环，只影响鸟的位置与展翼幅度
    property real phase: 0

    // 相位推进**按真实经过时间算**，不是"每个 tick 加一个固定值"。
    // 旧写法 `phase += 0.0016` 让滑翔速度取决于 Timer 的实际触发频率（掉帧、系统繁忙、
    // 后台限频都会改速度），同一个动画在不同机器上快慢不同 —— 这是典型的帧率相关动画。
    // 现在改成：phase += 经过毫秒 / 1000 * phaseSpeed，phaseSpeed 的单位是「每秒走几个循环」。
    property real phaseSpeed: 0.036        // ≈ 27 秒一个完整滑翔循环
    property double lastTickMs: 0

    // 这张版有没有"常驻动效"。模板 E（白底 + 参考图笔画 + 环状花纹）画完之后是完全静止的，
    // 它单次重绘又特别贵（72 组多边形），所以不给它常驻心跳 —— 只在显现/尺寸变化时画一次。
    readonly property bool hasMotion: root.template !== "E"

    Timer {
        interval: Math.max(40, Math.round(1000 / Math.max(1, root.ambientFps)))
        running: root.active && root.ambient && root.visible && root.revealed
                 && root.opacity > 0.01 && root.hasMotion
        repeat: true
        onTriggered: {
            var now = Date.now()
            // 首帧、或从"暂停/最小化"回来（间隔异常大）时不确定起点：直接对齐，不补时间，
            // 免得恢复瞬间相位突然跳一大段。
            var dt = root.lastTickMs > 0 ? Math.min(400, now - root.lastTickMs) : 0
            root.lastTickMs = now
            if (dt > 0)
                root.phase = (root.phase + dt / 1000 * root.phaseSpeed) % 1
            canvas.requestPaint()
        }
        onRunningChanged: {
            if (!running)
                root.lastTickMs = 0
        }
    }

    Canvas {
        id: canvas

        anchors.fill: parent
        renderStrategy: root.renderMode
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
        // 量化到 0.05 一档再比：版面的缩放比会随着"呼吸缩放 / 指针视差 / 切页顶动"连续变化，
        // 逐帧比较会让每一帧都判定"变了"并 requestPaint —— 那等于把静态图版变成逐帧重绘，
        // 又贵又会让画布背衬不停重新分配（实测会话页内存 24 秒里从 272 MiB 涨到 469 MiB）。
        // 量化之后只有真正跨越一档（窗口缩放）才重绘。
        var q = Math.round(s / 0.05) * 0.05
        var qOld = Math.round(uiScale / 0.05) * 0.05
        if (s > 0.05 && Math.abs(q - qOld) > 0.001) {
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
