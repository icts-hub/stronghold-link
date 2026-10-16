import QtQuick
import "../theme.js" as T
import "../plate/sketch.js" as SK
import "../plate/people.js" as PEOPLE

// 好友页图版：参照参考项目 personnelPlate 的构图 —— 中心一座圆形徽记（内嵌档案照），
// 四周散布人像版位并以细线连成关系网，外圈是自转的图注轨道，角落里压着小窗、单据、
// 信封与方块碎屑，四周还有纵向量尺、套准标记与裁切角标。
//
// 与 HeroPlate 同一套做法：全部靠 Canvas 几何绘制，不引入任何位图或字体文件。
Item {
    id: root

    // 切页入场标记：外壳（Main.qml 的 revealPage）依次把 revealed 置 false → true
    property bool revealed: true

    opacity: revealed ? 1 : 0
    Behavior on opacity { NumberAnimation { duration: T.DUR_ENTER; easing.type: Easing.OutCubic } }
    transform: Translate {
        x: revealed ? 0 : -T.LIFT
        Behavior on x { NumberAnimation { duration: T.DUR_ENTER + 60; easing.type: Easing.OutQuint } }
    }

    property int seed: 97
    property string legend: "FRIENDS · STEAM LOBBY · PRESENCE · STRONGHOLD LINK · "
    property string mark: "F"
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
            PEOPLE.draw(ctx, width, height, SK, root.seed, root.legend, root.mark)
        }
    }

    onWidthChanged: if (active) canvas.requestPaint()
    onHeightChanged: if (active) canvas.requestPaint()
    onActiveChanged: if (active) canvas.requestPaint()
    Component.onCompleted: if (active) canvas.requestPaint()
}
