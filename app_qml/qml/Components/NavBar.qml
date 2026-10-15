import QtQuick
import "../theme.js" as T

// 一级导航：只有三项（会话 / 好友 / 设置）。每项带编号、标签与一条手绘尺线，
// 选中项用钴蓝 + 锁定圆环标记。
Item {
    id: nav

    property var items: []
    property string current: ""
    signal selected(string key)

    implicitHeight: 66

    Row {
        id: row
        anchors.left: parent.left
        anchors.right: parent.right
        spacing: 22

        Repeater {
            model: nav.items
            delegate: Item {
                id: entry
                width: (row.width - row.spacing * (nav.items.length - 1)) / Math.max(1, nav.items.length)
                height: nav.height

                readonly property bool on: modelData.key === nav.current
                readonly property bool hot: hover.containsMouse || on

                Text {
                    id: numTxt
                    text: modelData.index
                    font.family: T.FONT_MONO
                    font.pixelSize: 10
                    color: entry.on ? T.COBALT : T.MUTED
                    anchors.left: parent.left
                    anchors.top: parent.top
                    anchors.topMargin: 8
                }

                Text {
                    id: nameTxt
                    text: modelData.label
                    font.family: T.FONT_DISPLAY
                    font.pixelSize: entry.on ? 19 : 18
                    color: entry.hot ? (entry.on ? T.COBALT : T.INK) : T.MUTED
                    anchors.left: numTxt.right
                    anchors.leftMargin: 8
                    anchors.verticalCenter: numTxt.verticalCenter
                }

                Text {
                    text: modelData.caption === undefined ? "" : modelData.caption
                    font.family: T.FONT_MONO
                    font.pixelSize: 10
                    color: T.MUTED
                    opacity: entry.hot ? 0.95 : 0.6
                    anchors.left: parent.left
                    anchors.top: nameTxt.bottom
                    anchors.topMargin: 2
                    elide: Text.ElideRight
                    width: parent.width - 4
                }

                SketchRule {
                    id: under
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.bottom: parent.bottom
                    anchors.bottomMargin: 6
                    height: 6
                    x1: 0
                    y1: 3
                    x2: under.width
                    y2: 3
                    seed: T.hashSeed("nav" + modelData.key)
                    stroke: entry.on ? T.COBALT : T.LINE
                    weight: entry.on ? 1.6 : 1
                    doubleStroke: entry.on
                }

                SketchRing {
                    visible: entry.on
                    radius: 5
                    weight: 1.4
                    doubleStroke: false
                    ticks: false
                    stroke: T.COBALT
                    seed: T.hashSeed("navring" + modelData.key)
                    width: 22
                    height: 22
                    anchors.right: parent.right
                    anchors.rightMargin: 2
                    anchors.top: parent.top
                    anchors.topMargin: 2
                }

                MouseArea {
                    id: hover
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: nav.selected(modelData.key)
                }
            }
        }
    }
}
