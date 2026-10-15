// 把 ASSET_PROVENANCE.md 里的哈希，按 asset-provenance.json 同步一遍。
//
// 为什么需要它：守卫要求 JSON 与 MD 两端的哈希一致，但 refresh-provenance-hashes.cjs
// 只认 JSON。每次改被登记的源文件、或重拍截图（版面一变哈希就全变）都得手工同步，
// 容易漏 —— 漏了守卫就红（"ASSET_PROVENANCE.md 里找不到 mig-qml-frontend 的 sha256"）。
// 这个脚本以 JSON 为准，逐行替换 MD 里 `路径` | `哈希` 形式的表格行。
//
// 默认同步**全部分组** + assets[] 里带 sha256 的代表条目；--group <名> 只同步一组。
//
// 用法：node tools/sync-provenance-md.cjs [--group <组名|all>] [--dry]

const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const argv = process.argv.slice(2)
const group = argv.includes('--group') ? argv[argv.indexOf('--group') + 1] : 'all'
const dry = argv.includes('--dry')

const jsonPath = path.join(root, 'asset-provenance.json')
const mdPath = path.join(root, 'ASSET_PROVENANCE.md')

const doc = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
const groups = doc.installed_files || doc.INSTALLED_FILES
if (!groups) {
    console.error('✗ 台账里找不到 installed_files 分组')
    process.exit(2)
}

// 收集要同步的 [路径, 哈希]：分组里的每个文件 + assets[] 里的代表条目。
// assets[] 同样重要 —— 守卫就是拿它的 sha256 去 MD 里找（"找不到 X 的 sha256"）。
const targets = []
if (group === 'all') {
    for (const name of Object.keys(groups)) targets.push([`group:${name}`, groups[name]])
    for (const a of doc.assets || []) {
        if (a && a.installed_path && a.sha256) targets.push([`asset:${a.asset_id}`, [[a.installed_path, a.sha256]]])
    }
} else {
    const files = groups[group] || groups[group.toUpperCase()]
    if (!files) {
        console.error(`✗ 台账里找不到分组 ${group}`)
        process.exit(2)
    }
    targets.push([`group:${group}`, files])
}

let md = fs.readFileSync(mdPath, 'utf8')
let changed = 0
const missing = []

for (const [label, files] of targets) {
    // 分组有两种写法：{ 路径: 哈希 } 对象，或 [{ path, sha256 }] 数组。两种都要认。
    const entries = Array.isArray(files)
        ? files.map((f) => [f.path, f.sha256])
        : Object.entries(files)
    let hit = 0
    for (const [rel, hash] of entries) {
        if (!rel || !hash) continue
        // 转义成字面量，再匹配 `路径` | `64 位十六进制`
        const esc = rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const re = new RegExp('(`' + esc + '`\\s*\\|\\s*`)([0-9a-f]{64})(`)')
        if (re.test(md)) {
            md = md.replace(re, '$1' + hash + '$3')
            hit++
            changed++
        } else {
            missing.push(`${label} → ${rel}`)
        }
    }
    console.log(`  ${label}：${entries.length} 个文件，命中 ${hit} 行`)
}

if (!dry) fs.writeFileSync(mdPath, md)

console.log(`  ${dry ? '预演' : '写回'}：同步了 ${changed} 行哈希${dry ? '（未落盘）' : ''}`)
for (const m of missing) console.log(`  · MD 里没有该行（跳过）：${m}`)
// 缺行不算失败：assets[] 与分组会指同一批文件，重复项只会在第一次命中。
process.exit(0)
