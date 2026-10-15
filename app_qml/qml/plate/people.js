.pragma library

// ══════════════════════════════════════════════════════════════════════════
// 好友页图版 —— 参照参考项目 personnelPlate 的构图语汇重画。
//
// 参考项目的好友/档案页是"一圈人像版 + 连线 + 量尺 + 小窗碎片"的平面构成：
// 中心一座圆形徽记，四周散布头像版位（每个版位带套印的边框、编号与短线），
// 相邻版位之间用细线相连形成星座，角落压小窗、单据、信封与方块碎屑。
// 这里用同一套几何语汇画，落点全部由固定种子决定：界面静止时不抖动。
//
// 与 hero.js 一样：sketch 模块通过参数注入（不用 Qt.include，避免污染全局、
// 也保住离线 `node --check` 的能力）。
// ══════════════════════════════════════════════════════════════════════════

var PALETTE = {
    paper: '#eff1ef',
    ink: '#22282b',
    muted: '#6c7679',
    cobalt: '#3a5bc2',
    accent: '#2a3fff',
    line: '#9aa3a8',
    pale: '#c7cecd',
    blush: '#c94b5c'
}

// 人像版位：纸底 + 套印边框 + 内部头像剪影（圆头 + 肩线，纯几何，不用位图）
function portraitTile(ctx, sk, x, y, s, ink, cobalt, pale, paper, r) {
    ctx.save()
    ctx.translate(x, y)

    ctx.beginPath(); ctx.rect(0, 0, s, s)
    ctx.fillStyle = paper; ctx.fill()

    // 头与肩：两笔就把"档案照"的意思交代清楚
    ctx.beginPath()
    ctx.arc(s * 0.5, s * 0.38, s * 0.17, 0, Math.PI * 2)
    ctx.strokeStyle = ink; ctx.lineWidth = s * 0.035
    ctx.save(); ctx.globalAlpha = 0.75; ctx.stroke(); ctx.restore()

    ctx.beginPath()
    ctx.moveTo(s * 0.2, s * 0.86)
    ctx.quadraticCurveTo(s * 0.5, s * 0.55, s * 0.8, s * 0.86)
    ctx.strokeStyle = ink; ctx.lineWidth = s * 0.035
    ctx.save(); ctx.globalAlpha = 0.55; ctx.stroke(); ctx.restore()

    // 套印边框：同一矩形画两遍，第二遍偏移一点、降透明度
    ctx.beginPath(); ctx.rect(0, 0, s, s)
    ctx.strokeStyle = cobalt; ctx.lineWidth = s * 0.02
    ctx.save(); ctx.globalAlpha = 0.55; ctx.stroke(); ctx.restore()

    ctx.beginPath(); ctx.rect(s * 0.02, s * 0.023, s, s)
    ctx.strokeStyle = cobalt; ctx.lineWidth = s * 0.014
    ctx.save(); ctx.globalAlpha = 0.22; ctx.stroke(); ctx.restore()

    // 左下角编号短线
    ctx.beginPath()
    sk.rulePath(ctx, s * 0.08, s * 0.93, s * 0.08 + s * (0.18 + r() * 0.2), s * 0.93, r, 4, 0.8)
    ctx.strokeStyle = pale; ctx.lineWidth = s * 0.02
    ctx.save(); ctx.globalAlpha = 0.8; ctx.stroke(); ctx.restore()

    ctx.restore()
}

