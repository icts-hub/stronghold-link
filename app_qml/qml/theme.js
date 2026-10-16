.pragma library

// ══════════════════════════════════════════════════════════════════════════
// Stronghold Link — QML 设计令牌与确定性手绘几
// 设计语言按参考项目 the-masses-travels 的公开描述重新实现（纸张/墨色/钴蓝
// 手绘圆环与直尺线、过冲收笔、半调网点）。这里全部是自写代码，不复制上游源码
// 所有随机量都由固定种子驱动：界面静止时不会抖动
// ══════════════════════════════════════════════════════════════════════════

var PAPER = "#e9ecec"
var PAPER_LOCAL = "#eff1ef"
var INK = "#22282b"
var MUTED = "#6c7679"
var COBALT = "#3a5bc2"
var HIGHLIGHT = "#2a3fff"
var AZURE = "#4c92d4"
// 参考界面里那个高饱和的亮蓝（圆盘上的笔触、小方块与标条尾块）用的就是 HIGHLIGHT
// 的色值；ACCENT 是它在图版里的语义别名，别改成一个新颜色，否则图版会跟参考跑偏
var ACCENT = HIGHLIGHT
var LINE = "#9aa1a5"
var LINE_SOFT = "#c2c8ca"
var GOOD = "#3f6b4a"
var WARN = "#a9702c"
var BAD = "#a33a35"

var FONT_DISPLAY = "Georgia"
var FONT_MONO = "Consolas"
var FONT_SANS = "Segoe UI"
// 中文衬线：参考界面的中文标题用的是思源宋体一系的衬线字。本机没有字体文件，
// 所以按可用性依次回退（都是 Windows 自带字体族，不需要随包分发字体）
var FONT_SERIF_CN = "Noto Serif SC, Source Han Serif SC, SimSun, NSimSun, serif"

var PAD = 26
var HAIR = 1
var CUT = 12
var RADIUS = 2

// ── 动效令牌 ──────────────────────────────────────────────────────────────
// 参考项目的按钮过渡 0.22s、位移动效 0.3s，入场用 cubic-bezier(.19,1,.22,1)
// （一条很陡的 ease-out，QML 侧用 OutQuint/OutExpo 近似）。这里统一成毫秒
var DUR_PRESS = 120      // 按下
var DUR_HOVER = 180      // 悬停
var DUR = 240            // 颜色 / 透明
var DUR_ENTER = 420      // 切页与部件入
var STAGGER = 48         // 同页部件的错峰间
var LIFT = 16            // 入场时的横向位移（像素，设计坐标）
// ── 斜切与擦除（《明日方舟》那套界面语汇）────────────────────────────────
// 那块界面最认得出的三件事：① 一切色块都是平行四边形（斜切），没有纯矩形"高亮"；
// ② 内容不是淡入的，是被一条硬边"擦"出来的，擦除前沿压一道比底色更亮的细线；
// ③ 快出缓收 —— 0.15~0.35 秒，OutExpo/OutQuint，偶尔带一点点过冲。
// SKEW 是斜切量：每 1 单位高度在 x 方向偏移多少（负数是向右下斜）
var SKEW = -0.20
var DUR_WIPE = 320       // 面板被擦出来的时
var DUR_SWEEP = 560      // 全屏扫过（切页时
var DUR_MOVE = 340       // 高亮条滑
var STAGGER_WIPE = 55    // 面板之间的擦除错峰
// ── 间距 / 骨架 ────────────────────────────────────────────────────────────
var GAP_S = 8
var GAP = 14
var GAP_L = 22
var CHROME_H = 40         // 自绘标题栏高度（不参与版面缩放）
var TOPBAR_H = 84         // 版面内的品牌顶栏
var BOTTOM_H = 78         // 版面内的底部导航
var MAX_SCALE = 1.8       // 版面缩放上限：2560x1440 屏上把 1440x900 放大铺满。
// ── 层次：阴影三层叠加（软件渲染也画得出来，不用着色器）──────────────────
var SHADOW_1 = 0.10
var SHADOW_2 = 0.055
var SHADOW_3 = 0.03
// 面板底色：自上而下极轻微的渐变，让"纸"有厚度而不是一块纯色
var PANEL_TOP = "#f4f6f4"
var PANEL_BOTTOM = "#e7eae9"
// 顶栏 / 底栏这类"浮在版面上的框架"，比纸略亮一
var FRAME_TOP = "#f6f8f6"
var FRAME_BOTTOM = "#e4e8e7"
// 悬停时压在按钮上的那层极淡的雾（参考项目 .line-button:hover）
var HOVER_VEIL = "#14738c8b"
var PRESS_VEIL = "#1a22282b"

