import QtQuick
import "../theme.js" as T

// 手绘圆环：叠两层正弦扰动 + 收口过冲；关键线条再压一道偏移描边（过版错位）。
// 种子固定 ⇒ 同一状态永远同一形状，不会每帧抖动。
Canvas {
    renderTarget: Canvas.Image
    id: ring

    property real radius: 60
    property int seed: 7
    property color stroke: T.INK
    property real weight: 1.2
    property bool doubleStroke: true
    property bool ticks: false
    property int tickCount: 36
    property real tickLength: 6
    property real phase: 0

    implicitWidth: radius * 2 + 28
    implicitHeight: radius * 2 + 28
    renderStrategy: Canvas.Cooperative

    onRadiusChanged: requestPaint()
    onSeedChanged: requestPaint()
    onStrokeChanged: requestPaint()
    onDoubleStrokeChanged: requestPaint()
    onTicksChanged: requestPaint()
    onPhaseChanged: requestPaint()

    onPaint: {
        var ctx = getContext("2d")
        ctx.clearRect(0, 0, width, height)
        var cx = width / 2
        var cy = height / 2
        var pts = T.ringPoints(cx, cy, radius, seed)

        function strokePath(offset, alpha, w) {
            ctx.globalAlpha = alpha
            ctx.lineWidth = w
            ctx.strokeStyle = stroke
            ctx.beginPath()
            for (var i = 0; i < pts.length; i++) {
                var p = pts[i]
                if (i === 0)
                    ctx.moveTo(p.x + offset, p.y + offset)
                else
                    ctx.lineTo(p.x + offset, p.y + offset)
            }
            ctx.stroke()
        }

        strokePath(0, 0.95, weight)
        if (doubleStroke)
            strokePath(1.7, 0.4, weight * 0.75)

        if (ticks) {
            ctx.globalAlpha = 0.75
            ctx.strokeStyle = stroke
            ctx.lineWidth = 1
            for (var k = 0; k < tickCount; k++) {
                var a = phase + 6.283185307 * k / tickCount
                var inner = radius + 2
                var outer = radius + 2 + tickLength
                ctx.beginPath()
                ctx.moveTo(cx + inner * Math.cos(a), cy + inner * Math.sin(a))
                ctx.lineTo(cx + outer * Math.cos(a), cy + outer * Math.sin(a))
                ctx.stroke()
            }
        }
        ctx.globalAlpha = 1
    }
}
