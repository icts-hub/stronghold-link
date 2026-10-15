.pragma library

// 手绘线条语汇 —— 从参考项目 D:\shl\the-masses-travels\src\sketch.ts 逐条重写过来的。
// 参考项目用 SVG 的 `d` 字符串，这里换成 Canvas 2D 的路径调用，几何公式与常量一字不改：
// 圆环会越过起点再收笔、标线微微拱起又冲出端点、笔触中段鼓起两端收尖、
// 关键线条描两遍且第二遍故意错开（套印没对准的效果）。
//
// 为什么必须照抄几何而不是"看着像就行"：手绘感全在这些细节里 ——
// 抖动是双正弦低频（不是随机噪点）、收笔过冲 0.1~0.4 弧度、笔触宽度按 sin^0.75 分布。
// 少一样看起来就是"另一个东西"。

var TAU = Math.PI * 2

// 参考项目的确定性伪随机（xorshift32）。同一个 seed 永远得到同一张图。
function rng(seed) {
    var s = (seed >>> 0) || 1
    return function () {
        s ^= s << 13; s >>>= 0
        s ^= s >>> 17
        s ^= s << 5; s >>>= 0
        return ((s >>> 0) % 100000) / 100000
    }
}

function num(n) { return Math.round(n * 10) / 10 }

// 低频径向抖动：两个正弦、随机相位，所以圆环是"呼吸"而不是"发抖"。
function wobble(r) {
    var a = r() * TAU, b = r() * TAU
    var k = 1 + Math.floor(r() * 2), m = 3 + Math.floor(r() * 3)
    return function (t) { return Math.sin(t * k + a) * 0.65 + Math.sin(t * m + b) * 0.35 }
}

// 一段弧的采样点。n 与参考项目一致：弧长每 26px 取一个点，至少 6 个。
function arcPts(cx, cy, rad, a0, a1, r, amp, sy) {
    amp = amp === undefined ? 1.6 : amp
    sy = sy === undefined ? 1 : sy
    var w = wobble(r)
    var n = Math.max(6, Math.ceil(Math.abs(a1 - a0) * rad / 26))
    var out = []
    for (var i = 0; i <= n; i++) {
        var a = a0 + (a1 - a0) * i / n
        var rr = rad + w(a) * amp
        out.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * sy])
    }
    return out
}

// 一笔画完的圆环：从任意角度起笔，越过起点一点点再收（+0.1~0.4 弧度）。
function ringPts(cx, cy, rad, r, amp, sy) {
    var a0 = r() * TAU
    return arcPts(cx, cy, rad, a0, a0 + TAU + 0.1 + r() * 0.3, r, amp, sy)
}

// 手画的标线：中段微微拱起（bow），两端冲出标记点（over）。
// 返回三次点集 [起点, 控制点, 终点]，供 quadraticCurveTo 使用。
function rule(x1, y1, x2, y2, r, over, bow) {
    over = over === undefined ? 10 : over
    bow = bow === undefined ? 2.4 : bow
    var dx = x2 - x1, dy = y2 - y1
    var l = Math.hypot(dx, dy) || 1
    var ux = dx / l, uy = dy / l
    var o1 = over * (0.3 + r()), o2 = over * (0.3 + r())
    var b = (r() - 0.5) * 2 * bow
    return [
        [x1 - ux * o1, y1 - uy * o1],
        [(x1 + x2) / 2 - uy * b, (y1 + y2) / 2 + ux * b],
        [x2 + ux * o2, y2 + uy * o2]
    ]
}

// 笔触：沿路径鼓起、两端收成尖的填充轮廓。
// 宽度系数 k = sin(π·t^(bias·2))^0.75，两端最小值 0.03。返回左右两条轮廓点集。
function brushOutline(pts, w, bias) {
    bias = bias === undefined ? 0.5 : bias
    var n = pts.length, L = [], R = []
    for (var i = 0; i < n; i++) {
        var a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)]
        var nx = -(b[1] - a[1]), ny = b[0] - a[0]
        var l = Math.hypot(nx, ny) || 1
        nx /= l; ny /= l
        var t = i / (n - 1)
        var k = Math.pow(Math.sin(Math.PI * Math.pow(t, bias * 2)), 0.75)
        var hw = w * Math.max(0.03, k) / 2
        L.push([pts[i][0] + nx * hw, pts[i][1] + ny * hw])
        R.push([pts[i][0] - nx * hw, pts[i][1] - ny * hw])
    }
    R.reverse()
    return [L, R]
}

