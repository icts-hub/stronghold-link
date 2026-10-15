import QtQuick
import "../theme.js" as T
import "../plate/sketch.js" as SK
import "../plate/hero.js" as HERO

// 主视觉图版。整块 1440x900 的作图区（与参考项目同一套 1000x1000 坐标，等比缩放居中），
// 逐层复刻：远景巨字与扫笔 → 背景大圆与光芒 → 40 根锥形光芒与同心环 → 圆盘与半调网点
// → 弧冠与印章 → 界面碎片 → 近景光刃。
//
// 为什么用 Canvas 而不是一堆 Rectangle/Image：这套图形语汇的核心是"每条线都略有偏差"
// （圆环越过起点、标线拱起、笔触中段鼓起），用声明式图元表达不出来，而且 App 里一张位图
// 都不引入 —— 全部是几何绘制，随包分发没有素材授权问题。
Item {
    id: root

    property int seed: 61
    property string legend: "SESSION · FRIENDS · SETTING · STRONGHOLD LINK · FAITH · ORDER · FREEDOM · "
    property string mark: "S"
    // 页面切到别处时可以停画（省 CPU）：active 为 false 就不重绘。
    property bool active: true

    // 画布随尺寸走。opaque:false 让背景透出纸色，由外层决定底色。
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
}
