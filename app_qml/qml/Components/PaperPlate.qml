import QtQuick
import "../theme.js" as T

// 纸张底板：细网格 + 边缘标尺 + 切角记号 + 可选半调网点。
// 装饰层用 Canvas 一次栅格化，静止时不再重绘（内存与帧率都可控）。
Item {
    id: plate

    // 切页入场标记：外壳（Main.qml 的 revealPage）依次把 revealed 置 false → true
    property bool revealed: true

    opacity: revealed ? 1 : 0
    Behavior on opacity { NumberAnimation { duration: T.DUR_ENTER; easing.type: Easing.OutCubic } }

    property color paperColor: T.PAPER
    property bool showGrid: true
    property bool showRulers: true
    property bool showDots: false
    property int seed: 1
    property int gridStep: 34
    property real gridOpacity: 0.5

    default property alias content: slot.data

    Rectangle {
        anchors.fill: parent
        color: plate.paperColor
        radius: T.RADIUS
    }

    Canvas {
        renderTarget: Canvas.Image
        id: deco
        anchors.fill: parent
        renderStrategy: Canvas.Cooperative

        onWidthChanged: requestPaint()
        onHeightChanged: requestPaint()
        onPaint: {
            var ctx = getContext("2d")
            ctx.clearRect(0, 0, width, height)
            ctx.lineWidth = 1

            if (plate.showGrid) {
                ctx.strokeStyle = T.LINE_SOFT
                ctx.globalAlpha = plate.gridOpacity
                for (var x = plate.gridStep; x < width - 1; x += plate.gridStep) {
                    ctx.beginPath()
                    ctx.moveTo(x, 0)
                    ctx.lineTo(x, height)
                    ctx.stroke()
                }
                for (var y = plate.gridStep; y < height - 1; y += plate.gridStep) {
                    ctx.beginPath()
                    ctx.moveTo(0, y)
                    ctx.lineTo(width, y)
                    ctx.stroke()
                }
                ctx.globalAlpha = 1
            }

            if (plate.showDots) {
                var rand = T.rng(plate.seed)
                ctx.fillStyle = T.INK
                ctx.globalAlpha = 0.12
                var step = 12
                for (var r = 0; r < height; r += step) {
                    for (var c = 0; c < width; c += step) {
                        if (rand() < 0.72)
                            continue
                        ctx.beginPath()
                        ctx.arc(c + rand() * 4, r + rand() * 4, 0.7 + rand() * 0.6, 0, 6.2832)
                        ctx.fill()
                    }
                }
                ctx.globalAlpha = 1
            }

            if (plate.showRulers) {
                ctx.strokeStyle = T.LINE
                ctx.globalAlpha = 0.85
                // 上下边缘标尺：每 10 格一条长刻度，中间短刻度
                var i
                for (i = 0; i * plate.gridStep <= width; i++) {
                    var px = i * plate.gridStep
                    var isLong = (i % 5 === 0)
                    ctx.beginPath()
                    ctx.moveTo(px, 0)
                    ctx.lineTo(px, isLong ? 9 : 5)
                    ctx.stroke()
                    ctx.beginPath()
                    ctx.moveTo(px, height)
                    ctx.lineTo(px, height - (isLong ? 9 : 5))
                    ctx.stroke()
                }
                for (i = 0; i * plate.gridStep <= height; i++) {
                    var py = i * plate.gridStep
                    var longV = (i % 5 === 0)
                    ctx.beginPath()
                    ctx.moveTo(0, py)
                    ctx.lineTo(longV ? 9 : 5, py)
                    ctx.stroke()
                    ctx.beginPath()
                    ctx.moveTo(width, py)
                    ctx.lineTo(width - (longV ? 9 : 5), py)
                    ctx.stroke()
                }
                // 四角切角记号
                var c1 = 16
                ctx.globalAlpha = 0.9
                ctx.beginPath()
                ctx.moveTo(width - c1, 0)
                ctx.lineTo(width, c1)
                ctx.moveTo(width - c1 + 6, 0)
                ctx.lineTo(width, c1 - 6)
                ctx.stroke()
                ctx.beginPath()
                ctx.moveTo(0, c1)
                ctx.lineTo(c1, 0)
                ctx.stroke()
                ctx.globalAlpha = 1
            }
        }
    }

    Item {
        id: slot
        anchors.fill: parent
        anchors.margins: T.PAD
    }
}
