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

    // ══ 画布缩放 ═══════════════════════════════════════════════════════
    // 界面按 1440x900 的版面设计，网格布局在小窗口里会被裁掉右侧（1024x768 验收截图暴露过）。
    // 这里不做"重排"而是整体等比缩小：版面不变，只换缩放，宽高都不越界。窗口比设计尺寸大时
    // 不放大（scale 上限 1），保持 1:1 的清晰度。
    readonly property int designWidth: 1440
    readonly property int designHeight: 900
    readonly property real fitScale: Math.min(1, width / designWidth, height / designHeight)
    readonly property bool scaled: fitScale < 0.999

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

    // ══ 画布：所有版面都在这里面，整体缩放 ═════════════════════════════
    Item {
        id: canvas

        width: root.designWidth
        height: root.designHeight
        scale: root.fitScale
        transformOrigin: Item.TopLeft

        // ══ 顶栏 ═══════════════════════════════════════════════════════
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

            Row {
                spacing: 12

                // 翼形徽记（参考项目左上角那个带翼的标记，这里用几何线条重画）
                WingMark {
                    anchors.verticalCenter: parent.verticalCenter
                    width: 44
                    height: 44
                    seed: 7
                }

                Text {
                    anchors.verticalCenter: parent.verticalCenter
                    text: "STRONGHOLD LINK  <font size=\"3\" color=\"" + T.MUTED + "\">干线隧道控制台</font>"
                    textFormat: Text.RichText
                    font.family: T.FONT_DISPLAY
                    font.pixelSize: 30
                    color: T.INK
                }
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
                  + (root.scaled ? ("   ·   版面缩放 " + Math.round(root.fitScale * 100) + "%") : "")
                  + (root.awake ? "" : "   ·   窗口已最小化：装饰动画已停")
            font.family: T.FONT_MONO
            font.pixelSize: 10
            color: root.awake ? T.MUTED : T.WARN
        }

        // 内存验收/截图工装用的轮换定时器，放在画布内，随画布一起销毁。
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
    }
    }

    // 上面这一行收的是 id: canvas 那个 Item。
    // 教训：加了这层画布包装却忘了配对闭括号时，QML 报的错是文件最后一行的
    // "Expected token" 提示（解析器要到 EOF 才确认少一个右花括号），会让人误以为
    // 文件末尾有问题；真正的定位手段是 tools/qml-parse-check.cjs（用 Qt 自己的
    // qmlformat 解析每个 QML，失败直接报文件名）——自己数花括号不可靠，
    // 注释里出现反引号或花括号装饰字符都会让手写的计数器误判。

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

    // ══ 流动背景 ═══════════════════════════════════════════════════════
    // 压在所有版面之上的一层极淡的"活纸"：网点漂移、细流曲线游走、扫光、星点。
    // 为什么在最上层：三页的主图版本身是不透明的纸色底，放在它们下面就被盖住了。
    // 透明度压得很低（网点 0.026~0.045、曲线 0.065~0.10、扫光 0.07~0.10），
    // 只为"在动"，不为"看得见"，不跟正文抢注意力。
    //
    // - awake 决定动不动：窗口最小化或隐藏时时钟停住（画面停在当前相位，不跳回 0）。
    // - motionTier 来自设置页的"装饰动效"档位：0 最低 = 完全静止。
    // - --flow-phase <0~1> 把时钟钉死，验收截图因此可复现；--flow-level 可覆盖档位。
    FlowField {
        id: flowLayer
        anchors.fill: parent
        z: 900
        enabled: false                                  // 纯装饰，不吃鼠标事件
        active: root.awake
        tier: {
            if (typeof flowLevelOverride !== "undefined" && flowLevelOverride !== "")
                return flowLevelOverride
            return root.motionTier <= 0 ? "minimal" : (root.motionTier === 1 ? "normal" : "full")
        }
        lockedPhase: (typeof flowPhaseLocked !== "undefined" && flowPhaseLocked) ? initialFlowPhase : -1
        parts: (typeof flowPartsMask !== "undefined") ? flowPartsMask : 15
    }

    // 内存验收用：--cycle <ms> 定期在三页之间轮换，--cycles <n> 轮换 n 次后停下。
    // 正常启动时这两个上下文属性为 0，定时器不运行，对产品行为零影响。
    property int cycleDone: 0

    Component.onCompleted: root.pollMetrics()
}
