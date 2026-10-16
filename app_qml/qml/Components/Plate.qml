import QtQuick
import "../theme.js" as T

// 多层版画之一：细边框 + 编号 + 标题 + 说明，右上角切角，标题下压一条手绘尺线
//
// 层次（用户反馈"没有层次感"）靠四件事堆出来，全部不依赖着色器，软件渲染也一样：
//   1. 三层错位的极淡投影（越往下越淡、越往外越大）——纸张是"浮"在底板上的；
//   2. 纸面自上而下有一档很轻的渐变，不是一块纯色；
//   3. 头部编号/标题/说明用三级字阶拉开（字号与字距都不同）；
//   4. 选中态在左沿压一条 2px 钴蓝，跟边框同色呼应
//
// 入场动效由外壳统一驱动：外壳把 `revealed` 依次置为 false 再置 true，这里用
// Behavior 把透明度 / 横向位移 / 缩放一起收尾（错峰间隔在 Main.qml 的 STAGGER）
Item {
    id: root

    property string index: "01"
    property string title: ""
    property string caption: ""
    property color paperColor: T.PAPER_LOCAL
    property bool active: false
    property color borderColor: active ? T.COBALT : T.LINE
    property int headerHeight: 48
    // 外壳的错峰入场标记；组件自己不看这个值以外的东西
    property bool revealed: true
    // 常驻装饰动效开关（动效档位为"最低"时外壳会关掉它）
    property bool ambient: true
    default property alias content: body.data

    implicitHeight: headerHeight + 28

    // 入场：不是淡入，是一条斜切的"带"从左往右被擦开（Sweep 的实心模式当遮罩用）
// 内容跟着被擦出来，同时从左往右推 10px 归位；错峰由外壳的 revealTimer 给出。
transform: Translate {
        x: root.revealed ? 0 : -10
        Behavior on x { NumberAnimation { duration: T.DUR_WIPE + 120; easing.type: Easing.OutQuint } }
    }

    Sweep {
        id: wipe

        anchors.fill: panel
        // 0.62 时带子正好把整块面板盖满（bandWidth 是 1.5 倍宽），1.0 时完全扫出去
        progress: root.revealed ? 1.0 : 0.62
        bandWidth: width * 1.5
        bandSolid: true
        bandColor: root.paperColor
        bandOpacity: 1.0
        edgeColor: T.HIGHLIGHT
        edgeOpacity: 0.8
        edgeWidth: 2
        z: 8

        Behavior on progress { NumberAnimation { duration: T.DUR_WIPE; easing.type: Easing.OutExpo } }
    }

    // ── 投影：三层错位 ────────────────────────────────────────────────────
    Rectangle {
        anchors.fill: panel
        anchors.margins: -7
        anchors.topMargin: 7
        radius: T.RADIUS + 4
        color: "#22282b"
        opacity: T.SHADOW_3
    }

    Rectangle {
        anchors.fill: panel
        anchors.margins: -3
        anchors.topMargin: 4
        radius: T.RADIUS + 2
        color: "#22282b"
        opacity: T.SHADOW_2
    }

    Rectangle {
        anchors.fill: panel
        anchors.margins: -1
        anchors.topMargin: 2
        radius: T.RADIUS + 1
        color: "#22282b"
        opacity: T.SHADOW_1
    }

    // ── 纸面 ──────────────────────────────────────────────────────────────
    Rectangle {
        id: panel

        anchors.fill: parent
        radius: T.RADIUS
        border.width: 1
        border.color: root.active ? T.COBALT : (mouse.containsMouse ? "#5522282b" : root.borderColor)

        gradient: Gradient {
            GradientStop { position: 0.0; color: Qt.lighter(root.paperColor, 1.035) }
            GradientStop { position: 0.35; color: root.paperColor }
            GradientStop { position: 1.0; color: Qt.darker(root.paperColor, 1.012) }
        }

        Behavior on border.color { ColorAnimation { duration: T.DUR } }
    }

    // 选中时左沿的钴蓝竖条
    Rectangle {
        anchors.left: panel.left
        anchors.top: panel.top
        anchors.bottom: panel.bottom
        anchors.topMargin: 1
        anchors.bottomMargin: 1
        width: 2
        color: T.COBALT
        opacity: root.active ? 1 : 0
        Behavior on opacity { NumberAnimation { duration: T.DUR } }
    }

    MouseArea {
        id: mouse
        anchors.fill: parent
        hoverEnabled: true
        acceptedButtons: Qt.NoButton
    }

    // 右上切角记号（裁切角，不是圆角）
    Canvas {        renderTarget: Canvas.Image
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

    // 常驻动效：头部尺线上缓慢走过的一枚"数据点"。静止的版面靠这点小动作显得在动
// 走一段停一下（x 上的 SequentialAnimation，只改 item 变换，不重绘画布）
Rectangle {
        id: packet

        width: 34
        height: 2
        color: root.active ? T.COBALT : T.HIGHLIGHT
        opacity: (root.revealed && root.ambient) ? 0.5 : 0.0
        anchors.bottom: header.bottom
        anchors.bottomMargin: -1

        Behavior on opacity { NumberAnimation { duration: T.DUR } }

        SequentialAnimation on x {
            loops: Animation.Infinite
            running: root.revealed && root.ambient

            PauseAnimation { duration: 800 }

            NumberAnimation {
                from: 14
                to: Math.max(24, root.width - packet.width - 14)
                duration: 4600
                easing.type: Easing.InOutSine
            }
            PauseAnimation { duration: 2200 }
        }
    }

    Item {
        id: header
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        height: root.headerHeight

        // 编号：小号等宽 + 大字距，压成"眉标"
        Text {
            id: idx
            text: root.index
            font.family: T.FONT_MONO
            font.pixelSize: 10
            font.letterSpacing: 2.4
            color: T.COBALT
            anchors.left: parent.left
            anchors.leftMargin: 15
            anchors.verticalCenter: parent.verticalCenter
        }

        Text {
            id: ttl
            text: root.title
            font.family: T.FONT_DISPLAY
            font.pixelSize: 19
            font.letterSpacing: 0.8
            color: T.INK
            anchors.left: idx.right
            anchors.leftMargin: 13
            anchors.verticalCenter: parent.verticalCenter
            elide: Text.ElideRight
        }

        Text {
            text: root.caption
            font.family: T.FONT_MONO
            font.pixelSize: 10
            font.letterSpacing: 0.5
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
        anchors.topMargin: 10
    }
}
