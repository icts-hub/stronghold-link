import QtQuick
import "../theme.js" as T

// 单选组：标签 + 一排等宽按键（连接方式、动效档位等用它）
Item {
    id: row

    property string label: ""
    property var choices: []      // [{ value, text, hint }]
    property string value: ""
    property string note: ""
    signal picked(string value)

    implicitHeight: (label.length > 0 ? 22 : 0) + keys.height + (note.length > 0 ? 18 : 0)

    Text {
        id: lab
        text: row.label
        visible: row.label.length > 0
        font.family: T.FONT_MONO
        font.pixelSize: 10
        color: T.MUTED
        anchors.left: parent.left
        anchors.top: parent.top
    }

    Flow {
        id: keys
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: lab.bottom
        anchors.topMargin: row.label.length > 0 ? 6 : 0
        spacing: 8

        Repeater {
            model: row.choices
            delegate: PlateButton {
                label: modelData.text
                hint: modelData.hint === undefined ? "" : modelData.hint
                primary: modelData.value === row.value
                enabled: modelData.disabled === undefined ? true : !modelData.disabled
                onClicked: row.picked(modelData.value)
            }
        }
    }

    Text {
        id: noteTxt
        text: row.note
        visible: row.note.length > 0
        font.family: T.FONT_MONO
        font.pixelSize: 10
        color: T.MUTED
        anchors.left: parent.left
        anchors.top: keys.bottom
        anchors.topMargin: 6
    }
}
