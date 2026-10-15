import QtQuick
import QtQuick.Layouts
import "../Components"
import "../theme.js" as T
import "../logic.js" as L

// 一级页 2/3：好友。Steam 好友清单 + 大厅（建房 / 加入 / 邀请 / 房间名）。
// 头像一律是"由 SteamID 生成的几何印章"，不是真实头像 —— 界面上明确标注，避免误认。
Item {
    id: page

    property bool active: true
    property int motionTier: 2

    signal notice(string text, bool bad)

    property var friends: []
    property var lobby: ({})
    property var diag: ({})
    property var members: []
    property int selected: -1
    property string room: ""
    property string joinId: ""
    property string maxMembers: "4"
    property string lastError: ""
    property bool loading: false

    property int pendingStatus: 0
    property int pendingFriends: 0
    property int pendingDiagnose: 0
    property int pendingCreate: 0
    property int pendingJoin: 0
    property int pendingLeave: 0
    property int pendingStop: 0
    property int pendingInvite: 0
    property int pendingRoom: 0

    readonly property bool attached: lobby.attached === true
    readonly property bool ready: lobby.ready === true
    readonly property bool isOwner: lobby.isOwner === true
    readonly property string steamId: lobby.steamId ? String(lobby.steamId) : ""
    readonly property string steamName: lobby.name ? String(lobby.name) : ""
    readonly property string lobbyId: lobby.lobbyId ? String(lobby.lobbyId) : ""
    readonly property int onlineCount: {
        var n = 0
        for (var i = 0; i < friends.length; i++) {
            if (friends[i].online)
                n++
        }
        return n
    }
    readonly property string steamProblem: {
        if (diag === undefined || diag === null || diag.available === undefined)
            return ""
        if (diag.available === true)
            return ""
        return (diag.blockers && diag.blockers.length) ? diag.blockers.join("；") : "Steam 环境未就绪"
    }
    readonly property var steamSteps: (diag && diag.steps) ? diag.steps : []

    function say(text, bad) {
        notice(String(text === undefined || text === null ? "" : text), bad === true)
    }

    function refreshStatus() {
        loading = true
        pendingStatus = bridge.call("lobby.status", {})
    }

    function refreshFriends() {
        loading = true
        pendingFriends = bridge.call("lobby.friends", {})
    }

    function diagnose() {
        pendingDiagnose = bridge.call("steam.diagnose", {})
    }

    function refreshAll() {
        refreshStatus()
        refreshFriends()
        diagnose()
    }

    function createLobby() {
        pendingCreate = bridge.call("lobby.create", { maxMembers: Number(maxMembers) || 4 })
    }

    function joinLobby() {
        var id = String(joinId || "").trim()
        if (!id.length) {
            say("先填大厅 ID（房主在好友页创建大厅后会显示）", true)
            return
        }
        pendingJoin = bridge.call("lobby.join", { lobbyId: id })
    }

    function invite(target) {
        if (!target)
            return
        pendingInvite = bridge.call("lobby.invite", { steamId: String(target) })
    }

    function setRoom() {
        if (!String(room || "").trim().length) {
            say("先填一个房间名", true)
            return
        }
        pendingRoom = bridge.call("lobby.setRoom", { room: String(room).trim() })
    }

    Component.onCompleted: refreshAll()

    onActiveChanged: {
        if (active)
            refreshAll()
    }

    // 只在页面可见时轮询：好友页不显示时不占用任何定时器
    Timer {
        interval: 5000
        repeat: true
        running: page.active
        onTriggered: page.refreshStatus()
    }

    Timer {
        interval: 15000
        repeat: true
        running: page.active && page.ready
        onTriggered: page.refreshFriends()
    }

    Connections {
        target: bridge

        function onResponse(id, ok, result, code, message) {
            var err = (code ? "[" + code + "] " : "") + (message || "请求失败")

            if (id === page.pendingStatus) {
                page.loading = false
                if (ok) {
                    page.lobby = result || ({})
                    page.members = (result && result.members) ? result.members : []
                    // 房间名写在房主的 hostInfo 里（network/steam-lobby.cjs readHostInfo）
                    if (result && result.hostInfo && result.hostInfo.room !== undefined)
                        page.room = String(result.hostInfo.room || "")
                    page.lastError = (result && result.error) ? String(result.error) : ""
                } else {
                    page.lastError = err
                }
                return
            }
            if (id === page.pendingFriends) {
                page.loading = false
                if (ok)
                    page.friends = (result && result.friends) ? result.friends : []
                else
                    page.lastError = err
                return
            }
            if (id === page.pendingDiagnose) {
                if (ok)
                    page.diag = result || ({})
                return
            }
            if (id === page.pendingCreate) {
                if (ok) {
                    page.say(result && result.ok ? ("大厅已创建：" + (result.lobbyId || page.lobbyId)) : ("创建失败：" + ((result && result.error) || "未知")), !(result && result.ok))
                    page.refreshStatus()
                } else {
                    page.say(err, true)
                }
                return
            }
            if (id === page.pendingJoin) {
                if (ok) {
                    page.say(result && result.ok ? "已加入大厅" : ("加入失败：" + ((result && result.error) || "未知")), !(result && result.ok))
                    page.refreshStatus()
                } else {
                    page.say(err, true)
                }
                return
            }
            if (id === page.pendingLeave) {
                page.say(ok ? "已离开大厅" : err, !ok)
                page.refreshStatus()
                return
            }
            if (id === page.pendingStop) {
                page.say(ok ? "大厅已结束" : err, !ok)
                page.refreshStatus()
                return
            }
            if (id === page.pendingInvite) {
                page.say(ok ? "邀请已发出（Steam 覆盖层里会出现）" : err, !ok)
                return
            }
            if (id === page.pendingRoom) {
                page.say(ok ? ("房间名已设为：" + page.room) : err, !ok)
                return
            }
        }

        function onBackendEvent(name, payload) {
            if (String(name).indexOf("lobby") === 0) {
                // 大厅事件只当"有变化"的信号，真实状态一律重新问后端
                if (page.pendingStatus === 0)
                    page.refreshStatus()
                var kind = payload && payload.kind ? String(payload.kind) : ""
                if (kind.length)
                    page.say("大厅事件：" + kind, false)
            }
        }
    }

    RowLayout {
        anchors.fill: parent
        spacing: 16

        // ══ 左列：星座图 + 好友档案 ═══════════════════════════════════
        ColumnLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            Layout.preferredWidth: 5
            spacing: 14

            PaperPlate {
                Layout.fillWidth: true
                Layout.preferredHeight: 244
                seed: 60607
                showDots: true

                Item {
                    anchors.fill: parent
                    anchors.rightMargin: 150

                    Constellation {
                        id: chart
                        anchors.fill: parent
                        items: {
                            var out = []
                            for (var i = 0; i < page.friends.length; i++) {
                                var f = page.friends[i]
                                out.push({
                                    name: f.name || "未知好友",
                                    state: f.stateName || (f.online ? "在线" : "离线"),
                                    color: f.online ? T.COBALT : T.LINE
                                })
                            }
                            return out
                        }
                        seed: 90210
                        hovered: page.selected
                        onActivated: (index) => { page.selected = (page.selected === index ? -1 : index) }
                    }

                    Text {
                        anchors.centerIn: parent
                        visible: page.friends.length === 0
                        text: page.ready ? "好友列表为空" : "等待 Steam 好友列表"
                        font.family: T.FONT_MONO
                        font.pixelSize: 11
                        color: T.MUTED
                    }

                    Column {
                        anchors.left: parent.left
                        anchors.bottom: parent.bottom
                        spacing: 1

                        Text {
                            text: "好友星图"
                            font.family: T.FONT_DISPLAY
                            font.pixelSize: 22
                            color: T.INK
                        }

                        Text {
                            text: page.friends.length + " 位好友 · " + page.onlineCount + " 在线" + (page.selected >= 0 && page.friends[page.selected] ? ("   ·   选中：" + (page.friends[page.selected].name || "")) : "")
                            font.family: T.FONT_MONO
                            font.pixelSize: 10
                            color: T.MUTED
                        }
                    }
                }

                // 右缘：Steam 身份
                Column {
                    anchors.right: parent.right
                    anchors.top: parent.top
                    spacing: 5
                    width: 142

                    Text {
                        text: "STEAM"
                        font.family: T.FONT_MONO
                        font.pixelSize: 10
                        color: page.ready ? T.COBALT : T.MUTED
                    }

                    StatusReadout {
                        width: parent.width
                        label: "账号"
                        value: page.steamName.length ? page.steamName : "—"
                    }

                    StatusReadout {
                        width: parent.width
                        label: "SteamID"
                        value: page.steamId.length ? T.shortId(page.steamId) : "—"
                    }

                    StatusReadout {
                        width: parent.width
                        label: "大厅"
                        value: page.lobbyId.length ? page.lobbyId : "未加入"
                        valueColor: page.lobbyId.length ? T.GOOD : T.MUTED
                    }

                    StatusReadout {
                        width: parent.width
                        label: "身份"
                        value: page.isOwner ? "房主" : (page.lobbyId.length ? "成员" : "—")
                    }

                    StatusReadout {
                        width: parent.width
                        label: "可加入"
                        value: page.lobby.joinable === true ? "是" : "否"
                    }
                }
            }

            Plate {
                Layout.fillWidth: true
                Layout.fillHeight: true
                index: "02"
                title: "好友档案"
                caption: page.loading ? "读取中…" : (page.friends.length + " 条")
                active: page.ready

                Column {
                    anchors.fill: parent
                    spacing: 8

                    // 状态行：未就绪 / 空 / 出错，都要说清楚，不能只给一张空表
                    Text {
                        width: parent.width
                        visible: page.friends.length === 0
                        text: {
                            if (page.lastError.length)
                                return "读取失败：" + page.lastError
                            if (page.steamProblem.length)
                                return "Steam 环境未就绪：" + page.steamProblem
                            if (!page.attached)
                                return "还没有连上 Steam 客户端：请在设置页跑一次诊断，并确认 Steam 已登录。"
                            if (!page.ready)
                                return "Steam 已连接，正在初始化好友列表…"
                            return "好友列表是空的：账号里没有好友，或好友列表权限不可用。"
                        }
                        font.family: T.FONT_MONO
                        font.pixelSize: 11
                        color: page.lastError.length || page.steamProblem.length ? T.BAD : T.MUTED
                        wrapMode: Text.WordWrap
                    }

                    Flickable {
                        width: parent.width
                        height: parent.height - 24
                        visible: page.friends.length > 0
                        clip: true
                        contentHeight: cards.height
                        boundsBehavior: Flickable.StopAtBounds

                        Column {
                            id: cards
                            width: parent.width
                            spacing: 6

                            Repeater {
                                model: page.friends

                                delegate: PersonPlate {
                                    required property var modelData
                                    required property int index
                                    readonly property int rowIndex: index
                                    width: cards.width
                                    indexLabel: T.pad2(rowIndex + 1)
                                    name: modelData.name || "未知好友"
                                    steamId: String(modelData.steamId || "")
                                    stateText: modelData.stateName || (modelData.online ? "在线" : "离线")
                                    stateColor: modelData.online ? T.GOOD : T.MUTED
                                    detail: (modelData.inOurLobby ? "已在本大厅" : (modelData.game && modelData.game.gameId ? ("正在玩 " + modelData.game.gameId) : "—"))
                                            + "   ·   印章头像由 SteamID 生成，不是真实头像"
                                    invitable: modelData.online === true && page.ready
                                    hovered: page.selected === rowIndex
                                    onInvite: page.invite(modelData.steamId)
                                }
                            }
                        }
                    }
                }
            }
        }

        // ══ 右列：Steam 环境 + 大厅操作 + 成员 ═══════════════════════
        ColumnLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            Layout.preferredWidth: 4
            spacing: 14

            Plate {
                Layout.fillWidth: true
                Layout.preferredHeight: 224
                index: "01"
                title: "Steam 环境"
                caption: page.diag && page.diag.platform ? String(page.diag.platform) : "—"
                active: page.steamProblem.length > 0

                Column {
                    anchors.fill: parent
                    spacing: 4

                    Text {
                        width: parent.width
                        text: {
                            if (page.diag === undefined || page.diag.available === undefined)
                                return "正在诊断…"
                            return page.diag.available === true ? "环境就绪：可以建房 / 加入 / 邀请。" : ("环境未就绪：" + page.steamProblem)
                        }
                        font.family: T.FONT_MONO
                        font.pixelSize: 11
                        color: (page.diag && page.diag.available === false) ? T.BAD : T.INK
                        wrapMode: Text.WordWrap
                    }

                    Repeater {
                        model: page.steamSteps.slice(0, 5)

                        delegate: StatusReadout {
                            required property var modelData
                            width: parent.width
                            label: (modelData.ok ? "✓ " : "✗ ") + modelData.title
                            value: String(modelData.detail || "").length > 60 ? (String(modelData.detail).slice(0, 58) + "…") : String(modelData.detail || "")
                            valueColor: modelData.ok ? T.MUTED : T.BAD
                        }
                    }

                    Flow {
                        width: parent.width
                        spacing: 8

                        PlateButton {
                            label: "重新诊断"
                            onClicked: page.diagnose()
                        }

                        PlateButton {
                            label: "刷新好友"
                            enabled: page.ready
                            onClicked: page.refreshFriends()
                        }
                    }
                }
            }

            Plate {
                Layout.fillWidth: true
                Layout.preferredHeight: 262
                index: "02"
                title: "大厅"
                caption: page.lobbyId.length ? ("ID " + page.lobbyId) : "未加入"

                Column {
                    anchors.fill: parent
                    spacing: 8

                    ChoiceRow {
                        width: parent.width
                        label: "人数上限（创建时）"
                        value: page.maxMembers
                        choices: [{ value: "2", text: "2" }, { value: "4", text: "4" }, { value: "8", text: "8" }, { value: "16", text: "16" }]
                        onPicked: (v) => { page.maxMembers = v }
                    }

                    Flow {
                        width: parent.width
                        spacing: 8

                        PlateButton {
                            label: "创建大厅"
                            primary: !page.lobbyId.length && page.ready
                            enabled: page.ready && !page.lobbyId.length
                            onClicked: page.createLobby()
                        }

                        PlateButton {
                            label: "离开大厅"
                            enabled: page.lobbyId.length > 0 && !page.isOwner
                            onClicked: { page.pendingLeave = bridge.call("lobby.leave", {}) }
                        }

                        PlateButton {
                            label: "结束大厅"
                            hint: "房主"
                            enabled: page.isOwner
                            onClicked: { page.pendingStop = bridge.call("lobby.stop", {}) }
                        }
                    }

                    FieldInput {
                        width: parent.width
                        label: "大厅 ID（加入用）"
                        placeholder: "例如 109775243957481234"
                        text: page.joinId
                        onTextChanged: page.joinId = text
                    }

                    Flow {
                        width: parent.width
                        spacing: 8

                        PlateButton {
                            label: "加入大厅"
                            enabled: page.ready && page.joinId.length > 0 && !page.lobbyId.length
                            onClicked: page.joinLobby()
                        }

                        FieldInput {
                            width: parent.width - 108
                            label: ""
                            placeholder: "房间名（可选，写进大厅数据）"
                            text: page.room
                            onTextChanged: page.room = text
                        }

                        PlateButton {
                            label: "设置房间名"
                            enabled: page.lobbyId.length > 0
                            onClicked: page.setRoom()
                        }
                    }

                    Text {
                        width: parent.width
                        text: {
                            if (page.members.length)
                                return "成员 " + page.members.length + " 人：" + page.members.map(function (m) { return m.name || m.steamId }).join("、")
                            if (page.lobbyId.length)
                                return "成员 0 人（等好友进来）"
                            return "未加入大厅：创建后把大厅 ID 发给好友，或在好友列表里点邀请。"
                        }
                        font.family: T.FONT_MONO
                        font.pixelSize: 10
                        color: T.MUTED
                        wrapMode: Text.WordWrap
                    }
                }
            }

            Plate {
                Layout.fillWidth: true
                Layout.fillHeight: true
                index: "03"
                title: "大厅成员"
                caption: page.members.length + " 人"

                Flickable {
                    anchors.fill: parent
                    clip: true
                    contentHeight: memberCol.height
                    boundsBehavior: Flickable.StopAtBounds

                    Column {
                        id: memberCol
                        width: parent.width
                        spacing: 3

                        Repeater {
                            model: page.members

                            delegate: StatusReadout {
                                required property var modelData
                                required property int index
                                width: memberCol.width
                                label: T.pad2(index + 1) + " " + (modelData.name || modelData.steamId || "成员")
                                value: modelData.owner ? "房主" : (modelData.steamId ? T.shortId(modelData.steamId) : "—")
                                valueColor: modelData.owner ? T.COBALT : T.MUTED
                            }
                        }

                        Text {
                            visible: page.members.length === 0
                            text: "（没有成员）"
                            font.family: T.FONT_MONO
                            font.pixelSize: 10
                            color: T.MUTED
                        }
                    }
                }
            }
        }
    }
}
