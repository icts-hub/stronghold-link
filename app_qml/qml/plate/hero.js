.pragma library

// 主视觉图版 —— 逐层复刻参考项目 D:\shl\the-masses-travels\src\plates.ts 的 homePlate()：
// 钴蓝圆盘压在半调网点上、同心圆环与 96 根刻度、断续十字轴线、40 根锥形光芒、
// 盘面上方的弧线与印章、飞离盘面的鸟群、散落的界面碎片（小窗 / 票据 / 点阵 / 六边簇 /
// 马赛克 / 故障条 / 像素块）、纵向量尺、套准标记、裁切角标。
//
// 坐标系与参考项目一致：1000x1000 的作图空间，盘心 (520,470)，盘半径 236 —— 每个数字都能
// 对着 plates.ts 的源码核。绘制时整体缩放到目标矩形。
//
// 与原版刻意的差异：图注文字换成本产品自己的字（不抄活动文案）；颜色取本项目的主题令牌；
// 不引入任何游戏素材 —— 全部是几何绘制，因此可以随包分发。

// 依赖通过参数注入：draw(ctx, w, h, sketch, seed, legend, mark)。
// 不用 Qt.include 是因为那会把 sketch.js 的符号塞进全局、还挡住离线语法检查；
// 显式传参后这两个文件都能被 node --check 直接校验。

var PALETTE = {
    paper: "#eff1ef",
    ink: "#22282b",
    muted: "#6c7679",
    cobalt: "#3a5bc2",
    accent: "#4c92d4",
    vivid: "#2a3fff",
    line: "#9aa3a8",
    pale: "#c7cecd"
}

// 参考项目里线宽按景深加权（sk.weight() 函数）。这里为每一层显式写出加权后的值，
// 免得改动景深时忘了同步线宽。
function scaleStroke(ctx, base, d) {
    ctx.lineWidth = base * (d < 0.3 ? 0.6 : d < 0.6 ? 0.85 : d < 1 ? 1.15 : 1.55)
}

// 半调网点：Canvas 没有 pattern 的填充遮罩就直接画点阵，密度按纵向渐隐。
function halftone(ctx, cx, cy, rad, colGap, rowGap, r, T, alphaTop, alphaBottom) {
    for (var y = cy - rad; y <= cy + rad; y += rowGap) {
        var t = (y - (cy - rad)) / (2 * rad)          // 0 顶 → 1 底
        var a = alphaTop + (alphaBottom - alphaTop) * t
        if (a <= 0.01) continue
        var dy = y - cy
        var half = Math.sqrt(Math.max(0, rad * rad - dy * dy))
        for (var x = cx - half + colGap / 2; x <= cx + half; x += colGap) {
            ctx.save()
            ctx.globalAlpha = a
            ctx.fillStyle = T.paper
            ctx.beginPath()
            ctx.arc(x, y, 2, 0, Math.PI * 2)
            ctx.fill()
            ctx.restore()
        }
    }
}

/**
 * 画一张完整的图版。
 * ctx     : Canvas 的 2D 上下文
 * w, h    : 目标矩形尺寸（作图空间 1000x1000 会等比缩放并居中）
 * seed    : 确定性种子
 * legend  : 沿圆环自转的图注文字
 * mark    : 大号衬线数字/字母（参考项目里是 'N'，这里用来放主视觉字）
 * onDraw  : 可选回调，传 (ctx, scale, offsetX, offsetY) 供调用方叠画自己的内容
 */
