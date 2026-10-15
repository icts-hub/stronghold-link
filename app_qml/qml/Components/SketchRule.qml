import QtQuick
import "../theme.js" as T

// 手绘直尺线：中段微弯、两端过冲；可加第二道偏移描边与端部刻度。
Canvas {
    renderTarget: Canvas.Image
    id: rule

    property real x1: 0
    property real y1: 0
    property real x2: 100
    property real y2: 0
    property int seed: 3
    property color stroke: T.LINE
    property real weight: 1
    property bool doubleStroke: false
    property bool endTicks: false

    renderStrategy: Canvas.Cooperative

    onX1Changed: requestPaint()
    onY1Changed: requestPaint()
    onX2Changed: requestPaint()
    onY2Changed: requestPaint()
    onSeedChanged: requestPaint()
    onStrokeChanged: requestPaint()
    onDoubleStrokeChanged: requestPaint()
    onEndTicksChanged: requestPaint()

    onPaint: {
        var ctx = getContext("2d")
        ctx.clearRect(0, 0, width, height)
        var pts = T.rulePoints(x1, y1, x2, y2, seed)

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

        strokePath(0, 0.9, weight)
        if (doubleStroke)
            strokePath(1.2, 0.35, weight * 0.7)

        if (endTicks) {
            ctx.globalAlpha = 0.8
            ctx.strokeStyle = stroke
            ctx.lineWidth = 1
            var dx = x2 - x1
            var dy = y2 - y1
            var len = Math.sqrt(dx * dx + dy * dy) || 1
            var nx = -dy / len
            var ny = dx / len
            var ends = [[x1, y1], [x2, y2]]
            for (var e = 0; e < ends.length; e++) {
                ctx.beginPath()
                ctx.moveTo(ends[e][0] - nx * 4, ends[e][1] - ny * 4)
                ctx.lineTo(ends[e][0] + nx * 4, ends[e][1] + ny * 4)
                ctx.stroke()
            }
        }
        ctx.globalAlpha = 1
    }
}
