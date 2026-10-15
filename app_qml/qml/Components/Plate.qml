import QtQuick
import "../theme.js" as T

// 多层版画之一：细边框 + 编号 + 标题 + 说明，右上角切角，标题下压一条手绘尺线。
Item {
    id: root

    property string index: "01"
    property string title: ""
    property string caption: ""
    property color paperColor: T.PAPER_LOCAL
    property bool active: false
    property color borderColor: active ? T.COBALT : T.LINE
    property int headerHeight: 48
    default property alias content: body.data

    implicitHeight: headerHeight + 28

    Rectangle {
        anchors.fill: parent
        color: root.paperColor
        border.width: 1
        border.color: root.borderColor
        radius: T.RADIUS
    }

    // 右上切角记号（裁切角，不是圆角）
    Canvas {
        renderTarget: Canvas.Image
        anchors.fill: parent
        renderStrategy: Canvas.Cooperative
        onWidthChanged: requestPaint()
        onHeightChanged: requestPaint()
        onPaint: {
            var ctx = getContext("2d")
            ctx.clearRect(0, 0, width, height)
            ctx.strokeStyle = root.borderColor
            ctx.globalAlpha = 0.9
            ctx.lineWidth = 1
            var c = 14
            ctx.beginPath()
            ctx.moveTo(width - c, 0)
            ctx.lineTo(width, c)
            ctx.stroke()
            ctx.beginPath()
            ctx.moveTo(width - c + 5, 0)
            ctx.lineTo(width, c - 5)
            ctx.stroke()
            ctx.globalAlpha = 1
        }
    }

    Item {
        id: header
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        height: root.headerHeight

        Text {
            id: idx
            text: root.index
            font.family: T.FONT_MONO
            font.pixelSize: 11
            color: T.COBALT
            anchors.left: parent.left
            anchors.leftMargin: 14
            anchors.verticalCenter: parent.verticalCenter
        }

        Text {
            id: ttl
            text: root.title
            font.family: T.FONT_DISPLAY
            font.pixelSize: 17
            color: T.INK
            anchors.left: idx.right
            anchors.leftMargin: 12
            anchors.verticalCenter: parent.verticalCenter
            elide: Text.ElideRight
        }

        Text {
            text: root.caption
            font.family: T.FONT_MONO
            font.pixelSize: 10
            color: T.MUTED
            anchors.right: parent.right
            anchors.rightMargin: 20
            anchors.verticalCenter: parent.verticalCenter
        }

        SketchRule {
            id: rule
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            anchors.leftMargin: 14
            anchors.rightMargin: 14
            height: 4
            x1: 0
            y1: 2
            x2: rule.width
            y2: 2
            seed: T.hashSeed(root.index + root.title)
            stroke: root.active ? T.COBALT : T.LINE
        }
    }

    Item {
        id: body
        anchors.top: header.bottom
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        anchors.margins: 14
    }
}
