import QtQuick
import QtQuick.Layouts
import "../Components"
import "../theme.js" as T
import "../logic.js" as L

// 一级页 1/3：会话。房主 / 加入者、连接方式、端口规则、邀请码、启动停止、线路与流量。
Item {
    id: page

    property bool active: true
    property int motionTier: 2
    // 切页入场：外壳（Main.qml 的 revealPage）会把这两个属性一起写下去，
    // 页面里的版画与纹样图版据此错峰显现 / 关掉常驻动效。
    property bool revealed: true
    property bool ambient: true

    // ── 表单状态 ───────────────────────────────────────────────────────
    property string role: "host"
    property string recipe: "local-ports"
    property string rulesText: "TCP 25565"
    property string token: ""
    property string game: ""
    property string bindHost: "0.0.0.0"
    property string targetHost: "127.0.0.1"
    property string remoteHost: ""
    property string gamePort: "3000"
    property string appId: ""
    property string hostSteamId: ""
    property string localPort: "25565"
    property string inviteCode: ""
    property bool autoSessionFired: false   // 内存验收：自动开会话只触发一次

    // ── 后端状态 ───────────────────────────────────────────────────────
    property var recipes: []
    property var snapshot: ({})
    property var route: ({})
    property var hints: ({ hostHint: [], clientHint: [] })
    property string notice: ""
    property bool noticeBad: false
    property int pendingStart: 0
    property int pendingStop: 0
    property int pendingStatus: 0
    property int pendingRoute: 0
    property int pendingInvite: 0
    property int pendingCheck: 0
    property int pendingHints: 0

    readonly property string sessionState: (snapshot && snapshot.state) ? String(snapshot.state) : "idle"
    readonly property bool busy: sessionState === "starting" || sessionState === "stopping"
    readonly property bool live: sessionState === "running"
    readonly property var metrics: (snapshot && snapshot.metrics) ? snapshot.metrics : ({ rateToPeer: 0, rateFromPeer: 0 })
    readonly property var channels: (snapshot && snapshot.channels) ? snapshot.channels : []
    readonly property var logs: (snapshot && snapshot.logs) ? snapshot.logs : []
    readonly property bool steamRecipe: recipe === "steam-tunnel"
    readonly property bool localRecipe: recipe === "local-ports" || recipe === "local-web"

    function say(text, bad) {
        notice = String(text === undefined || text === null ? "" : text)
        noticeBad = bad === true
    }

    function stateColor() {
        var key = L.stateColorKey(sessionState)
        if (key === "good")
            return T.GOOD
        if (key === "bad")
            return T.BAD
        if (key === "warn")
            return T.WARN
        return T.MUTED
    }

    function formState() {
        return {
            role: role,
            recipe: recipe,
            rulesText: rulesText,
            token: token,
            game: game,
            bindHost: bindHost,
            targetHost: targetHost,
            remoteHost: remoteHost,
            gamePort: gamePort,
            appId: appId,
            hostSteamId: hostSteamId,
            localPort: localPort
        }
    }

    function refreshHints() {
        var built = L.buildInput(formState())
        var body = { recipe: recipe, game: game, targetHost: targetHost, gamePort: Number(gamePort) || null, localPort: Number(localPort) || null }
        if (built.ok && built.input.rules)
            body.rules = built.input.rules
        pendingHints = bridge.call("adapters.recipeHints", body)
    }

    function refreshStatus() {
        pendingStatus = bridge.call("session.status", {})
    }

    function refreshRoute() {
        pendingRoute = bridge.call("session.route", {})
    }

    function start() {
        var built = L.buildInput(formState())
        if (!built.ok) {
            say(built.error, true)
            return
        }
        notice = ""
        pendingStart = bridge.call("session.start", built.input)
    }

    function stop() {
        pendingStop = bridge.call("session.stop", {})
    }

    function applyInvite() {
        var code = String(inviteCode || "").trim()
        if (!code.length) {
            say("先粘贴邀请码（SHL1- 开头）", true)
            return
        }
        pendingInvite = bridge.call("session.parseInvite", { code: code })
    }

    function checkFirstPort() {
        var parsed = L.parseRules(rulesText)
        var port = parsed.ok ? parsed.rules[0].localPort : Number(localPort)
        if (!port) {
            say("先写端口规则或本机入口端口", true)
            return
        }
        // 注意：后端白名单里没有 port 键，端口检查必须发 localPort
        pendingCheck = bridge.call("session.checkPort", {
            localPort: Number(port) || 0,
            protocol: parsed.ok ? parsed.rules[0].protocol : "TCP",
            bindHost: role === "host" ? bindHost : "127.0.0.1"
        })
    }

    Component.onCompleted: {
        refreshStatus()
        refreshRoute()
        refreshHints()
    }

    // 会话运行时每秒拉一次状态；本页不可见或窗口最小化时降到 5 秒（后端照常运行）
    Timer {
        interval: page.active ? 1000 : 5000
        repeat: true
        running: page.live || page.busy
        onTriggered: page.refreshStatus()
    }

    Timer {
        interval: 2000
        repeat: true
        running: page.live && page.active
        onTriggered: page.refreshRoute()
    }

    Connections {
        target: bridge

        function onResponse(id, ok, result, code, message) {
            if (id === page.pendingStart) {
                if (ok) {
                    page.snapshot = result
                    page.say("会话已启动：" + L.stateLabel(result && result.state), false)
                } else {
                    page.say((code ? "[" + code + "] " : "") + (message || "启动失败"), true)
                }
                page.refreshHints()
                return
            }
            if (id === page.pendingStop) {
                if (ok)
                    page.snapshot = result
                else
                    page.say((code ? "[" + code + "] " : "") + (message || "停止失败"), true)
                return
            }
            if (id === page.pendingStatus) {
                if (ok)
                    page.snapshot = result
                return
            }
            if (id === page.pendingRoute) {
                if (ok)
                    page.route = result
                return
            }
            if (id === page.pendingHints) {
                if (ok)
                    page.hints = result
                return
            }
            if (id === page.pendingInvite) {
                if (ok) {
                    page.role = "joiner"
                    page.recipe = "local-ports"
                    page.remoteHost = String(result.host || "")
                    page.token = String(result.token || "")
                    page.game = String(result.game || "")
                    if (result.rules && result.rules.length)
                        page.rulesText = L.formatRules(result.rules)
                    page.say("已解析邀请码：房主 " + result.host + ":" + result.port + "，口令" + (result.token ? "已填好" : "为空"), false)
                    page.refreshHints()
                } else {
                    page.say((code ? "[" + code + "] " : "") + (message || "邀请码无法解析"), true)
                }
                return
            }
            if (id === page.pendingCheck) {
                if (ok)
                    page.say(result && result.free ? "端口可用：" + (result.port || "") : ("端口被占用：" + ((result && result.owner) || (result && result.reason) || "未知")), !(result && result.free))
                else
                    page.say((code ? "[" + code + "] " : "") + (message || "端口检查失败"), true)
                return
            }
        }

        function onBackendEvent(name, payload) {
            if (name === "session.event") {
                // 事件只当"有变化"的信号：真实状态一律用 session.status 复核，避免界面自己编状态
                if (page.pendingStatus === 0)
                    page.refreshStatus()
                return
            }
            if (name === "backend.error") {
                page.say("后端错误：" + (payload && payload.message ? payload.message : ""), true)
            }
        }

        function onBackendError(code, message) {
            page.say("[" + code + "] " + message, true)
        }
    }

    RowLayout {
        anchors.fill: parent
        spacing: 16

        // ══ 左列：主视觉 + 通道流量 + 日志 ═════════════════════════════
        ColumnLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            Layout.preferredWidth: 5
            spacing: 14

            // ══ 主视觉图版（逐层复刻参考项目的 homePlate 构图）═════════════
            // 版式照参考项目：左半是刊头（深色徽标条 + 两行巨型衬线标题 + 中文副题 +
            // 两条说明 + 深色行动条），右半是钴蓝圆盘构图（40 根锥形光芒、同心圆环与
            // 96 根刻度、断续十字轴线、纵向量尺、套准标记与裁切角标、飞离盘面的鸟群、
            // 散落的界面碎片）。实时数据叠在图版右缘，位置与参考项目的轨道图注同高。
            Item {
                Layout.fillWidth: true
                Layout.fillHeight: true
                Layout.preferredHeight: 486
                Layout.minimumHeight: 380

                // 主纹样系统 = 模板 A（鸟群 + 圣徽 + 留白）：整页由这一套纹样主导，
                // 左半的刊头正好落在它留出的负空间里。旧的 HeroPlate 构图已被取代。
                MotifPlate {
                    anchors.fill: parent
                    // E = 深底「羽兽墙」：照用户给的参考图（冷灰底 + 浅色细线的大鸟叠成一片 +
                    // 左缘深蓝块 + 大圆弧点阵）。A 那套"淡纸面鸟潮"仍保留，换一行就回去。
                    template: "E"
                    seed: 61
                    cxRatio: 0.635
                    mark: "S"
                    sealText: "STRONGHOLD LINK · TUNNEL CONSOLE · "
                    active: page.active !== false
                    revealed: page.revealed !== false
                    ambient: page.ambient !== false
                }

                // ── 左半：刊头 ────────────────────────────────────────────
                Column {
                    anchors.left: parent.left
                    anchors.leftMargin: 26
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.verticalCenterOffset: 14
                    width: parent.width * 0.40
                    spacing: 0

                    // 深色徽标条（参考项目左上的胶囊标签）
                    Item {
                        width: badgeText.width + (badgeTail.visible ? badgeTail.width + 12 : 0)
                        height: 30

                        Rectangle {
                            id: badgeBar
                            width: badgeText.width + 22
                            height: parent.height
                            color: T.INK
                        }

                        Text {
                            id: badgeText
                            anchors.left: parent.left
                            anchors.leftMargin: 11
                            anchors.verticalCenter: parent.verticalCenter
                            text: "QML EDITION / TUNNEL CONSOLE"
                            font.family: T.FONT_MONO
                            font.pixelSize: 12
                            font.letterSpacing: 2.4
                            color: T.PAPER
                        }

                        Rectangle {
                            id: badgeTail
                            anchors.left: badgeBar.right
                            anchors.leftMargin: 6
                            anchors.verticalCenter: parent.verticalCenter
                            width: 24
                            height: parent.height
                            color: T.ACCENT
                        }
                    }

                    Item { width: 1; height: 26 }

                    // 巨型衬线标题两行
                    Text {
                        text: "Stronghold"
                        font.family: T.FONT_DISPLAY
                        font.pixelSize: 62
                        color: T.INK
                    }

                    Text {
                        text: "Link"
                        font.family: T.FONT_DISPLAY
                        font.pixelSize: 62
                        color: T.INK
                        leftPadding: 104
                        topPadding: -12
                    }

                    Item { width: 1; height: 18 }

                    // 标线 + 中文副题 + 菱形
                    Row {
                        spacing: 14

                        Rectangle {
                            width: 52
                            height: 1
                            color: T.INK
                            anchors.verticalCenter: parent.verticalCenter
                        }

                        Text {
                            text: "干线隧道控制台"
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

                    Item { width: 1; height: 20 }

                    Text {
                        text: "一条干道，两端直连。"
                        font.family: T.FONT_SERIF_CN
                        font.pixelSize: 14
                        color: T.MUTED
                    }

                    Text {
                        text: "本机监听端口，字节原样透传。"
                        font.family: T.FONT_SERIF_CN
                        font.pixelSize: 14
                        color: T.MUTED
                    }

                    Item { width: 1; height: 24 }

                    // 深色行动条：会话状态（参考项目的 CTA 按钮）
                    Item {
                        width: parent.width
                        height: 46

                        Rectangle {
                            anchors.fill: parent
                            color: T.INK
                        }

                        MouseArea {
                            anchors.fill: parent
                            cursorShape: Qt.PointingHandCursor
                            onClicked: page.live ? page.stop() : page.start()
                        }

                        Row {
                            anchors.left: parent.left
                            anchors.leftMargin: 16
                            anchors.verticalCenter: parent.verticalCenter
                            spacing: 14

                            Text {
                                text: page.live ? "停止会话" : "启动会话"
                                font.family: T.FONT_SANS
                                font.pixelSize: 17
                                color: T.PAPER
                                anchors.verticalCenter: parent.verticalCenter
                            }

                            Text {
                                text: L.stateLabel(page.sessionState).toUpperCase() + "  ·  " + (page.live ? page.channels.length + " CHANNELS" : "IDLE")
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

                // ── 右缘：实时读数（纸底 + 黑条，压在圆盘构图的留白上）────
                Column {
                    anchors.right: parent.right
                    anchors.rightMargin: 16
                    anchors.top: parent.top
                    anchors.topMargin: 24
                    spacing: 7
                    width: 168

                    Rectangle {
                        width: parent.width
                        height: 16
                        color: T.INK
                    }

                    Text {
                        text: "干道状态"
                        font.family: T.FONT_MONO
                        font.pixelSize: 10
                        color: T.MUTED
                    }

                    Meter {
                        width: parent.width
                        label: "上行（对端）"
                        bytesPerSec: page.metrics.rateToPeer || 0
                        up: true
                    }

                    Meter {
                        width: parent.width
                        label: "下行（对端）"
                        bytesPerSec: page.metrics.rateFromPeer || 0
                        up: false
                    }

                    StatusReadout {
                        width: parent.width
                        label: "线路"
                        value: L.routeText(page.route.route)
                        valueColor: page.route.relayed ? T.WARN : T.INK
                    }

                    StatusReadout {
                        width: parent.width
                        label: "延迟"
                        value: page.route.ping === null || page.route.ping === undefined ? "—" : (page.route.ping + " ms")
                    }

                    StatusReadout {
                        width: parent.width
                        label: "累计上/下"
                        value: L.bytes(page.snapshot.bytesToPeer || 0) + " / " + L.bytes(page.snapshot.bytesFromPeer || 0)
                    }
                }

                // ── 左下角：后端状态（工程图角落注记）──────────────────────
                Text {
                    anchors.left: parent.left
                    anchors.leftMargin: 26
                    anchors.bottom: parent.bottom
                    anchors.bottomMargin: 14
                    text: "后端 " + (bridge.version.length ? "v" + bridge.version : "（读取中）") + "   ·   " + (bridge.ready ? "已连接" : "连接中")
                    font.family: T.FONT_MONO
                    font.pixelSize: 10
                    color: bridge.ready ? T.MUTED : T.WARN
                }
            }

            Plate {
                Layout.fillWidth: true
                Layout.preferredHeight: 132
                index: "02"
                title: "通道与流量"
                caption: page.channels.length + " 条规则"

                Column {
                    anchors.fill: parent
                    spacing: 4

                    Repeater {
                        model: page.channels.slice(0, 3)
                        delegate: StatusReadout {
                            required property var modelData
                            required property int index
                            width: parent.width
                            label: modelData.protocol + " " + (modelData.rule ? (modelData.rule.localPort + "→" + modelData.rule.remotePort) : "")
                                    + "  监听 " + (modelData.listen ? modelData.listen.port : "—")
                            value: (modelData.stats ? (modelData.stats.connections + " 连接 · ↓" + L.bytes(modelData.stats.bytesToPeer) + " ↑" + L.bytes(modelData.stats.bytesFromPeer)) : "—")
                            valueColor: modelData.stats && modelData.stats.connections > 0 ? T.GOOD : T.MUTED
                        }
                    }

                    Text {
                        visible: page.channels.length === 0
                        text: "本次会话还没有任何通道。启动后这里会逐条列出监听端口、连接数与双向字节。"
                        font.family: T.FONT_MONO
                        font.pixelSize: 11
                        color: T.MUTED
                        width: parent.width
                        wrapMode: Text.WordWrap
                    }
                }
            }

            Plate {
                Layout.fillWidth: true
                Layout.fillHeight: true
                index: "03"
                title: "会话日志"
                caption: "最后 " + Math.min(12, page.logs.length) + " 行"

                Flickable {
                    anchors.fill: parent
                    clip: true
                    contentHeight: logColumn.height
                    boundsBehavior: Flickable.StopAtBounds

                    Column {
                        id: logColumn
                        width: parent.width
                        spacing: 2

                        Repeater {
                            model: page.logs.slice(-12).reverse()
                            delegate: Text {
                                required property var modelData
                                width: logColumn.width
                                text: (typeof modelData === "string")
                                      ? modelData
                                      : ("[" + (modelData.level || "info") + "] " + (modelData.text || modelData.message || JSON.stringify(modelData)))
                                font.family: T.FONT_MONO
                                font.pixelSize: 10
                                color: T.INK
                                opacity: 0.85
                                wrapMode: Text.WordWrap
                            }
                        }

                        Text {
                            visible: page.logs.length === 0
                            text: "（暂无日志）"
                            font.family: T.FONT_MONO
                            font.pixelSize: 10
                            color: T.MUTED
                        }
                    }
                }
            }
        }

        // ══ 右列：参数 + 线路判定 + 连接说明 ═══════════════════════════
        ColumnLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            Layout.preferredWidth: 4
            spacing: 14

            Plate {
                Layout.fillWidth: true
                Layout.preferredHeight: 470
                index: "01"
                title: "会话参数"
                caption: page.role === "host" ? "房主" : "加入者"
                active: page.live

                Flickable {
                    anchors.fill: parent
                    clip: true
                    contentHeight: form.height
                    boundsBehavior: Flickable.StopAtBounds

                    Column {
                        id: form
                        width: parent.width
                        spacing: 12

                        ChoiceRow {
                            width: parent.width
                            label: "角色"
                            value: page.role
                            choices: [{ value: "host", text: "房主" }, { value: "joiner", text: "加入者" }]
                            onPicked: (v) => { page.role = v; page.refreshHints() }
                        }

                        ChoiceRow {
                            width: parent.width
                            label: "连接方式"
                            value: page.recipe
                            choices: {
                                var out = []
                                for (var i = 0; i < page.recipes.length; i++) {
                                    var r = page.recipes[i]
                                    out.push({ value: r.id, text: r.name, disabled: r.available === false })
                                }
                                return out
                            }
                            onPicked: (v) => {
                                page.recipe = v
                                if (v === "steam-tunnel")
                                    page.gamePort = page.gamePort || "3000"
                                page.refreshHints()
                            }
                        }

                        Text {
                            width: parent.width
                            text: {
                                for (var i = 0; i < page.recipes.length; i++) {
                                    if (page.recipes[i].id === page.recipe)
                                        return page.recipes[i].available === false ? ("不可用：" + (page.recipes[i].unavailableReason || "")) : page.recipes[i].summary
                                }
                                return ""
                            }
                            font.family: T.FONT_MONO
                            font.pixelSize: 10
                            color: page.recipes.some(function (r) { return r.id === page.recipe && r.available === false }) ? T.WARN : T.MUTED
                            wrapMode: Text.WordWrap
                        }

                        FieldInput {
                            width: parent.width
                            visible: page.localRecipe
                            label: "端口规则（每行一条）"
                            placeholder: L.RULE_HINT
                            multiline: true
                            text: page.rulesText
                            onTextChanged: page.rulesText = text
                        }

                        Text {
                            width: parent.width
                            visible: page.localRecipe
                            text: {
                                var parsed = L.parseRules(page.rulesText)
                                return parsed.ok ? ("已解析 " + parsed.rules.length + " 条规则：" + L.formatRules(parsed.rules).replace(/\n/g, " · ")) : ("规则有问题：" + parsed.error)
                            }
                            font.family: T.FONT_MONO
                            font.pixelSize: 10
                            color: L.parseRules(page.rulesText).ok ? T.MUTED : T.BAD
                            wrapMode: Text.WordWrap
                        }

                        FieldInput {
                            width: parent.width
                            visible: page.role === "joiner" && page.localRecipe
                            label: "房主地址（IP 或域名）"
                            placeholder: "例如 192.168.1.20"
                            text: page.remoteHost
                            onTextChanged: page.remoteHost = text
                        }

                        FieldInput {
                            width: parent.width
                            visible: page.localRecipe
                            label: "会话口令（两端必须一致，可留空 = 明文）"
                            placeholder: "留空表示不加密"
                            text: page.token
                            onTextChanged: page.token = text
                        }

                        FieldInput {
                            width: parent.width
                            visible: page.steamRecipe && page.role === "host"
                            label: "本地服务端口"
                            placeholder: "3000"
                            text: page.gamePort
                            onTextChanged: page.gamePort = text
                        }

                        FieldInput {
                            width: parent.width
                            visible: page.steamRecipe && page.role === "joiner"
                            label: "房主 SteamID"
                            placeholder: "17 位数字"
                            text: page.hostSteamId
                            onTextChanged: page.hostSteamId = text
                        }

                        FieldInput {
                            width: parent.width
                            visible: page.steamRecipe && page.role === "joiner"
                            label: "本机入口端口"
                            placeholder: "25565"
                            text: page.localPort
                            onTextChanged: page.localPort = text
                        }

                        FieldInput {
                            width: parent.width
                            visible: page.steamRecipe
                            label: "AppID（两端必须一致，测试用 480）"
                            placeholder: "480"
                            text: page.appId
                            onTextChanged: page.appId = text
                        }

                        FieldInput {
                            width: parent.width
                            visible: page.recipe === "lan-direct"
                            label: "服务端口"
                            placeholder: "3000"
                            text: page.gamePort
                            onTextChanged: page.gamePort = text
                        }

                        FieldInput {
                            width: parent.width
                            label: "服务名（可选，写入邀请与日志）"
                            placeholder: "例如 Minecraft"
                            text: page.game
                            onTextChanged: { page.game = text; page.refreshHints() }
                        }

                        FieldInput {
                            width: parent.width
                            visible: page.role === "joiner"
                            label: "邀请码（粘贴后点右侧解析）"
                            placeholder: "SHL1-..."
                            text: page.inviteCode
                            onTextChanged: page.inviteCode = text
                        }

                        Flow {
                            width: parent.width
                            spacing: 8

                            PlateButton {
                                label: page.live || page.busy ? "停止会话" : "启动会话"
                                primary: !page.live && !page.busy
                                enabled: !page.busy && bridge.ready
                                onClicked: page.live ? page.stop() : page.start()
                            }

                            PlateButton {
                                visible: page.role === "joiner"
                                label: "解析邀请码"
                                enabled: page.inviteCode.length > 0
                                onClicked: page.applyInvite()
                            }

                            PlateButton {
                                label: "端口检查"
                                onClicked: page.checkFirstPort()
                            }

                            PlateButton {
                                label: "刷新状态"
                                onClicked: { page.refreshStatus(); page.refreshRoute(); page.refreshHints() }
                            }
                        }

                        Text {
                            width: parent.width
                            visible: page.notice.length > 0
                            text: page.notice
                            font.family: T.FONT_MONO
                            font.pixelSize: 11
                            color: page.noticeBad ? T.BAD : T.GOOD
                            wrapMode: Text.WordWrap
                        }

                        Text {
                            width: parent.width
                            visible: !bridge.ready
                            text: "后端未就绪：界面只显示本地状态，不会伪造“已连接”。"
                            font.family: T.FONT_MONO
                            font.pixelSize: 10
                            color: T.WARN
                            wrapMode: Text.WordWrap
                        }
                    }
                }
            }

            Plate {
                Layout.fillWidth: true
                Layout.preferredHeight: 192
                index: "04"
                title: "线路判定"
                caption: "来自 Steam 自己报的 POP"

                Column {
                    anchors.fill: parent
                    spacing: 3

                    StatusReadout {
                        width: parent.width
                        label: "线路"
                        value: L.routeText(page.route.route)
                        valueColor: page.route.relayed ? T.WARN : T.INK
                        strong: true
                    }
                    StatusReadout {
                        width: parent.width
                        label: "上报标签"
                        value: page.route.routeLabel || "—"
                    }
                    StatusReadout {
                        width: parent.width
                        label: "中继 POP / 远端 POP"
                        value: (page.route.relayPop || "—") + " / " + (page.route.remotePop || "—")
                    }
                    StatusReadout {
                        width: parent.width
                        label: "远端地址"
                        value: page.route.remoteAddress || "—"
                    }
                    StatusReadout {
                        width: parent.width
                        label: "发送上限"
                        value: L.speed(page.route.sendRateBytesPerSecond)
                    }
                    StatusReadout {
                        width: parent.width
                        label: "可靠队列（待发/未确认）"
                        value: (page.route.pendingReliable === undefined || page.route.pendingReliable === null ? "—" : page.route.pendingReliable)
                               + " / " + (page.route.sentUnackedReliable === undefined || page.route.sentUnackedReliable === null ? "—" : page.route.sentUnackedReliable)
                    }
                    Text {
                        width: parent.width
                        text: page.route.reason ? ("说明：" + page.route.reason) : (page.live ? "" : "会话未运行时线路一律显示“未判定”。")
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
                index: "05"
                title: "两端怎么连"
                caption: "由连接方式生成"

                Column {
                    anchors.fill: parent
                    spacing: 4

                    Text {
                        text: page.role === "host" ? "房主" : "加入者"
                        font.family: T.FONT_MONO
                        font.pixelSize: 10
                        color: T.COBALT
                    }

                    Repeater {
                        model: page.role === "host" ? (page.hints.hostHint || []) : (page.hints.clientHint || [])
                        delegate: Text {
                            required property var modelData
                            width: parent.width
                            text: "· " + modelData
                            font.family: T.FONT_MONO
                            font.pixelSize: 10
                            color: T.INK
                            wrapMode: Text.WordWrap
                        }
                    }

                    Text {
                        visible: (page.hints.hostHint || []).length === 0 && (page.hints.clientHint || []).length === 0
                        text: "（还没有连接说明）"
                        font.family: T.FONT_MONO
                        font.pixelSize: 10
                        color: T.MUTED
                    }
                }
            }
        }
    }

    // ── 内存验收专用：无人值守地真的开一次会话、再停掉 ──────────────────
    // 只在命令行给了 --session-start / --session-stop 时激活，正常启动完全不受影响。
    Timer {
        id: autoSessionTimer
        interval: (typeof sessionStartDelayMs !== "undefined" && sessionStartDelayMs > 0) ? sessionStartDelayMs : 999999
        running: (typeof autoSession !== "undefined") && autoSession && !page.autoSessionFired
        repeat: false
        onTriggered: {
            page.autoSessionFired = true
            page.start()
        }
    }

    Timer {
        id: autoStopTimer
        interval: (typeof sessionStopDelayMs !== "undefined" && sessionStopDelayMs > 0) ? sessionStopDelayMs : 999999
        running: (typeof autoSession !== "undefined") && autoSession && (typeof sessionStopDelayMs !== "undefined") && sessionStopDelayMs > 0
        repeat: false
        onTriggered: page.stop()
    }
}
