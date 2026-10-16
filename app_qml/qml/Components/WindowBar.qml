import QtQuick
import "../theme.js" as T

// 自绘标题栏（无系统边框）
// 为什么自己做：系统标题栏跟这套"纸张 + 墨色 + 钴蓝"的设计语言对不上，而且
// 2560x1440 上它会把品牌区挤到很下面。这里把徽记、页面位置、后端状态和窗口按钮
// 收进一条 40px 的窄条。拖动 / 双击最大化交给 Main.qml 的 Window.startSystemMove()
Item {
    id: bar

    property string mark: "STRONGHOLD LINK"
    property string subtitle: "干线隧道控制台"
    property string pageIndex: "01"
    property string pageLabel: "会话"
    property bool backendReady: false
    property string statusText: ""
    property string metricsText: ""
    property string errorText: ""
    property bool maximized: false
    property bool windowActive: true
    // 引语卡片是否开着：外壳持有状态，这里只负责显示与点击
    property bool quotesOpen: false

    signal minimizeRequested()
    signal maximizeRequested()
    signal closeRequested()
    signal moveRequested()
    signal quotesRequested()

    implicitHeight: T.CHROME_H

    // ── 底：自左向右的极淡横向渐变，跟版面内的顶栏区分开 ──────────────────
    Rectangle {
        anchors.fill: parent
        gradient: Gradient {
            orientation: Gradient.Horizontal
            GradientStop { position: 0.0; color: T.FRAME_TOP }
            GradientStop { position: 0.55; color: "#eef1f0" }
            GradientStop { position: 1.0; color: T.FRAME_BOTTOM }
        }
    }

    Rectangle {
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        height: T.HAIR
        color: bar.windowActive ? "#2e22282b" : "#1622282b"
    }

    // ── 拖动区：先声明（在按钮下面），双击切最大化 ────────────────────────
    MouseArea {
        anchors.left: parent.left
        anchors.top: parent.top
        anchors.bottom: parent.bottom
        anchors.right: parent.right
        anchors.rightMargin: 132
        acceptedButtons: Qt.LeftButton
        onPressed: bar.moveRequested()
        onDoubleClicked: bar.maximizeRequested()
    }

    // ── 左：徽记 + 名称 + 当前页 ──────────────────────────────────────────
    Row {
        anchors.left: parent.left
        anchors.leftMargin: 12
        anchors.verticalCenter: parent.verticalCenter
        spacing: 9

        WingMark {
            anchors.verticalCenter: parent.verticalCenter
            width: 19
            height: 19
            seed: 11
        }

        Text {
            anchors.verticalCenter: parent.verticalCenter
            text: bar.mark
            font.family: T.FONT_MONO
            font.pixelSize: 10
            font.letterSpacing: 2.2
            color: T.INK
        }

        Rectangle {
            anchors.verticalCenter: parent.verticalCenter
            width: 1
            height: 13
            color: "#2622282b"
        }

        Text {
            anchors.verticalCenter: parent.verticalCenter
            text: bar.subtitle
            font.family: T.FONT_SANS
            font.pixelSize: 11
            color: T.MUTED
        }

        Text {
            anchors.verticalCenter: parent.verticalCenter
            text: bar.pageIndex + " · " + bar.pageLabel
            font.family: T.FONT_MONO
            font.pixelSize: 10
            font.letterSpacing: 1.2
            color: T.COBALT
        }
    }

    // ── 右：引语入口 + 状态灯 + 状态文字 + 窗口按钮 ───────────────────────
    Row {
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        spacing: 12

        // 引语模块的入口：一个小方章，点开就是题词卡片（上一条 / 下一条 / 收藏）
        Rectangle {
            id: quoteButton

            anchors.verticalCenter: parent.verticalCenter
            width: 46
            height: 20
            color: quoteHover.hovered ? T.HOVER_VEIL : "transparent"
            border.width: T.HAIR
            border.color: bar.quotesOpen ? T.COBALT : T.LINE

            Behavior on color { ColorAnimation { duration: T.DUR_HOVER } }

            Text {
                anchors.centerIn: parent
                text: "题词"
                font.family: T.FONT_SANS
                font.pixelSize: 10
                font.letterSpacing: 1.2
                color: bar.quotesOpen ? T.COBALT : T.MUTED
            }

            HoverHandler { id: quoteHover; cursorShape: Qt.PointingHandCursor }

            MouseArea {
                anchors.fill: parent
                onClicked: bar.quotesRequested()
            }
        }

        Item {
            anchors.verticalCenter: parent.verticalCenter
            width: 12
            height: 12

            // 呼吸的外圈：连上后端时每 2.3 秒扩散一
Rectangle {
                anchors.centerIn: parent
                width: 6
                height: 6
                radius: 3
                color: "transparent"
                border.width: 1
                border.color: bar.backendReady ? T.GOOD : T.WARN
                opacity: 0
                scale: 1

                SequentialAnimation on scale {
                    running: bar.backendReady
                    loops: Animation.Infinite
                    PauseAnimation { duration: 1400 }
                    NumberAnimation { from: 1.0; to: 2.6; duration: 900; easing.type: Easing.OutCubic }
                }

                SequentialAnimation on opacity {
                    running: bar.backendReady
                    loops: Animation.Infinite
                    PauseAnimation { duration: 1400 }
                    NumberAnimation { from: 0.55; to: 0.0; duration: 900; easing.type: Easing.OutCubic }
                }
            }

            Rectangle {
                anchors.centerIn: parent
                width: 6
                height: 6
                radius: 3
                color: bar.backendReady ? T.GOOD : T.WARN
            }
        }

        Text {
            anchors.verticalCenter: parent.verticalCenter
            text: bar.statusText
            font.family: T.FONT_MONO
            font.pixelSize: 10
            color: bar.backendReady ? T.GOOD : T.WARN
        }

        Text {
            anchors.verticalCenter: parent.verticalCenter
            visible: bar.metricsText.length > 0
            text: bar.metricsText
            font.family: T.FONT_MONO
            font.pixelSize: 10
            color: T.MUTED
        }

        Text {
            anchors.verticalCenter: parent.verticalCenter
            visible: bar.errorText.length > 0
            text: bar.errorText
            font.family: T.FONT_MONO
            font.pixelSize: 10
            color: T.BAD
        }

        Rectangle {
            anchors.verticalCenter: parent.verticalCenter
            width: 1
            height: 16
            color: "#2222282b"
        }

        Row {
            anchors.verticalCenter: parent.verticalCenter
            spacing: 0

            Repeater {
                model: ["min", "max", "close"]

                delegate: Rectangle {
                    id: btn
                    width: 40
                    height: bar.height
                    color: "transparent"

                    readonly property string kind: modelData
                    readonly property bool danger: kind === "close"
                    property bool hot: false

                    Rectangle {
                        anchors.fill: parent
                        color: btn.hot ? (btn.danger ? T.BAD : T.HOVER_VEIL) : "transparent"
                        Behavior on color { ColorAnimation { duration: T.DUR_HOVER } }
                    }

                    // 最小化：一条横
Rectangle {
                        anchors.centerIn: parent
                        visible: btn.kind === "min"
                        width: 10
                        height: 1
                        color: T.INK
                    }

                    // 最大化 / 还原用一个方框图标；还原态左前方压出一块"底纸"
                    Item {
                        anchors.centerIn: parent
                        visible: btn.kind === "max"
                        width: 11
                        height: 11

                        Rectangle {
                            x: bar.maximized ? 2 : 0
                            y: bar.maximized ? 0 : 2
                            width: 9
                            height: 9
                            color: "transparent"
                            border.width: 1
                            border.color: T.INK
                        }

                        Rectangle {
                            visible: bar.maximized
                            x: 0
                            y: 2
                            width: 8
                            height: 8
                            color: T.FRAME_TOP
                            border.width: 1
                            border.color: T.INK
                        }
                    }

                    // 关闭：两笔交
Item {
                        anchors.centerIn: parent
                        visible: btn.kind === "close"
                        width: 11
                        height: 11

                        Rectangle {
                            anchors.centerIn: parent
                            width: 11
                            height: 1
                            rotation: 45
                            color: btn.hot && btn.danger ? "#ffffff" : T.INK
                        }

                        Rectangle {
                            anchors.centerIn: parent
                            width: 11
                            height: 1
                            rotation: -45
                            color: btn.hot && btn.danger ? "#ffffff" : T.INK
                        }
                    }

                    MouseArea {
                        anchors.fill: parent
                        hoverEnabled: true
                        onEntered: btn.hot = true
                        onExited: btn.hot = false
                        onClicked: {
                            if (btn.kind === "min")
                                bar.minimizeRequested()
                            else if (btn.kind === "max")
                                bar.maximizeRequested()
                            else
                                bar.closeRequested()
                        }
                    }
                }
            }
        }
    }
}