// 沿一条缓和 S 形扫过的点集（sweepPts）。
function sweepPts(x1, y1, x2, y2, amp, n) {
    n = n === undefined ? 14 : n
    var nx = -(y2 - y1), ny = x2 - x1
    var l = Math.hypot(nx, ny) || 1
    var out = []
    for (var i = 0; i <= n; i++) {
        var t = i / n, s = Math.sin(t * Math.PI * 1.6) * amp
        out.push([x1 + (x2 - x1) * t + nx / l * s, y1 + (y2 - y1) * t + ny / l * s])
    }
    return out
}

// 光刃碎片：活动界面里那种弯曲的细长刀片。
// 返回 [起点, 控制点1, 终点, 控制点2]，供两段 quadraticCurveTo 使用。
function blade(cx, cy, len, w, ang, r) {
    var ux = Math.cos(ang), uy = Math.sin(ang)
    var nx = -uy, ny = ux
    var s = (r() - 0.3) * 0.5
    var ax = cx - ux * len / 2, ay = cy - uy * len / 2
    var bx = cx + ux * len / 2, by = cy + uy * len / 2
    return [
        [ax, ay],
        [cx + ux * len * s + nx * w, cy + uy * len * s + ny * w],
        [bx, by],
        [cx + ux * len * s * 0.6 - nx * w * 0.2, cy + uy * len * s * 0.6 - ny * w * 0.2]
    ]
}

// 四角星闪光。返回轮廓点集（顶点 → 内凹 → 顶点 …）。
function sparklePts(x, y, s) {
    return [
        [x, y - s], [x, y], [x + s * 0.7, y], [x, y], [x, y + s], [x, y], [x - s * 0.7, y], [x, y]
    ]
}

// 六边形点集，每个顶点带 ±0.7px 抖动（手画的不准）。
function hexPts(cx, cy, s, r) {
    var out = []
    for (var k = 0; k < 6; k++) {
        var a = k / 6 * TAU - Math.PI / 2
        out.push([cx + Math.cos(a) * s + (r() - 0.5) * 1.4, cy + Math.sin(a) * s + (r() - 0.5) * 1.4])
    }
    return out
}

/* ── Canvas 绘制助手 ───────────────────────────────────────────────────── */

// 用 Catmull-Rom 转三次贝塞尔把点串平滑连起来（参考项目的 curve()）。
function strokeCurve(ctx, pts, closed) {
    var n = pts.length
    if (n < 2) return
    function at(i) {
        return closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]
    }
    ctx.moveTo(pts[0][0], pts[0][1])
    var last = closed ? n : n - 1
    for (var i = 0; i < last; i++) {
        var p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2)
        ctx.bezierCurveTo(
            p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
            p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6,
            p2[0], p2[1])
    }
    if (closed) ctx.closePath()
}

function fillCurve(ctx, pts, closed) {
    ctx.beginPath(); strokeCurve(ctx, pts, closed); ctx.fill()
}

function line(ctx, pts, closed) {
    ctx.beginPath(); strokeCurve(ctx, pts, closed); ctx.stroke()
}

function ringPath(ctx, cx, cy, rad, r, amp, sy) {
    ctx.beginPath(); strokeCurve(ctx, ringPts(cx, cy, rad, r, amp, sy), false)
}

function arcPath(ctx, cx, cy, rad, a0, a1, r, amp, sy) {
    ctx.beginPath(); strokeCurve(ctx, arcPts(cx, cy, rad, a0, a1, r, amp, sy), false)
}

// 一条手画标线。
function rulePath(ctx, x1, y1, x2, y2, r, over, bow) {
    var p = rule(x1, y1, x2, y2, r, over, bow)
    ctx.beginPath()
    ctx.moveTo(p[0][0], p[0][1])
    ctx.quadraticCurveTo(p[1][0], p[1][1], p[2][0], p[2][1])
}

// 笔触：先把轮廓摆好（不含 beginPath），调用方自己决定填充还是描边。
function brushPath(ctx, pts, w, bias) {
    var o = brushOutline(pts, w, bias)
    ctx.beginPath()
    strokeCurve(ctx, o[0], false)
    var R = o[1]
    ctx.lineTo(R[0][0], R[0][1])
    strokeCurve(ctx, R, false)
    ctx.closePath()
}

