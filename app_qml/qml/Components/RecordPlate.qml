import QtQuick
import "../theme.js" as T
import "../plate/sketch.js" as SK
import "../plate/record.js" as RECORD

// 设置页图版：参照参考项目 recordPlate 的"工程图纸"构图 —— 细密字距网格打底、
// 右下角斜向扫色、四角裁切角标、边上的尺寸标注线、图纸中间的记录行、右上角大号
// 空心衬线编号，空隙里塞小窗、单据、条码与方块碎屑。
//
// 与 HeroPlate / ConstellationPlate 同一套做法：全靠 Canvas 几何绘制，不引入位图。
Item {
    id: root

    property int seed: 131
    property string legend: "SETTING · DOSSIER · DIAGNOSTICS · STRONGHOLD LINK · "
    property string mark: "03"
    property bool active: true

    Canvas {
        id: canvas
        anchors.fill: parent
        renderStrategy: Canvas.Cooperative
        antialiasing: true

        onPaint: {
            var ctx = getContext("2d")
            ctx.reset()
            ctx.clearRect(0, 0, width, height)
            RECORD.draw(ctx, width, height, SK, root.seed, root.legend, root.mark)
        }
    }

    onWidthChanged: if (active) canvas.requestPaint()
    onHeightChanged: if (active) canvas.requestPaint()
    onActiveChanged: if (active) canvas.requestPaint()
    Component.onCompleted: if (active) canvas.requestPaint()
}
