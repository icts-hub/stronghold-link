import QtQuick
import QtQuick.Layouts
import "Components"
import "Pages"
import "theme.js" as T

// Stronghold Link — Qt Quick 前端外壳。
// 一级导航只有三项：会话 / 好友 / 设置。窗口最小化时装饰动画停止，后端照常运行。
Window {
    id: root

    width: (typeof initialWidth !== "undefined" && initialWidth > 0) ? initialWidth : 1440
    height: (typeof initialHeight !== "undefined" && initialHeight > 0) ? initialHeight : 900
    minimumWidth: 1024
    minimumHeight: 720
    visible: true
    color: T.PAPER
    title: "Stronghold Link"

    property string currentPage: (typeof initialPage !== "undefined" && initialPage !== "") ? initialPage : "session"
    // 动效档位：2 完整 / 1 标准 / 0 最低。只影响界面装饰，不写后端配置，也不影响会话。
    property int motionTier: 2
    readonly property bool awake: root.visible && root.visibility !== Window.Minimized
    readonly property int pageIndex: currentPage === "friends" ? 1 : (currentPage === "setting" ? 2 : 0)

    property string banner: ""
    property bool bannerBad: false
    property var metrics: ({})
    property int pendingMetrics: 0

    readonly property var navItems: [
        { key: "session", index: "01", label: "会话", caption: "SESSION · 房主与加入者" },
        { key: "friends", index: "02", label: "好友", caption: "FRIENDS · Steam 大厅" },
        { key: "setting", index: "03", label: "设置", caption: "SETTING · 线路与诊断" }
    ]

    function note(text, bad) {
        banner = String(text === undefined || text === null ? "" : text)
        bannerBad = bad === true
    }

    function pollMetrics() {
        pendingMetrics = bridge.call("app.metrics", {})
    }

    Shortcut { sequence: "Ctrl+1"; onActivated: root.currentPage = "session" }
    Shortcut { sequence: "Ctrl+2"; onActivated: root.currentPage = "friends" }
    Shortcut { sequence: "Ctrl+3"; onActivated: root.currentPage = "setting" }

    // ══ 顶栏 ═══════════════════════════════════════════════════════════
    Item {
        id: top
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.margins: 18
        height: 78

        Column {
            anchors.left: parent.left
            anchors.top: parent.top
            spacing: 1

            Text {
                text: "STRONGHOLD LINK  <font size=\"3\" color=\"" + T.MUTED + "\">干线隧道控制台</font>"
                textFormat: Text.RichText
                font.family: T.FONT_DISPLAY
                font.pixelSize: 30
                color: T.INK
            }

            Text {
                text: "TUNNEL CONSOLE  ·  Qt Quick 前端 / Node 常驻后端  ·  Ctrl+1/2/3 切换页面"
                font.family: T.FONT_MONO
                font.pixelSize: 10
                color: T.MUTED
            }
        }

        // 右上：后端连接状态
        Row {
            anchors.right: parent.right
            anchors.top: parent.top
            spacing: 12

            Column {
                spacing: 2

                Text {
                    anchors.right: parent.right
                    text: bridge.ready ? ("后端已连接  v" + (bridge.version.length ? bridge.version : "?"))
                                       : (bridge.running ? "后端启动中…" : "后端未运行")
                    font.family: T.FONT_MONO
                    font.pixelSize: 11
                    color: bridge.ready ? T.GOOD : T.WARN
                }

                Text {
                    anchors.right: parent.right
                    text: "pid " + (metrics && metrics.uptimeMs !== undefined ? "运行 " + T.fmtDuration(metrics.uptimeMs) : "—")
                          + "  ·  RSS " + (metrics && metrics.rssBytes !== undefined ? T.fmtBytes(metrics.rssBytes) : "—")
                    font.family: T.FONT_MONO
                    font.pixelSize: 10
                    color: T.MUTED
                }

                Text {
                    anchors.right: parent.right
                    visible: bridge.lastError.length > 0 && !bridge.ready
                    text: bridge.lastError
                    font.family: T.FONT_MONO
                    font.pixelSize: 10
                    color: T.BAD
                }
            }

            Column {
                spacing: 4
                anchors.top: parent.top

                PlateButton {
                    label: "读取后端信息"
                    onClicked: root.pollMetrics()
                }

                PlateButton {
                    label: "重启后端"
                    hint: "不动会话以外的界面"
                    onClicked: {
                        root.note("正在重启后端…", false)
                        bridge.stop()
                        bridge.start()
                    }
                }
            }
        }

        SketchRule {
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            height: 8
            x1: 0
            y1: 4
            x2: width
            y2: 4
            seed: 4711
            weight: 1.4
            doubleStroke: true
            endTicks: true
            stroke: T.LINE
        }
    }

    // ══ 一级导航（只有三项） ════════════════════════════════════════════
    NavBar {
        id: nav
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: top.bottom
        anchors.leftMargin: 18
        anchors.rightMargin: 18
        anchors.topMargin: 4
        current: root.currentPage
        items: root.navItems
        onSelected: (key) => { root.currentPage = key }
    }

    // ══ 页面 ═══════════════════════════════════════════════════════════
    StackLayout {
        id: stack
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: nav.bottom
        anchors.bottom: footer.top
        anchors.margins: 18
        anchors.topMargin: 12
        anchors.bottomMargin: 6
        currentIndex: root.pageIndex

        SessionPage {
            active: root.awake && root.currentPage === "session"
            motionTier: root.motionTier
        }

        FriendsPage {
            active: root.awake && root.currentPage === "friends"
            motionTier: root.motionTier
            onNotice: (text, bad) => root.note(text, bad)
        }

        SettingPage {
            active: root.awake && root.currentPage === "setting"
            motionTier: root.motionTier
            onNotice: (text, bad) => root.note(text, bad)
            onMotionTierPicked: (tier) => { root.motionTier = tier }
        }
    }

    // ══ 提示条 ═════════════════════════════════════════════════════════
    Rectangle {
        id: bannerBox
        visible: root.banner.length > 0
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: footer.top
        anchors.leftMargin: 18
        anchors.rightMargin: 18
        anchors.bottomMargin: 6
        height: visible ? 26 : 0
        color: "transparent"
        border.width: 1
        border.color: root.bannerBad ? T.BAD : T.COBALT

        Text {
            anchors.left: parent.left
            anchors.leftMargin: 10
            anchors.verticalCenter: parent.verticalCenter
            text: root.banner
            font.family: T.FONT_MONO
            font.pixelSize: 11
            color: root.bannerBad ? T.BAD : T.INK
        }

        MouseArea {
            anchors.fill: parent
            onClicked: root.banner = ""
        }
    }

    // ══ 页脚 ═══════════════════════════════════════════════════════════
    Item {
        id: footer
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        anchors.leftMargin: 18
        anchors.rightMargin: 18
        anchors.bottomMargin: 10
        height: 22

        Text {
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            text: bridge.configDir.length > 0 ? ("配置目录 " + bridge.configDir) : "配置目录（等待后端）"
            font.family: T.FONT_MONO
            font.pixelSize: 10
            color: T.MUTED
        }

        Text {
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            text: navItems[root.pageIndex].index + " / " + navItems[root.pageIndex].label
                  + "   ·   动效档位 " + (root.motionTier === 2 ? "完整" : (root.motionTier === 1 ? "标准" : "最低"))
                  + (root.awake ? "" : "   ·   窗口已最小化：装饰动画已停")
            font.family: T.FONT_MONO
            font.pixelSize: 10
            color: root.awake ? T.MUTED : T.WARN
        }
    }

    Connections {
        target: bridge

        function onBackendError(code, message) {
            root.note("[" + code + "] " + message, true)
        }

        function onResponse(id, ok, result, code, message) {
            if (id !== root.pendingMetrics)
                return
            if (ok)
                root.metrics = result || ({})
            else
                root.note("[" + code + "] " + message, true)
        }

        function onLogLine(text) {
            // 后端诊断走 stderr，桥把它转成 logLine 信号；这里只在出错时提示，不刷屏。
            if (/ECRASH|EREJECTION|EINSTANCE/.test(text))
                root.note(text, true)
        }
    }

    Timer {
        interval: 3000
        repeat: true
        running: root.awake
        onTriggered: root.pollMetrics()
    }

    // 内存验收用：--cycle <ms> 定期在三页之间轮换，--cycles <n> 轮换 n 次后停下。
    // 正常启动时这两个上下文属性为 0，定时器不运行，对产品行为零影响。
    property int cycleDone: 0

    Timer {
        id: cycleTimer
        interval: (typeof cycleIntervalMs !== "undefined" && cycleIntervalMs > 0) ? cycleIntervalMs : 0
        repeat: true
        running: interval > 0 && (typeof cycleLimit === "undefined" || cycleLimit <= 0
                                  || root.cycleDone < cycleLimit)
        onTriggered: {
            var order = ["session", "friends", "setting"]
            var next = (order.indexOf(root.currentPage) + 1) % order.length
            root.currentPage = order[next]
            root.cycleDone += 1
        }
    }

    Component.onCompleted: root.pollMetrics()
}