function bladePath(ctx, cx, cy, len, w, ang, r) {
    var p = blade(cx, cy, len, w, ang, r)
    ctx.beginPath()
    ctx.moveTo(p[0][0], p[0][1])
    ctx.quadraticCurveTo(p[1][0], p[1][1], p[2][0], p[2][1])
    ctx.quadraticCurveTo(p[3][0], p[3][1], p[0][0], p[0][1])
    ctx.closePath()
}

function polyPath(ctx, pts) {
    ctx.beginPath()
    ctx.moveTo(pts[0][0], pts[0][1])
    for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1])
    ctx.closePath()
}

// 关键线条描两遍：第二遍整体错开 (dx,dy) 且更淡 —— 套印没对准的油墨。
function inked(ctx, dx, dy, drawFn) {
    drawFn(1.0)
    ctx.save()
    ctx.globalAlpha = (ctx.globalAlpha === undefined ? 1 : ctx.globalAlpha) * 0.26
    ctx.translate(dx === undefined ? 1.6 : dx, dy === undefined ? 1.1 : dy)
    drawFn(1.0)
    ctx.restore()
}

// 圆环上的刻度线：每 1/12 一根长、每 1/24 一根中、其余短，长度还带 ±20% 抖动。
function ticksPath(ctx, cx, cy, rad, n, r) {
    ctx.beginPath()
    for (var i = 0; i < n; i++) {
        var a = i / n * TAU
        var base = (i % (n / 12) === 0) ? 20 : (i % (n / 24) === 0) ? 11 : 5
        var l = base * (0.8 + r() * 0.4)
        ctx.moveTo(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad)
        ctx.lineTo(cx + Math.cos(a) * (rad + l), cy + Math.sin(a) * (rad + l))
    }
}

// 断续的坐标轴：分成几段，每段都跑过自己的端点。
function brokenAxisPath(ctx, x1, y1, x2, y2, r, parts) {
    parts = parts === undefined ? 4 : parts
    ctx.beginPath()
    for (var i = 0; i < parts; i++) {
        var t0 = i / parts + r() * 0.03
        var t1 = (i + 1) / parts - 0.02 - r() * 0.05
        var p = rule(x1 + (x2 - x1) * t0, y1 + (y2 - y1) * t0,
                     x1 + (x2 - x1) * t1, y1 + (y2 - y1) * t1, r, 6, 1.6)
        ctx.moveTo(p[0][0], p[0][1])
        ctx.quadraticCurveTo(p[1][0], p[1][1], p[2][0], p[2][1])
    }
}

// 纵向量尺：每 20px 一根刻度（每 5 根加长），每 5 根带一个 Yn 标签。
// 返回标签数组，由调用方负责写字（Canvas 里要单独填文字）。
function yRuler(ctx, x, y0, y1, r) {
    var labels = []
    ctx.beginPath()
    var p = rule(x, y0, x, y1, r, 6, 1.2)
    ctx.moveTo(p[0][0], p[0][1])
    ctx.quadraticCurveTo(p[1][0], p[1][1], p[2][0], p[2][1])
    var k = 0
    for (var y = y0; y <= y1; y += 20, k++) {
        var l = (k % 5 === 0) ? 14 : 6
        ctx.moveTo(x, y)
        ctx.lineTo(x + l * (0.85 + r() * 0.3), y)
        if (k % 5 === 0) labels.push([x + 18, y + 4, 'Y' + (k / 5 + 1)])
    }
    return labels
}

// 套准标记：一个小圆环配十字，四角各一个。
function registrationPath(ctx, x, y, s, r) {
    ctx.beginPath()
    strokeCurve(ctx, ringPts(x, y, s * 0.42, r, 0.4), false)
    var a = rule(x - s, y, x + s, y, r, 0, 0.5)
    ctx.moveTo(a[0][0], a[0][1]); ctx.quadraticCurveTo(a[1][0], a[1][1], a[2][0], a[2][1])
    var b = rule(x, y - s, x, y + s, r, 0, 0.5)
    ctx.moveTo(b[0][0], b[0][1]); ctx.quadraticCurveTo(b[1][0], b[1][1], b[2][0], b[2][1])
}