function draw(ctx, w, h, sk, seed, legend, mark) {
    var r = sk.rng(seed === undefined ? 61 : seed)
    var T = PALETTE
    var D = 1000                                  // 作图空间边长
    var k = Math.min(w / D, h / D)                // 等比缩放系数
    var ox = (w - D * k) / 2
    var oy = (h - D * k) / 2
    // 参考项目的版面里图版占满整宽，圆盘坐落在画面偏右的位置，左边留给刊头文字。
    // 我们的图版只占左栏（约 680px），若照居中摆放，圆盘会正好压在标题上；所以把
    // 圆盘连同它的刻度环、图注轨道一起右移一点点，让刊头文字落在盘外的留白里。
    var shift = D * 0.085

    ctx.save()
    ctx.translate(ox, oy)
    ctx.scale(k, k)
    ctx.translate(shift, 0)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    var C = [520, 470]                            // 盘心，与 plates.ts 一致
    var CT = T                                    // 参考项目把 CT 当成一个颜色集合

    /* ── d .15：远景 —— 巨大的衬线首字母、钴蓝扫笔、四片淡光刃 ─────────────── */
    ctx.save()
    ctx.globalAlpha = 0.06
    ctx.fillStyle = T.ink
    ctx.font = '400 900px Georgia, "Times New Roman", serif'
    ctx.textAlign = 'center'
    ctx.fillText(mark === undefined ? 'S' : mark, 240, 860)
    ctx.restore()

    ctx.save()
    ctx.globalAlpha = 0.10
    ctx.fillStyle = T.cobalt
    sk.brushPath(ctx, sk.sweepPts(40, 860, 980, 260, 70), 150, 0.42)
    ctx.fill()
    ctx.restore()

    for (var i = 0; i < 4; i++) {
        ctx.save()
        ctx.globalAlpha = 0.05 + r() * 0.07
        ctx.fillStyle = T.ink
        sk.bladePath(ctx, 100 + r() * 800, 120 + r() * 760, 200 + r() * 260, 16 + r() * 22, r() * Math.PI * 2, r)
        ctx.fill()
        ctx.restore()
    }

    /* ── d .3：背景大圆 + 光芒 ──────────────────────────────────────────── */
    sk.bigCircles(ctx, C[0], C[1], 360, r, CT, 1)
    sk.sunburst(ctx, C[0], C[1], 300, 520, 72, r, CT, 1.3)

    /* ── d .4：40 根锥形光芒 + 三圈环 + 96 根刻度 + 断续轴线 + 量尺与角标 ── */
    for (var j = 0; j < 40; j++) {
        var a = j / 40 * Math.PI * 2 + r() * 0.07
        var a0 = 262 + r() * 24, l = 320 + r() * 190, bw = 2 + r() * 5
        var pts = [
            [C[0] + Math.cos(a) * a0, C[1] + Math.sin(a) * a0],
            [C[0] + Math.cos(a + 0.004) * (a0 + l) / 2 + (r() - 0.5) * 3, C[1] + Math.sin(a + 0.004) * (a0 + l) / 2],
            [C[0] + Math.cos(a) * l, C[1] + Math.sin(a) * l]
        ]
        ctx.save()
        ctx.globalAlpha = 0.25 + r() * 0.5
        ctx.fillStyle = T.ink
        sk.brushPath(ctx, pts, bw, 0.25)
        ctx.fill()
        ctx.restore()
    }

    ctx.strokeStyle = T.ink
    sk.ringPath(ctx, C[0], C[1], 300, r, 2); ctx.lineWidth = 1.3; ctx.stroke()
    sk.ringPath(ctx, C[0], C[1], 302, r, 2.6)
    ctx.lineWidth = 0.6; ctx.save(); ctx.globalAlpha = 0.4; ctx.stroke(); ctx.restore()

    sk.ringPath(ctx, C[0], C[1], 268, r, 1.4)
    ctx.lineWidth = 0.8; ctx.setLineDash([2, 6]); ctx.stroke(); ctx.setLineDash([])

    sk.ticksPath(ctx, C[0], C[1], 300, 96, r)
    ctx.lineWidth = 0.9; ctx.save(); ctx.globalAlpha = 0.7; ctx.stroke(); ctx.restore()

    sk.brokenAxisPath(ctx, C[0], 80, C[0], 900, r, 5)
    sk.brokenAxisPath(ctx, 90, C[1], 950, C[1], r, 5)
    ctx.lineWidth = 0.6; ctx.save(); ctx.globalAlpha = 0.35; ctx.stroke(); ctx.restore()

    // 纵向量尺 + Yn 标签
    var labels = sk.yRuler(ctx, 40, 240, 760, r)
    ctx.strokeStyle = T.ink; ctx.lineWidth = 0.9
    ctx.save(); ctx.globalAlpha = 0.7; ctx.stroke(); ctx.restore()
    ctx.save()
    ctx.globalAlpha = 0.7
    ctx.fillStyle = T.ink
    ctx.font = '11px Consolas, "Cascadia Mono", monospace'
    for (var q = 0; q < labels.length; q++) ctx.fillText(labels[q][2], labels[q][0], labels[q][1])
    ctx.restore()

    // 右侧竖排栏目名
    sk.columnText(ctx, 968, 150, "SESSION · FRIENDS · SETTING · A TUNNEL TOWARDS THE LIGHT", T.ink)

    // 套准标记 + 裁切角标
    sk.registrationPath(ctx, 90, 170, 18, r)
    sk.registrationPath(ctx, 930, 880, 18, r)
    ctx.strokeStyle = T.ink; ctx.lineWidth = 0.9; ctx.stroke()
    sk.cropsPath(ctx, 16, 16, 984, 984); ctx.lineWidth = 1.1; ctx.stroke()

    /* ── d .45：沿大圆自转的一圈图注 + 382 半径的点线环与四个节点 ─────────── */
    orbitLegend(ctx, C[0], C[1], 400, legend, T)
    sk.ringPath(ctx, C[0], C[1], 382, r, 1.2)
    ctx.strokeStyle = T.ink; ctx.lineWidth = 1.6
    ctx.setLineDash([0.5, 11]); ctx.stroke(); ctx.setLineDash([])
    for (var n4 = 0; n4 < 4; n4++) {
        var an = r() * Math.PI * 2
        ctx.beginPath()
        ctx.arc(C[0] + Math.cos(an) * 382, C[1] + Math.sin(an) * 382, (n4 % 2) ? 4 : 7, 0, Math.PI * 2)
        ctx.fillStyle = T.paper; ctx.fill()
        ctx.strokeStyle = T.accent; ctx.lineWidth = 1.6; ctx.stroke()
    }

    /* ── d .5：左下那道粗笔触 + 细弧（参考项目里这一层反向自转）───────────── */
    ctx.save()
    ctx.fillStyle = T.accent
    sk.brushPath(ctx, sk.arcPts(C[0], C[1], 322, -2.6, -0.4, r, 1.4), 20, 0.45)
    ctx.fill()
    ctx.restore()
    ctx.strokeStyle = T.accent; ctx.lineWidth = 1
    sk.arcPath(ctx, C[0], C[1], 334, -2.5, 0.1, r, 1); ctx.stroke()

    /* ── d .6：钴蓝圆盘 + 半调网点 + 套印两遍的盘缘 ───────────────────────── */
    var discPts = sk.ringPts(C[0], C[1], 236, r, 1.8)
    ctx.beginPath(); sk.strokeCurve(ctx, discPts, false)
    ctx.fillStyle = T.cobalt; ctx.fill()

    halftone(ctx, C[0], C[1], 234, 14, 14, r, T, 0.05, 0.48)

    ctx.save()
    ctx.strokeStyle = T.ink; ctx.lineWidth = 1.2
    sk.ringPath(ctx, C[0], C[1], 238, r, 1.4); ctx.stroke()
    ctx.globalAlpha = 0.26
    ctx.translate(1.6, 1.1)
    sk.ringPath(ctx, C[0], C[1], 238, r, 1.4); ctx.stroke()
    ctx.restore()

    /* ── d .9：上方压扁的弧冠、印章、白扫笔、构造图、六边簇、马赛克、故障条 ── */
    ctx.strokeStyle = T.ink
    sk.ringPath(ctx, C[0], 196, 190, r, 1.6, 0.21); ctx.lineWidth = 2.8; ctx.stroke()
    sk.ringPath(ctx, C[0], 198, 150, r, 1, 0.19)
    ctx.lineWidth = 0.9; ctx.save(); ctx.globalAlpha = 0.6; ctx.stroke(); ctx.restore()

    ctx.save()
    ctx.fillStyle = T.accent
    sk.brushPath(ctx, sk.arcPts(C[0], 196, 190, 0.2, 2.95, r, 1, 0.21), 11, 0.5)
    ctx.fill()
    ctx.restore()

    sealStamp(ctx, 408, 340, 1.4, T.paper)

    ctx.save()
    ctx.globalAlpha = 0.6
    ctx.fillStyle = T.paper
    sk.brushPath(ctx, sk.sweepPts(330, 600, 720, 380, 16), 22, 0.45)
    ctx.fill()
    ctx.restore()

    sk.constellation(ctx, 250, 700, 140, 8, r, T.ink, T.accent)
    sk.hexCluster(ctx, 850, 690, 26, r, T, null, ['01', '02', '03', '04', '05', '06'])
    sk.mosaic(ctx, 170, 300, 64, 12, r, [T.cobalt, T.accent, T.ink, T.pale])
    sk.glitchStrip(ctx, 620, 820, 300, 34, r, [T.ink, T.cobalt, T.accent])

    /* ── d .95：散落实心色块 ────────────────────────────────────────────── */
    sk.blocks(ctx, r, 10, [220, 180, 620, 620], [T.accent, T.ink, T.paper, '#c94b5c'])

    /* ── d .98：界面碎片 —— 像素、点阵、三个小窗、票据、信封、花与草 ─────── */
    sk.pixels(ctx, 790, 640, 60, 30, r)
    sk.pixels(ctx, 250, 250, 36, 16, r)
    sk.dotsNet(ctx, 800, 300, 90, 7, r, CT, 1.1)
    uiFrame(ctx, 110, 560, 200, 96, r, CT, 1.4, -4, 'RECORD · 06', sk)
    uiFrame(ctx, 760, 520, 186, 88, r, CT, 1.4, 3, 'LATERANO', sk)
    uiFrame(ctx, 640, 90, 170, 70, r, CT, 1.4, -2, 'SESSION', sk)
    ticket(ctx, 700, 760, 230, "STRONGHOLD LINK", ['TUNNEL CONTROL · QML EDITION', 'SESSION / FRIENDS / SETTING'], r, CT, 1.4, 2, sk)
    envelope(ctx, 330, 300, 1.2, CT, 1.3, -8)
    envelope(ctx, 318, 762, 0.9, CT, 1.3, 10)
    ctx.save(); ctx.fillStyle = T.paper; ctx.strokeStyle = T.cobalt; ctx.lineWidth = 1.4
    sk.dove(ctx, 330, 168, 0.62, false, -12); ctx.fill(); ctx.stroke()
    sk.dove(ctx, 700, 146, 0.46, true, 10); ctx.fill(); ctx.stroke()
    sk.dove(ctx, 866, 334, 0.40, false, -20); ctx.fill(); ctx.stroke()
    sk.dove(ctx, 150, 610, 0.50, true, 8); ctx.fill(); ctx.stroke()
    ctx.restore()
    sk.flower(ctx, 262, 836, 1.5, T.accent, CT, 1)
    sk.flower(ctx, 292, 862, 1.0, T.vivid, CT, 1)
    sk.flower(ctx, 884, 566, 1.1, T.vivid, CT, 1)

    /* ── 斜向起飞的鸟群（参考项目 plates.ts:174）─────────────────────────
     * 这是那张图的招牌元素：九只鸟沿一条斜线自盘面右上方飞离，越远越小、
     * 每三只水平翻转一次（避免看起来是同一只复制九遍）。参考参数：
     *   x = 580 + i*44 + r()*30, y = 230 - i*18 + r()*40, s = .32 + r()*.38 */
    ctx.save()
    ctx.fillStyle = T.ink
    for (var fb = 0; fb < 9; fb++) {
        var fx = 580 + fb * 44 + r() * 30
        var fy = 230 - fb * 18 + r() * 40
        var fs = 0.32 + r() * 0.38
        ctx.save()
        ctx.translate(fx, fy)
        if (fb % 3 === 1) ctx.scale(-1, 1)
        ctx.scale(fs, fs)
        ctx.translate(-50, -30)
        sk.birdPath(ctx)
        ctx.fill()
        ctx.restore()
    }
    ctx.restore()

    /* ── d 1.3：四枚闪光 + 圆角标签条 ───────────────────────────────────── */
    var sparks = [[170, 420, 22, T.accent], [760, 250, 14, T.cobalt], [640, 860, 18, T.ink], [250, 880, 10, T.accent]]
    for (var sp = 0; sp < sparks.length; sp++) {
        ctx.fillStyle = sparks[sp][3]
        sk.polyPath(ctx, sk.sparklePts(sparks[sp][0], sparks[sp][1], sparks[sp][2]))
        ctx.fill()
    }

    /* ── d 1.5：近景 —— 三片光刃（参考项目里带 1.6px 景深模糊，Canvas 用淡色近似）── */
    ctx.save()
    ctx.globalAlpha = 0.62
    var bladeCols = [T.ink, T.cobalt, T.accent]
    var bladeXY = [[90, 860], [700, 140], [930, 930]]
    for (var bl = 0; bl < 3; bl++) {
        ctx.fillStyle = bladeCols[bl]
        sk.bladePath(ctx, bladeXY[bl][0], bladeXY[bl][1], 220 + r() * 140, 16 + r() * 14, r() * Math.PI * 2, r)
        ctx.fill()
    }
    ctx.restore()

    ctx.restore()
}

