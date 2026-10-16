import QtQuick
import QtQuick.Layouts
import "Components"
import "Pages"
import "theme.js" as T
import "quotes.js" as Q

// Stronghold Link — Qt Quick 前端外壳
// 一级导航只有三项：会话 / 好友 / 设置。窗口最小化时装饰动画停止，后端照常运行
//
// 骨架分四层（用户反馈"没有层次感"，这里把层与层之间的关系写死）：
//   ① 自绘标题栏 chrome —— 不随版面缩放，永远 1:1 清晰（窗口按钮、后端状态、当前页）；
//   ② 版面画布 canvas —— 1440x900 的设计版面，整体等比缩放到窗口可用区（上限 MAX_SCALE）；
//   ③ 版面内的顶栏 / 底部导航条 —— 纸张框架，细边压线，把内容夹在中间；
//   ④ 流动背景 FlowField —— 浮在最上面的极淡"活纸"，纯装饰不吃事件。
Window {
    id: root

    // 去掉系统标题栏：由 Components/WindowBar.qml 自绘（拖动 / 双击最大化 / 边缘缩放
    // 都在下面接线）。无边框窗口在 Windows 上最大化会盖住任务栏，所以 main.cpp 给的
    // 初始尺寸直接就是"屏幕可用区"，不用 Window.showMaximized()。
    flags: Qt.Window | Qt.FramelessWindowHint

    x: (typeof initialX !== "undefined") ? initialX : 0
    y: (typeof initialY !== "undefined") ? initialY : 0
    width: (typeof initialWidth !== "undefined" && initialWidth > 0) ? initialWidth : 1440
    height: (typeof initialHeight !== "undefined" && initialHeight > 0) ? initialHeight : 900
    minimumWidth: 1024
    minimumHeight: 720
    visible: true
    color: T.PAPER
    title: "Stronghold Link"

    property string currentPage: (typeof initialPage !== "undefined" && initialPage !== "") ? initialPage : "session"
    // 动效档位：2 完整 / 1 标准 / 0 最低。只影响界面装饰，不写后端配置，也不影响会话
property int motionTier: 2
    readonly property bool awake: root.visible && root.visibility !== Window.Minimized
    readonly property int pageIndex: currentPage === "friends" ? 1 : (currentPage === "setting" ? 2 : 0)

    property string banner: ""
    property bool bannerBad: false
    property var metrics: ({})
    property int pendingMetrics: 0
    property bool maximized: (typeof initialMaximized !== "undefined") ? initialMaximized : false

    // ══ 引语模块（题词）═══════════════════════════════════════════════════
    // 一个靠在窗口边上的小纸片：哲学 / 文学 / 诗歌的句子，能翻、能收藏。
    // 条目的来源有两处：`quotes.js`（离线兜底，39 条）与后端 `quotes.fetch`
    // 从公开接口抓回来的（一言 k/d/i + 今日诗词），两边合成一条环。
    // 收藏只存条目的 key（稳定标识），落盘到数据目录 quotes.json。
    property bool quoteOpen: (typeof initialQuoteOpen !== "undefined") ? initialQuoteOpen : false
    property int quoteIndex: 0
    property var quoteFavorites: []
    property bool quoteLoaded: false
    property int pendingQuoteLoad: 0
    property int pendingQuoteSave: 0
    property int quoteSavedAt: 0

    // 联网补齐：抓回来的一批接在本地那批后面；抓不到就还是本地那批，界面不空
    property var quoteFetched: []
    property bool quoteFetching: false
    property int pendingQuoteFetch: 0
    readonly property var quotePool: Q.QUOTES.concat(quoteFetched)

    function toggleQuotes() {
        quoteOpen = !quoteOpen
        if (quoteOpen && !quoteLoaded) {
            quoteLoaded = true
            pendingQuoteLoad = bridge.call("quotes.load", {})
        }
        if (quoteOpen)
            root.fetchQuotes(6)
    }

    // 抓一批新句子（后端自己去重、落缓存；离线时安静地失败）
    function fetchQuotes(n) {
        if (root.quoteFetching || !bridge.ready)
            return
        root.quoteFetching = true
        root.pendingQuoteFetch = bridge.call("quotes.fetch", { count: n })
    }

    // 环形翻页：走到最后一条的下一条会绕回第一条
    function quoteStep(delta) {
        var n = root.quotePool.length

        if (n <= 0)
            return
        quoteIndex = ((quoteIndex + delta) % n + n) % n
        root.saveQuotes()
        // 走到池子后半段就顺手再抓一批，用户不会撞到"没词了"
        if (n > 0 && quoteIndex > n - 4)
            root.fetchQuotes(6)
    }

    function quoteStar() {
        var one = root.quotePool[root.quoteIndex]

        if (!one)
            return

        var list = root.quoteFavorites.slice()
        var at = list.indexOf(one.key)

        if (at >= 0)
            list.splice(at, 1)
        else
            list.push(one.key)
        root.quoteFavorites = list
        root.saveQuotes()
    }

    // 收藏与"读到第几条"都落盘；写盘不打断交互，失败只记一条提示
    function saveQuotes() {
        pendingQuoteSave = bridge.call("quotes.save", { favorites: root.quoteFavorites, last: root.quoteIndex })
    }

    // 启动后先把网络那批抓回来（不等用户点开题词）：延迟一点，别和后端握手抢时间
    Timer {
        interval: 2400
        running: root.awake && bridge.ready && root.quoteFetched.length === 0 && root.pendingQuoteFetch === 0
        repeat: false
        onTriggered: root.fetchQuotes(8)
    }

    // ══ 指针视差 ══════════════════════════════════════════════════════
// 鼠标在窗口里移动时，背景流动层与版面四周的边注反着漂一点点（最多十几像素）
// 版面本身只挪几像素。这是"流动感"最直接的一层：画面永远在跟着你动
property real pointerX: 0     // -1 .. 1
    property real pointerY: 0

    // 镜头呼吸：0 → 1 → 0 的慢循环（26 秒一轮），画布缩放读它
property real breathe: 0

    // 一直在跳的时间码与帧号（底部栏中间那只 HUD 读数
property string timecode: "00:00:00.0"
    property int frameTick: 0

    Timer {
        id: hudTimer

        interval: 100
        repeat: true
        running: root.awake && root.motionTier > 0

        onTriggered: {
            root.uptimeMs += 100
            const total = root.uptimeMs / 1000
            const h = Math.floor(total / 3600)
            const m = Math.floor((total % 3600) / 60)
            const s = total % 60
            root.timecode = T.pad2(h) + ":" + T.pad2(m) + ":"
                    + (s < 10 ? "0" : "") + s.toFixed(1)
            root.frameTick = (root.frameTick + 1) % 1000
        }
    }

    property double uptimeMs: 0

    SequentialAnimation {
        loops: Animation.Infinite
        running: root.awake && root.motionTier > 0

        NumberAnimation {
            target: root
            property: "breathe"
            from: 0
            to: 1
            duration: 13000
            easing.type: Easing.InOutSine
        }
        NumberAnimation {
            target: root
            property: "breathe"
            from: 1
            to: 0
            duration: 13000
            easing.type: Easing.InOutSine
        }
    }

    HoverHandler {
        id: pointer

        onPointChanged: {
            root.pointerX = Math.max(-1, Math.min(1, (point.position.x / Math.max(1, root.width)) * 2 - 1))
            root.pointerY = Math.max(-1, Math.min(1, (point.position.y / Math.max(1, root.height)) * 2 - 1))
        }
    }

    // ══ 版面缩放 ══════════════════════════════════════════════════════
// 界面按 1440x900 的版面设计。以前缩放上限是 1（只在窗口比版面小时缩小），
// 2560x1440 的屏幕上画面只占中间一块 —— 现在改成两个方向都铺满可用区，
// 上限 MAX_SCALE，缩放在画布中心，两侧空出来的地方留给竖向边注与定位记号
    property real designWidth: 1680
    property real designHeight: 1240
    readonly property real stagePad: 14

    // 题词不再单独占一条：它是标题栏里的一行字，不参与版面缩放、也不占版面空间，
    // 所以这里没有"让位"逻辑（早期那版右侧小条需要 quoteGutter，已经撤掉）。
    //
    // 缩放下限 MIN_SCALE：窗口再小也不把版面一直缩下去 —— 缩到 0.60 就打住，
    // 多出来的部分由视口（Flickable）滚动查看（用户反馈"分辨率一小什么都看不清"）。
    // 取 0.60 而不是更激进的值，是为了 1440x900（原本整页可见，0.608）不回归：
    // 常规尺寸仍是"一屏看全"，只有更小的窗口才进入可滚动模式。
    readonly property real minScale: 0.60
    property real fitScale: Math.max(minScale, Math.min(T.MAX_SCALE,
                                                        (stage.width - 2 * stagePad) / designWidth,
                                                        (stage.height - 2 * stagePad) / designHeight))

    // 版面比视口大（被下限挡住了）时为真：此时可以滚动，边注与定位记号让开
    readonly property bool pannable: (designWidth * fitScale > stage.width + 1)
                                      || (designHeight * fitScale > stage.height + 1)

    Behavior on fitScale { NumberAnimation { duration: T.DUR_ENTER + 120; easing.type: Easing.OutCubic } }

    readonly property bool scaled: Math.abs(fitScale - 1) > 0.002

    readonly property var navItems: [
        { key: "session", index: "01", label: "会话", caption: "SESSION · 房主与加入者" },
        { key: "friends", index: "02", label: "好友", caption: "FRIENDS · Steam 大厅" },
        { key: "setting", index: "03", label: "设置", caption: "SETTING · 线路与诊断" }
    ]

    // 三个页面在 StackLayout 的顺序列在这里：切页入场时要按当前页收集"版画"
    // （StackLayout 会把子项重挂到自己的 contentItem 上，直接读 children 不可靠）
    readonly property var pages: [sessionPage, friendsPage, settingPage]

    function note(text, bad) {
        banner = String(text === undefined || text === null ? "" : text)
        bannerBad = bad === true
    }

    function pollMetrics() {
        pendingMetrics = bridge.call("app.metrics", {})
    }

    // 无边框窗口的最大化/还原：走 QWindow 自己的 showMaximized/showNormal
// 这样 Windows 会正确处理贴边、多屏与任务栏，比手工铺满可用区稳
function toggleMaximized() {
        if (root.maximized) {
            root.showNormal()
            root.maximized = false
        } else {
            root.showMaximized()
            root.maximized = true
        }
    }

    onVisibilityChanged: root.maximized = (root.visibility === Window.Maximized)

    // ══ 切页入场：错峰淡入 ════════════════════════════════════════════════
// 页面里的每个"版画"（Plate / PaperPlate / HeroPlate / 依赖组件）都带 revealed 标记
// 按 48ms 的间隔依次淡入并轻微归位；页面容器自己也做一次淡入 + 横移
property var revealQueue: []
    property int revealIndex: 0

    function collectRevealable(node, out) {
        var kids = node.children
        for (var i = 0; i < kids.length; ++i) {
            var k = kids[i]
            if (!k)
                continue
            if (k.revealed !== undefined) {
                out.push(k)
                continue
            }
            if (k.children && k.children.length > 0)
                collectRevealable(k, out)
        }
    }

    function revealPage() {
        revealTimer.stop()
        var page = root.pages[root.pageIndex]
        var out = []
        if (page)
            collectRevealable(page, out)

        // 常驻装饰动效（面板上的数据点、主视觉的自转环、扫描线）按动效档位开关；
        // "最低"档时全部停住，只留静态版面
for (var a = 0; a < out.length; ++a) {
            if (out[a].ambient !== undefined)
                out[a].ambient = root.motionTier > 0
        }

        if (root.motionTier <= 0) {
            for (var j = 0; j < out.length; ++j)
                out[j].revealed = true
            revealQueue = []
            return
        }

        for (var i = 0; i < out.length; ++i)
            out[i].revealed = false
        revealQueue = out
        revealIndex = 0
        pageHost.shown = false
        Qt.callLater(function () { pageHost.shown = true })

        // 全窗一道斜切转场带扫过去：页面部件在它后面被逐块擦出来（错峰 55ms），
        // 于是切页看起来是"擦"出来的，而不是两边各自淡入淡出。
        pageSweep.progress = 0
        sweepAnim.restart()
        blinds.blindsProgress = 0
        blindsAnim.restart()
        // 镜头一"顶"：整块版面被切页那一下顶偏几像素，然后弹回来（PV 里的硬切手感）。
        cameraJolt.restart()
        // 仪式性转场：玫瑰窗（模板 D）在最上层短促地分层显出来再化掉。
        // 它只在切页那 0.9 秒存在，平时完全不占版面 —— 对应规范第 4 节模板 D 的用法。
        if (root.motionTier > 0)
            transitionMotifAnim.restart()

        if (out.length > 0)
            revealTimer.start()
    }

    // 切页时版面被"顶"一下：jolt 从 1 弹回 0，画布的变换读它
    property real jolt: 0

    SequentialAnimation {
        id: cameraJolt

        NumberAnimation {
            target: root
            property: "jolt"
            from: 1
            to: 0
            duration: 260
            easing.type: Easing.OutQuint
        }
    }

    // 转场带：0 → 1 扫过整窗，OutExpo（快出缓收）
    NumberAnimation {
        id: sweepAnim

        target: pageSweep
        property: "progress"
        from: 0
        to: 1
        duration: T.DUR_SWEEP
        easing.type: Easing.OutExpo
    }

    Timer {
        id: revealTimer
        interval: T.STAGGER
        repeat: true
        onTriggered: {
            if (root.revealIndex >= root.revealQueue.length) {
                stop()
                return
            }
            var it = root.revealQueue[root.revealIndex]
            root.revealIndex += 1
            it.revealed = true
        }
    }

    onCurrentPageChanged: root.revealPage()

    Shortcut { sequence: "Ctrl+1"; onActivated: root.currentPage = "session" }
    Shortcut { sequence: "Ctrl+2"; onActivated: root.currentPage = "friends" }
    Shortcut { sequence: "Ctrl+3"; onActivated: root.currentPage = "setting" }

    //   ① 自绘标题栏 chrome —— 不随版面缩放，永远 1:1 清晰（窗口按钮、后端状态、当前页）；
    WindowBar {
        id: chrome
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        height: T.CHROME_H
        z: 1200

        pageIndex: root.navItems[root.pageIndex].index
        pageLabel: root.navItems[root.pageIndex].label
        backendReady: bridge.ready
        statusText: bridge.ready ? ("后端已连接 v" + (bridge.version.length ? bridge.version : "?"))
                                 : (bridge.running ? "后端启动中…" : "后端未运行")
        metricsText: (metrics && metrics.uptimeMs !== undefined)
                     ? ("pid 运行 " + T.fmtDuration(metrics.uptimeMs) + "  ·  RSS " + T.fmtBytes(metrics.rssBytes))
                     : ""
        errorText: (bridge.lastError.length > 0 && !bridge.ready) ? bridge.lastError : ""
        maximized: root.maximized
        windowActive: root.active
        quotesOpen: root.quoteOpen

        onMinimizeRequested: root.showMinimized()
        onMaximizeRequested: root.toggleMaximized()
        onCloseRequested: root.close()
        onQuotesRequested: root.toggleQuotes()
        onMoveRequested: {
            if (root.maximized) {
                root.showNormal()
                root.maximized = false
            }
            root.startSystemMove()
        }
    }

    // ══ 题词 ══════════════════════════════════════════════════════════════
    // 不是卡片、不占版面、不压暗任何东西 —— 就是标题栏空白处的一行字。
    // 位置卡在"页面名"之后、"题词/状态/窗口按钮"那一簇之前，两端各留够距离，
    // 所以无论窗口多宽都不会和标题栏自己的内容叠上（用户要求：UI 不许互相遮挡）。
    QuoteLine {
        id: quoteLine

        Component.onCompleted: console.log("[qa-quote] pool=" + root.quotePool.length
                                           + " idx=" + root.quoteIndex
                                           + " item=" + (root.quotePool[root.quoteIndex] ? root.quotePool[root.quoteIndex].text.slice(0, 10) : "无")
                                           + " w=" + width + " open=" + root.quoteOpen)

        anchors.left: parent.left
        anchors.leftMargin: 186
        anchors.top: parent.top
        anchors.topMargin: 0
        height: T.CHROME_H
        width: Math.max(0, root.width - 186 - 340)
        z: 400
        visible: root.quoteOpen

        opacity: root.quoteOpen ? 1 : 0

        Behavior on opacity { NumberAnimation { duration: T.DUR_HOVER; easing.type: Easing.OutCubic } }

        item: root.quotePool[root.quoteIndex] || ({ key: "", kind: "", who: "", work: "", text: "" })
        favorites: root.quoteFavorites
        onStep: (delta) => root.quoteStep(delta)
        onStar: root.quoteStar()
    }

    Shortcut {
        sequence: "Escape"
        enabled: root.quoteOpen
        onActivated: root.quoteOpen = false
    }

    // ══ ② 版面画布所在的舞台（标题栏以下是可用区）═══════════════════════════
    Item {
        id: stage

        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: chrome.bottom
        anchors.bottom: parent.bottom

        // 两侧边注：只在画布没铺满、两侧留出空白时出现
        Text {
            anchors.left: parent.left
            anchors.leftMargin: 12
            anchors.verticalCenter: parent.verticalCenter
            visible: canvas.x > 60
            rotation: -90
            text: "TUNNEL CONSOLE  ·  QML EDITION" + (bridge.version.length ? "  ·  " + bridge.version : "")
            font.family: T.FONT_MONO
            font.pixelSize: 9
            font.letterSpacing: 2.4
            color: "#3d22282b"

            // 边注跟着指针漂得最多（最外一层，纵深最大）
            transform: Translate {
                y: root.pointerY * 34
                Behavior on y { NumberAnimation { duration: 1000; easing.type: Easing.OutCubic } }
            }
        }

        // 定位记号（参考界面里那种衬线体的十字）；引语卡片开着时把右边这条让开
        Item {
            width: 18
            height: 18
            visible: canvas.x > 60
            anchors.right: parent.right
            anchors.rightMargin: (canvas.x - 18) / 2 - 9
            anchors.top: parent.top
            anchors.topMargin: parent.height * 0.14

            transform: Translate {
                x: -root.pointerX * 26
                y: root.pointerY * 20
                Behavior on x { NumberAnimation { duration: 950; easing.type: Easing.OutCubic } }
                Behavior on y { NumberAnimation { duration: 950; easing.type: Easing.OutCubic } }
            }

            Rectangle { anchors.centerIn: parent; width: 18; height: 1; color: "#802448d8" }
            Rectangle { anchors.centerIn: parent; width: 1; height: 18; color: "#802448d8" }
        }

        // ══ 视口：版面比窗口大时可以滚（缩放下限之上保持可读，不再无限缩小）══
        Flickable {
            id: view

            anchors.fill: parent
            contentWidth: holder.width
            contentHeight: holder.height
            boundsBehavior: Flickable.StopAtBounds
            flickableDirection: Flickable.HorizontalAndVerticalFlick
            clip: true

            Item {
                id: holder

                width: Math.max(view.width, root.designWidth * root.fitScale)
                height: Math.max(view.height, root.designHeight * root.fitScale)

                // ══ 版面画布 ════════════════════════════════════════════════════
                Item {
                    id: canvas

                    width: root.designWidth
                    height: root.designHeight
                    anchors.centerIn: holder
            // 常驻"呼吸"：整块版面极缓慢地推近再退回（PV 里镜头从不完全静止）
// 幅度只有 0.6%，但配合指针视差，画面永远是活的。
scale: root.fitScale * (1 + 0.006 * root.breathe)

            // 版面本身跟着指针挪一点点（比背景层小得多，于是有"分层"的错觉）；
            // 引语卡片开着时再往左让出半条让位的宽度，让版面在剩下的地方居中
            transform: Translate {
                x: root.pointerX * 6 + root.jolt * 12
                y: root.pointerY * 4 - root.jolt * 6
                Behavior on x { NumberAnimation { duration: 1100; easing.type: Easing.OutCubic } }
                Behavior on y { NumberAnimation { duration: 1100; easing.type: Easing.OutCubic } }
            }

            // ── ②a 品牌顶栏 ──────────────────────────────────────────────────────
            Item {
                id: top

                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: parent.top
                anchors.margins: 22
                height: T.TOPBAR_H

                Rectangle {
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.top: parent.top
                    anchors.bottom: parent.bottom
                    gradient: Gradient {
                        GradientStop { position: 0.0; color: "#00000000" }
                        GradientStop { position: 1.0; color: "#0822282b" }
                    }
                }

                Column {
                    anchors.left: parent.left
                    anchors.top: parent.top
                    spacing: 2

                    Row {
                        spacing: 13

                        // 翼形徽记（参考项目左上角那个带翼的标记，这里用几何线条重画）
                        WingMark {
                            anchors.verticalCenter: parent.verticalCenter
                            width: 46
                            height: 46
                            seed: 7
                        }

                        Text {
                            anchors.verticalCenter: parent.verticalCenter
                            text: "STRONGHOLD LINK  <font size=\"3\" color=\"" + T.MUTED + "\">干线隧道控制台</font>"
                            textFormat: Text.RichText
                            font.family: T.FONT_DISPLAY
                            font.pixelSize: 31
                            font.letterSpacing: 0.5
                            color: T.INK
                        }
                    }

                    Text {
                        text: "TUNNEL CONSOLE  ·  Qt Quick 前端 / Node 常驻后端  ·  Ctrl+1/2/3 切换页面"
                        font.family: T.FONT_MONO
                        font.pixelSize: 9
                        font.letterSpacing: 1.6
                        color: T.MUTED
                    }
                }

                Row {
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: 10

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

            // ── ②b 页面区（带入场过渡）───────────────────────────────────────────
            Item {
                id: pageHost

                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: top.bottom
                anchors.bottom: bottombar.top
                anchors.leftMargin: 22
                anchors.rightMargin: 22
                anchors.topMargin: 8
                anchors.bottomMargin: 6
                // 页面自身比设计版面高时宁可裁掉，也不许压到底部导航条上。
                clip: true

                property bool shown: true

                opacity: shown ? 1 : 0
                transform: Translate {
                    x: pageHost.shown ? 0 : -T.GAP_L
                    Behavior on x { NumberAnimation { duration: T.DUR_ENTER; easing.type: Easing.OutQuint } }
                }
                Behavior on opacity { NumberAnimation { duration: T.DUR_ENTER - 60; easing.type: Easing.OutCubic } }

                StackLayout {
                    id: stack
                    anchors.fill: parent
                    currentIndex: root.pageIndex

                    SessionPage {
                        id: sessionPage
                        active: root.awake && root.currentPage === "session"
                        motionTier: root.motionTier
                    }

                    FriendsPage {
                        id: friendsPage
                        active: root.awake && root.currentPage === "friends"
                        motionTier: root.motionTier
                        onNotice: (text, bad) => root.note(text, bad)
                    }

                    SettingPage {
                        id: settingPage
                        active: root.awake && root.currentPage === "setting"
                        motionTier: root.motionTier
                        onNotice: (text, bad) => root.note(text, bad)
                        onMotionTierPicked: (tier) => { root.motionTier = tier }
                    }
                }
            }

            // ── ②c 提示条：贴着页面区下沿浮出来的小纸片 ───────────────────────────
            Item {
                id: bannerHost

                anchors.left: parent.left
                anchors.right: parent.right
                anchors.bottom: bottombar.top
                anchors.bottomMargin: 8
                height: 34

                // 投影先声明（在纸片下面），否则会盖住纸片自己的底
Rectangle {
                    anchors.fill: bannerBox
                    anchors.margins: -5
                    anchors.topMargin: 6
                    radius: T.RADIUS + 2
                    color: "#22282b"
                    opacity: bannerBox.opacity * T.SHADOW_2
                }

                Rectangle {
                    id: bannerBox

                    anchors.centerIn: parent
                    width: bannerRow.width + 44
                    height: 30
                    color: T.PAPER_LOCAL
                    border.width: 1
                    border.color: root.bannerBad ? T.BAD : T.COBALT
                    radius: T.RADIUS

                    opacity: root.banner.length > 0 ? 1 : 0
                    Behavior on opacity { NumberAnimation { duration: T.DUR } }
                    transform: Translate {
                        y: root.banner.length > 0 ? 0 : 14
                        Behavior on y { NumberAnimation { duration: T.DUR; easing.type: Easing.OutCubic } }
                    }

                    Row {
                        id: bannerRow
                        anchors.centerIn: parent
                        spacing: 10

                        Rectangle {
                            anchors.verticalCenter: parent.verticalCenter
                            width: 6
                            height: 6
                            radius: 3
                            color: root.bannerBad ? T.BAD : T.COBALT
                        }

                        Text {
                            anchors.verticalCenter: parent.verticalCenter
                            text: root.banner
                            font.family: T.FONT_MONO
                            font.pixelSize: 11
                            color: root.bannerBad ? T.BAD : T.INK
                        }
                    }

                    MouseArea {
                        anchors.fill: parent
                        cursorShape: Qt.PointingHandCursor
                        onClicked: root.banner = ""
                    }
                }

                Timer {
                    running: root.banner.length > 0
                    interval: 9000
                    onTriggered: root.banner = ""
                }
            }

            // ── ②d 底部导航条 ────────────────────────────────────────────────────
            Item {
                id: bottombar

                anchors.left: parent.left
                anchors.right: parent.right
                anchors.bottom: parent.bottom
                height: T.BOTTOM_H
                anchors.margins: 22
                anchors.bottomMargin: 16

                Rectangle {
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.top: parent.top
                    anchors.bottom: parent.bottom
                    gradient: Gradient {
                        GradientStop { position: 0.0; color: "#0822282b" }
                        GradientStop { position: 1.0; color: "#00000000" }
                    }
                }

                Rectangle {
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.top: parent.top
                    height: T.HAIR
                    color: "#2e22282b"
                }

                // 左：版次与路径（原来在页脚，现在收进这条栏里，右侧腾给导航）
                Column {
                    anchors.left: parent.left
                    anchors.leftMargin: 2
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: 3

                    Text {
                        text: "干线隧道控制台  ·  QML EDITION"
                        font.family: T.FONT_DISPLAY
                        font.pixelSize: 14
                        font.letterSpacing: 1.6
                        color: T.INK
                    }

                    Text {
                        text: "配置目录 " + (bridge.configDir.length > 0 ? bridge.configDir : "（等待后端）")
                        font.family: T.FONT_MONO
                        font.pixelSize: 9
                        color: T.MUTED
                    }

                    Text {
                        text: root.navItems[root.pageIndex].index + " / " + root.navItems[root.pageIndex].label
                              + "   ·   动效档位 " + (root.motionTier === 2 ? "完整" : (root.motionTier === 1 ? "标准" : "最低"))
                              + "   ·   版面 " + Math.round(root.fitScale * 100) + "%"
                              + (root.awake ? "" : "   ·   窗口已最小化：装饰动画已停")
                        font.family: T.FONT_MONO
                        font.pixelSize: 9
                        color: root.awake ? T.MUTED : T.WARN
                    }
                }

                // 中间：一直在跳的时间码（HUD 语汇；数字在动，画面就"活"）。
Text {
                    anchors.horizontalCenter: parent.horizontalCenter
                    anchors.verticalCenter: parent.verticalCenter
                    text: "TC " + root.timecode + "   ·   FRM " + root.frameTick
                    font.family: T.FONT_MONO
                    font.pixelSize: 9
                    font.letterSpacing: 1.4
                    color: "#6622282b"
                    visible: root.awake && root.motionTier > 0
                }

                NavBar {
                    id: nav
                    anchors.right: parent.right
                    anchors.rightMargin: 2
                    anchors.verticalCenter: parent.verticalCenter
                    width: implicitWidth
                    height: parent.height
                    current: root.currentPage
                    items: root.navItems
                    onSelected: (key) => { root.currentPage = key }
                }

                // 内存验收/截图工装用的轮换定时器，放在画布内，随画布一起销毁
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
    }
        }   // holder / view 的收口（画布外面套了可滚动视口，这里多两层）
    }

    // ══ 无边框窗口的边缘缩放 ══════════════════════════════════════════
// 上面这一层是 id: canvas 那个 Item
// 教训：加了画布包装却忘了配对闭括号时，QML 报的错是文件最后一行的
    // "Expected token" 提示（解析器要到 EOF 才确认少一个右花括号），会让人误以
// 文件末尾有问题；真正的定位手段是 tools/qml-parse-check.cjs（用 Qt 自己
// qmlformat 解析每个 QML，失败直接报文件名）——自己数花括号不可靠
// 注释里出现反引号或花括号装饰字符都会让手写的计数器误判。
EdgeGrip {
        edges: Qt.LeftEdge
        width: 5
        anchors.left: parent.left
        anchors.top: parent.top
        anchors.bottom: parent.bottom
        anchors.topMargin: 8
        anchors.bottomMargin: 8
    }

    EdgeGrip {
        edges: Qt.RightEdge
        width: 5
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.bottom: parent.bottom
        anchors.topMargin: 8
        anchors.bottomMargin: 8
    }

    EdgeGrip {
        edges: Qt.TopEdge
        height: 4
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        cursorShape: Qt.SizeVerCursor
    }

    EdgeGrip {
        edges: Qt.BottomEdge
        height: 5
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        cursorShape: Qt.SizeVerCursor
    }

    EdgeGrip {
        edges: Qt.LeftEdge | Qt.TopEdge
        width: 10
        height: 10
        anchors.left: parent.left
        anchors.top: parent.top
        cursorShape: Qt.SizeFDiagCursor
    }

    EdgeGrip {
        edges: Qt.RightEdge | Qt.TopEdge
        width: 10
        height: 10
        anchors.right: parent.right
        anchors.top: parent.top
        cursorShape: Qt.SizeBDiagCursor
    }

    EdgeGrip {
        edges: Qt.LeftEdge | Qt.BottomEdge
        width: 10
        height: 10
        anchors.left: parent.left
        anchors.bottom: parent.bottom
        cursorShape: Qt.SizeBDiagCursor
    }

    EdgeGrip {
        edges: Qt.RightEdge | Qt.BottomEdge
        width: 10
        height: 10
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        cursorShape: Qt.SizeFDiagCursor
    }

    // 版面体检：页面区高度 vs 三页各自想要的尺寸。设计版面高度就是按这个数定
// （页面要多少高、顶栏与底部导航条一扣，剩下的才给页面）。日志进 --log 文件
function layoutProbe() {
        const page = stack.currentItem
        if (!page)
            return "无页面"
        const row = page.children.length > 0 ? page.children[0] : null
        if (!row)
            return "无行布局"
        const cols = []
        for (let i = 0; i < row.children.length; ++i)
            cols.push(Math.round(row.children[i].implicitHeight))
        return "行内列高=" + cols.join("/") + " 行高=" + Math.round(row.implicitHeight)
    }

    Timer {
        interval: 2600
        running: true
        repeat: false
        onTriggered: console.log("[layout] pageHost=" + Math.round(pageHost.height)
                                 + " canvas=" + Math.round(canvas.width) + "x" + Math.round(canvas.height)
                                 + " scale=" + root.fitScale.toFixed(3)
                                 + " session=" + Math.round(sessionPage.implicitHeight)
                                 + " friends=" + Math.round(friendsPage.implicitHeight)
                                 + " setting=" + Math.round(settingPage.implicitHeight)
                                 + " | " + root.layoutProbe())
    }

    Connections {
        target: bridge

        function onBackendError(code, message) {
            root.note("[" + code + "] " + message, true)
        }

        function onResponse(id, ok, result, code, message) {
            if (id === root.pendingQuoteLoad) {
                if (ok && result) {
                    root.quoteFavorites = result.favorites || []
                    var n = root.quotePool.length
                    var last = result.last || 0
                    root.quoteIndex = (n > 0) ? ((last % n) + n) % n : 0
                }
                return
            }

            // 联网抓回来的新句子：接在池子后面（key 已由后端去重）
            if (id === root.pendingQuoteFetch) {
                root.pendingQuoteFetch = 0
                root.quoteFetching = false
                if (ok && result && result.items && result.items.length > 0) {
                    var add = []
                    for (var i = 0; i < result.items.length; i += 1) {
                        if (Q.indexOf(result.items[i].key) < 0)
                            add.push(result.items[i])
                    }
                    if (add.length > 0)
                        root.quoteFetched = root.quoteFetched.concat(add)
                }
                return
            }

            if (id === root.pendingQuoteSave) {
                if (ok)
                    root.quoteSavedAt = Date.now()
                else
                    root.note("[" + code + "] " + message, true)
                return
            }

            if (id !== root.pendingMetrics)
                return
            if (ok)
                root.metrics = result || ({})
            else
                root.note("[" + code + "] " + message, true)
        }

        function onLogLine(text) {
            // 后端诊断走 stderr，桥把它转成 logLine 信号；这里只在出错时提示，不刷屏
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

    // ══ 流动背景 ════════════════════════════════════════════════════
// 压在所有版面之上的一层极淡的"活纸"：网点漂移、细流曲线游走、扫光、星点
// 为什么在最上层：三页的主图版本身是不透明的纸色底，放在它们下面就被盖住了
// 透明度压得很低（网点 0.026~0.045、曲线 0.065~0.10、扫光 0.07~0.10），
    // 只为"在动"，不为"看得见"，不跟正文抢注意力
//
    // - awake 决定动不动：窗口最小化或隐藏时时钟停住（画面停在当前相位，不跳回 0）
// - motionTier 来自设置页的"装饰动效"档位：0 最低 = 完全静止
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

        // 指针视差：背景层反着走，幅度比版面大（层与层之间因此有了纵深）。
        transform: Translate {
            x: -root.pointerX * 22
            y: -root.pointerY * 14
            Behavior on x { NumberAnimation { duration: 900; easing.type: Easing.OutCubic } }
            Behavior on y { NumberAnimation { duration: 900; easing.type: Easing.OutCubic } }
        }
    }

    // ── 常驻扫描线：两条极淡的横带缓慢向下漂 ─────────────────────────────
    // 静态界面上最容易做出"屏幕活着"的一层：不抢内容、但一眼能看出在动
Item {
        id: scanlines

        anchors.fill: parent
        z: 910
        enabled: false
        opacity: root.awake ? 1 : 0
        Behavior on opacity { NumberAnimation { duration: T.DUR_ENTER } }

        Repeater {
            model: 2

            delegate: Rectangle {
                required property int index

                width: scanlines.width
                height: index === 0 ? 120 : 60

                gradient: Gradient {
                    GradientStop { position: 0.0; color: "#0022282b" }
                    GradientStop { position: 0.55; color: index === 0 ? "#0e22282b" : "#122a3fff" }
                    GradientStop { position: 1.0; color: "#0022282b" }
                }

                SequentialAnimation on y {
                    loops: Animation.Infinite
                    running: root.awake && root.motionTier > 0

                    NumberAnimation {
                        from: -height
                        to: scanlines.height
                        duration: index === 0 ? 11000 : 7300
                        easing.type: Easing.Linear
                    }
                    PauseAnimation { duration: index === 0 ? 2600 : 1400 }
                }
            }
        }
    }

    // 转场纹样（模板 D：玫瑰窗 + 放射几何 + 少量铭文）的显现进度：0 → 1 → 0。
    // 第一段是"分层显现"（轮 → 花瓣 → 窗格），第二段是"透光化掉"——不是整屏缩放。
    property real transitionMotif: 0

    SequentialAnimation {
        id: transitionMotifAnim

        NumberAnimation {
            target: root
            property: "transitionMotif"
            from: 0
            to: 1
            duration: 340
            easing.type: Easing.OutCubic
        }
        NumberAnimation {
            target: root
            property: "transitionMotif"
            from: 1
            to: 0
            duration: 520
            easing.type: Easing.InOutSine
        }
    }

    // ══ 实测性能探针 ═══════════════════════════════════════════════════
    // 命令行 `--perf <秒>` 打开：用 FrameAnimation 逐帧收 frameTime（Qt 6.4+ 才有这个属性），
    // 结束时打印 帧数 / 平均帧时间 / p95 / 最差一帧 / 等效 FPS。
    // 这是"性能可控"那条验收的实测口径，正常运行不启用（不建计时器、不占开销）。
    readonly property bool perfOn: (typeof perfSeconds !== "undefined" && perfSeconds > 0)
    property var perfSamples: []
    property var perfSteady: []
    property real perfLeft: perfOn ? perfSeconds : 0
    property int perfFrames: 0
    property real perfLast: 0
    property bool perfDone: false

    FrameAnimation {
        running: root.perfOn && !root.perfDone && root.perfLeft > 0

        onTriggered: {
            // 实测：这个 Qt 版本给的 frameTime 是"秒"（0.02 = 20ms），统一换成毫秒再统计
            var ms = frameTime > 1 ? frameTime : frameTime * 1000
            root.perfLast = ms
            root.perfFrames += 1
            root.perfSamples.push(ms)
            // 前 2 秒是启动期（建画布、拉后端、铺版面），不计入稳态
            if (root.perfFrames > 40)
                root.perfSteady.push(ms)
            root.perfLeft -= (frameTime > 1 ? frameTime / 1000 : frameTime)
            if (root.perfLeft <= 0)
                root.reportPerf()
        }
    }

    // 每 2 秒报一次心跳：能直接看出探针有没有在收帧
    Timer {
        interval: 2000
        repeat: true
        running: root.perfOn && !root.perfDone

        onTriggered: console.log("[perf] tick frames=" + root.perfFrames
                                 + " left=" + root.perfLeft.toFixed(2)
                                 + " last=" + root.perfLast.toFixed(1) + "ms")
    }

    function perfLine(tag, s) {
        if (s.length === 0)
            return tag + " 无样本"
        var sorted = s.slice().sort(function (a, b) { return a - b })
        var sum = 0
        for (var i = 0; i < sorted.length; ++i)
            sum += sorted[i]
        var avg = sum / sorted.length
        var p50 = sorted[Math.floor(sorted.length * 0.50)]
        var p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
        return tag + " frames=" + sorted.length
                + " avg=" + avg.toFixed(2) + "ms"
                + " p50=" + p50.toFixed(2) + "ms"
                + " p95=" + p95.toFixed(2) + "ms"
                + " max=" + sorted[sorted.length - 1].toFixed(2) + "ms"
                + " fps=" + (1000 / avg).toFixed(1)
    }

    function reportPerf() {
        root.perfDone = true
        console.log("[perf] " + root.perfLine("全程", root.perfSamples))
        console.log("[perf] " + root.perfLine("稳态", root.perfSteady))
    }

    // 切页时扫过整窗的转场带（压在流动背景之上，包括标题栏与底部导航条）。
    // 仪式性转场层：玫瑰窗纹样（模板 D），只在切页那 0.9 秒里存在
    MotifPlate {
        id: transitionMotifPlate

        anchors.fill: parent
        z: 945
        enabled: false
        template: "D"
        seed: 59
        mark: "∴"
        sealText: "STRONGHOLD LINK"
        radScale: 0.34
        opacity: root.transitionMotif * 0.9
        revealT: root.transitionMotif
        // 只在转场那 0.9 秒里画：平时 active=false，画布既不重绘也不吃 12fps 心跳
        active: root.awake && root.transitionMotif > 0.001
        ambient: root.motionTier > 0
        revealed: true
    }

    Sweep {
        id: pageSweep

        anchors.fill: parent
        z: 960
        progress: 1
        bandWidth: 520
        bandOpacity: 0.26
        edgeOpacity: 0.95
        enabled: false
    }

    // ── 百叶窗：切页时六道板条一起扫过 ───────────────────────────────────
    // PV 里的转场很少是"整块淡入淡出"，而是很多条硬边同时擦过去、每条错开一点，
// 这里是 6 条平行四边形（旋转 -8° 的 Rectangle，不用 Canvas，零画布开销），
    // 每条比前一条晚 6% 出发，扫完把整窗"刷"一遍；前沿各带一道亮线。
Item {
        id: blinds

        anchors.fill: parent
        z: 950
        enabled: false
        visible: blindsProgress > 0.0001 && blindsProgress < 0.9999
        property real blindsProgress: 1

        Repeater {
            model: 6

            delegate: Item {
                required property int index

                // 每条自己的进度：整条带子在（0~1）之间错开出发时刻
                readonly property real p: Math.max(0, Math.min(1,
                                                            (blinds.blindsProgress - index * 0.055) / 0.72))
                readonly property real bandW: width * 0.34
                // 快出缓收（OutExpo 近似
readonly property real eased: 1 - Math.pow(1 - p, 5)

                anchors.fill: parent

                Rectangle {
                    width: parent.width * 0.34
                    height: parent.height * 1.35
                    y: -parent.height * 0.18
                    rotation: -8
                    x: -width + eased * (parent.width + width * 1.6)
                    color: T.PAPER
                    opacity: 0.94
                }

                Rectangle {
                    width: 2
                    height: parent.height * 1.35
                    y: -parent.height * 0.18
                    rotation: -8
                    x: -width + eased * (parent.width + width * 1.6) + parent.width * 0.34
                    color: T.HIGHLIGHT
                    opacity: 0.55
                }
            }
        }
    }

    NumberAnimation {
        id: blindsAnim

        target: blinds
        property: "blindsProgress"
        from: 0
        to: 1
        duration: T.DUR_SWEEP + 180
        easing.type: Easing.OutExpo
    }

    // ── 常驻尘点：极小的浮尘缓慢上漂，给画面一点"空气"────────────────────
    Repeater {
        model: 26

        delegate: Rectangle {
            required property int index

            readonly property real seed: (index * 0.6180339887) % 1
            readonly property real size: index % 5 === 0 ? 2 : 1

            z: 905
            enabled: false
            width: size
            height: size
            color: index % 3 === 0 ? T.COBALT : T.INK
            opacity: root.awake ? (0.05 + seed * 0.09) : 0
            x: (index * 197) % Math.max(1, root.width)

            SequentialAnimation on y {
                loops: Animation.Infinite
                running: root.awake && root.motionTier > 0

                NumberAnimation {
                    from: root.height + 10
                    to: -12
                    duration: 16000 + index * 900
                    easing.type: Easing.Linear
                }
                PauseAnimation { duration: 1200 + index * 130 }
            }

            Behavior on opacity { NumberAnimation { duration: T.DUR_ENTER } }
        }
    }

    // ── 纹样样张（`--sheet`）────────────────────────────────────────────
    // 把四种组合模板并排铺成 2x2，配合 `--grab` 出设计验收图。
    // 只在带 --sheet 启动时出现；正常运行完全不建这些图版（visible=false 之外还跳过绘制）。
    Item {
        id: sheetLayer

        anchors.fill: parent
        z: 3000
        visible: (typeof sheetMode !== "undefined") && sheetMode

        Rectangle { anchors.fill: parent; color: T.PAPER }

        Grid {
            anchors.fill: parent
            anchors.margins: 3
            columns: 2
            spacing: 3

            Repeater {
                model: [
                    { key: "A", seed: 61, mark: "S", cap: "A  鸟群 + 圣徽 + 留白" },
                    { key: "B", seed: 97, mark: "F", cap: "B  羽翼 + 圣堂拱框" },
                    { key: "C", seed: 131, mark: "03", cap: "C  鸟群 + 坐标轴 + 几何轨迹" },
                    { key: "D", seed: 59, mark: "∴", cap: "D  玫瑰窗 + 放射几何 + 铭文" }
                ]

                delegate: Item {
                    required property var modelData

                    width: (sheetLayer.width - 9) / 2
                    height: (sheetLayer.height - 9) / 2

                    MotifPlate {
                        anchors.fill: parent
                        template: modelData.key
                        seed: modelData.seed
                        mark: modelData.mark
                        caption: modelData.cap
                        sealText: "STRONGHOLD LINK · TUNNEL CONSOLE · "
                        revealT: 1
                        active: true
                        ambient: false
                    }

                    Rectangle {
                        anchors.fill: parent
                        color: "transparent"
                        border.color: T.LINE_SOFT
                        border.width: 1
                    }

                    Text {
                        anchors.left: parent.left
                        anchors.top: parent.top
                        anchors.margins: 14
                        text: modelData.cap
                        font.family: T.FONT_MONO
                        font.pixelSize: 11
                        color: T.MUTED
                    }
                }
            }
        }
    }

    // 内存验收用：--cycle <ms> 定期在三页之间轮换，--cycles <n> 轮换 n 次后停下
// 正常启动时这两个上下文属性为 0，定时器不运行，对产品行为零影响
property int cycleDone: 0

    Component.onCompleted: {
        root.pollMetrics()
        root.revealPage()
    }
}
