#!/usr/bin/env node
// 重新生成三页 x 三分辨率的验收截图，并打印每个文件的字节数与 sha256，供
// asset-provenance.json 的 qa-screenshots 分组回填。
//
// 为什么用 Node 而不是 PowerShell：被测程序是 Windows GUI 子系统程序，没有控制台，
// PowerShell 里用 `& $exe` 调它会走 ConPTY 兼容路径并偶发不产出（实测 1/3 概率整批失败）。
// Node 的 spawn + `stdio: 'ignore'` + 等 exit 事件稳定得多；诊断走 `--log <file>`。
//
// 用法：node tools/make-shots.cjs [--exe <路径>] [--retries 3] [--delay 4000] [--runDir <目录>]
//
// 为什么要先把 exe 复制到一个中立目录再跑（--runDir，默认 %TEMP%\shl-shots）：
// 本机装了游戏加加（GamePP）。它会把某些进程当成游戏注入自己的 GPP64.dll，注入后
// 因拿不到自己的 IPC 命名对象（CreateSemaphore/CreateFileMapping 报 ACCESS_DENIED）
// 而在进程里 0xC0000005 崩掉。实测同一个二进制：
//   · 放在仓库里（app_qml/build/release/release/）      → 每次必崩，出不了图
//   · 放到 %TEMP%\*、D:\shl\qmlrun\ 等仓库外目录        → 正常出图
// 触发条件在 GamePP 那一侧（按路径分类），我们没有它的开关，所以截图统一从仓库外
// 的目录运行；后端脚本用 SHL_BACKEND_SCRIPT 指回仓库里的真脚本，行为与原地运行一致。
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawn } = require('child_process')

const argv = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const root = path.resolve(__dirname, '..')
const builtExe = path.resolve(root, opt('--exe', 'app_qml/build/release/release/StrongholdLink.exe'))
const retries = Number(opt('--retries', '3'))
const delay = opt('--delay', '4000')
const runDir = path.resolve(opt('--runDir', path.join(os.tmpdir(), 'shl-shots')))
fs.mkdirSync(runDir, { recursive: true })
const exe = path.join(runDir, 'StrongholdLink.exe')
fs.copyFileSync(builtExe, exe)
const backendScript = path.join(root, 'backend', 'stronghold-backend.cjs')
if (!fs.existsSync(backendScript)) {
  console.error(`后端脚本不存在：${backendScript}`)
  process.exit(2)
}
// Qt 运行时不在系统 PATH 上。少了这两个目录，被测程序会直接以 0xC0000135
// （STATUS_DLL_NOT_FOUND）退出，一行日志都不会写 —— 表现为"三次尝试都没出图"。
// 这里自己拼好 PATH，脚本就不依赖调用者的 shell 环境。
const qtBin = ['D:\\Qt\\6.8.3\\mingw_64\\bin', 'D:\\Qt\\Tools\\mingw1310_64\\bin']
const childPath = [...qtBin, process.env.PATH || ''].join(';')
const shotsDir = path.join(root, 'app_qml', 'shots')
fs.mkdirSync(shotsDir, { recursive: true })

const specs = ['1440x900', '1280x720', '1024x768']
const pages = ['session', 'friends', 'setting']

function runOnce(page, spec) {
  return new Promise((resolve) => {
    const png = path.join(shotsDir, `${page}-${spec}.png`)
    const log = path.join(shotsDir, `${page}-${spec}.log`)
    const cfg = path.join(require('os').tmpdir(), `shl-shot-${page}-${spec}`)
    fs.mkdirSync(cfg, { recursive: true })
    for (const f of [png, log]) fs.rmSync(f, { force: true })
    const child = spawn(exe, ['--page', page, '--size', spec, '--grab', png, '--delay', delay, '--log', log], {
      stdio: 'ignore',
      windowsHide: false,
      cwd: runDir,
      env: {
        ...process.env,
        PATH: childPath,
        SHL_CONFIG_DIR: cfg,
        SHL_BACKEND_SCRIPT: backendScript
      }
    })
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 已退出 */ }
    }, Number(delay) + 30000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      const ok = fs.existsSync(png) && fs.statSync(png).size > 20000
      resolve({ ok, code, png, log })
    })
  })
}

async function main() {
  const rows = []
  for (const spec of specs) {
    for (const page of pages) {
      let done = null
      for (let i = 1; i <= retries && !done; i++) {
        const r = await runOnce(page, spec)
        if (r.ok) done = r
        else console.log(`     第 ${i} 次没出图（exit=${r.code}），重试…`)
      }
      const name = `${page}-${spec}.png`
      if (!done) {
        console.log(`  ✗ ${name.padEnd(24)} ${retries} 次都没出图`)
        continue
      }
      const bytes = fs.statSync(done.png).size
      const sha256 = require('crypto').createHash('sha256').update(fs.readFileSync(done.png)).digest('hex')
      rows.push({ name, bytes, sha256 })
      console.log(`  ✓ ${name.padEnd(24)} ${String(bytes).padStart(8)} B  ${sha256}`)
    }
  }

  console.log('\n=== 汇总（回填 asset-provenance.json 的 qa-screenshots 用）===')
  for (const r of rows) console.log(`  ${r.name}  ${r.bytes}  ${r.sha256}`)
  console.log(`\n  成功 ${rows.length} / ${specs.length * pages.length} 张`)
  process.exit(rows.length === specs.length * pages.length ? 0 : 1)
}

main()