/* ── 上列图层用到的两个组合件 ─────────────────────────────────────────── */

// 沿半径 rad 的圆环自转排列的图注文字。
function orbitLegend(ctx, cx, cy, rad, text, T) {
    if (!text) return
    ctx.save()
    ctx.fillStyle = T.ink
    ctx.font = '600 15px Consolas, "Cascadia Mono", monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    var chars = text.split('')
    var step = Math.PI * 2 / chars.length
    for (var i = 0; i < chars.length; i++) {
        var a = -Math.PI / 2 + i * step
        ctx.save()
        ctx.translate(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad)
        ctx.rotate(a + Math.PI / 2)
        ctx.fillText(chars[i], 0, 0)
        ctx.restore()
    }
    ctx.restore()
}

// 印章：双圆 + 米字 + 两侧翼（参考项目 ui.ts 的 seal）。
function sealStamp(ctx, x, y, s, color) {
    ctx.save()
    ctx.translate(x, y)
    ctx.scale(s, s)
    ctx.strokeStyle = color
    ctx.lineWidth = 1.6
    ctx.beginPath()
    ctx.arc(80, 68, 45, 0, Math.PI * 2)
    ctx.moveTo(80 + 39, 68); ctx.arc(80, 68, 39, 0, Math.PI * 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(80, 5); ctx.lineTo(80, 153)
    ctx.moveTo(18, 115); ctx.lineTo(142, 115)
    ctx.moveTo(35, 141); ctx.lineTo(80, 63); ctx.lineTo(125, 141)
    ctx.moveTo(12, 68); ctx.lineTo(148, 68)
    ctx.moveTo(27, 31); ctx.lineTo(133, 137)
    ctx.moveTo(133, 31); ctx.lineTo(27, 137)
    ctx.stroke()
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.moveTo(4, 92); ctx.lineTo(35, 99); ctx.lineTo(59, 121); ctx.lineTo(29, 117); ctx.closePath()
    ctx.moveTo(156, 92); ctx.lineTo(125, 99); ctx.lineTo(101, 121); ctx.lineTo(131, 117); ctx.closePath()
    ctx.fill()
    ctx.beginPath(); ctx.arc(80, 68, 5, 0, Math.PI * 2); ctx.fill()
    ctx.restore()
}

// 小窗面板：纸底 + 顶部粗黑条 + 两条细线 + 边 + 右下角折角。
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

// 票据：黑底标题条 + 编号 + 条形码。
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
