import QtQuick
import "../theme.js" as T

// 工程图上的按键：方角细边（右上切角），等宽标签
//
// 动效语汇（照《明日方舟》的按钮）：悬停不是"变个底色"，而是一条斜切的色带从左往
// **扫过**整个按钮，前沿压一道亮线；移开时色带继续往右扫出界，而不是原地退回去
// 主按钮（primary）在扫过时同时翻成钴蓝，扫完才停住——快出缓收（OutExpo）
Item {
    id: btn

    property string label: ""
    property string hint: ""
    property bool primary: false
    property bool active: false
    property color accent: T.COBALT
    signal clicked()

    readonly property bool hovered: mouse.containsMouse
    readonly property bool pressed: mouse.pressed

    // 扫过带的进度 p：0.25 = 还在左边外面，1 = 已经扫出（0 → 1 之间是扫过过程）
property real sweepT: 1.9

    readonly property color baseFill: {
        if (btn.primary)
            return btn.hovered ? T.HIGHLIGHT : "#15191b"
        if (btn.pressed)
            return T.PRESS_VEIL
        return "transparent"
    }
    readonly property color lineColor: {
        if (btn.primary)
            return btn.hovered ? T.HIGHLIGHT : "#15191b"
        if (btn.active || btn.hovered)
            return btn.accent
        return T.LINE
    }
    readonly property color textColor: {
        if (btn.primary)
            return "#f5f7f1"
        if (btn.active || btn.hovered)
            return btn.accent
        return T.INK
    }

    implicitWidth: Math.max(104, txt.implicitWidth + 36 + (btn.hint.length > 0 ? hintTxt.implicitWidth + 12 : 0))
    implicitHeight: 36
    opacity: enabled ? 1 : 0.4
    scale: btn.pressed ? 0.985 : (btn.hovered ? 1.012 : 1.0)
    Behavior on scale { NumberAnimation { duration: T.DUR_HOVER; easing.type: Easing.OutCubic } }

    transform: Translate {
        y: btn.pressed ? 1 : (btn.hovered ? -1 : 0)
        Behavior on y { NumberAnimation { duration: T.DUR_HOVER; easing.type: Easing.OutCubic } }
    }

    onHoveredChanged: {
        if (btn.hovered) {
            sweepOut.stop()
            btn.sweepT = -0.25
            sweepIn.restart()
        } else {
            sweepIn.stop()
            sweepOut.restart()
        }
    }

    NumberAnimation {
        id: sweepIn

        target: btn
        property: "sweepT"
        from: -0.25
        to: 1.0
        duration: 260
        easing.type: Easing.OutExpo
    }

    NumberAnimation {
        id: sweepOut

        target: btn
        property: "sweepT"
        from: 1.0
        to: 1.9
        duration: 300
        easing.type: Easing.OutQuint
    }

    // 悬停时浮起来：两层错位投
Rectangle {
        anchors.fill: face
        anchors.margins: -3
        anchors.topMargin: 4
        radius: T.RADIUS + 2
        color: "#22282b"
        opacity: btn.hovered ? 0.07 : 0
        Behavior on opacity { NumberAnimation { duration: T.DUR_HOVER } }
    }

    Rectangle {
        id: face

        anchors.fill: parent
        color: btn.baseFill
        border.width: 1
        border.color: btn.lineColor
        radius: T.RADIUS

        Behavior on color { ColorAnimation { duration: T.DUR } }
        Behavior on border.color { ColorAnimation { duration: T.DUR } }
    }

    // 扫过带：一条斜切的平行四边形，沿按钮横向走
    Item {
        id: sweepClip

        anchors.fill: face
        anchors.margins: 1
        clip: true
        visible: btn.sweepT < 1.85

        Item {
            id: band

            width: sweepClip.width * 0.55
            height: sweepClip.height
            x: (btn.sweepT - 0.55) * sweepClip.width

            Canvas {
                id: bandCanvas

                anchors.fill: parent
                antialiasing: true
                renderStrategy: Canvas.Cooperative

                onPaint: {
                    const ctx = getContext("2d")
                    const w = width
                    const h = height
                    ctx.clearRect(0, 0, w, h)
                    const shear = 0.42 * h
                    ctx.fillStyle = btn.primary ? "#26ffffff" : "#243a5bc2"
                    ctx.beginPath()
                    ctx.moveTo(shear, 0)
                    ctx.lineTo(w, 0)
                    ctx.lineTo(w - shear, h)
                    ctx.lineTo(0, h)
                    ctx.closePath()
                    ctx.fill()
                    ctx.strokeStyle = btn.primary ? "#ccffffff" : "#cc2a3fff"
                    ctx.lineWidth = 1.6
                    ctx.beginPath()
                    ctx.moveTo(shear, 0.5)
                    ctx.lineTo(w, 0.5)
                    ctx.stroke()
                }
            }
        }
    }

    Canvas {
        id: cut

        anchors.fill: parent
        renderStrategy: Canvas.Cooperative
        onWidthChanged: requestPaint()
        onHeightChanged: requestPaint()
        onPaint: {
            var ctx = getContext("2d")
            ctx.clearRect(0, 0, width, height)
            ctx.strokeStyle = btn.primary ? "#f5f7f1" : (btn.active || btn.hovered ? btn.accent : T.LINE)
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

    // 标签：悬停时向右挪一格，像被色带推了一
Item {
        id: txtMask

        anchors.left: parent.left
        anchors.leftMargin: 14
        anchors.verticalCenter: parent.verticalCenter
        width: txt.width
        height: txt.height
        clip: true

        Text {
            id: txt

            x: btn.hovered ? 2 : 0
            text: btn.label
            color: btn.textColor
            font.family: T.FONT_MONO
            font.pixelSize: 12
            font.letterSpacing: 0.6

            Behavior on color { ColorAnimation { duration: T.DUR } }
            Behavior on x { NumberAnimation { duration: T.DUR_MOVE; easing.type: Easing.OutQuint } }
        }
    }

    Text {
        id: hintTxt

        anchors.right: parent.right
        anchors.rightMargin: 12
        anchors.verticalCenter: parent.verticalCenter
        text: btn.hint
        color: btn.primary ? "#d8ded9" : T.MUTED
        opacity: btn.hovered ? 1.0 : 0.85
        font.family: T.FONT_MONO
        font.pixelSize: 10
        x: btn.hovered ? -2 : 0

        Behavior on opacity { NumberAnimation { duration: T.DUR } }
        Behavior on x { NumberAnimation { duration: T.DUR_MOVE; easing.type: Easing.OutQuint } }
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