// 小窗面板（与 hero.js 里那一份同一套画法）。
//
// 为什么带一份私有副本：hero.js 的 uiFrame / ticket / envelope 是**该文件私有的**
// 文件级函数（没有导出机制），QML 的 .pragma library 模块之间只能通过参数互相传，
// 拿不到对方的内部函数。要么把三个函数抽成共享模块，要么各自留一份。
// 目前只有两个图版文件需要它们，抽模块的收益不抵改动风险，所以先各自留一份，
// 并在两处都注明 —— 要改画法时记得两边一起改。
function uiFrame(ctx, x, y, w, h, r, T, lw, rotDeg, title, sk) {
    ctx.save()
    ctx.translate(x + w / 2, y + h / 2)
    ctx.rotate(rotDeg * Math.PI / 180)
    ctx.translate(-w / 2, -h / 2)

    ctx.save(); ctx.globalAlpha = 0.82; ctx.fillStyle = T.paper
    ctx.fillRect(0, 0, w, h); ctx.restore()

    ctx.beginPath()
    ctx.moveTo(-2, 0); ctx.lineTo(w + 2, 0)
    ctx.strokeStyle = T.ink; ctx.lineWidth = 12 * lw
    ctx.save(); ctx.globalAlpha = 0.92; ctx.stroke(); ctx.restore()

    if (title) {
        ctx.save()
        ctx.fillStyle = T.paper
        ctx.font = '600 ' + (9 * lw) + 'px Consolas, "Cascadia Mono", monospace'
        ctx.fillText(title, 6, 9 * lw)
        ctx.restore()
    }

    ctx.beginPath()
    sk.ruleSeg(ctx, 6, h * 0.42, w - 6, h * 0.42, r)
    sk.ruleSeg(ctx, 6, h * 0.66, w - 6, h * 0.66, r)
    sk.ruleSeg(ctx, 6, h * 0.84, w * 0.55, h * 0.84, r)
    ctx.strokeStyle = T.cobalt; ctx.lineWidth = lw
    ctx.save(); ctx.globalAlpha = 0.55; ctx.stroke(); ctx.restore()

    ctx.beginPath(); ctx.rect(0, 0, w, h)
    ctx.strokeStyle = T.ink; ctx.lineWidth = lw * 0.8
    ctx.save(); ctx.globalAlpha = 0.5; ctx.stroke(); ctx.restore()

    ctx.beginPath()
    ctx.moveTo(w, h - 10); ctx.lineTo(w - 10, h - 10); ctx.lineTo(w, h - 2)
    ctx.strokeStyle = T.ink; ctx.lineWidth = lw; ctx.stroke()
    ctx.restore()
}

// 票据：黑底标题条 + 两行小字 + 条形码。
function ticket(ctx, x, y, w, title, lines, r, T, lw, rotDeg, sk) {
    var h = 74
    ctx.save()
    ctx.translate(x + w / 2, y + h / 2)
    ctx.rotate(rotDeg * Math.PI / 180)
    ctx.translate(-w / 2, -h / 2)

    ctx.save(); ctx.globalAlpha = 0.9; ctx.fillStyle = T.paper
    ctx.fillRect(0, 0, w, h); ctx.restore()

    ctx.fillStyle = T.ink
    ctx.fillRect(0, 0, w, 16)
    ctx.fillStyle = T.paper
    ctx.font = '600 11px Consolas, "Cascadia Mono", monospace'
    ctx.fillText(title, 6, 12)

    ctx.fillStyle = T.ink
    ctx.font = '10px Consolas, "Cascadia Mono", monospace'
    for (var i = 0; i < lines.length; i++) ctx.fillText(lines[i], 6, 30 + i * 17)

    sk.barcode(ctx, r, w - 74, 30, 62, 30, T.ink)

    ctx.beginPath(); ctx.rect(0, 0, w, h)
    ctx.strokeStyle = T.ink; ctx.lineWidth = lw * 0.8
    ctx.save(); ctx.globalAlpha = 0.55; ctx.stroke(); ctx.restore()
    ctx.restore()
}

// 信封：矩形 + 折线 V。
function envelope(ctx, x, y, s, T, lw, rotDeg) {
    var w = 120 * s, h = 78 * s
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(rotDeg * Math.PI / 180)
    ctx.save(); ctx.globalAlpha = 0.85; ctx.fillStyle = T.paper
    ctx.fillRect(-w / 2, -h / 2, w, h); ctx.restore()
    ctx.beginPath()
    ctx.rect(-w / 2, -h / 2, w, h)
    ctx.moveTo(-w / 2, -h / 2); ctx.lineTo(0, h * 0.12); ctx.lineTo(w / 2, -h / 2)
    ctx.strokeStyle = T.cobalt; ctx.lineWidth = lw
    ctx.stroke()
    ctx.restore()
}

