import QtQuick
import "../theme.js" as T

// 人员档案牌：编号 + 程序生成的几何印章头像 + 昵称 + 状态 + SteamID 缩写。
// 头像不是真实 Steam 头像（离线时为几何替代），界面上必须写清楚。
Item {
    id: card

    // 注意：这个序号标签**不能**叫 index。Repeater 委托里 `index` 是必填的模型属性，
    // 组件再声明同名的 index 就会和 FriendsPage 里的 `rowIndex: index` 构成绑定环
    // （Qt 会刷 "Binding loop detected for property rowIndex"）。故改名 indexLabel。
    property string indexLabel: "01"
    property string name: ""
    property string steamId: ""
    property string stateText: ""
    property color stateColor: T.MUTED
    property string detail: ""
    property bool invitable: false
    property bool hovered: false
    signal invite()

    implicitHeight: 74

    function sigilSeed() {
        return T.hashSeed((steamId && steamId.length > 0 ? steamId : name) + "|sigil")
    }

    Rectangle {
        anchors.fill: parent
        color: card.hovered ? Qt.rgba(0.23, 0.36, 0.76, 0.05) : "transparent"
        border.width: 1
        border.color: card.hovered ? T.COBALT : T.LINE_SOFT
        radius: T.RADIUS
    }

    Text {
        id: num
        text: card.indexLabel
        font.family: T.FONT_MONO
        font.pixelSize: 10
        color: T.MUTED
        anchors.left: parent.left
        anchors.leftMargin: 10
        anchors.top: parent.top
        anchors.topMargin: 10
    }

    // 几何印章头像（确定性：同一个 SteamID 永远同一图案）
    Canvas {
        renderTarget: Canvas.Image
        id: sigil
        width: 50
        height: 50
        anchors.left: parent.left
        anchors.leftMargin: 10
        anchors.verticalCenter: parent.verticalCenter
        anchors.verticalCenterOffset: 6
        renderStrategy: Canvas.Cooperative
        onPaint: {
            var ctx = getContext("2d")
            ctx.clearRect(0, 0, width, height)
            var rand = T.rng(card.sigilSeed())
            var cx = width / 2
            var cy = height / 2
            var R = 21

            ctx.strokeStyle = T.LINE
            ctx.globalAlpha = 0.8
            ctx.lineWidth = 1
            var ring = T.ringPoints(cx, cy, R, card.sigilSeed())
            ctx.beginPath()
            for (var i = 0; i < ring.length; i++) {
                if (i === 0)
                    ctx.moveTo(ring[i].x, ring[i].y)
                else
                    ctx.lineTo(ring[i].x, ring[i].y)
            }
            ctx.stroke()

            ctx.strokeStyle = card.stateColor
            ctx.globalAlpha = 0.9
            var lines = 2 + Math.floor(rand() * 3)
            for (var l = 0; l < lines; l++) {
                var a0 = rand() * 6.2832
                var a1 = a0 + 0.6 + rand() * 2.4
                var r0 = 4 + rand() * 6
                var r1 = 12 + rand() * 8
                ctx.beginPath()
                ctx.moveTo(cx + r0 * Math.cos(a0), cy + r0 * Math.sin(a0))
                ctx.lineTo(cx + r1 * Math.cos(a1), cy + r1 * Math.sin(a1))
                ctx.stroke()
            }
            var dots = 2 + Math.floor(rand() * 4)
            ctx.fillStyle = T.INK
            ctx.globalAlpha = 0.55
            for (var d = 0; d < dots; d++) {
                var ad = rand() * 6.2832
                var rd = 6 + rand() * 14
                ctx.beginPath()
                ctx.arc(cx + rd * Math.cos(ad), cy + rd * Math.sin(ad), 1.1 + rand(), 0, 6.2832)
                ctx.fill()
            }
            ctx.globalAlpha = 1
        }
    }

    Text {
        id: nameTxt
        text: card.name
        font.family: T.FONT_DISPLAY
        font.pixelSize: 16
        color: T.INK
        anchors.left: sigil.right
        anchors.leftMargin: 14
        anchors.top: parent.top
        anchors.topMargin: 14
        elide: Text.ElideRight
        width: parent.width - sigil.width - 40
    }

    Row {
        id: meta
        anchors.left: nameTxt.left
        anchors.top: nameTxt.bottom
        anchors.topMargin: 4
        spacing: 10

        Text {
            text: card.stateText
            font.family: T.FONT_MONO
            font.pixelSize: 11
            color: card.stateColor
        }

        Text {
            text: T.shortId(card.steamId)
            font.family: T.FONT_MONO
            font.pixelSize: 11
            color: T.MUTED
            visible: card.steamId.length > 0
        }
    }

    Text {
        id: detailTxt
        text: card.detail
        visible: card.detail.length > 0
        font.family: T.FONT_MONO
        font.pixelSize: 10
        color: T.MUTED
        opacity: 0.9
        anchors.left: nameTxt.left
        anchors.top: meta.bottom
        anchors.topMargin: 3
        elide: Text.ElideRight
        width: parent.width - sigil.width - 40
    }

    PlateButton {
        visible: card.invitable
        label: "邀请"
        anchors.right: parent.right
        anchors.rightMargin: 12
        anchors.verticalCenter: parent.verticalCenter
        onClicked: card.invite()
    }

    MouseArea {
        id: hoverArea
        anchors.fill: parent
        hoverEnabled: true
        acceptedButtons: Qt.NoButton
        onContainsMouseChanged: card.hovered = containsMouse
    }
}
