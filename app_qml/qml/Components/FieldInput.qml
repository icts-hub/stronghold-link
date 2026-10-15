import QtQuick
import "../theme.js" as T

// 输入框：等宽输入、下划线式边框、聚焦时出现钴蓝刻度；支持多行（端口规则用）。
Item {
    id: field

    property string label: ""
    property string placeholder: ""
    property alias text: editor.text
    property alias editor: editor
    property bool multiline: false
    property bool mono: true
    property int maxLength: 0
    property bool readOnly: false
    signal accepted()

    implicitHeight: (label.length > 0 ? 20 : 0) + (multiline ? 74 : 32)

    Text {
        id: lab
        text: field.label
        visible: field.label.length > 0
        font.family: T.FONT_MONO
        font.pixelSize: 10
        color: T.MUTED
        anchors.left: parent.left
        anchors.top: parent.top
    }

    Rectangle {
        anchors.fill: editor
        anchors.margins: -4
        color: T.PAPER
        border.width: 1
        border.color: editor.activeFocus ? T.COBALT : T.LINE
        radius: T.RADIUS
    }

    Text {
        anchors.fill: editor
        anchors.margins: 4
        text: field.placeholder
        visible: editor.text.length === 0 && !editor.activeFocus
        color: T.MUTED
        opacity: 0.75
        font.family: T.FONT_MONO
        font.pixelSize: 12
        elide: Text.ElideRight
        wrapMode: field.multiline ? Text.WordWrap : Text.NoWrap
    }

    TextEdit {
        id: editor
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        height: field.multiline ? 74 : 32
        leftPadding: 4
        topPadding: 6
        textFormat: TextEdit.PlainText
        color: field.readOnly ? T.MUTED : T.INK
        selectionColor: T.COBALT
        selectedTextColor: T.PAPER
        readOnly: field.readOnly
        selectByMouse: true
        wrapMode: field.multiline ? TextEdit.WrapAnywhere : TextEdit.NoWrap
        clip: true
        font.family: field.mono ? T.FONT_MONO : T.FONT_SANS
        font.pixelSize: 12
        onTextChanged: {
            if (field.maxLength > 0 && text.length > field.maxLength)
                text = text.slice(0, field.maxLength)
        }
        Keys.onReturnPressed: {
            if (!field.multiline)
                field.accepted()
        }
    }
}
