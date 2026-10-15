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

            PaperPlate {
                Layout.fillWidth: true
                Layout.preferredHeight: 286
                seed: 20260419
                showDots: true

                // 主视觉：干道圆环 + 放射构图线 + 通道节点
                Item {
                    id: stage
                    anchors.fill: parent
                    anchors.rightMargin: 178

                    SketchRing {
                        id: orbit
                        anchors.centerIn: parent
                        radius: Math.min(stage.width, stage.height) * 0.34
                        seed: 771
                        weight: 1.3
                        ticks: true
                        tickCount: 48
                        tickLength: 5
                        stroke: T.INK
                    }

                    SketchRing {
                        anchors.centerIn: parent
                        radius: Math.min(stage.width, stage.height) * 0.22
                        seed: 1789
                        weight: 1
                        doubleStroke: false
                        stroke: page.live ? T.COBALT : T.LINE
                    }

                    SketchRing {
                        anchors.centerIn: parent
                        radius: Math.min(stage.width, stage.height) * 0.42
                        seed: 31337
                        weight: 0.9
                        doubleStroke: false
                        ticks: true
                        tickCount: 12
                        tickLength: 9
                        stroke: T.LINE_SOFT
                    }

                    Repeater {
                        model: 4
                        delegate: SketchRule {
                            anchors.fill: parent
                            x1: stage.width / 2
                            y1: stage.height / 2
                            x2: stage.width / 2 + (stage.width * 0.46) * Math.cos(index * Math.PI / 4 + 0.35)
                            y2: stage.height / 2 + (stage.height * 0.46) * Math.sin(index * Math.PI / 4 + 0.35)
                            seed: 900 + index * 17
                            stroke: T.LINE_SOFT
                            weight: 1
                        }
                    }

                    // 通道节点：每个监听端口是一个编号节点
                    Repeater {
                        model: page.channels.slice(0, 4)
                        delegate: Item {
                            required property var modelData
                            required property int index

                            readonly property real angle: -1.05 + index * 0.72
                            x: stage.width / 2 + orbit.radius * Math.cos(angle) - width / 2
                            y: stage.height / 2 + orbit.radius * Math.sin(angle) - height / 2
                            width: 128
                            height: 34

                            Rectangle {
                                anchors.fill: parent
                                color: T.PAPER
                                opacity: 0.86
                            }

                            Text {
                                anchors.centerIn: parent
                                text: "0" + (index + 1) + "  " + modelData.protocol + " :" + (modelData.rule ? modelData.rule.localPort : "")
                                font.family: T.FONT_MONO
                                font.pixelSize: 10
                                color: T.INK
                            }

                            SketchRing {
                                anchors.left: parent.left
                                anchors.verticalCenter: parent.verticalCenter
                                radius: 3.5
                                weight: 1.2
                                doubleStroke: false
                                stroke: page.live ? T.COBALT : T.MUTED
                                seed: 500 + index
                                width: 14
                                height: 14
                            }
                        }
                    }

                    // 左下：会话标题与状态
                    Column {
                        anchors.left: parent.left
                        anchors.bottom: parent.bottom
                        spacing: 2

                        Text {
                            text: "STRONGHOLD LINK"
                            font.family: T.FONT_DISPLAY
                            font.pixelSize: 27
                            color: T.INK
                        }

                        Text {
                            text: "会话 / SESSION   ·   " + (page.role === "host" ? "房主" : "加入者") + "   ·   " + page.recipe
                            font.family: T.FONT_MONO
                            font.pixelSize: 10
                            color: T.MUTED
                        }

                        Text {
                            text: "后端 " + (bridge.version.length ? "v" + bridge.version : "（读取中）") + "   ·   " + (bridge.ready ? "已连接" : "连接中")
                            font.family: T.FONT_MONO
                            font.pixelSize: 10
                            color: bridge.ready ? T.MUTED : T.WARN
                        }
                    }

                    // 右下：状态圆环读数
                    Column {
                        anchors.right: parent.right
                        anchors.bottom: parent.bottom
                        anchors.rightMargin: 6
                        spacing: 1

                        Text {
                            text: L.stateLabel(page.sessionState)
                            font.family: T.FONT_DISPLAY
                            font.pixelSize: 22
                            color: page.stateColor()
                            anchors.right: parent.right
                        }

                        Text {
                            text: page.live ? "已监听 " + page.channels.length + " 条通道" : "未启动"
                            font.family: T.FONT_MONO
                            font.pixelSize: 10
                            color: T.MUTED
                            anchors.right: parent.right
                        }
                    }
                }

                // 右侧竖排旁注（工程图边缘文字）
                Column {
                    anchors.right: parent.right
                    anchors.top: parent.top
                    anchors.topMargin: 4
                    spacing: 6
                    width: 160

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
