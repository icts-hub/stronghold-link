import QtQuick
import "../theme.js" as T
import "../plate/sketch.js" as SK
import "../plate/hero.js" as HERO

// 主视觉图版。整块 1440x900 的作图区（与参考项目同一套 1000x1000 坐标，等比缩放居中）
// 逐层复刻：远景巨字与扫笔 → 背景大圆与光芒 → 40 根锥形光芒与同心环 → 圆盘与半调网
// → 弧冠与印章 → 界面碎片 → 近景光刃
//
// 为什么用 Canvas 而不是一堆 Rectangle/Image：这套图形语汇的核心是"每条线都略有偏差"
// （圆环越过起点、标线拱起、笔触中段鼓起），用声明式图元表达不出来，而且 App 里一张位
// 都不引入 —— 全部是几何绘制，随包分发没有素材授权问题
Item {
    id: root

    property int seed: 61
    property string legend: "SESSION · FRIENDS · SETTING · STRONGHOLD LINK · FAITH · ORDER · FREEDOM · "
    property string mark: "S"
    // 页面切到别处时可以停画（省 CPU）：active 为 false 就不重绘
property bool active: true

    // 切页入场标记：外壳（Main.qml 的 revealPage）依次把 revealed 置 false 再置 true
    property bool revealed: true

    opacity: revealed ? 1 : 0
    Behavior on opacity { NumberAnimation { duration: T.DUR_ENTER; easing.type: Easing.OutCubic } }
    transform: Translate {
        x: revealed ? 0 : -T.LIFT
        Behavior on x { NumberAnimation { duration: T.DUR_ENTER + 60; easing.type: Easing.OutQuint } }
    }

    // 画布随尺寸走。opaque:false 让背景透出纸色，由外层决定底色
Canvas {
        id: canvas
        anchors.fill: parent
        renderStrategy: Canvas.Cooperative
        antialiasing: true

        onPaint: {
            var ctx = getContext("2d")
            ctx.reset()
            ctx.clearRect(0, 0, width, height)
            HERO.draw(ctx, width, height, SK, root.seed, root.legend, root.mark)
        }
    }

    onWidthChanged: if (active) canvas.requestPaint()
    onHeightChanged: if (active) canvas.requestPaint()
    onActiveChanged: if (active) canvas.requestPaint()
    Component.onCompleted: if (active) canvas.requestPaint()

    // ── 常驻动效：两圈缓慢自转的刻度环 + 一道雷达扫线 ──────────────────────
    // 全部走 item 旋转（不是重绘画布），所以一直转着也不额外吃绘制开销；
// 版面上这层"一直在动的东西"就是用户要的流动感。
readonly property real ringSize: Math.min(width, height) * 0.82
    property bool ambient: true

    Item {
        id: ticks

        anchors.centerIn: parent
        width: root.ringSize
        height: root.ringSize
        opacity: (root.active && root.ambient) ? 0.55 : 0
        Behavior on opacity { NumberAnimation { duration: T.DUR_ENTER } }

        RotationAnimation on rotation {
            from: 0
            to: 360
            duration: 96000
            loops: Animation.Infinite
            running: root.active && root.ambient
        }

        Repeater {
            model: 36

            delegate: Rectangle {
                required property int index

                readonly property real ang: index / 36 * Math.PI * 2

                width: index % 3 === 0 ? 11 : 6
                height: 1
                color: index % 3 === 0 ? T.INK : T.LINE
                opacity: index % 3 === 0 ? 0.55 : 0.35
                x: ticks.width / 2 + Math.cos(ang) * (ticks.width / 2 - 5) - width / 2
                y: ticks.height / 2 + Math.sin(ang) * (ticks.height / 2 - 5) - height / 2
                rotation: index / 36 * 360
            }
        }
    }

    Item {
        id: radar

        anchors.centerIn: parent
        width: root.ringSize * 0.94
        height: width
        opacity: (root.active && root.ambient) ? 0.75 : 0
        Behavior on opacity { NumberAnimation { duration: T.DUR_ENTER } }

        RotationAnimation on rotation {
            from: 0
            to: 360
            duration: 24000
            loops: Animation.Infinite
            running: root.active && root.ambient
        }

        // 从圆心指向外的一道渐隐扫
Rectangle {
            x: radar.width / 2
            y: radar.height / 2 - 0.5
            width: radar.width / 2 - 8
            height: 1

            gradient: Gradient {
                orientation: Gradient.Horizontal
                GradientStop { position: 0.0; color: "#002a3fff" }
                GradientStop { position: 1.0; color: "#992a3fff" }
            }
        }

        Rectangle {
            anchors.centerIn: parent
            width: 5
            height: 5
            radius: 3
            color: T.HIGHLIGHT
            opacity: 0.45
        }
    }

    // 反向自转的第二圈：比刻度环更慢、更淡，两圈交叉转动时"活"的感觉最明显
    Item {
        anchors.centerIn: parent
        width: root.ringSize * 1.06
        height: width
        opacity: (root.active && root.ambient) ? 0.4 : 0
        Behavior on opacity { NumberAnimation { duration: T.DUR_ENTER } }

        RotationAnimation on rotation {
            from: 360
            to: 0
            duration: 150000
            loops: Animation.Infinite
            running: root.active && root.ambient
        }

        Rectangle {
            anchors.horizontalCenter: parent.horizontalCenter
            y: 0
            width: 40
            height: 1
            color: T.COBALT
            opacity: 0.5
        }

        Rectangle {
            anchors.horizontalCenter: parent.horizontalCenter
            anchors.bottom: parent.bottom
            width: 40
            height: 1
            color: T.COBALT
            opacity: 0.5
        }
    }

    // ── 常驻光扫：一道很淡的斜光每几秒掠过主视觉 ──────────────────────────
    // PV 里表现"被照亮"的方式就是让一束光扫过表面；这里只改 item 的 x，不重绘画布
Item {
        anchors.fill: parent
        clip: true
        opacity: (root.active && root.ambient) ? 1 : 0
        Behavior on opacity { NumberAnimation { duration: T.DUR_ENTER } }

        Rectangle {
            id: beam

            width: root.width * 0.20
            height: root.height * 1.8
            y: -root.height * 0.4
            rotation: -14
            opacity: 0.5

            gradient: Gradient {
                orientation: Gradient.Horizontal
                GradientStop { position: 0.0; color: "#00ffffff" }
                GradientStop { position: 0.5; color: "#8cffffff" }
                GradientStop { position: 1.0; color: "#00ffffff" }
            }

            SequentialAnimation on x {
                loops: Animation.Infinite
                running: root.active && root.ambient

                PauseAnimation { duration: 4600 }

                NumberAnimation {
                    from: -beam.width * 2.2
                    to: root.width + beam.width
                    duration: 2400
                    easing.type: Easing.InOutSine
                }
            }
        }
    }
}