// 裁切角标（四角的 L 形）。
function cropsPath(ctx, x0, y0, x1, y1, l) {
    l = l === undefined ? 26 : l
    ctx.beginPath()
    ctx.moveTo(x0, y0 + l); ctx.lineTo(x0, y0); ctx.lineTo(x0 + l, y0)
    ctx.moveTo(x1 - l, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y0 + l)
    ctx.moveTo(x1, y1 - l); ctx.lineTo(x1, y1); ctx.lineTo(x1 - l, y1)
    ctx.moveTo(x0 + l, y1); ctx.lineTo(x0, y1); ctx.lineTo(x0, y1 - l)
}

// 竖排文字（旋转 90° 的栏目名）。Canvas 里必须自己管变换。
function columnText(ctx, x, y, text, ink) {
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(Math.PI / 2)
    ctx.fillStyle = ink
    ctx.font = '600 12px Consolas, "Cascadia Mono", monospace'
    ctx.textAlign = 'left'
    ctx.fillText(text, 0, 0)
    ctx.restore()
}

// 一簇六边形：中心一个大的（里面有花纹），周围六个带编号的。
function hexCluster(ctx, cx, cy, s, r, T, innerKind, labels) {
    var cells = [[0, 0]]
    for (var k = 0; k < 6; k++) {
        var a = k / 6 * TAU - Math.PI / 6
        cells.push([Math.cos(a) * s * 1.78, Math.sin(a) * s * 1.78])
    }
    for (var i = 0; i < cells.length; i++) {
        var dx = cells[i][0], dy = cells[i][1]
        var main = i === 0
        var pts = hexPts(cx + dx, cy + dy, s, r)
        // 套印两遍
        polyPath(ctx, pts)
        ctx.fillStyle = main ? T.cobalt : T.paper
        ctx.fill()
        ctx.strokeStyle = main ? T.paper : T.cobalt
        ctx.lineWidth = 1.3
        ctx.stroke()
        ctx.save()
        ctx.globalAlpha = 0.3
        ctx.translate(1.4, 1)
        polyPath(ctx, pts)
        ctx.fillStyle = main ? T.cobalt : T.paper
        ctx.fill()
        ctx.stroke()
        ctx.restore()

        if (main) {
            ctx.save()
            ctx.translate(cx, cy)
            ctx.scale(s / 120, s / 120)
            ctx.strokeStyle = T.paper
            ctx.lineWidth = 240 / s
            ctx.beginPath()
            ctx.arc(0, 0, 60, 0, TAU)
            ctx.moveTo(0, -90); ctx.lineTo(0, 90)
            ctx.moveTo(-90, 0); ctx.lineTo(90, 0)
            ctx.stroke()
            ctx.restore()
        } else {
            ctx.fillStyle = T.cobalt
            ctx.font = '600 ' + num(s * 0.42) + 'px Consolas, "Cascadia Mono", monospace'
            ctx.textAlign = 'center'
            ctx.fillText(labels[i - 1] || '', cx + dx, cy + dy + 4)
            ctx.textAlign = 'left'
        }
    }
}

// 马赛克：中心越近越密，四色调色板，透明度随距离衰减。
function mosaic(ctx, cx, cy, rad, cell, r, fills) {
    for (var y = cy - rad; y < cy + rad; y += cell) {
        for (var x = cx - rad * 0.7; x < cx + rad * 0.7; x += cell) {
            var d = Math.hypot((x - cx) / (rad * 0.7), (y - cy) / rad)
            if (d < 1 && r() > d * 0.9) {
                var i = Math.min(fills.length - 1, Math.floor(d * fills.length + r() * 0.8))
                ctx.save()
                ctx.globalAlpha = Math.max(0, 0.95 - d * 0.5)
                ctx.fillStyle = fills[i]
                ctx.fillRect(x, y, cell - 1, cell - 1)
                ctx.restore()
            }
        }
    }
}

// 故障条：横向拉丝的小色块。
function glitchStrip(ctx, x, y, w, h, r, fills) {
    var cy = y
    while (cy < y + h) {
        var lh = 1 + r() * 4
        var off = (r() - 0.5) * 40
        ctx.save()
        ctx.globalAlpha = 0.3 + r() * 0.6
        ctx.fillStyle = fills[Math.floor(r() * fills.length)]
        ctx.fillRect(x + off + r() * w * 0.2, cy, w * (0.3 + r() * 0.7), lh)
        ctx.restore()
        cy += lh + 1 + r() * 4
    }
}

// 散落的实心矩形块。
function blocks(ctx, r, n, area, fills) {
    for (var k = 0; k < n; k++) {
        var w = 8 + r() * 70, h = 6 + r() * 30
        ctx.fillStyle = fills[Math.floor(r() * fills.length)]
        ctx.fillRect(area[0] + r() * (area[2] - w), area[1] + r() * (area[3] - h), w, h)
    }
}

