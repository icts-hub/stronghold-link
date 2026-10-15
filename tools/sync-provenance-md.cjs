// 把 ASSET_PROVENANCE.md 里 qa-screenshots 分组的哈希，按 asset-provenance.json 同步一遍。
//
// 为什么需要它：守卫要求 JSON 与 MD 两端的哈希一致，但 refresh-provenance-hashes.cjs
// 只认 JSON。每次重拍截图（版面一变哈希就全变）都得手工同步九个哈希，容易漏。
// 这个脚本以 JSON 为准，逐行替换 MD 里 `路径` | `哈希` 形式的表格行。
//
// 用法：node tools/sync-provenance-md.cjs [--group qa-screenshots] [--dry]

const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const argv = process.argv.slice(2)
const group = argv.includes('--group') ? argv[argv.indexOf('--group') + 1] : 'qa-screenshots'
const dry = argv.includes('--dry')

const jsonPath = path.join(root, 'asset-provenance.json')
const mdPath = path.join(root, 'ASSET_PROVENANCE.md')

const doc = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
const groups = doc.installed_files || doc.INSTALLED_FILES
if (!groups) {
    console.error('✗ 台账里找不到 installed_files 分组')
    process.exit(2)
}
const files = groups[group] || groups[group.toUpperCase()]
if (!files) {
    console.error(`✗ 台账里找不到分组 ${group}`)
    process.exit(2)
}

let md = fs.readFileSync(mdPath, 'utf8')
let changed = 0
let missing = []

// 分组有两种写法：一种是 { 路径: 哈希 } 的对象，另一种是
// [{ path, sha256 }] 的数组（qa-screenshots 用的就是后者）。两种都要认。
const entries = Array.isArray(files)
    ? files.map((f) => [f.path, f.sha256])
    : Object.entries(files)

for (const [rel, hash] of entries) {
    // 转义成字面量，再匹配 `路径` | `64 位十六进制`
    const esc = rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp('(`' + esc + '`\\s*\\|\\s*`)([0-9a-f]{64})(`)')
    if (re.test(md)) {
        md = md.replace(re, '$1' + hash + '$3')
        changed++
    } else {
        missing.push(rel)
    }
}

if (!dry) fs.writeFileSync(mdPath, md)

console.log(`  分组 ${group}：${entries.length} 个文件`)
console.log(`  ${dry ? '预演' : '写回'}：同步了 ${changed} 行哈希${dry ? '（未落盘）' : ''}`)
for (const m of missing) console.log(`  · MD 里没有该行（跳过）：${m}`)
process.exit(missing.length === 0 ? 0 : 1)
