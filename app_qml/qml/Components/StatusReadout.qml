import QtQuick
import "../theme.js" as T

// 技术读数行：等宽小标签 + 点线引导 + 等宽数值（工程图上的标注风格）
Item {
    id: row

    property string label: ""
    property string value: "—"
    property color valueColor: T.INK
    property int labelSize: 11
    property int valueSize: 12
    property bool strong: false

    implicitHeight: 20

    Canvas {
        renderTarget: Canvas.Image
        id: leader
        anchors.fill: parent
        renderStrategy: Canvas.Cooperative
        onWidthChanged: requestPaint()
        onHeightChanged: requestPaint()
        Connections {
            target: row
            function onValueChanged() { leader.requestPaint() }
            function onLabelChanged() { leader.requestPaint() }
        }
        onPaint: {
            var ctx = getContext("2d")
            ctx.clearRect(0, 0, width, height)
            var x0 = lab.paintedWidth + 8
            var x1 = width - val.paintedWidth - 8
            if (x1 <= x0)
                return
            ctx.fillStyle = T.LINE
            ctx.globalAlpha = 0.9
            for (var x = x0; x < x1; x += 4) {
                ctx.beginPath()
                ctx.arc(x, height / 2, 0.7, 0, 6.2832)
                ctx.fill()
            }
            ctx.globalAlpha = 1
        }
    }

    Text {
        id: lab
        text: row.label
        font.family: T.FONT_MONO
        font.pixelSize: row.labelSize
        color: T.MUTED
        anchors.left: parent.left
        anchors.verticalCenter: parent.verticalCenter
    }

    Text {
        id: val
        text: row.value
        font.family: T.FONT_MONO
        font.pixelSize: row.valueSize
        font.bold: row.strong
        color: row.valueColor
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        elide: Text.ElideRight
    }
}