// 条形码。
function barcode(ctx, r, x, y, w, h, ink) {
    ctx.fillStyle = ink
    var cx = x
    while (cx < x + w) {
        var bw = 1 + Math.floor(r() * 4)
        if (r() > 0.35) ctx.fillRect(cx, y, bw, h)
        cx += bw + 1 + Math.floor(r() * 3)
    }
}

// 闪光小像素（品红/青/灰）。
function pixels(ctx, cx, cy, rad, n, r) {
    var c = ['#9aa3a8', '#c7cecd', '#e0569a', '#3fc6d6', '#22282b', '#5b6bff']
    for (var i = 0; i < n; i++) {
        var a = r() * TAU, d = rad * Math.sqrt(r()), s = 3 + r() * 11
        ctx.save()
        ctx.globalAlpha = 0.45 + r() * 0.5
        ctx.fillStyle = c[Math.floor(r() * c.length)]
        ctx.fillRect(cx + Math.cos(a) * d, cy + Math.sin(a) * d, s, s * (0.5 + r() * 0.8))
        ctx.restore()
    }
}

// 点与直线连成的"数学课"图。
function dotsNet(ctx, cx, cy, rad, n, r, T, lw) {
    var p = []
    for (var i = 0; i < n; i++) {
        var a = r() * TAU, d = rad * (0.2 + r() * 0.8)
        p.push([cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.8, 2 + r() * 4])
    }
    ctx.beginPath()
    for (var j = 0; j < p.length; j++) {
        if (j) { ctx.moveTo(p[j - 1][0], p[j - 1][1]); ctx.lineTo(p[j][0], p[j][1]) }
        if (j > 2 && r() > 0.5) {
            var o = p[Math.floor(r() * j)]
            ctx.moveTo(o[0], o[1]); ctx.lineTo(p[j][0], p[j][1])
        }
    }
    ctx.strokeStyle = T.cobalt
    ctx.lineWidth = lw
    ctx.save()
    ctx.globalAlpha = 0.8
    ctx.stroke()
    ctx.restore()
    for (var k = 0; k < p.length; k++) {
        ctx.beginPath()
        ctx.arc(p[k][0], p[k][1], p[k][2], 0, TAU)
        ctx.fillStyle = (k % 3) ? T.paper : T.vivid
        ctx.fill()
        ctx.strokeStyle = T.cobalt
        ctx.lineWidth = lw
        ctx.stroke()
    }
}

// 从盘心射出的光芒：每根长度随机，画两遍（白描 + 淡钴蓝）。
function sunburst(ctx, cx, cy, r0, r1, n, r, T, lw) {
    ctx.beginPath()
    for (var i = 0; i < n; i++) {
        var a = i / n * TAU + r() * 0.04
        var l = r0 + (r1 - r0) * (0.55 + r() * 0.45)
        ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0)
        ctx.lineTo(cx + Math.cos(a) * l, cy + Math.sin(a) * l)
    }
    ctx.strokeStyle = T.paper; ctx.lineWidth = lw
    ctx.save(); ctx.globalAlpha = 0.9; ctx.stroke(); ctx.restore()
    ctx.strokeStyle = T.cobalt; ctx.lineWidth = lw * 0.6
    ctx.save(); ctx.globalAlpha = 0.22; ctx.stroke(); ctx.restore()
}

// 背景大圆：四个偏心圆交叉，再加十字轴线。
function bigCircles(ctx, cx, cy, R0, r, T, lw) {
    var specs = [[0, 0, 1], [0.55, -0.15, 0.62], [-0.6, 0.25, 0.5], [0.1, 0.55, 0.38]]
    for (var i = 0; i < specs.length; i++) {
        var dx = specs[i][0], dy = specs[i][1], k = specs[i][2]
        ringPath(ctx, cx + dx * R0, cy + dy * R0, R0 * k, r, 1.2)
        ctx.strokeStyle = T.paper; ctx.lineWidth = lw * 1.8
        ctx.save(); ctx.globalAlpha = 0.85; ctx.stroke(); ctx.restore()
        ringPath(ctx, cx + dx * R0, cy + dy * R0, R0 * k, r, 1.2)
        ctx.strokeStyle = T.cobalt; ctx.lineWidth = lw
        ctx.save(); ctx.globalAlpha = 0.35; ctx.stroke(); ctx.restore()
    }
    ctx.beginPath()
    var a = rule(cx - R0 * 1.3, cy, cx + R0 * 1.3, cy, r, 0, 2)
    ctx.moveTo(a[0][0], a[0][1]); ctx.quadraticCurveTo(a[1][0], a[1][1], a[2][0], a[2][1])
    var b = rule(cx, cy - R0 * 1.2, cx, cy + R0 * 1.2, r, 0, 2)
    ctx.moveTo(b[0][0], b[0][1]); ctx.quadraticCurveTo(b[1][0], b[1][1], b[2][0], b[2][1])
    ctx.strokeStyle = T.cobalt; ctx.lineWidth = lw * 0.8
    ctx.save(); ctx.globalAlpha = 0.3; ctx.stroke(); ctx.restore()
}

