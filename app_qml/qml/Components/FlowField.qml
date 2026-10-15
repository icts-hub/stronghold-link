import QtQuick 2.15

import "../theme.js" as T
import "../plate/sketch.js" as SK

// 流动背景层。
//
// 目标：让整张纸看起来是"活的" —— 网点在缓慢平移、细流曲线在游走、一道光扫过纸面、
// 几枚星点在明灭。风格上不引新的语汇，全部是参考项目里已有的东西（半调网点、细线、
// 笔触、星点、扫光），只是让它们动起来。
//
// 两个刻意的工程决定：
//
// 1. **不逐帧重画。** 每个元素都是"画一次、之后只改 x / rotation / opacity"。
//    Qt 只做图层合成，JS 侧一帧都不跑；整层只有一个 Timer 在推进时钟。
//    逐帧 requestPaint 一个 1440x900 的 Canvas 会白烧一个核，而这个界面还背着
//    100 MiB 的内存门槛，不值得。
// 2. **只有一根时钟。** 所有元素的位置都由 `clock`（0~1 循环）算出来，所以：
//    - 同一个 clock 每次渲染结果完全一致（截图可复现）；
//    - 验收时给 `--flow-phase 0.35` 就能把动画钉在某一刻，拍到确定的画面；
//    - 最小化 / 隐藏时把 `active` 置假，时钟停住，画面停在当前相位而不是跳回 0。
//
// 写法上刻意保守（这一层把进程搞崩过一次，0xC0000005）：
//   - 不用 `required property`，delegate 里用普通属性接 Repeater 注入的 modelData/index；
//   - 不用属性值源动画（`NumberAnimation on clock` 那种），改成 Timer 里显式赋值；
//   - 每个 delegate 里的 Canvas 只在自己的几何或时钟变化时才重画。
//
// 动效档位（设置页那个"装饰动效"）：
//   full    完整：网点 + 细流 + 扫光 + 星点，全部动
//   normal  标准：去掉扫光，流速减半
//   minimal 最低：完全静止（时钟不跑，画面停在 clock=0）
Item {
    id: flow

    property bool active: true          // 窗口可见且未最小化
    property string tier: "full"        // full / normal / minimal
    property real clock: 0              // 0~1 循环；所有元素由它算位置
    property real lockedPhase: -1       // >=0 时钉死在这一相位（验收截图用）
    property int seed: 4242
    // 组成部分位掩码（1 网点带 / 2 细流 / 4 扫光 / 8 星点）—— 排查崩溃用，默认全开。
    property int parts: 15

    property color ink: T.INK
    property color accentColor: T.ACCENT

    readonly property bool moving: active && tier !== "minimal" && lockedPhase < 0

    // 时钟：6 分钟走一圈（"标准"档 12 分钟）。慢是故意的 —— 这是纸在呼吸，不是进度条。
    Timer {
        interval: 40
        repeat: true
        running: flow.moving
        onTriggered: {
            var step = (flow.tier === "normal" ? 0.00006 : 0.00012) * (40 / 1000) * 100
            flow.clock = (flow.clock + step) % 1.0
        }
    }

    Component.onCompleted: if (lockedPhase >= 0) clock = lockedPhase

    // ── 一、网点漂移：三条带子画在**同一张** Canvas 上，整张一起平移 ──────────
    // 为什么合并：内存实测（场景⑦的逐部件归因，见 QML_QA_REPORT.md）显示
    // **每个 Canvas 元素本身就要几 MiB**（纹理 + CPU 侧后备缓冲 + 独立的 JS 上下文），
    // 三条带子各自一个 Canvas 时，光是这一个部件就多花约 24 MiB。
    // 合并成一张之后仍然保留三档网点（尺寸/间距/透明度不同），只是视差速度统一了 ——
    // 这是一个 4.5% 透明度的纸纹，看不出差别。
    //
    // 另外两处也是为内存做的：
    //   • 透明度烘进绘制（`ctx.globalAlpha`），**不再用父项 `opacity`** ——
    //     父项带非 1 的 opacity 会让 Qt 给整棵子树单独开一层离屏纹理；
    //   • 关掉 `antialiasing`：1 px 的点不需要抗锯齿，而 1680x900 的渲染目标开抗锯齿
    //     在一些后端上会走多重采样，显存按倍数涨。
    Item {
        id: bandLayer

        visible: (flow.parts & 1) !== 0
        width: flow.width + 240
        height: flow.height
        // 取模 → 走到头无缝接回
        x: flow.width + 60 - (flow.clock % 1) * (flow.width + 300)

        Canvas {
            anchors.fill: parent
            renderStrategy: Canvas.Cooperative
            antialiasing: false
            // 内容只跟尺寸和种子有关，不跟 clock 有关 —— 所以一辈子只画一次。
            onPaint: {
                var ctx = getContext("2d")
                ctx.reset()
                var w = width, h = height
                if (w <= 4 || h <= 4) return
                var bands = [{ sp: 1.00, off: 0.00, alpha: 0.045, rows: 5, size: 1.15, gap: 26 },
                             { sp: 0.62, off: 0.37, alpha: 0.032, rows: 3, size: 0.95, gap: 34 },
                             { sp: 1.35, off: 0.72, alpha: 0.026, rows: 2, size: 1.45, gap: 52 }]
                for (var bi = 0; bi < bands.length; bi++) {
                    var m = bands[bi]
                    var r = SK.rng(flow.seed + bi * 977)
                    var rowH = h / (m.rows + 1)
                    ctx.globalAlpha = flow.tier === "minimal" ? m.alpha * 0.6 : m.alpha
                    ctx.fillStyle = flow.ink
                    for (var row = 1; row <= m.rows; row++) {
                        var y = row * rowH + (r() - 0.5) * 18
                        var gap = m.gap * (0.9 + r() * 0.25)
                        var x0 = -40 + r() * gap
                        for (var x = x0; x < w + 40; x += gap) {
                            var jx = x + (r() - 0.5) * 4
                            var jy = y + (r() - 0.5) * 5
                            ctx.beginPath()
                            ctx.arc(jx, jy, m.size * (0.75 + r() * 0.6), 0, SK.TAU)
                            ctx.fill()
                        }
                    }
                }
                ctx.globalAlpha = 1
            }
        }
    }

    // ── 二、细流曲线：三条长曲线画在**同一张** Canvas 上（理由同上）──────────
    Item {
        id: streamLayer

        visible: (flow.parts & 2) !== 0
        width: flow.width + 400
        height: flow.height
        x: flow.width + 100 - (flow.clock % 1) * (flow.width + 300)

        Canvas {
            anchors.fill: parent
            renderStrategy: Canvas.Cooperative
            antialiasing: true          // 细线要抗锯齿，否则会断成虚线
            onPaint: {
                var ctx = getContext("2d")
                ctx.reset()
                var w = width, h = height
                if (w <= 4 || h <= 4) return
                var streams = [{ y: 0.22, alpha: 0.10, sw: 1.0, col: T.ACCENT },
                               { y: 0.55, alpha: 0.075, sw: 1.4, col: T.COBALT },
                               { y: 0.78, alpha: 0.065, sw: 0.9, col: T.INK }]
                ctx.lineCap = "round"
                for (var si = 0; si < streams.length; si++) {
                    var m = streams[si]
                    var r = SK.rng(flow.seed + 3001 + si * 613)
                    ctx.globalAlpha = flow.tier === "minimal" ? m.alpha * 0.5 : m.alpha
                    ctx.strokeStyle = m.col
                    ctx.lineWidth = m.sw
                    var cy = h * m.y
                    // 画一段很扁的大圆弧 → 看上去就是一条横着游走的细流
                    var pts = SK.arcPts(w * 0.5, cy + h * 3.1, h * 3.0, -0.4, 0.4, r, 2.2)
                    SK.strokeCurve(ctx, pts)
                    ctx.stroke()
                }
                ctx.globalAlpha = 1
            }
        }
    }

    // ── 三、扫光：两道极淡的光带斜着扫过纸面 ──────────────────────────────
    // 用 Rectangle + 渐变而不是 Canvas：边缘天然是软的，合成成本几乎为零。
    Repeater {
        model: (flow.parts & 4) !== 0 && flow.tier === "full"
               ? [{ sp: 0.45, off: 0.05, alpha: 0.10, wRatio: 0.42 },
                  { sp: 0.30, off: 0.62, alpha: 0.07, wRatio: 0.30 }]
               : []

        delegate: Rectangle {
            id: sweep
            property var sweepData: modelData

            width: flow.width * sweepData.wRatio
            height: flow.height * 2.2
            y: -flow.height * 0.6
            rotation: -18
            transformOrigin: Item.Center
            opacity: sweepData.alpha
            gradient: Gradient {
                orientation: Gradient.Horizontal
                GradientStop { position: 0.0; color: "transparent" }
                GradientStop { position: 0.5; color: "#ffffff" }
                GradientStop { position: 1.0; color: "transparent" }
            }
            x: flow.width + 200 - ((flow.clock * sweepData.sp + sweepData.off) % 1) * (flow.width * 1.9)
        }
    }

    // ── 四、星点：几枚四角星在明灭（参考项目里叫 twinkle）────────────────
    // 用两个交叉的旋转方块拼出四角星，而不是再开 5 个 Canvas ——
    // 实测每多一个 Canvas 就要多几 MiB（见第一部分注释），这里 5 枚星点换成纯几何，
    // 一个纹理都不占。
    Repeater {
        model: (flow.parts & 8) !== 0
               ? [{ x: 0.08, y: 0.30, s: 15 },
                  { x: 0.26, y: 0.72, s: 10 },
                  { x: 0.62, y: 0.16, s: 12 },
                  { x: 0.80, y: 0.60, s: 17 },
                  { x: 0.92, y: 0.36, s: 9 }]
               : []

        delegate: Item {
            id: twinkle
            property var twinkleData: modelData
            property int twinkleIndex: index

            width: twinkleData.s * 2.4
            height: width
            x: flow.width * twinkleData.x
            y: flow.height * twinkleData.y
            // 相位错开，免得五枚一起亮
            opacity: flow.tier === "minimal"
                     ? 0.25
                     : 0.25 + 0.55 * Math.abs(Math.sin(Math.PI * (flow.clock * 3 + twinkleIndex * 0.17)))

            // 竖条 + 横条 = 四角星（两条都从中心向两端收细，靠 scale 压成梭形）
            Rectangle {
                anchors.centerIn: parent
                width: parent.width * 0.16
                height: parent.height * 0.92
                color: twinkle.twinkleIndex % 2 === 0 ? flow.accentColor : flow.ink
            }
            Rectangle {
                anchors.centerIn: parent
                width: parent.width * 0.92
                height: parent.height * 0.16
                color: twinkle.twinkleIndex % 2 === 0 ? flow.accentColor : flow.ink
            }
        }
    }
}
