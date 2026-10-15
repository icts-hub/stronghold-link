.pragma library

// 会话表单逻辑：端口规则解析、启动参数组装、状态文案。
// 组装规则与 network/adapters.cjs 的 buildStartInput 保持一致（那里是权威实现，
// 这里只是把它在 QML 侧复刻一遍；字段名一旦对不上，后端 sanitizeSessionInput 会拒绝）。

var MAX_RULES = 16
var RULE_HINT = "每行一条：TCP 25565 / UDP 25565 25566 / TCP 25565->25566"

function parsePort(text) {
    var n = Number(String(text === undefined || text === null ? "" : text).trim())
    if (!isFinite(n) || n <= 0 || n > 65535)
        return null
    return Math.round(n)
}

function stripComment(line) {
    var i = line.indexOf("#")
    if (i >= 0)
        line = line.slice(0, i)
    var j = line.indexOf("//")
    if (j >= 0)
        line = line.slice(0, j)
    return line.trim()
}

function parseRules(text) {
    var out = []
    var lines = String(text === undefined || text === null ? "" : text).split(/\r?\n/)
    for (var i = 0; i < lines.length; i++) {
        var line = stripComment(lines[i])
        if (!line.length)
            continue
        var parts = line.split(/[\s,;]+/).filter(function (s) { return s.length > 0 })
        var protocol = "TCP"
        if (parts.length && /^(tcp|udp)$/i.test(parts[0])) {
            protocol = parts[0].toUpperCase()
            parts.shift()
        }
        if (!parts.length)
            return { ok: false, error: "第 " + (i + 1) + " 行缺少端口号：" + line }
        var localPort = null
        var remotePort = null
        if (parts.length === 1) {
            var seg = parts[0].split(/->|:|\/|=/)
            localPort = parsePort(seg[0])
            remotePort = seg.length > 1 ? parsePort(seg[1]) : localPort
        } else {
            localPort = parsePort(parts[0])
            remotePort = parsePort(parts[1])
        }
        if (localPort === null || remotePort === null)
            return { ok: false, error: "第 " + (i + 1) + " 行端口无效（1–65535）：" + line }
        out.push({ protocol: protocol, localPort: localPort, remotePort: remotePort })
    }
    if (!out.length)
        return { ok: false, error: "至少写一条端口规则，例如：TCP 25565" }
    if (out.length > MAX_RULES)
        return { ok: false, error: "端口规则最多 " + MAX_RULES + " 条（现在 " + out.length + " 条）" }
    return { ok: true, rules: out }
}

function formatRules(rules) {
    if (!rules || !rules.length)
        return ""
    var lines = []
    for (var i = 0; i < rules.length; i++) {
        var r = rules[i]
        lines.push(String(r.protocol || "TCP").toUpperCase() + " " + r.localPort + (Number(r.remotePort) === Number(r.localPort) ? "" : " " + r.remotePort))
    }
    return lines.join("\n")
}

// state: { role, recipe, rulesText, token, game, bindHost, targetHost, remoteHost,
//          gamePort, appId, hostSteamId, localPort }
function buildInput(state) {
    var role = state.role
    if (role !== "host" && role !== "joiner")
        return { ok: false, error: "角色必须是房主或加入者" }
    var game = String(state.game || "").slice(0, 80)

    if (state.recipe === "local-ports" || state.recipe === "local-web") {
        var parsed = parseRules(state.rulesText)
        if (!parsed.ok)
            return parsed
        if (role === "host") {
            return {
                ok: true,
                input: {
                    role: "host",
                    adapter: "local",
                    rules: parsed.rules,
                    bindHost: String(state.bindHost || "").trim() || "0.0.0.0",
                    targetHost: String(state.targetHost || "").trim() || "127.0.0.1",
                    authToken: String(state.token || ""),
                    game: game,
                    recipe: state.recipe
                }
            }
        }
        var host = String(state.remoteHost || "").trim()
        if (!host)
            return { ok: false, error: "加入者需要房主地址：粘贴邀请码可自动填好" }
        return {
            ok: true,
            input: {
                role: "joiner",
                adapter: "local",
                rules: parsed.rules,
                bindHost: "127.0.0.1",
                remoteHost: host,
                authToken: String(state.token || ""),
                game: game,
                recipe: state.recipe
            }
        }
    }

    if (state.recipe === "steam-tunnel") {
        var appId = null
        if (String(state.appId || "").trim().length) {
            appId = Number(state.appId)
            if (!isFinite(appId) || appId <= 0)
                return { ok: false, error: "AppID 必须是正整数（测试可用 480）" }
        }
        if (role === "host") {
            var gp = parsePort(state.gamePort)
            if (gp === null)
                return { ok: false, error: "本地服务端口无效（1–65535）" }
            return {
                ok: true,
                input: {
                    role: "host",
                    adapter: "steam",
                    targetHost: String(state.targetHost || "").trim() || "127.0.0.1",
                    gamePort: gp,
                    appId: appId,
                    game: game,
                    recipe: state.recipe
                }
            }
        }
        var steamId = String(state.hostSteamId || "").trim()
        if (!steamId)
            return { ok: false, error: "加入者需要房主 SteamID（17 位数字）" }
        var lp = parsePort(state.localPort)
        if (lp === null)
            return { ok: false, error: "本机入口端口无效（1–65535）" }
        return {
            ok: true,
            input: {
                role: "joiner",
                adapter: "steam",
                hostSteamId: steamId,
                localPort: lp,
                appId: appId,
                game: game,
                recipe: state.recipe
            }
        }
    }

    if (state.recipe === "lan-direct") {
        var port = parsePort(state.gamePort)
        if (port === null)
            return { ok: false, error: "服务端口无效（1–65535）" }
        return { ok: true, input: { role: role, adapter: "none", gamePort: port, game: game, recipe: state.recipe, notes: "" } }
    }

    return { ok: false, error: "请选择连接方式" }
}

function stateLabel(state) {
    var map = { idle: "空闲", starting: "启动中", running: "运行中", stopping: "停止中", error: "出错" }
    return map[state] || (state ? String(state) : "未知")
}

function stateColorKey(state) {
    if (state === "running")
        return "good"
    if (state === "error")
        return "bad"
    if (state === "starting" || state === "stopping")
        return "warn"
    return "muted"
}

function routeText(route) {
    var map = {
        DIRECT_P2P: "直连 P2P",
        STEAM_SDR_RELAY: "Steam 中继",
        LOCAL_RELAY: "本地中继",
        UNKNOWN: "未判定"
    }
    return map[route] || (route ? String(route) : "未判定")
}

function bytes(n) {
    var v = Number(n)
    if (!isFinite(v) || v < 0)
        return "—"
    if (v < 1024)
        return v.toFixed(0) + " B"
    if (v < 1048576)
        return (v / 1024).toFixed(1) + " KiB"
    if (v < 1073741824)
        return (v / 1048576).toFixed(2) + " MiB"
    return (v / 1073741824).toFixed(2) + " GiB"
}

function speed(v) {
    var n = Number(v)
    if (!isFinite(n))
        return "—"
    return bytes(n) + "/s"
}