// 节点大小不一、用手画线连起来的"构造图"。
function constellation(ctx, cx, cy, rad, n, r, ink, accent) {
    var nodes = []
    for (var i = 0; i < n; i++) {
        var a = r() * TAU, d = rad * (0.25 + r() * 0.75)
        nodes.push([cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.78, 3 + r() * 13])
    }
    nodes.sort(function (a, b) { return a[0] - b[0] })

    ctx.beginPath()
    for (var j = 0; j < nodes.length; j++) {
        if (j) {
            var p = rule(nodes[j - 1][0], nodes[j - 1][1], nodes[j][0], nodes[j][1], r, 4, 3)
            ctx.moveTo(p[0][0], p[0][1]); ctx.quadraticCurveTo(p[1][0], p[1][1], p[2][0], p[2][1])
        }
        if (j > 1 && r() > 0.55) {
            var q = nodes[Math.floor(r() * (j - 1))]
            var p2 = rule(q[0], q[1], nodes[j][0], nodes[j][1], r, 3, 4)
            ctx.moveTo(p2[0][0], p2[0][1]); ctx.quadraticCurveTo(p2[1][0], p2[1][1], p2[2][0], p2[2][1])
        }
    }
    ctx.strokeStyle = ink; ctx.lineWidth = 0.8
    ctx.save(); ctx.globalAlpha = 0.75; ctx.stroke(); ctx.restore()

    for (var k = 0; k < nodes.length; k++) {
        var nd = nodes[k]
        if (nd[2] < 6) {
            ctx.beginPath(); ctx.arc(nd[0], nd[1], nd[2] * 0.6, 0, TAU)
            ctx.fillStyle = (k % 3) ? ink : accent
            ctx.fill()
        } else {
            ringPath(ctx, nd[0], nd[1], nd[2], r, 0.5)
            ctx.strokeStyle = (k % 4) ? ink : accent
            ctx.lineWidth = 1.1
            ctx.stroke()
            ctx.fillStyle = ink
            ctx.save(); ctx.globalAlpha = 0.7
            ctx.font = '10px Consolas, "Cascadia Mono", monospace'
            ctx.fillText(('0' + (k + 1)).slice(-2), nd[0] + nd[2] + 4, nd[1] - nd[2] * 0.4)
            ctx.restore()
        }
    }
}

// 线宽随景深：远景是发丝，近景像马克笔。
function weight(d) { return d < 0.3 ? 0.6 : d < 0.6 ? 0.85 : d < 1 ? 1.15 : 1.55 }

// 参数化的小窗口面板（参考项目 uiFrame）。返回要写字的位置，由调用方填标题。
function uiFrame(ctx, x, y, w, h, r, T, lw, rot) {
    rot = rot || 0
    ctx.save()
    ctx.translate(x + w / 2, y + h / 2)
    ctx.rotate(rot * Math.PI / 180)
    ctx.translate(-w / 2, -h / 2)

    ctx.fillStyle = T.paper
    ctx.save(); ctx.globalAlpha = 0.82
    ctx.fillRect(0, 0, w, h)
    ctx.restore()

    ctx.beginPath()
    ctx.moveTo(-2, 0); ctx.lineTo(w + 2, 0)
    ctx.strokeStyle = T.ink; ctx.lineWidth = 12 * lw
    ctx.save(); ctx.globalAlpha = 0.92; ctx.stroke(); ctx.restore()

    ctx.beginPath()
    ruleSeg(ctx, 0, h * 0.34, w, h * 0.34, r)
    ruleSeg(ctx, 0, h * 0.66, w, h * 0.66, r)
    ctx.strokeStyle = T.cobalt; ctx.lineWidth = lw
    ctx.save(); ctx.globalAlpha = 0.55; ctx.stroke(); ctx.restore()

    ctx.beginPath()
    ctx.rect(0, 0, w, h)
    ctx.strokeStyle = T.ink; ctx.lineWidth = lw * 0.8
    ctx.save(); ctx.globalAlpha = 0.5; ctx.stroke(); ctx.restore()

    ctx.beginPath()
    ctx.moveTo(w - 11, h - 11); ctx.lineTo(w - 3, h - 11); ctx.lineTo(w - 11, h - 3)
    ctx.strokeStyle = T.ink; ctx.lineWidth = lw
    ctx.stroke()
    ctx.restore()
}

