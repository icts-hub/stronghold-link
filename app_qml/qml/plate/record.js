.pragma library

// ══════════════════════════════════════════════════════════════════════════
// 设置页图版 —— 参照参考项目 recordPlate 的构图语汇重画。
//
// 参考项目的图鉴/记录页是"一张工程图纸"：细密的字距网格打底，右下角一道
// 斜向扫色，四角是裁切角标，边上排着带尺寸箭头的标尺，图纸中间横着一条条
// 记录行（细线 + 小标签 + 方块），右上角压一个大号的空心衬线编号，其余空
// 隙塞小窗、单据、条码、方块碎屑。整体是印刷品的感觉，不是卡片。
//
// 落点全部由固定种子决定：界面静止时图形不抖动。
// sketch 模块通过参数注入（与 hero.js / people.js 同一套约定）。
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

// 尺寸标注：两端带箭头的细线 + 中间断开留白给数字。
function dimLine(ctx, sk, x1, y1, x2, y2, r, ink) {
    var mx = (x1 + x2) / 2
    var my = (y1 + y2) / 2
    var gap = 26

    ctx.save()
    ctx.globalAlpha = 0.5
    ctx.strokeStyle = ink
    ctx.lineWidth = 0.8
    ctx.beginPath()
    sk.rulePath(ctx, x1, y1, mx - gap, my, r, 3, 0.7)
    sk.rulePath(ctx, mx + gap, my, x2, y2, r, 3, 0.7)
    ctx.stroke()

    // 两头的箭头
    var ang = Math.atan2(y2 - y1, x2 - x1)
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x1 + Math.cos(ang + 2.6) * 9, y1 + Math.sin(ang + 2.6) * 9)
    ctx.moveTo(x1, y1)
    ctx.lineTo(x1 + Math.cos(ang - 2.6) * 9, y1 + Math.sin(ang - 2.6) * 9)
    ctx.moveTo(x2, y2)
    ctx.lineTo(x2 - Math.cos(ang + 2.6) * 9, y2 - Math.sin(ang + 2.6) * 9)
    ctx.moveTo(x2, y2)
    ctx.lineTo(x2 - Math.cos(ang - 2.6) * 9, y2 - Math.sin(ang - 2.6) * 9)
    ctx.stroke()
    ctx.restore()
}

// 记录行：一条基线 + 起手小方块 + 若干刻度短线，像打印表格的一行。
function recordRow(ctx, sk, x, y, w, r, ink, accent, pale, filled) {
    ctx.save()
    ctx.beginPath()
    sk.rulePath(ctx, x, y, x + w, y, r, 6, 1.1)
    ctx.strokeStyle = ink
    ctx.lineWidth = 0.7
    ctx.globalAlpha = 0.4
    ctx.stroke()

    ctx.globalAlpha = 0.85
    ctx.fillStyle = filled ? accent : pale
    ctx.fillRect(x, y - 3.5, 7, 7)

    ctx.globalAlpha = 0.5
    ctx.strokeStyle = ink
    var seg = 0
    for (var i = 1; i <= 5; i++) {
        var sx = x + w * (i / 6)
        ctx.beginPath()
        ctx.moveTo(sx, y - 3)
        ctx.lineTo(sx, y - 3 - (2 + r() * 6))
        ctx.stroke()
        seg++
    }
    ctx.restore()
}

// 仪表：一段刻度弧 + 一根指针，用来占住图纸左上角。
function gauge(ctx, sk, cx, cy, rad, r, ink, accent, cobalt) {
    ctx.save()
    ctx.beginPath()
    sk.arcPath(ctx, cx, cy, rad, Math.PI * 1.15, Math.PI * 1.85, r, 1.2)
    ctx.strokeStyle = ink
    ctx.lineWidth = 1.2
    ctx.globalAlpha = 0.7
    ctx.stroke()

    ctx.globalAlpha = 0.5
    for (var i = 0; i <= 24; i++) {
        var a = Math.PI * 1.15 + (i / 24) * Math.PI * 0.7
        var len = (i % 6 === 0) ? 14 : 7
        ctx.beginPath()
        ctx.moveTo(cx + Math.cos(a) * (rad - 2), cy + Math.sin(a) * (rad - 2))
        ctx.lineTo(cx + Math.cos(a) * (rad - 2 - len), cy + Math.sin(a) * (rad - 2 - len))
        ctx.stroke()
    }

    // 指针：指向弧内的一个固定角度（不用时间，避免每帧变化）
    var na = Math.PI * 1.15 + 0.7 * Math.PI * (0.25 + r() * 0.42)
    ctx.globalAlpha = 0.9
    ctx.strokeStyle = accent
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(cx + Math.cos(na) * (rad - 18), cy + Math.sin(na) * (rad - 18))
    ctx.stroke()

    ctx.beginPath()
    ctx.arc(cx, cy, 5, 0, Math.PI * 2)
    ctx.fillStyle = cobalt
    ctx.globalAlpha = 0.9
    ctx.fill()
    ctx.restore()
}

