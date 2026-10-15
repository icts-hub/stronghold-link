.pragma library

// ══════════════════════════════════════════════════════════════════════════
// Stronghold Link — QML 设计令牌与确定性手绘几何
// 设计语言按参考项目 the-masses-travels 的公开描述重新实现（纸张/墨色/钴蓝、
// 手绘圆环与直尺线、过冲收笔、半调网点）。这里全部是自写代码，不复制上游源码。
// 所有随机量都由固定种子驱动：界面静止时不会抖动。
// ══════════════════════════════════════════════════════════════════════════

var PAPER = "#e9ecec"
var PAPER_LOCAL = "#eff1ef"
var INK = "#22282b"
var MUTED = "#6c7679"
var COBALT = "#3a5bc2"
var HIGHLIGHT = "#2a3fff"
var AZURE = "#4c92d4"
var LINE = "#9aa1a5"
var LINE_SOFT = "#c2c8ca"
var GOOD = "#3f6b4a"
var WARN = "#a9702c"
var BAD = "#a33a35"

var FONT_DISPLAY = "Georgia"
var FONT_MONO = "Consolas"
var FONT_SANS = "Segoe UI"

var PAD = 26
var HAIR = 1
var CUT = 12
var RADIUS = 2

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

// 手绘圆环：半径叠两层正弦扰动，收口处略过冲；固定种子 → 每次一样
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

// 节点星图：确定性布点 + 就近连线（好友页的星座图）
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