function rng(seed) {
    var s = (seed | 0) || 1
    return function () {
        s = (s + 0x6D2B79F5) | 0
        var t = Math.imul(s ^ (s >>> 15), 1 | s)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

function hashSeed(text) {
    var h = 2166136261
    var str = String(text === undefined || text === null ? "" : text)
    for (var i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i)
        h = Math.imul(h, 16777619)
    }
    return (h >>> 0) || 1
}

// 手绘圆环：半径叠两层正弦扰动，收口处略过冲；固定种子 → 每次一
function ringPoints(cx, cy, r, seed, opts) {
    opts = opts || {}
    var n = opts.steps || 220
    var a1 = opts.a1 === undefined ? 0.018 : opts.a1
    var a2 = opts.a2 === undefined ? 0.007 : opts.a2
    var f1 = opts.f1 || 3
    var f2 = opts.f2 || 7
    var over = opts.overshoot === undefined ? 0.055 : opts.overshoot
    var rand = rng(seed)
    var p1 = rand() * 6.283185307
    var p2 = rand() * 6.283185307
    var total = 6.283185307 * (1 + over)
    var pts = []
    for (var i = 0; i <= n; i++) {
        var a = total * i / n
        var rr = r * (1 + a1 * Math.sin(f1 * a + p1) + a2 * Math.sin(f2 * a + p2))
        pts.push({ x: cx + rr * Math.cos(a), y: cy + rr * Math.sin(a) })
    }
    return pts
}

// 手绘直尺线：中段微弯，两端各过冲若干像素
function rulePoints(x1, y1, x2, y2, seed, opts) {
    opts = opts || {}
    var steps = opts.steps || 22
    var bow = opts.bow === undefined ? 0.0035 : opts.bow
    var over = opts.overshoot === undefined ? 5 : opts.overshoot
    var rand = rng(seed)
    var sign = rand() < 0.5 ? -1 : 1
    var dx = x2 - x1
    var dy = y2 - y1
    var len = Math.sqrt(dx * dx + dy * dy) || 1
    var ux = dx / len
    var uy = dy / len
    var nx = -uy
    var ny = ux
    var pts = []
    for (var i = 0; i <= steps; i++) {
        var k = i / steps
        var t = -over + (len + 2 * over) * k
        var off = sign * bow * len * Math.sin(Math.PI * k)
        pts.push({ x: x1 + ux * t + nx * off, y: y1 + uy * t + ny * off })
    }
    return pts
}

// 半调网点
function dots(w, h, step, seed) {
    var rand = rng(seed)
    var out = []
    var rows = Math.max(1, Math.floor(h / step))
    var cols = Math.max(1, Math.floor(w / step))
    for (var r = 0; r < rows; r++) {
        for (var c = 0; c < cols; c++) {
            if (rand() < 0.5)
                continue
            out.push({ x: c * step + rand() * step * 0.4, y: r * step + rand() * step * 0.4, r: 0.55 + rand() * 0.7 })
        }
    }
    return out
}

// 节点星图：确定性布点 + 就近连线（好友页的星座图
function constellation(items, w, h, seed) {
    var rand = rng(seed)
    var nodes = []
    for (var i = 0; i < items.length; i++) {
        nodes.push({
            x: w * (0.12 + 0.76 * rand()),
            y: h * (0.14 + 0.72 * rand()),
            r: 2.2 + rand() * 2.4,
            item: items[i],
            index: i
        })
    }
    var links = []
    for (var a = 0; a < nodes.length; a++) {
        var best = -1
        var bestD = 1e9
        for (var b = 0; b < nodes.length; b++) {
            if (a === b)
                continue
            var dx = nodes[a].x - nodes[b].x
            var dy = nodes[a].y - nodes[b].y
            var d = dx * dx + dy * dy
            if (d < bestD) { bestD = d; best = b }
        }
        if (best >= 0 && bestD < (w * h) * 0.16)
            links.push({ a: a, b: best })
    }
    return { nodes: nodes, links: links }
}

function fmtBytes(n) {
    if (n === undefined || n === null || isNaN(n))
        return "—"
    var v = Number(n)
    if (v < 1024)
        return v.toFixed(0) + " B"
    if (v < 1024 * 1024)
        return (v / 1024).toFixed(1) + " KiB"
    if (v < 1024 * 1024 * 1024)
        return (v / 1048576).toFixed(2) + " MiB"
    return (v / 1073741824).toFixed(2) + " GiB"
}

function fmtSpeed(bytesPerSec) {
    if (bytesPerSec === undefined || bytesPerSec === null || isNaN(bytesPerSec))
        return "—"
    return fmtBytes(Number(bytesPerSec)) + "/s"
}

function fmtDuration(ms) {
    if (!ms || isNaN(ms))
        return "—"
    var s = Math.floor(Number(ms) / 1000)
    var h = Math.floor(s / 3600)
    var m = Math.floor((s % 3600) / 60)
    var ss = s % 60
    if (h > 0)
        return h + "h " + ("0" + m).slice(-2) + "m"
    if (m > 0)
        return m + "m " + ("0" + ss).slice(-2) + "s"
    return ss + "s"
}

function shortId(steamId) {
    var s = String(steamId === undefined || steamId === null ? "" : steamId)
    if (s.length <= 10)
        return s
    return s.slice(0, 4) + "····" + s.slice(-4)
}

function pad2(n) {
    return ("0" + Math.max(0, Math.floor(Number(n) || 0))).slice(-2)
}
