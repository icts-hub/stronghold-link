import QtQuick
import "../theme.js" as T

// 速率尺：刻度条按对数点亮相（0 值时保持暗刻度），右侧等宽读数。
Item {
    id: meter

    property string label: ""
    property real bytesPerSec: 0
    property color accent: T.COBALT
    property int bars: 26
    property bool up: true

    implicitHeight: 34

    readonly property int litCount: {
        var v = Math.max(0, bytesPerSec)
        if (v <= 1)
            return 0
        var l = Math.log(v) / Math.LN10        // 1 → 0, 1e6 → 6
        return Math.max(1, Math.min(bars, Math.round(l / 6 * bars)))
    }

    Text {
        id: lab
        text: meter.label
        font.family: T.FONT_MONO
        font.pixelSize: 10
        color: T.MUTED
        anchors.left: parent.left
        anchors.top: parent.top
    }

    Text {
        id: val
        text: T.fmtSpeed(meter.bytesPerSec)
        font.family: T.FONT_MONO
        font.pixelSize: 12
        color: meter.bytesPerSec > 0 ? T.INK : T.MUTED
        anchors.right: parent.right
        anchors.top: parent.top
    }

    Canvas {
        renderTarget: Canvas.Image
        id: scale
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: lab.bottom
        anchors.topMargin: 4
        height: 12
        renderStrategy: Canvas.Cooperative
        onWidthChanged: requestPaint()
        onHeightChanged: requestPaint()
        onPaint: {
            var ctx = getContext("2d")
            ctx.clearRect(0, 0, width, height)
            var n = meter.bars
            var step = width / n
            for (var i = 0; i < n; i++) {
                var t = i / Math.max(1, n - 1)
                var h = 3 + 8 * (meter.up ? t : (1 - t))
                var lit = i < meter.litCount
                ctx.globalAlpha = lit ? 0.95 : 0.28
                ctx.strokeStyle = lit ? meter.accent : T.LINE
                ctx.lineWidth = lit ? 2 : 1
                ctx.beginPath()
                ctx.moveTo(i * step + step * 0.25, height)
                ctx.lineTo(i * step + step * 0.25, height - h)
                ctx.stroke()
            }
            ctx.globalAlpha = 1
        }
        Connections {
            target: meter
            function onLitCountChanged() { scale.requestPaint() }
            function onBarsChanged() { scale.requestPaint() }
            function onAccentChanged() { scale.requestPaint() }
        }
    }
}