function draw(ctx, w, h, sk, seed, legend, mark) {
    var r = sk.rng(seed === undefined ? 97 : seed)
    var C = PALETTE
    // 版心：作图区固定 1000 对应画布短边，但方块在画布里的**横向**位置可调。
    // 为什么需要这个：好友页的图版被挤在刊头与实时读数之间，横向空间只有纵向的一半
    // 左右；如果照 hero.js 那样把方块整体右移，圆盘就会被右边的读数压住。
    // focus 就是"方块中心落在画布宽度的百分之几"，默认 0.58（略偏右，接近参考）；
    // 窄版心时传 0.5 让它居中。
    var focus = 0.58
    var D = 1000
    var k = Math.min(w / D, h / D)
    var ox = (w - D * k) / 2
    var oy = (h - D * k) / 2

    ctx.save()
    ctx.translate(ox, oy)
    ctx.scale(k, k)
    // 横向对位：让方块中心落在画布宽度的 focus 处（纵向照旧居中）。
    ctx.translate(((focus - 0.5) * w) / k, 0)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    var cx = 520
    var cy = 470

    /* ── 纸底与网格 ───────────────────────────────────────────────────── */
    ctx.beginPath(); ctx.rect(-400, -200, D + 800, D + 400)
    ctx.fillStyle = C.paper; ctx.fill()

    ctx.save()
    ctx.globalAlpha = 0.13
    for (var gx = 0; gx <= D; gx += 50) {
        ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, D)
        ctx.strokeStyle = C.line; ctx.lineWidth = 0.7; ctx.stroke()
    }
    for (var gy = 0; gy <= D; gy += 52) {
        ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(D, gy)
        ctx.strokeStyle = C.line; ctx.lineWidth = 0.7; ctx.stroke()
    }
    ctx.restore()

    /* ── 远景：淡巨字 + 偏心大圆 ─────────────────────────────────────── */
    ctx.save()
    ctx.globalAlpha = 0.05
    ctx.fillStyle = C.ink
    ctx.font = '400 880px Georgia, "Times New Roman", serif'
    ctx.textAlign = 'center'
    ctx.fillText(mark === undefined ? 'F' : mark, 250, 880)
    ctx.restore()

    ctx.save()
    ctx.globalAlpha = 0.55
    sk.bigCircles(ctx, cx, cy, 372, r, C, 1)
    ctx.restore()

    /* ── 中心：圆形徽记（双环 + 米字 + 刻度 + 内嵌头像）───────────────── */
    ctx.beginPath()
    sk.ringPath(ctx, cx, cy, 208, r, 1.6)
    ctx.strokeStyle = C.cobalt; ctx.lineWidth = 1.5
    ctx.save(); ctx.globalAlpha = 0.7; ctx.stroke(); ctx.restore()

    ctx.beginPath()
    sk.ringPath(ctx, cx, cy, 214, r, 1.2)
    ctx.strokeStyle = C.cobalt; ctx.lineWidth = 0.8
    ctx.save(); ctx.globalAlpha = 0.3; ctx.stroke(); ctx.restore()

    ctx.beginPath()
    sk.ticksPath(ctx, cx, cy, 214, 72, r)
    ctx.strokeStyle = C.ink; ctx.lineWidth = 0.85
    ctx.save(); ctx.globalAlpha = 0.55; ctx.stroke(); ctx.restore()

    ctx.beginPath()
    sk.brokenAxisPath(ctx, cx - 150, cy, cx + 150, cy, r, 5)
    sk.brokenAxisPath(ctx, cx, cy - 150, cx, cy + 150, r, 5)
    ctx.strokeStyle = C.ink; ctx.lineWidth = 0.6
    ctx.save(); ctx.globalAlpha = 0.35; ctx.stroke(); ctx.restore()

    // 徽记内的档案照
    ctx.save()
    ctx.globalAlpha = 0.95
    portraitTile(ctx, sk, cx - 74, cy - 74, 148, C.ink, C.cobalt, C.pale, C.paper, r)
    ctx.restore()

    /* ── 星座：围绕徽记的人像版位 + 连线 ─────────────────────────────── */
    // 落点按参考 personnelPlate 的做法：极坐标取一圈，半径在 300~450 之间摆动，
    // 按横坐标排序后相邻相连，另补几根跳线，形成"关系网"的样子。
    var n = 9
    var pts = []
    for (var i = 0; i < n; i++) {
        var a = (i / n) * Math.PI * 2 + r() * 0.16 - 0.08
        var rad = 300 + r() * 150
        pts.push({ x: cx + Math.cos(a) * rad, y: cy + Math.sin(a) * rad * 0.82 })
    }
    var sorted = pts.slice().sort(function (p, q) { return p.x - q.x })

    ctx.beginPath()
    for (var j = 0; j + 1 < sorted.length; j++) {
        ctx.moveTo(sorted[j].x, sorted[j].y)
        ctx.lineTo(sorted[j + 1].x, sorted[j + 1].y)
    }
    for (var m = 0; m < 3; m++) {
        var p1 = sorted[Math.floor(r() * sorted.length)]
        var p2 = sorted[Math.floor(r() * sorted.length)]
        if (p1 === p2) continue
        ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y)
    }
    ctx.strokeStyle = C.cobalt; ctx.lineWidth = 0.9
    ctx.save(); ctx.globalAlpha = 0.42; ctx.stroke(); ctx.restore()

    for (var t = 0; t < pts.length; t++) {
        var sz = 52 + r() * 34

        // 版位到徽记的引线（画在版位底下，避免压住边框）
        ctx.beginPath()
        ctx.moveTo(pts[t].x, pts[t].y)
        ctx.lineTo(cx, cy)
        ctx.strokeStyle = C.line; ctx.lineWidth = 0.5
        ctx.save(); ctx.globalAlpha = 0.28; ctx.stroke(); ctx.restore()

        ctx.save()
        ctx.globalAlpha = 0.62 + r() * 0.3
        portraitTile(ctx, sk, pts[t].x - sz / 2, pts[t].y - sz / 2, sz, C.ink, C.cobalt, C.pale, C.paper, r)
        ctx.restore()

        ctx.beginPath()
        ctx.arc(pts[t].x, pts[t].y, 4 + r() * 3, 0, Math.PI * 2)
        ctx.fillStyle = (t % 3 === 0) ? C.accent : C.ink
        ctx.save(); ctx.globalAlpha = 0.85; ctx.fill(); ctx.restore()
    }

    /* ── 图注轨道：沿大圆自转的一圈文字 ───────────────────────────────── */
    ctx.save()
    ctx.globalAlpha = 0.6
    ctx.fillStyle = C.ink
    ctx.font = '600 14px Consolas, "Cascadia Mono", monospace'
    var text = (legend && legend.length ? legend : 'FRIENDS · STEAM LOBBY · STRONGHOLD LINK · ')
    var chars = text.split('')
    var per = chars.length
    for (var c = 0; c < per; c++) {
        var ang = (c / per) * Math.PI * 2 - Math.PI * 0.5
        ctx.save()
        ctx.translate(cx + Math.cos(ang) * 424, cy + Math.sin(ang) * 424)
        ctx.rotate(ang + Math.PI * 0.5)
        ctx.fillText(chars[c], 0, 0)
        ctx.restore()
    }
    ctx.restore()

    ctx.beginPath()
    sk.ringPath(ctx, cx, cy, 392, r, 1.2)
    ctx.strokeStyle = C.cobalt; ctx.lineWidth = 1.4
    ctx.save()
    ctx.globalAlpha = 0.5
    ctx.setLineDash([0.5, 11])
    ctx.stroke()
    ctx.restore()

    /* ── 工程图附件：量尺、栏注、套准标记、裁切角标 ───────────────────── */
    sk.yRuler(ctx, 40, 250, 760, r)
    ctx.strokeStyle = C.ink; ctx.lineWidth = 0.8
    ctx.save(); ctx.globalAlpha = 0.5; ctx.stroke(); ctx.restore()

    ctx.save(); ctx.globalAlpha = 0.5
    sk.columnText(ctx, 966, 160, 'FRIENDS · LOBBY · PRESENCE', C.ink)
    ctx.restore()

    ctx.beginPath()
    sk.registrationPath(ctx, 96, 176, 18, r)
    sk.registrationPath(ctx, 928, 872, 18, r)
    ctx.strokeStyle = C.ink; ctx.lineWidth = 0.9
    ctx.save(); ctx.globalAlpha = 0.75; ctx.stroke(); ctx.restore()

    ctx.beginPath()
    sk.cropsPath(ctx, 16, 16, 984, 984, 26)
    ctx.strokeStyle = C.ink; ctx.lineWidth = 1.2
    ctx.stroke()

    /* ── 碎片：小窗、单据、信封、方块调色板、马赛克、故障条 ───────────── */
    uiFrame(ctx, 96, 636, 198, 92, r, C, 1.3, -4, 'ROSTER', sk)
    uiFrame(ctx, 742, 596, 186, 86, r, C, 1.3, 3, 'PRESENCE', sk)
    ticket(ctx, 690, 782, 224, 'STRONGHOLD LINK', ['FRIENDS · STEAM LOBBY', 'PRESENCE / INVITE'], r, C, 1.3, 2, sk)
    envelope(ctx, 316, 268, 1.15, C, 1.25, -8)
    envelope(ctx, 300, 792, 0.88, C, 1.25, 10)

    sk.pixels(ctx, 812, 612, 54, 26, r)
    sk.dotsNet(ctx, 792, 268, 84, 7, r, C, 1.05)
    sk.mosaic(ctx, 180, 320, 60, 12, r, [C.cobalt, C.accent, C.ink, C.pale])
    sk.glitchStrip(ctx, 596, 842, 280, 30, r, [C.ink, C.cobalt, C.accent])
    sk.blocks(ctx, r, 8, [240, 200, 600, 600], [C.accent, C.ink, C.paper, C.blush])

    // 鸟：参考界面里飞散的鸟群，这里留两只在盘外
    ctx.save()
    ctx.globalAlpha = 0.62
    sk.dove(ctx, 700, 156, 0.5, false, 10)
    ctx.fill(); ctx.stroke()
    ctx.restore()
    ctx.save()
    ctx.globalAlpha = 0.5
    sk.dove(ctx, 168, 566, 0.42, true, -14)
    ctx.fill(); ctx.stroke()
    ctx.restore()

    ctx.save()
    ctx.globalAlpha = 0.8
    sk.flower(ctx, 262, 856, 1.3, C.accent, C, 1)
    sk.flower(ctx, 884, 520, 1.0, C.accent, C, 1)
    ctx.restore()

    /* ── 近景：亮蓝光刃与四角星 ───────────────────────────────────────── */
    // 注意：sketch 的 fillCurve(ctx, pts, closed) 自己 beginPath + 曲线 + fill()，
    // 颜色要用调用点的 fillStyle 指定（它不接颜色参数），别把颜色当成参数传进去。
    ctx.save()
    ctx.globalAlpha = 0.55
    ctx.fillStyle = C.accent
    sk.fillCurve(ctx, sk.blade(120, 900, 230, 18, -0.35, r), true)
    ctx.fillStyle = C.cobalt
    sk.fillCurve(ctx, sk.blade(900, 250, 210, 15, 0.42, r), true)
    ctx.restore()

    ctx.save()
    ctx.globalAlpha = 0.85
    ctx.fillStyle = C.accent
    sk.fillCurve(ctx, sk.sparklePts(186, 428, 21), false)
    ctx.fillStyle = C.cobalt
    sk.fillCurve(ctx, sk.sparklePts(770, 360, 13), false)
    ctx.fillStyle = C.ink
    sk.fillCurve(ctx, sk.sparklePts(636, 880, 16), false)
    ctx.restore()

    ctx.restore()
}
