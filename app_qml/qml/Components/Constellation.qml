import QtQuick
import "../theme.js" as T

// 星座图：好友节点 + 就近连线。布点用固定种子，静止时不闪；悬停时节点长出锁定圆环。
Item {
    id: chart

    property var items: []          // [{ name, state, color }]
    property int seed: 4242
    property color stroke: T.LINE
    property var layout: ({ nodes: [], links: [] })
    property int hovered: -1

    signal activated(int index)

    function relayout() {
        layout = T.constellation(items, Math.max(40, width), Math.max(40, height), seed)
        canvas.requestPaint()
    }

    onItemsChanged: relayout()
    onWidthChanged: relayout()
    onHeightChanged: relayout()
    onSeedChanged: relayout()
    onHoveredChanged: canvas.requestPaint()

    Canvas {
        renderTarget: Canvas.Image
        id: canvas
        anchors.fill: parent
        renderStrategy: Canvas.Cooperative
        onPaint: {
            var ctx = getContext("2d")
            ctx.clearRect(0, 0, width, height)
            var nodes = chart.layout.nodes || []
            var links = chart.layout.links || []
            var i

            ctx.strokeStyle = T.LINE
            ctx.globalAlpha = 0.5
            ctx.lineWidth = 1
            for (i = 0; i < links.length; i++) {
                var a = nodes[links[i].a]
                var b = nodes[links[i].b]
                if (!a || !b)
                    continue
                var pts = T.rulePoints(a.x, a.y, b.x, b.y, T.hashSeed("link" + i), { bow: 0.006, overshoot: 2 })
                ctx.beginPath()
                for (var k = 0; k < pts.length; k++) {
                    if (k === 0)
                        ctx.moveTo(pts[k].x, pts[k].y)
                    else
                        ctx.lineTo(pts[k].x, pts[k].y)
                }
                ctx.stroke()
            }
            ctx.globalAlpha = 1

            for (i = 0; i < nodes.length; i++) {
                var n = nodes[i]
                var hot = (i === chart.hovered)
                ctx.globalAlpha = hot ? 0.35 : 0.18
                ctx.fillStyle = n.item && n.item.color ? n.item.color : T.COBALT
                ctx.beginPath()
                ctx.arc(n.x, n.y, n.r + 6, 0, 6.2832)
                ctx.fill()
                ctx.globalAlpha = 1
                ctx.fillStyle = n.item && n.item.color ? n.item.color : T.COBALT
                ctx.beginPath()
                ctx.arc(n.x, n.y, n.r, 0, 6.2832)
                ctx.fill()
                ctx.strokeStyle = T.INK
                ctx.globalAlpha = 0.35
                ctx.beginPath()
                ctx.moveTo(n.x - n.r - 5, n.y)
                ctx.lineTo(n.x - n.r - 1, n.y)
                ctx.moveTo(n.x + n.r + 1, n.y)
                ctx.lineTo(n.x + n.r + 5, n.y)
                ctx.stroke()
                ctx.globalAlpha = 1
            }
        }
    }

    Repeater {
        model: chart.layout.nodes || []

        delegate: Item {
            id: hit
            x: modelData.x - 62
            y: modelData.y - 20
            width: 124
            height: 40

            Text {
                anchors.horizontalCenter: parent.horizontalCenter
                anchors.bottom: parent.bottom
                anchors.bottomMargin: 20
                text: modelData.item ? modelData.item.name : ""
                font.family: T.FONT_MONO
                font.pixelSize: 10
                color: hitArea.containsMouse ? T.COBALT : T.MUTED
                elide: Text.ElideRight
                width: parent.width
                horizontalAlignment: Text.AlignHCenter
            }

            MouseArea {
                id: hitArea
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onContainsMouseChanged: chart.hovered = containsMouse ? modelData.index : (chart.hovered === modelData.index ? -1 : chart.hovered)
                onClicked: chart.activated(modelData.index)
            }

            property bool containsMouse: hitArea.containsMouse
        }
    }
}
