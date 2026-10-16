import QtQuick
import "../theme.js" as T

// 底部一级导航（三项：会话 / 好友 / 设置）
//
// 动效语汇（照《明日方舟》的界面）：
//   · 选中标记是一块**斜切的平行四边形**，不是横条；
//   · 它滑过去的时候会先被"拉长"再收回来（橡皮筋），不是匀速平移；
//   · 文字不是淡入的——选中项的标签从下方一道遮罩里**升**上来，编号从左侧滑进来
// 用法与旧版一致：items（[{key,index,label,caption}]）、current / selected(key)
Item {
    id: nav

    property var items: []
    property string current: ""
    signal selected(string key)

    implicitHeight: T.BOTTOM_H
    implicitWidth: row.implicitWidth + 10

    readonly property int currentIndex: {
        for (var i = 0; i < items.length; ++i) {
            if (items[i].key === current)
                return i
        }
        return 0
    }

    // 让下面那条标记的位置绑定在"条目已建好 / 栏宽已定"时重新求值：
    // entryX() 是函数调用，QML 追踪不到它的依赖，所以把 rep.count 和 width 读进绑定里
readonly property int layoutEpoch: rep.count * 1000 + Math.round(width)

    // 滑移途中额外撑开的宽度（橡皮筋），由下面那条 SequentialAnimation 驱动
    property real stretch: 0

    function entryAt(index) {
        return rep.itemAt(index)
    }

    function entryX(index) {
        var it = entryAt(index)
        return it ? it.x : 0
    }

    function entryW(index) {
        var it = entryAt(index)
        return it ? it.width : 0
    }

    onCurrentIndexChanged: stretchAnim.restart()

    SequentialAnimation {
        id: stretchAnim

        NumberAnimation {
            target: nav
            property: "stretch"
            to: 26
            duration: Math.round(T.DUR_MOVE * 0.34)
            easing.type: Easing.OutCubic
        }
        NumberAnimation {
            target: nav
            property: "stretch"
            to: 0
            duration: Math.round(T.DUR_MOVE * 0.66)
            easing.type: Easing.OutQuint
        }
    }

    Row {
        id: row

        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        spacing: 38

        Repeater {
            id: rep
            model: nav.items

            delegate: Item {
                id: entry

                readonly property bool on: nav.current === modelData.key
                readonly property bool hot: mouse.containsMouse

                width: content.width
                height: nav.implicitHeight
                opacity: on ? 1.0 : 0.55

                Behavior on opacity { NumberAnimation { duration: T.DUR; easing.type: Easing.OutCubic } }

                // 悬停：一块略微倾斜的雾从左侧滑进来（不是原地淡入）
                Item {
                    anchors.fill: content
                    anchors.margins: -14
                    clip: true

                    Rectangle {
                        anchors.fill: parent
                        anchors.margins: -6
                        color: T.HOVER_VEIL
                        rotation: -4
                        opacity: entry.hot && !entry.on ? 1 : 0
                        x: entry.hot && !entry.on ? 0 : -14
                        Behavior on opacity { NumberAnimation { duration: T.DUR_HOVER } }
                        Behavior on x { NumberAnimation { duration: T.DUR_MOVE; easing.type: Easing.OutQuint } }
                    }
                }

                Column {
                    id: content

                    anchors.verticalCenter: parent.verticalCenter
                    spacing: 3

                    Row {
                        spacing: 8

                        Text {
                            id: badge

                            // 基线对齐：标签现在躺在一层遮罩里（不是兄弟项），锚不到它的 baseline
// 用遮罩下沿往回让 3px 近似出同样的基线位置
anchors.bottom: labelMask.bottom
                            anchors.bottomMargin: 3
                            text: modelData.index
                            font.family: T.FONT_MONO
                            font.pixelSize: 10
                            font.letterSpacing: 1.6
                            color: entry.on ? T.COBALT : T.MUTED
                            x: entry.on ? 0 : -7

                            Behavior on color { ColorAnimation { duration: T.DUR } }
                            Behavior on x { NumberAnimation { duration: T.DUR_MOVE; easing.type: Easing.OutQuint } }
                        }

                        // 标签从下方一道遮罩里升上
Item {
                            id: labelMask

                            width: labelText.width
                            height: labelText.height + 2
                            clip: true

                            Text {
                                id: labelText

                                text: modelData.label
                                font.family: T.FONT_DISPLAY
                                font.pixelSize: 19
                                font.letterSpacing: 1.5
                                color: T.INK
                                y: entry.on ? 0 : labelMask.height - 5

                                Behavior on y { NumberAnimation { duration: T.DUR_MOVE; easing.type: Easing.OutQuint } }

                                // 选中时下方压一条会展开的细
Rectangle {
                                    anchors.left: parent.left
                                    anchors.right: parent.right
                                    anchors.top: parent.bottom
                                    anchors.topMargin: 3
                                    height: 1
                                    color: T.INK
                                    opacity: entry.on ? 0.35 : 0
                                    Behavior on opacity { NumberAnimation { duration: T.DUR; easing.type: Easing.OutCubic } }
                                }
                            }
                        }
                    }

                    Text {
                        text: modelData.caption
                        font.family: T.FONT_MONO
                        font.pixelSize: 9
                        font.letterSpacing: 0.8
                        color: T.MUTED
                        x: entry.on ? 0 : -4
                        Behavior on x { NumberAnimation { duration: T.DUR_MOVE; easing.type: Easing.OutQuint } }
                    }
                }

                MouseArea {
                    id: mouse

                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: nav.selected(modelData.key)
                }
            }
        }
    }

    // ── 选中标记：斜切平行四边形，滑移时被拉长 ────────────────────────────
    Item {
        id: marker

        x: nav.entryX(nav.currentIndex) - nav.stretch * 0.5
        y: row.y - 9
        width: nav.entryW(nav.currentIndex) + nav.stretch
        height: 5

        Behavior on x { NumberAnimation { duration: T.DUR_MOVE; easing.type: Easing.OutQuint } }
        Behavior on width { NumberAnimation { duration: T.DUR_MOVE; easing.type: Easing.OutQuint } }

        Canvas {
            id: markerCanvas

            anchors.fill: parent
            antialiasing: true
            renderStrategy: Canvas.Cooperative
            onPaint: {
                const ctx = getContext("2d")
                const w = width
                const h = height
                ctx.clearRect(0, 0, w, h)
                // 下斜的平行四边形：右上角后缩，左下角前伸
                const shear = 7
                ctx.fillStyle = T.INK
                ctx.beginPath()
                ctx.moveTo(shear, 0)
                ctx.lineTo(w, 0)
                ctx.lineTo(w - shear, h)
                ctx.lineTo(0, h)
                ctx.closePath()
                ctx.fill()
                // 前沿压一道更亮的细线（同 Sweep 的语汇）
                ctx.strokeStyle = T.HIGHLIGHT
                ctx.lineWidth = 1.4
                ctx.beginPath()
                ctx.moveTo(shear + 1, 1)
                ctx.lineTo(w - 1, 1)
                ctx.stroke()
            }

            Connections {
                target: marker
                function onWidthChanged() { markerCanvas.requestPaint() }
            }
        }
    }

    // 左端一枚定位记号，让这条栏不至于"空着"
    Rectangle {
        anchors.left: parent.left
        anchors.verticalCenter: parent.verticalCenter
        width: 6
        height: 1
        color: "#3322282b"
    }
}
