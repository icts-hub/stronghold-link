import QtQuick
import QtQuick.Layouts
import "../Components"
import "../theme.js" as T

// 一级页 3/3：设置。版面按"工程蓝图 / 技术档案"处理：编号、细线、坐标、分组。
// 只放真正接通后端的东西：线路档位、诊断入口、配置目录、版本、会话档案导入导出。
Item {
    id: page

    property bool active: true
    property int motionTier: 2
    // 切页入场：外壳（Main.qml 的 revealPage）会把这两个属性一起写下去。
    property bool revealed: true
    property bool ambient: true

    signal notice(string text, bool bad)
    signal motionTierPicked(int tier)

    property var settings: ({})
    property var info: ({})
    property var metrics: ({})
    property var portsReport: ({})
    property var routesReport: ({})
    property var relayReport: ({})
    property var steamReport: ({})
    property string profilesText: ""

    property int pendingSettings: 0
    property int pendingInfo: 0
    property int pendingMetrics: 0
    property int pendingPorts: 0
    property int pendingRoutes: 0
    property int pendingRelay: 0
    property int pendingSteam: 0
    property int pendingProfilesLoad: 0
    property int pendingProfilesSave: 0
    property int pendingReveal: 0

    readonly property string transport: settings.transport ? String(settings.transport) : "env"
    readonly property var transportChoices: (settings.choices && settings.choices.length) ? settings.choices : ["env", "auto", "ice", "relay"]
    readonly property var transportLabels: settings.labels ? settings.labels : ({})
    readonly property string effectiveLabel: settings.effectiveLabel ? String(settings.effectiveLabel) : "—"
    readonly property string envKey: settings.envKey ? String(settings.envKey) : "SHL_STEAM_TRANSPORT"
    readonly property string envValue: settings.envValue ? String(settings.envValue) : "（未设置）"

    function say(text, bad) {
        notice(String(text === undefined || text === null ? "" : text), bad === true)
    }

    function loadSettings() {
        pendingSettings = bridge.call("settings.load", {})
    }

    function saveTransport(value) {
        pendingSettings = bridge.call("settings.save", { transport: value })
    }

    function loadInfo() {
        pendingInfo = bridge.call("app.info", {})
        pendingMetrics = bridge.call("app.metrics", {})
    }

    function loadProfiles() {
        pendingProfilesLoad = bridge.call("profiles.load", {})
    }

    function saveProfiles() {
        var parsed = null
        try {
            parsed = JSON.parse(profilesText)
        } catch (e) {
            say("档案 JSON 解析失败：" + e.message, true)
            return
        }
        if (!parsed || typeof parsed !== "object") {
            say("档案必须是一个 JSON 对象", true)
            return
        }
        pendingProfilesSave = bridge.call("profiles.save", parsed)
    }

    function runPorts() {
        pendingPorts = bridge.call("network.listeningPorts", {})
    }

    function runRoutes() {
        pendingRoutes = bridge.call("network.routes", {})
    }

    function runRelay() {
        pendingRelay = bridge.call("network.relaySelfTest", {})
    }

    function runSteam() {
        pendingSteam = bridge.call("steam.diagnose", {})
    }

    Component.onCompleted: {
        loadSettings()
        loadInfo()
        loadProfiles()
    }

    onActiveChanged: {
        if (active)
            loadInfo()
    }

    Timer {
        interval: 3000
        repeat: true
        running: page.active
        onTriggered: page.loadInfo()
    }

    Connections {
        target: bridge

        function onResponse(id, ok, result, code, message) {
            var err = (code ? "[" + code + "] " : "") + (message || "请求失败")

            if (id === page.pendingSettings) {
                if (ok) {
                    page.settings = result || ({})
                    page.say("线路档位已保存，实际生效：" + (result && result.effectiveLabel ? result.effectiveLabel : "—"), false)
                } else {
                    page.say(err, true)
                }
                return
            }
            if (id === page.pendingInfo) {
                if (ok)
                    page.info = result || ({})
                return
            }
            if (id === page.pendingMetrics) {
                if (ok) {
                    page.metrics = result || ({})
                }
                return
            }
            if (id === page.pendingProfilesLoad) {
                if (ok) {
                    page.profilesText = JSON.stringify(result || ({ profiles: [] }), null, 2)
                    page.say("已载入会话档案（game-profiles.json）", false)
                } else {
                    page.say(err, true)
                }
                return
            }
            if (id === page.pendingProfilesSave) {
                page.say(ok ? "会话档案已写入" : err, !ok)
                return
            }
            if (id === page.pendingReveal) {
                page.say(ok ? "已打开配置目录" : err, !ok)
                return
            }
            if (id === page.pendingPorts) {
                page.portsReport = ok ? (result || ({})) : ({ ok: false, reason: err })
                return
            }
            if (id === page.pendingRoutes) {
                page.routesReport = ok ? (result || ({})) : ({ ok: false, reason: err })
                return
            }
            if (id === page.pendingRelay) {
                page.relayReport = ok ? (result || ({})) : ({ measured: false, reason: err })
                return
            }
            if (id === page.pendingSteam) {
                page.steamReport = ok ? (result || ({})) : ({ available: false, blockers: [err], steps: [] })
                return
            }
        }
    }

    RowLayout {
        anchors.fill: parent
        spacing: 16

        // ══ 左列：线路档位 + 动效档位 + 版本路径 ══════════════════════
        ColumnLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            Layout.preferredWidth: 5
            spacing: 14

            // ══ 左列顶部：设置档案图版（沿用会话页/好友页那套刊头构图）═══════
            // 参考项目每个页面都有一张自己的主图版：设置页是 recordPlate —— 一张
            // 工程图纸：字距网格、尺寸标注、记录行、大号空心编号、裁切角标。
            // 原来这里只是 118px 高的通用 PaperPlate，跟参考不是同一种东西。
            Item {
                Layout.fillWidth: true
                Layout.preferredHeight: 430
                Layout.minimumHeight: 300

                // 三栏并排：刊头（左，226px）· 图版（中，正方形）· 运行读数（右，176px）。
                // 宽高比锁正方形，Canvas 的宽高比与作图空间一致，图上的圆与方不会被拉变形。
                // 主纹样系统 = 模板 C（鸟群 + 坐标轴 + 几何轨迹）：这一页是诊断与参数，
                // 用坐标网、角度刻度、分区编号与一条轨迹上的鸟群，把"技术"与"象征"接在一起。
                MotifPlate {
                    id: settingPlate
                    anchors.horizontalCenter: parent.horizontalCenter
                    anchors.horizontalCenterOffset: 30
                    anchors.verticalCenter: parent.verticalCenter
                    width: Math.min(parent.height, parent.width - 2 * 260)
                    height: width
                    template: "C"
                    active: page.active !== false
                    revealed: page.revealed !== false
                    ambient: page.ambient !== false
                    seed: 131
                    mark: "03"
                    caption: "TRAJECTORY"
                }

                // ── 左半：刊头 ─────────────────────────────────────────────
                Column {
                    anchors.left: parent.left
                    anchors.leftMargin: 26
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.verticalCenterOffset: 6
                    width: 226
                    spacing: 0

                    Item {
                        width: badgeBarS.width + 6 + badgeTailS.width
                        height: 30

                        Rectangle {
                            id: badgeBarS
                            width: badgeTextS.width + 22
                            height: parent.height
                            color: T.INK
                        }

                        Text {
                            id: badgeTextS
                            anchors.left: parent.left
                            anchors.leftMargin: 11
                            anchors.verticalCenter: parent.verticalCenter
                            text: "SETTING DOSSIER / 03"
                            font.family: T.FONT_MONO
                            font.pixelSize: 12
                            font.letterSpacing: 2.4
                            color: T.PAPER
                        }

                        Rectangle {
                            id: badgeTailS
                            anchors.left: badgeBarS.right
                            anchors.leftMargin: 6
                            anchors.verticalCenter: parent.verticalCenter
                            width: 24
                            height: parent.height
                            color: T.ACCENT
                        }
                    }

                    Item { width: 1; height: 22 }

                    Text {
                        text: "Setting"
                        font.family: T.FONT_DISPLAY
                        font.pixelSize: 52
                        color: T.INK
                    }

                    Text {
                        text: "Dossier"
                        font.family: T.FONT_DISPLAY
                        font.pixelSize: 52
                        color: T.INK
                        leftPadding: 78
                        topPadding: -10
                    }

                    Item { width: 1; height: 14 }

                    Row {
                        spacing: 14

                        Rectangle {
                            width: 52
                            height: 1
                            color: T.INK
                            anchors.verticalCenter: parent.verticalCenter
                        }

                        Text {
                            text: "设置档案"
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

                    Item { width: 1; height: 16 }

                    Text {
                        text: "线路档位、诊断入口、配置与版本。"
                        font.family: T.FONT_SERIF_CN
                        font.pixelSize: 14
                        color: T.MUTED
                    }

                    Text {
                        text: "这里没有的开关，界面上也不会出现。"
                        font.family: T.FONT_SERIF_CN
                        font.pixelSize: 14
                        color: T.MUTED
                    }

                    Item { width: 1; height: 20 }

                    // 深色行动条：动作就是"线路自检"（端口 / 线路 / Relay）
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
                            onClicked: {
                                page.runPorts()
                                page.runRoutes()
                                page.runRelay()
                            }
                        }

                        Row {
                            anchors.left: parent.left
                            anchors.leftMargin: 16
                            anchors.verticalCenter: parent.verticalCenter
                            spacing: 12

                            Text {
                                text: "线路自检"
                                font.family: T.FONT_SANS
                                font.pixelSize: 17
                                color: T.PAPER
                                anchors.verticalCenter: parent.verticalCenter
                            }

                            Text {
                                text: "PORTS · ROUTES · RELAY"
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

                // ── 右缘：运行读数 ────────────────────────────────────────
                Column {
                    anchors.right: parent.right
                    anchors.rightMargin: 16
                    anchors.top: parent.top
                    anchors.topMargin: 20
                    spacing: 6
                    width: 176

                    Rectangle {
                        width: parent.width
                        height: 16
                        color: T.INK
                    }

                    Text {
                        text: "RUNTIME · " + (bridge.version.length ? bridge.version : "—")
                        font.family: T.FONT_MONO
                        font.pixelSize: 10
                        color: T.COBALT
                    }

                    StatusReadout {
                        width: parent.width
                        label: "版本"
                        value: bridge.version.length ? bridge.version : "—"
                    }

                    StatusReadout {
                        width: parent.width
                        label: "后端 RSS"
                        value: page.metrics.rssBytes !== undefined ? T.fmtBytes(page.metrics.rssBytes) : "—"
                        valueColor: page.metrics.rssBytes > 104857600 ? T.WARN : T.INK
                    }

                    StatusReadout {
                        width: parent.width
                        label: "后端运行"
                        value: page.metrics.uptimeMs !== undefined ? T.fmtDuration(page.metrics.uptimeMs) : "—"
                    }

                    StatusReadout {
                        width: parent.width
                        label: "实际线路"
                        value: page.effectiveLabel
                    }
                }

                // ── 左下角：环境变量摘要 ──────────────────────────────────
                Text {
                    anchors.left: parent.left
                    anchors.leftMargin: 26
                    anchors.bottom: parent.bottom
                    anchors.bottomMargin: 10
                    text: page.envKey + " = " + page.envValue
                    font.family: T.FONT_MONO
                    font.pixelSize: 10
                    color: T.MUTED
                }
            }

            Plate {
                Layout.fillWidth: true
                Layout.preferredHeight: 208
                index: "01"
                title: "线路档位"
                caption: "写入 settings.json"

                Column {
                    anchors.fill: parent
                    spacing: 8

                    ChoiceRow {
                        width: parent.width
                        label: "Steam 数据报线路"
                        value: page.transport
                        choices: {
                            var out = []
                            for (var i = 0; i < page.transportChoices.length; i++) {
                                var v = page.transportChoices[i]
                                out.push({ value: v, text: page.transportLabels[v] ? page.transportLabels[v] : v })
                            }
                            return out
                        }
                        onPicked: (v) => page.saveTransport(v)
                    }

                    StatusReadout {
                        width: parent.width
                        label: "实际生效"
                        value: page.effectiveLabel
                        strong: true
                        valueColor: page.effectiveLabel === "强制中继" ? T.WARN : T.INK
                    }

                    StatusReadout {
                        width: parent.width
                        label: "环境变量"
                        value: page.envKey + " = " + page.envValue
                    }

                    Text {
                        width: parent.width
                        text: "档位改了只影响之后启动的会话；正在运行的会话要先停止再启动才会用新档位。"
                        font.family: T.FONT_MONO
                        font.pixelSize: 10
                        color: T.MUTED
                        wrapMode: Text.WordWrap
                    }
                }
            }

            Plate {
                Layout.fillWidth: true
                Layout.preferredHeight: 150
                index: "02"
                title: "动效档位"
                caption: "只改界面，不写配置"

                Column {
                    anchors.fill: parent
                    spacing: 6

                    ChoiceRow {
                        width: parent.width
                        label: "装饰动画"
                        value: page.motionTier === 2 ? "full" : (page.motionTier === 1 ? "normal" : "min")
                        choices: [
                            { value: "full", text: "完整" },
                            { value: "normal", text: "标准" },
                            { value: "min", text: "最低" }
                        ]
                        onPicked: (v) => page.motionTierPicked(v === "full" ? 2 : (v === "normal" ? 1 : 0))
                    }

                    Text {
                        width: parent.width
                        text: "动效档位只决定手绘元素的入场与悬停动画；窗口最小化时装饰动画一律停止，但会话与后端继续运行。这一项是本次运行的界面偏好，不写进配置文件。"
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
                title: "版本与路径"
                caption: page.info.node ? String(page.info.node) : "—"

                Column {
                    anchors.fill: parent
                    spacing: 3

                    StatusReadout { width: parent.width; label: "应用版本"; value: page.info.version ? String(page.info.version) : (bridge.version || "—"); strong: true }
                    StatusReadout { width: parent.width; label: "后端 pid / 平台"; value: (page.info.pid !== undefined ? String(page.info.pid) : "—") + "   ·   " + (page.info.platform || "—") + "/" + (page.info.arch || "—") }
                    StatusReadout { width: parent.width; label: "安装目录"; value: page.info.appDir ? String(page.info.appDir) : "—" }
                    StatusReadout { width: parent.width; label: "配置目录"; value: page.info.configDir ? String(page.info.configDir) : (bridge.configDir || "—") }
                    StatusReadout { width: parent.width; label: "设置文件"; value: page.info.settingsFile ? String(page.info.settingsFile) : "—" }
                    StatusReadout { width: parent.width; label: "日志文件"; value: page.info.logFile ? String(page.info.logFile) : (bridge.logPath || "—") }
                    StatusReadout { width: parent.width; label: "后端脚本"; value: bridge.backendPath.length ? bridge.backendPath : "—" }
                    StatusReadout { width: parent.width; label: "Node 可执行"; value: bridge.nodePath.length ? bridge.nodePath : "—" }

                    Flow {
                        width: parent.width
                        spacing: 8

                        PlateButton {
                            label: "打开配置目录"
                            enabled: bridge.ready
                            onClicked: { page.pendingReveal = bridge.call("app.revealConfig", {}) }
                        }

                        PlateButton {
                            label: "后端诊断输出"
                            hint: "stderr"
                            onClicked: page.say(bridge.stderrTail().length ? bridge.stderrTail() : "（stderr 暂无输出）", false)
                        }
                    }
                }
            }
        }

        // ══ 右列：诊断 + 档案 + 内存读数 ══════════════════════════════
        ColumnLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            Layout.preferredWidth: 4
            spacing: 14

            Plate {
                Layout.fillWidth: true
                Layout.preferredHeight: 268
                index: "04"
                title: "诊断入口"
                caption: "都来自后端真实调用"

                Column {
                    anchors.fill: parent
                    spacing: 6

                    Flow {
                        width: parent.width
                        spacing: 8

                        PlateButton { label: "本机监听端口"; onClicked: page.runPorts() }
                        PlateButton { label: "线路候选"; onClicked: page.runRoutes() }
                        PlateButton { label: "Relay 自检"; onClicked: page.runRelay() }
                        PlateButton { label: "Steam 诊断"; onClicked: page.runSteam() }
                    }

                    Text {
                        width: parent.width
                        text: {
                            var lines = []
                            if (page.portsReport.ok === true)
                                lines.push("监听端口候选 " + (page.portsReport.candidates ? page.portsReport.candidates.length : 0) + " 条"
                                           + (page.portsReport.game && page.portsReport.game.name ? ("，识别到游戏：" + page.portsReport.game.name) : "")
                                           + (page.portsReport.steamPick ? ("，建议服务端口 " + page.portsReport.steamPick) : ""))
                            else if (page.portsReport.reason)
                                lines.push("监听端口：" + page.portsReport.reason)

                            if (page.routesReport.ok === true)
                                lines.push("线路候选 " + (page.routesReport.candidates ? page.routesReport.candidates.length : 0) + " 条，measured=" + page.routesReport.measured)
                            else if (page.routesReport.reason)
                                lines.push("线路：" + page.routesReport.reason)

                            if (page.relayReport.measured === true)
                                lines.push("Relay 自检：" + (page.relayReport.availability || "—") + (page.relayReport.label ? ("（" + page.relayReport.label + "）") : ""))
                            else if (page.relayReport.reason)
                                lines.push("Relay 自检：" + page.relayReport.reason)

                            if (page.steamReport.available !== undefined)
                                lines.push("Steam：" + (page.steamReport.available ? "就绪" : ("未就绪 —— " + ((page.steamReport.blockers || []).join("；") || "未知"))))

                            return lines.length ? lines.join("\n") : "点上面的按键取一次真实结果；这里只显示后端返回的内容。"
                        }
                        font.family: T.FONT_MONO
                        font.pixelSize: 10
                        color: page.steamReport.available === false ? T.WARN : T.INK
                        wrapMode: Text.WordWrap
                    }

                    Text {
                        width: parent.width
                        text: "多通道选路（docs/多通道选路设计.md）尚未实现：这里不提供切换开关，也不显示为可用能力。"
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
                title: "会话档案"
                caption: "game-profiles.json"

                Column {
                    anchors.fill: parent
                    spacing: 6

                    FieldInput {
                        width: parent.width
                        label: "档案 JSON（导出 = 复制这段；导入 = 粘贴后保存）"
                        multiline: true
                        text: page.profilesText
                        onTextChanged: page.profilesText = text
                    }

                    Flow {
                        width: parent.width
                        spacing: 8

                        PlateButton { label: "重新载入"; onClicked: page.loadProfiles() }
                        PlateButton { label: "保存到后端"; primary: true; onClicked: page.saveProfiles() }
                        PlateButton { label: "复制到剪贴板"; onClicked: { clipboardHelper.selectAll(); clipboardHelper.copy(); page.say("档案 JSON 已复制", false) } }
                    }

                    Text {
                        width: parent.width
                        text: "档案文件就是 Electron 版一直在用的那一份，位置见左侧\"设置文件\"。导入后立即对下一次启动生效。"
                        font.family: T.FONT_MONO
                        font.pixelSize: 10
                        color: T.MUTED
                        wrapMode: Text.WordWrap
                    }
                }
            }

            Plate {
                Layout.fillWidth: true
                Layout.preferredHeight: 176
                index: "06"
                title: "内存读数"
                caption: "100 MiB 口径说明"

                Column {
                    anchors.fill: parent
                    spacing: 3

                    StatusReadout { width: parent.width; label: "后端 RSS"; value: page.metrics.rssBytes !== undefined ? T.fmtBytes(page.metrics.rssBytes) : "—"; valueColor: page.metrics.rssBytes > 104857600 ? T.WARN : T.INK; strong: true }
                    StatusReadout { width: parent.width; label: "后端 heap 已用/总量"; value: (page.metrics.heapUsedBytes !== undefined ? T.fmtBytes(page.metrics.heapUsedBytes) : "—") + " / " + (page.metrics.heapTotalBytes !== undefined ? T.fmtBytes(page.metrics.heapTotalBytes) : "—") }
                    StatusReadout { width: parent.width; label: "后端 external"; value: page.metrics.externalBytes !== undefined ? T.fmtBytes(page.metrics.externalBytes) : "—" }

                    Text {
                        width: parent.width
                        text: "这里只是后端进程自己的读数。验收要的是\"Qt 主进程 + Node 子进程\"整棵进程树的 Working Set，由 tools/measure-memory.* 逐秒采样并出原始 CSV —— 界面上的数字不作为验收证据。"
                        font.family: T.FONT_MONO
                        font.pixelSize: 10
                        color: T.MUTED
                        wrapMode: Text.WordWrap
                    }
                }
            }
        }
    }

    // 给"复制到剪贴板"用的隐藏编辑框（QML 里只有 TextEdit 有 selectAll/copy）
    TextEdit {
        id: clipboardHelper
        visible: false
        width: 0
        height: 0
        text: page.profilesText
    }
}
