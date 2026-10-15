import QtQuick
import "../theme.js" as T

// 工程图上的按键：方角细边（右上切角），等宽标签；悬停时出现锁定圆环与过版错位。
Item {
    id: btn

    property string label: ""
    property string hint: ""
    property bool primary: false
    property bool active: false
    property color accent: T.COBALT
    signal clicked()

    implicitWidth: Math.max(104, txt.implicitWidth + 36 + (btn.hint.length > 0 ? hintTxt.implicitWidth + 12 : 0))
    implicitHeight: 36
    opacity: enabled ? 1 : 0.4

    Rectangle {
        anchors.fill: parent
        color: btn.primary ? btn.accent : (mouse.containsMouse ? Qt.rgba(0.23, 0.36, 0.76, 0.07) : "transparent")
        border.width: 1
        border.color: btn.primary ? btn.accent : (btn.active || mouse.containsMouse ? btn.accent : T.LINE)
        radius: T.RADIUS
    }

    Canvas {
        renderTarget: Canvas.Image
        id: cut
        anchors.fill: parent
        renderStrategy: Canvas.Cooperative
        onWidthChanged: requestPaint()
        onHeightChanged: requestPaint()
        onPaint: {
            var ctx = getContext("2d")
            ctx.clearRect(0, 0, width, height)
            ctx.strokeStyle = btn.primary ? T.PAPER : (btn.active ? btn.accent : T.LINE)
            ctx.globalAlpha = btn.primary ? 0.7 : 0.9
            ctx.lineWidth = 1
            var c = 9
            ctx.beginPath()
            ctx.moveTo(width - c, 0)
            ctx.lineTo(width, c)
            ctx.stroke()
            ctx.globalAlpha = 1
        }
    }

    Text {
        id: txt
        anchors.left: parent.left
        anchors.leftMargin: 14
        anchors.verticalCenter: parent.verticalCenter
        text: btn.label
        color: btn.primary ? T.PAPER : (btn.active || mouse.containsMouse ? btn.accent : T.INK)
        font.family: T.FONT_MONO
        font.pixelSize: 12
    }

    Text {
        id: hintTxt
        anchors.right: parent.right
        anchors.rightMargin: 12
        anchors.verticalCenter: parent.verticalCenter
        text: btn.hint
        color: btn.primary ? T.PAPER : T.MUTED
        opacity: 0.85
        font.family: T.FONT_MONO
        font.pixelSize: 10
    }

    MouseArea {
        id: mouse
        anchors.fill: parent
        hoverEnabled: true
        enabled: btn.enabled
        cursorShape: Qt.PointingHandCursor
        onClicked: btn.clicked()
    }
}
