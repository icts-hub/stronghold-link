import QtQuick
import "../theme.js" as T

// 斜切擦除带：一条平行四边形色带 + 前沿一道亮线，横向扫过整块区域。
//
// 为什么不是"淡入"：淡入看起来像图层透明度在变，而《明日方舟》那套界面的内容是被一条
// 硬边"擦"出来的——擦除前沿压着一道比底色更亮的细线，带宽的前缘还有一点渐变余晖。
// 这里把这件事做成一个可复用的部件：给 progress 0 → 1，带子就从左扫到右。
//
// 画法全部在 Canvas 上（软件渲染路径也一致，不依赖着色器）。斜切用 SKEW：
// 每 1 单位高度在 x 方向偏移 skew 像素，于是竖直边变成斜边，整块区域像被刀切过。
Item {
    id: sweep

    // 0 = 带子还在左边外面，1 = 已经扫过右边
    property real progress: 1
    property real skew: T.SKEW
    // 色带宽度（设计坐标）
    property real bandWidth: 260
    // 色带本体：很淡的一层墨，压出"被擦过"的痕迹；前沿亮线用 edgeColor
    property color bandColor: T.INK
    property real bandOpacity: 0.07
    // 实心模式：整条带子一个颜色（当"遮罩"用，把下面的内容盖住再擦开）。
    // 非实心时带子左端渐隐、右端硬边——那是"扫过一道光"的用法。
    property bool bandSolid: false
    property color edgeColor: T.HIGHLIGHT
    property real edgeOpacity: 0.85
    property real edgeWidth: 2
    // 带子扫过时的额外振幅：让前沿不是一条直线，而是折成两段（更像手绘的"擦"）
    property real kink: 0.06

    readonly property real lead: -bandWidth + progress * (width + bandWidth * 2)
    // 阈值取 0.99 而不是 0.9999：OutExpo/OutBack 这类缓动收尾时常常停在 0.999…，
    // 若要求严格小于 1 才算"还在扫"，画布就会永远停在可见状态反复重绘（白烧 CPU）。
    // 0.99 时前沿已经扫出右边界（带子本体早就出画），收在这里肉眼看不出来。
    readonly property bool painting: progress > 0.004 && progress < 0.99

    visible: painting
    enabled: false

    function rgba(c, a) {
        return "rgba(" + Math.round(c.r * 255) + "," + Math.round(c.g * 255) + ","
                + Math.round(c.b * 255) + "," + Math.max(0, Math.min(1, a)) + ")"
    }

    Canvas {
        id: canvas

        anchors.fill: parent
        renderStrategy: Canvas.Cooperative
        antialiasing: true
        onPaint: {
            const ctx = getContext("2d")
            const w = width
            const h = height
            ctx.clearRect(0, 0, w, h)
            const lead = sweep.lead
            const trail = lead - sweep.bandWidth
            const sh = sweep.skew * h
            const kink = sweep.kink * h

            // ① 色带本体：从左到右渐隐，右缘是硬边（实心模式下整条一个色）
            const grad = ctx.createLinearGradient(trail, 0, lead, 0)
            if (sweep.bandSolid) {
                grad.addColorStop(0, sweep.rgba(sweep.bandColor, sweep.bandOpacity))
                grad.addColorStop(1, sweep.rgba(sweep.bandColor, sweep.bandOpacity))
            } else {
                grad.addColorStop(0, sweep.rgba(sweep.bandColor, 0))
                grad.addColorStop(0.55, sweep.rgba(sweep.bandColor, sweep.bandOpacity * 0.55))
                grad.addColorStop(0.92, sweep.rgba(sweep.bandColor, sweep.bandOpacity))
                grad.addColorStop(1, sweep.rgba(sweep.bandColor, 0))
            }
            ctx.fillStyle = grad
            ctx.beginPath()
            ctx.moveTo(trail, 0)
            ctx.lineTo(lead, 0)
            ctx.lineTo(lead + sh, h)
            ctx.lineTo(trail + sh, h)
            ctx.closePath()
            ctx.fill()

            // ② 前沿：两段折线（上段略前、下段略后），像手绘擦出来的一道硬边
            ctx.strokeStyle = sweep.rgba(sweep.edgeColor, sweep.edgeOpacity)
            ctx.lineWidth = sweep.edgeWidth
            ctx.beginPath()
            ctx.moveTo(lead + kink * 0.5, 0)
            ctx.lineTo(lead + sh * 0.5 + kink, h * 0.5)
            ctx.lineTo(lead + sh, h)
            ctx.stroke()

            // ③ 前沿后面再跟一条更淡的余晖，免得硬边太"电子"
            ctx.strokeStyle = sweep.rgba(sweep.edgeColor, sweep.edgeOpacity * 0.22)
            ctx.lineWidth = sweep.edgeWidth + 2
            ctx.beginPath()
            ctx.moveTo(lead + kink * 0.5 - 5, 0)
            ctx.lineTo(lead + sh * 0.5 + kink - 5, h * 0.5)
            ctx.lineTo(lead + sh - 5, h)
            ctx.stroke()

            // ④ 实心遮盖模式下，前沿往后压一道极淡的墨：浅色纸上那道硬边否则看不出来
            if (sweep.bandSolid) {
                ctx.strokeStyle = sweep.rgba(T.INK, 0.16)
                ctx.lineWidth = 7
                ctx.beginPath()
                ctx.moveTo(lead + kink * 0.5 + 3, 0)
                ctx.lineTo(lead + sh * 0.5 + kink + 3, h * 0.5)
                ctx.lineTo(lead + sh + 3, h)
                ctx.stroke()
            }
        }

        Connections {
            target: sweep
            function onLeadChanged() { canvas.requestPaint() }
            function onProgressChanged() { canvas.requestPaint() }
        }
    }
}