// 小窗面板（与 hero.js / people.js 里同一套画法的私有副本 —— QML 的
// .pragma library 模块之间拿不到对方内部函数，改画法时记得几处一起改）。
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

function draw(ctx, w, h, sk, seed, legend, mark) {
    var r = sk.rng(seed === undefined ? 131 : seed)
    var C = PALETTE
    var D = 1000
    var k = Math.min(w / D, h / D)
    var ox = (w - D * k) / 2
    var oy = (h - D * k) / 2
    var focus = 0.5

    ctx.save()
    ctx.translate(ox, oy)
    ctx.scale(k, k)
    ctx.translate(((focus - 0.5) * w) / k, 0)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    /* ── 纸底：细密字距网格（参考 recordPlate 的 4px 字距网格）─────────── */
    ctx.beginPath(); ctx.rect(-400, -200, D + 800, D + 400)
    ctx.fillStyle = C.paper; ctx.fill()

    ctx.save()
    ctx.globalAlpha = 0.12
    ctx.strokeStyle = C.line
    ctx.lineWidth = 0.7
    ctx.beginPath()
    for (var gx = 0; gx <= D; gx += 50) { ctx.moveTo(gx, 0); ctx.lineTo(gx, D) }
    for (var gy = 0; gy <= D; gy += 52) { ctx.moveTo(0, gy); ctx.lineTo(D, gy) }
    ctx.stroke()
    ctx.restore()

    // 右下角斜向扫色（参考 recordPlate 底部那道 accent 扫笔）
    ctx.save()
    ctx.globalAlpha = 0.12
    ctx.fillStyle = C.accent
    ctx.beginPath()
    sk.strokeCurve(ctx, sk.sweepPts(180, 980, 1020, 620, 60, 22), false)
    ctx.lineTo(1120, 1060)
    ctx.lineTo(180, 1060)
    ctx.closePath()
    ctx.fill()
    ctx.restore()

    /* ── 图纸外框：双线框 + 裁切角标 + 套准标记 ───────────────────────── */
    ctx.save()
    ctx.globalAlpha = 0.75
    ctx.strokeStyle = C.ink
    ctx.lineWidth = 1.3
    ctx.beginPath(); ctx.rect(52, 52, 896, 896); ctx.stroke()
    ctx.globalAlpha = 0.35
    ctx.lineWidth = 0.7
    ctx.beginPath(); ctx.rect(62, 62, 876, 876); ctx.stroke()
    ctx.restore()

    ctx.beginPath()
    sk.cropsPath(ctx, 16, 16, 984, 984, 26)
    ctx.strokeStyle = C.ink; ctx.lineWidth = 1.2
    ctx.stroke()

    ctx.beginPath()
    sk.registrationPath(ctx, 96, 96, 15, r)
    sk.registrationPath(ctx, 904, 904, 15, r)
    ctx.strokeStyle = C.ink; ctx.lineWidth = 0.9
    ctx.save(); ctx.globalAlpha = 0.7; ctx.stroke(); ctx.restore()

    /* ── 右上角：大号空心衬线编号（参考的 150px 空心数字）─────────────── */
    ctx.save()
    ctx.globalAlpha = 0.6
    ctx.font = '400 240px Georgia, "Times New Roman", serif'
    ctx.textAlign = 'right'
    ctx.strokeStyle = C.accent
    ctx.lineWidth = 2.2
    ctx.strokeText(mark === undefined ? '03' : mark, 940, 300)
    ctx.restore()

    // 图纸标题栏（左上）
    ctx.save()
    ctx.globalAlpha = 0.9
    ctx.fillStyle = C.ink
    ctx.fillRect(78, 78, 300, 26)
    ctx.fillStyle = C.paper
    ctx.font = '600 13px Consolas, "Cascadia Mono", monospace'
    ctx.fillText('SETTING DOSSIER / 03', 88, 96)
    ctx.restore()

    /* ── 左侧：纵向量尺 + 尺寸标注线 ─────────────────────────────────── */
    sk.yRuler(ctx, 30, 200, 820, r)
    ctx.strokeStyle = C.ink; ctx.lineWidth = 0.8
    ctx.save(); ctx.globalAlpha = 0.5; ctx.stroke(); ctx.restore()

    dimLine(ctx, sk, 78, 132, 922, 132, r, C.ink)
    ctx.save()
    ctx.globalAlpha = 0.65
    ctx.fillStyle = C.ink
    ctx.font = '11px Consolas, "Cascadia Mono", monospace'
    ctx.textAlign = 'center'
    ctx.fillText('1000', 500, 126)
    ctx.restore()

    dimLine(ctx, sk, 940, 96, 940, 904, r, C.ink)
    ctx.save()
    ctx.globalAlpha = 0.65
    ctx.fillStyle = C.ink
    ctx.font = '11px Consolas, "Cascadia Mono", monospace'
    ctx.save()
    ctx.translate(958, 500)
    ctx.rotate(Math.PI / 2)
    ctx.textAlign = 'center'
    ctx.fillText('1000', 0, 0)
    ctx.restore()
    ctx.restore()

    /* ── 记录行：图纸中间那条条表格线 ─────────────────────────────────── */
    var rowY = 360
    for (var i = 0; i < 7; i++) {
        recordRow(ctx, sk, 120, rowY + i * 46, 620 - r() * 90, r, C.ink, C.accent, C.pale, i % 3 === 0)
    }

    /* ── 左上：仪表 ──────────────────────────────────────────────────── */
    gauge(ctx, sk, 220, 250, 92, r, C.ink, C.accent, C.cobalt)

    /* ── 右侧：一列状态灯块 ─────────────────────────────────────────── */
    for (var b = 0; b < 6; b++) {
        var by = 340 + b * 42
        var on = (b % 2 === 0)
        ctx.save()
        ctx.globalAlpha = on ? 0.9 : 0.35
        ctx.fillStyle = on ? C.cobalt : C.pale
        ctx.fillRect(790, by, 18, 18)
        ctx.globalAlpha = 0.55
        ctx.strokeStyle = C.ink
        ctx.lineWidth = 0.6
        ctx.beginPath()
        sk.ruleSeg(ctx, 818, by + 9, 818 + 60 + r() * 40, by + 9, r)
        ctx.stroke()
        ctx.restore()
    }

    /* ── 自转图注：沿下方一弧排字 ────────────────────────────────────── */
    ctx.save()
    ctx.globalAlpha = 0.55
    ctx.fillStyle = C.ink
    ctx.font = '600 13px Consolas, "Cascadia Mono", monospace'
    var text = (legend && legend.length ? legend : 'SETTING · DOSSIER · DIAGNOSTICS · STRONGHOLD LINK · ')
    var rad = 470
    var span = Math.PI * 0.9
    var a0 = Math.PI * 0.55
    for (var c = 0; c < text.length; c++) {
        var a = a0 + (c / Math.max(1, text.length - 1)) * span
        ctx.save()
        ctx.translate(500 + Math.cos(a) * rad, 500 + Math.sin(a) * rad)
        ctx.rotate(a - Math.PI / 2)
        ctx.fillText(text.charAt(c), 0, 0)
        ctx.restore()
    }
    ctx.restore()

    /* ── 碎片：小窗、单据、方块调色板、马赛克、故障条、条码 ───────────── */
    uiFrame(ctx, 120, 640, 210, 96, r, C, 1.3, -3, 'DIAGNOSTICS', sk)
    uiFrame(ctx, 690, 640, 200, 92, r, C, 1.3, 2, 'RUNTIME', sk)
    ticket(ctx, 300, 812, 230, 'STRONGHOLD LINK', ['SETTING / DOSSIER', 'TRANSPORT · DIAGNOSTICS'], r, C, 1.3, 1, sk)

    sk.pixels(ctx, 700, 200, 52, 24, r)
    sk.dotsNet(ctx, 210, 560, 70, 6, r, C, 1.0)
    sk.mosaic(ctx, 830, 520, 56, 12, r, [C.cobalt, C.accent, C.ink, C.pale])
    sk.glitchStrip(ctx, 560, 900, 260, 28, r, [C.ink, C.cobalt, C.accent])
    sk.blocks(ctx, r, 7, [640, 180, 300, 300], [C.accent, C.ink, C.paper, C.blush])

    ctx.save()
    ctx.globalAlpha = 0.62
    sk.dove(ctx, 620, 232, 0.46, false, 9)
    ctx.fill(); ctx.stroke()
    ctx.restore()

    ctx.save()
    ctx.globalAlpha = 0.8
    sk.flower(ctx, 160, 770, 1.2, C.accent, C, 1)
    ctx.restore()

    /* ── 近景：亮蓝光刃与四角星 ───────────────────────────────────────── */
    ctx.save()
    ctx.globalAlpha = 0.5
    ctx.fillStyle = C.accent
    sk.fillCurve(ctx, sk.blade(140, 940, 240, 18, -0.3, r), true)
    ctx.fillStyle = C.cobalt
    sk.fillCurve(ctx, sk.blade(880, 860, 200, 15, 0.35, r), true)
    ctx.restore()

    ctx.save()
    ctx.globalAlpha = 0.8
    ctx.fillStyle = C.accent
    sk.fillCurve(ctx, sk.sparklePts(430, 300, 18), false)
    ctx.fillStyle = C.ink
    sk.fillCurve(ctx, sk.sparklePts(640, 520, 13), false)
    ctx.restore()

    ctx.restore()
}