function ruleSeg(ctx, x1, y1, x2, y2, r) {
    var p = rule(x1, y1, x2, y2, r, 6, 1.2)
    ctx.moveTo(p[0][0], p[0][1])
    ctx.quadraticCurveTo(p[1][0], p[1][1], p[2][0], p[2][1])
}

// 飞鸟剪影（参考项目 graphics.ts 里的 BIRD 路径，viewBox 0 0 100 60）。
// 这里按原始 SVG 路径命令解析成绘制调用，缩放/翻转由调用方给。
var BIRD_D = 'M98 30L90 27Q84 25 80 27L70 25L64 14L66 4L60 11L58 0L54 10L50 2L48 13L43 7L42 18L38 22L26 26L14 24L4 22L10 29L2 33L16 33L30 35Q46 40 58 38L64 46L62 56L70 46L76 40L84 35Q92 34 98 30Z'

function birdPath(ctx) {
    ctx.beginPath()
    ctx.moveTo(98, 30)
    ctx.lineTo(90, 27)
    ctx.quadraticCurveTo(84, 25, 80, 27)
    ctx.lineTo(70, 25)
    ctx.lineTo(64, 14)
    ctx.lineTo(66, 4)
    ctx.lineTo(60, 11)
    ctx.lineTo(58, 0)
    ctx.lineTo(54, 10)
    ctx.lineTo(50, 2)
    ctx.lineTo(48, 13)
    ctx.lineTo(43, 7)
    ctx.lineTo(42, 18)
    ctx.lineTo(38, 22)
    ctx.lineTo(26, 26)
    ctx.lineTo(14, 24)
    ctx.lineTo(4, 22)
    ctx.lineTo(10, 29)
    ctx.lineTo(2, 33)
    ctx.lineTo(16, 33)
    ctx.lineTo(30, 35)
    ctx.quadraticCurveTo(46, 40, 58, 38)
    ctx.lineTo(64, 46)
    ctx.lineTo(62, 56)
    ctx.lineTo(70, 46)
    ctx.lineTo(76, 40)
    ctx.lineTo(84, 35)
    ctx.quadraticCurveTo(92, 34, 98, 30)
    ctx.closePath()
}

// 一只鸟：平移到 (x,y)、按 s 缩放，flip 时水平镜像。参考项目里鸟以原点为基准画在 (0,0)-(100,60)。
function dove(ctx, x, y, s, flip, rotDeg) {
    ctx.save()
    ctx.translate(x, y)
    if (rotDeg) ctx.rotate(rotDeg * Math.PI / 180)
    ctx.scale(flip ? -s : s, s)
    ctx.translate(-50, -30)
    birdPath(ctx)
    ctx.restore()
}

// 花：五瓣 + 花心。
function flower(ctx, x, y, s, color, T, lw) {
    ctx.save()
    ctx.translate(x, y)
    ctx.scale(s, s)
    ctx.beginPath()
    for (var i = 0; i < 5; i++) {
        var a = i / 5 * TAU - Math.PI / 2
        ctx.moveTo(0, 0)
        ctx.ellipse(Math.cos(a) * 7, Math.sin(a) * 7, 6, 4.2, a, 0, TAU)
    }
    ctx.fillStyle = color
    ctx.save(); ctx.globalAlpha = 0.85; ctx.fill(); ctx.restore()
    ctx.strokeStyle = T.ink; ctx.lineWidth = lw * 0.5
    ctx.stroke()
    ctx.beginPath(); ctx.arc(0, 0, 2.6, 0, TAU)
    ctx.fillStyle = T.accent
    ctx.fill()
    ctx.restore()
}
