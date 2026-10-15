import QtQuick 2.15

import "../theme.js" as T
import "../plate/sketch.js" as SK

// 翼形徽记（参考项目左上角那个带翼的标记）。
//
// 参考图里的徽记是"一根中轴 + 两侧各三片后掠的翼羽 + 下方一个小圆"，
// 全部由几何线条构成。这里按同样的构成用 Canvas 重画：不做位图、不加字体，
// 缩放时线条跟着变，任意尺寸都不糊。
Item {
    id: mark

    property color ink: T.INK
    property color accent: T.ACCENT
    property int seed: 7

    implicitWidth: 46
    implicitHeight: 46

    Canvas {
        id: canvas
        anchors.fill: parent
        renderStrategy: Canvas.Cooperative
        antialiasing: true

        onPaint: {
            var ctx = getContext("2d")
            ctx.reset()
            var w = width, h = height
            if (w <= 2 || h <= 2) return

            var r = SK.rng(mark.seed)
            var cx = w * 0.5
            var base = h * 0.62          // 翼根的高度
            var span = w * 0.46          // 单侧翼展

            ctx.lineCap = "round"
            ctx.lineJoin = "round"

            // 中轴：一根细长竖线，顶端一点
            ctx.strokeStyle = mark.ink
            ctx.lineWidth = Math.max(1, w * 0.028)
            ctx.beginPath()
            ctx.moveTo(cx, h * 0.16)
            ctx.lineTo(cx, h * 0.78)
            ctx.stroke()

            // 两侧各三片翼羽：从翼根向外后掠，越外面的越短、越平
            for (var side = -1; side <= 1; side += 2) {
                for (var i = 0; i < 3; i++) {
                    var t = i / 2
                    var len = span * (1.0 - t * 0.34)
                    var drop = h * (0.06 + t * 0.10)
                    var lift = h * (0.16 + t * 0.10)
                    var x0 = cx + side * w * 0.06
                    var y0 = base - lift * 0.5
                    var x1 = cx + side * len
                    var y1 = y0 + drop
                    // 羽片用二次贝塞尔画出弧度（中段外凸），跟参考的笔触一致
                    var cxp = cx + side * len * 0.55
                    var cyp = y0 + drop * 0.15 - h * 0.04
                    ctx.beginPath()
                    ctx.moveTo(x0, y0)
                    ctx.quadraticCurveTo(cxp, cyp, x1, y1)
                    ctx.strokeStyle = i === 1 ? mark.accent : mark.ink
                    ctx.lineWidth = Math.max(1, w * (i === 1 ? 0.030 : 0.024))
                    ctx.globalAlpha = 1.0 - t * 0.25
                    ctx.stroke()
                }
            }
            ctx.globalAlpha = 1.0

            // 下方小圆（参考项目里徽记底部的圆点）
            ctx.beginPath()
            ctx.arc(cx, h * 0.84, Math.max(1.2, w * 0.045), 0, SK.TAU)
            ctx.fillStyle = mark.accent
            ctx.fill()

            // 一点点手工感：外缘极淡的抖动弧，避免看起来像图标字体
            ctx.globalAlpha = 0.35
            ctx.strokeStyle = mark.ink
            ctx.lineWidth = Math.max(0.8, w * 0.012)
            var wob = SK.wobble(r)
            ctx.beginPath()
            var pts = SK.arcPts(cx, base + h * 0.02, span * 0.92, Math.PI * 1.08, Math.PI * 1.92, r, 1.2)
            SK.strokeCurve(ctx, pts)
            ctx.stroke()
            ctx.globalAlpha = 1.0
        }
    }
}
