import QtQuick
import "../Motion"

// 描摹鸟群装饰层（纯装饰）：
// 把 assets/birds/bird-01..06.svg —— 从参考截图矢量化出来的**代码内资源** —— 按阵型反复实例化，
// 复现参考图那种"鸟群横贯画面、彼此叠压"的形态。不使用参考图的位图（那类素材不进发布包）。
//
// 约束（与其它装饰层一致）：
//   · enabled:false —— 不吃鼠标、不参与焦点、不介入命中测试；
//   · 宿主决定几何（anchors.fill），本体不改任何既有 Layout；
//   · 动效只有每只鸟 ±4px 的极慢漂移，且挂 MotionProfile.motionAllowed，失焦/最小化/减少动态即停。
Item {
    id: root
    objectName: "TracedFlock"

    property bool motionEnabled: true
    property bool reducedMotion: false
    property real flockOpacity: 0.55
    property real drift: 4          // 每只鸟的最大漂移（像素）
    property int count: 26

    enabled: false
    focus: false
    clip: true

    readonly property var sources: [
        "qrc:/qml/assets/birds/bird-01.svg",
        "qrc:/qml/assets/birds/bird-02.svg",
        "qrc:/qml/assets/birds/bird-03.svg",
        "qrc:/qml/assets/birds/bird-04.svg",
        "qrc:/qml/assets/birds/bird-05.svg",
        "qrc:/qml/assets/birds/bird-06.svg"
    ]
    // 归一化阵型：横贯画面、三股错落（不是一列），尺寸/角度各有差异
    readonly property var slots: {
        var out = []
        for (var i = 0; i < count; i++) {
            var g = i % 3                       // 三股
            var k = Math.floor(i / 3)
            out.push({
                x: 0.02 + (k % 9) * 0.108 + g * 0.028,
                y: 0.30 + g * 0.17 + ((k * 7) % 5) * 0.035,
                s: 0.13 + ((k * 3) % 5) * 0.022,
                a: -16 + ((k * 11) % 7) * 5
            })
        }
        return out
    }

    Repeater {
        model: root.slots

        delegate: Item {
            id: birdItem
            property real baseX: modelData.x * root.width - width / 2
            property real baseY: modelData.y * root.height - height / 2

            width: Math.max(40, modelData.s * root.width)
            height: width
            x: baseX
            y: baseY
            rotation: modelData.a
            opacity: root.flockOpacity
            transformOrigin: Item.Center

            Image {
                anchors.fill: parent
                source: root.sources[index % root.sources.length]
                fillMode: Image.PreserveAspectFit
                asynchronous: true
                cache: true
                smooth: true
            }

            // 极慢整体漂移：单只 ±drift，周期随索引错开 —— 看起来像一群鸟，而不是一张图在抖
            SequentialAnimation on x {
                running: root.motionEnabled && !root.reducedMotion && root.visible && birdItem.visible
                loops: Animation.Infinite
                NumberAnimation {
                    to: birdItem.baseX + root.drift
                    duration: 36000 + (index % 6) * 2400
                    easing.type: Easing.InOutSine
                }
                NumberAnimation {
                    to: birdItem.baseX
                    duration: 36000 + (index % 6) * 2400
                    easing.type: Easing.InOutSine
                }
            }
        }
    }
}