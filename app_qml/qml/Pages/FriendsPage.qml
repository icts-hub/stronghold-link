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
    // 切页入场：外壳（Main.qml 的 revealPage）会把这两个属性一起写下去。
    property bool revealed: true
    property bool ambient: true

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

            // ══ 左列顶部：好友图版（沿用会话页那套刊头构图）═════════════════
            // 参考项目每个页面都有一张自己的主图版：好友页是 personnelPlate ——
            // 圆形徽记 + 一圈人像版位连成的关系网 + 工程图附件。这里把图版铺满整块，
            // 左半边留给刊头文字，实时读数压在最右缘（与会话页同一版式）。
            // 原来那张通用星座图（PaperPlate + Constellation）已被取代：它只有节点和
            // 连线，没有版位、引线、徽记与图纸附件，跟参考不是同一种东西。
            Item {
                id: friendsHero
                Layout.fillWidth: true
                Layout.preferredHeight: 500
                Layout.minimumHeight: 340

                // 三栏并排：刊头（左，226px）· 图版（中，占剩余宽度）· 实时读数（右，158px）。
                // 之前图版是"铺满整块、靠左栏留白躲开文字"，结果圆盘右半边被实时读数压住；
                // 现在把它当一个正方形版心摆在中间：作图区 1000x1000 的映射关系不变，
                // 盘心落在版心正中，两边各让出各自的地盘，谁也不压谁。
                // 宽高比锁正方形，所以 Canvas 的宽高比与作图空间一致 —— 圆盘不会被拉成椭圆。
                // 主纹样系统 = 模板 B（羽翼 + 圣堂拱框）：对称的拱形结构居中，
                // 两侧羽片由短到长、留空隙；刊头与实时读数分列左右，互不遮挡。
                MotifPlate {
                    id: friendPlate
                    anchors.horizontalCenter: parent.horizontalCenter
                    anchors.verticalCenter: parent.verticalCenter
                    width: Math.min(parent.height, parent.width - 2 * 220)
                    height: width
                    template: "B"
                    active: page.active !== false
                    revealed: page.revealed !== false
                    ambient: page.ambient !== false
                    seed: 97
                    mark: "F"
                    caption: "STEAM LOBBY"
                }

                // ── 左半：刊头 ─────────────────────────────────────────────
                Column {
                    anchors.left: parent.left
                    anchors.leftMargin: 26
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.verticalCenterOffset: 8
                    width: 226
                    spacing: 0

                    Item {
                        width: badgeBarF.width + 6 + badgeTail.width
                        height: 30

                        Rectangle {
                            id: badgeBarF
                            width: badgeTextF.width + 22
                            height: parent.height
                            color: T.INK
                        }

                        Text {
                            id: badgeTextF
                            anchors.left: parent.left
                            anchors.leftMargin: 11
                            anchors.verticalCenter: parent.verticalCenter
                            text: "STEAM LOBBY / PRESENCE"
                            font.family: T.FONT_MONO
                            font.pixelSize: 12
                            font.letterSpacing: 2.4
                            color: T.PAPER
                        }

                        Rectangle {
                            id: badgeTail
                            anchors.left: badgeBarF.right
                            anchors.leftMargin: 6
                            anchors.verticalCenter: parent.verticalCenter
                            width: 24
                            height: parent.height
                            color: T.ACCENT
                        }
                    }

                    Item { width: 1; height: 24 }

                    Text {
                        text: "Friends"
                        font.family: T.FONT_DISPLAY
                        font.pixelSize: 56
                        color: T.INK
                    }

                    Text {
                        text: "Roster"
                        font.family: T.FONT_DISPLAY
                        font.pixelSize: 56
                        color: T.INK
                        leftPadding: 92
                        topPadding: -10
                    }

                    Item { width: 1; height: 16 }

                    Row {
                        spacing: 14

                        Rectangle {
                            width: 52
                            height: 1
                            color: T.INK
                            anchors.verticalCenter: parent.verticalCenter
                        }

                        Text {
                            text: "好友档案"
                            font.family: T.FONT_SERIF_CN
                            font.pixelSize: 21
                            color: T.INK
                        }

                        Text {
                            text: "◆"
                            font.pixelSize: 9
                            color: T.INK
                            anchors.verticalCenter: parent.verticalCenter
                        }
                    }

                    Item { width: 1; height: 18 }

                    Text {
                        text: "好友名单来自 Steam 大厅。"
                        font.family: T.FONT_SERIF_CN
                        font.pixelSize: 14
                        color: T.MUTED
                    }

                    Text {
                        text: "不在同一条干道上也能先看到谁在线。"
                        font.family: T.FONT_SERIF_CN
                        font.pixelSize: 14
                        color: T.MUTED
                    }

                    Item { width: 1; height: 22 }

                    // 深色行动条：动作就是"刷新好友"
                    Item {
                        width: parent.width
                        height: 44

                        Rectangle {
                            anchors.fill: parent
                            color: T.INK
                        }

                        MouseArea {
                            anchors.fill: parent
                            cursorShape: Qt.PointingHandCursor
                            onClicked: page.refreshFriends()
                        }

                        Row {
                            anchors.left: parent.left
                            anchors.leftMargin: 16
                            anchors.verticalCenter: parent.verticalCenter
                            spacing: 14

                            Text {
                                text: "刷新好友"
                                font.family: T.FONT_SANS
                                font.pixelSize: 17
                                color: T.PAPER
                                anchors.verticalCenter: parent.verticalCenter
                            }

                            Text {
                                text: (page.loading ? "LOADING" : page.friends.length + " FRIENDS") + "  ·  " + page.onlineCount + " ONLINE"
                                font.family: T.FONT_MONO
                                font.pixelSize: 10
                                font.letterSpacing: 1.6
                                color: T.PAPER
                                opacity: 0.72
                                anchors.verticalCenter: parent.verticalCenter
                            }
                        }

                        Text {
                            anchors.right: parent.right
                            anchors.rightMargin: 16
                            anchors.verticalCenter: parent.verticalCenter
                            text: "→"
                            font.pixelSize: 18
                            color: T.PAPER
                        }
                    }
                }

                // ── 右缘：Steam 身份读数 ──────────────────────────────────
                Column {
                    anchors.right: parent.right
                    anchors.rightMargin: 16
                    anchors.top: parent.top
                    anchors.topMargin: 20
                    spacing: 6
                    width: 158

                    Rectangle {
                        width: parent.width
                        height: 16
                        color: T.INK
                    }

                    Text {
                        text: page.ready ? "STEAM · 已就绪" : ("STEAM · " + (page.attached ? "连接中" : "未连接"))
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
                }

                // ── 左下角：在线/选中摘要 ─────────────────────────────────
                Text {
                    anchors.left: parent.left
                    anchors.leftMargin: 26
                    anchors.bottom: parent.bottom
                    anchors.bottomMargin: 12
                    text: page.friends.length + " 位好友 · " + page.onlineCount + " 在线"
                        + (page.selected >= 0 && page.friends[page.selected] ? ("   ·   选中：" + (page.friends[page.selected].name || "")) : "")
                    font.family: T.FONT_MONO
                    font.pixelSize: 10
                    color: T.MUTED
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
