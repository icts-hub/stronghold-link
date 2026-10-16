import QtQuick
import "../theme.js" as T

// 题词：标题栏里的一行字。
//
// 不占卡片、不遮版面 —— 用户要的是"找一个角落塞一句话"。所以它就是标题栏空白处的一行：
// 句子用衬线体，出处用等宽小字；上一条 / 下一条 / 收藏 三项只在鼠标压上来时才浮出来，
// 平时整行只有句子本身（存在感压到最低）。自动播放 12 秒一条，指针压在上面就暂停。
//
// 排版注意：Row 的孩子不许用锚点（Positioner 会忽略纵向锚点），所以每个孩子都是
// 定高的 Item，真正的内容在 Item 内部居中 —— 这样基线才能对齐。
Item {
    id: line

    // 当前这条（外壳从"本地兜底 + 联网抓回来"的池子里取），以及收藏的 key 列表
    property var item: ({ key: "", kind: "", who: "", work: "", text: "" })
    property var favorites: []
    property bool playing: true
    property int autoMs: 12000
    // hover 淡入：0 只看得见句子，1 连控制项一起
    property real reveal: 0

    readonly property bool starred: item.key !== undefined && item.key.length > 0
                                     && favorites.indexOf(item.key) >= 0

    signal step(int delta)
    signal star()

    implicitHeight: 18

    Behavior on reveal { NumberAnimation { duration: T.DUR_HOVER; easing.type: Easing.OutCubic } }

    Component.onCompleted: line.reveal = 0

    HoverHandler {
        id: hover

        onHoveredChanged: line.reveal = hovered ? 1 : 0
    }

    Row {
        id: row

        anchors.left: parent.left
        anchors.verticalCenter: parent.verticalCenter
        spacing: 8

        // ── 控制项：平时完全透明，压上来才出现 ───────────────────────
        Item {
            id: ctrls

            width: inner.width
            height: line.height
            opacity: line.reveal

            Row {
                id: inner

                anchors.verticalCenter: parent.verticalCenter
                spacing: 7

                Repeater {
                    model: [
                        { key: "prev", text: "‹" },
                        { key: "next", text: "›" },
                        { key: "star", text: line.starred ? "★" : "☆" }
                    ]

                    delegate: Item {
                        required property var modelData

                        width: Math.max(10, glyph.implicitWidth)
                        height: 18

                        Text {
                            id: glyph

                            anchors.centerIn: parent
                            text: modelData.text
                            font.family: T.FONT_MONO
                            font.pixelSize: 11
                            color: (modelData.key === "star" && line.starred) ? T.COBALT
                                                                              : (hit.hovered ? T.INK : T.MUTED)

                            Behavior on color { ColorAnimation { duration: T.DUR_PRESS } }
                        }

                        HoverHandler { id: hit; cursorShape: Qt.PointingHandCursor }

                        MouseArea {
                            anchors.fill: parent
                            onClicked: {
                                if (modelData.key === "star")
                                    line.star()
                                else
                                    line.step(modelData.key === "prev" ? -1 : 1)
                            }
                        }
                    }
                }
            }
        }

        // ── 句子本体：一行，不换行，太长从尾部截断 ───────────────────
        Item {
            id: bodyBox

            width: Math.max(0, line.width - ctrls.width - row.spacing * 2 - signBox.width - 14)
            height: line.height

            Text {
                id: body

                anchors.left: parent.left
                anchors.verticalCenter: parent.verticalCenter
                width: parent.width
                text: "「" + (line.item.text !== undefined ? line.item.text : "") + "」"
                font.family: T.FONT_DISPLAY
                font.pixelSize: 13
                color: T.INK
                opacity: 0.82 * (0.3 + 0.7 * line.showT)
                elide: Text.ElideRight
            }
        }

        // ── 出处 ────────────────────────────────────────────────────
        Item {
            id: signBox

            width: Math.min(sign.implicitWidth, Math.max(0, line.width * 0.34))
            height: line.height

            Text {
                id: sign

                anchors.left: parent.left
                anchors.verticalCenter: parent.verticalCenter
                width: parent.width
                text: "—— " + (line.item.who !== undefined ? line.item.who : "")
                      + "《" + (line.item.work !== undefined ? line.item.work : "") + "》"
                font.family: T.FONT_MONO
                font.pixelSize: 9
                color: T.MUTED
                opacity: 0.3 + 0.7 * line.showT
                elide: Text.ElideRight
            }
        }
    }

    // 换条目时只做一次极短的淡入：这是标题栏上的一行字，不该有动效表演。
    // 注意淡入只作用在文字上，根节点的 opacity 恒为 1（否则整行会被一起压淡）。
    property real showT: 1

    onItemChanged: {
        showT = 0
        rise.restart()
    }

    NumberAnimation {
        id: rise

        target: line
        property: "showT"
        from: 0
        to: 1
        duration: 320
        easing.type: Easing.OutCubic
    }

    Timer {
        interval: line.autoMs
        running: line.playing && line.visible && !hover.hovered
        repeat: true
        onTriggered: line.step(1)
    }
}
