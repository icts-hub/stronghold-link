#!/usr/bin/env node
// QML 语法检查：调用 Qt 自己的 qmlformat（纯解析器，不需要 import 上下文）逐个解析
// app_qml/qml 下的 QML 文件，解析失败就报文件名并退出 1。
//
// 为什么需要它：Main.qml 曾经因为加了一层画布包装却漏掉配对闭括号，QML 引擎报的是
// "文件最后一行的 Expected token"（解析器要到 EOF 才确认少一个右花括号），看起来像末尾
// 坏了、实际是中间少一个 }，排查代价很高。自写计数器不可靠——注释里的反引号、装饰用的
// {} 字符都会让它误判（这个坑真的踩过：计数器说配平，Qt 解析器说文件无效）。
//
// 用法：node tools/qml-parse-check.cjs [目录或文件 ...]（默认 app_qml/qml）
// 找不到 qmlformat 时：打印提示并以 2 退出（不静默放过）。
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const args = process.argv.slice(2)
const roots = args.length ? args : [path.join('app_qml', 'qml')]

const files = []
const collect = (p) => {
  const st = fs.statSync(p)
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(p)) collect(path.join(p, name))
  } else if (p.endsWith('.qml')) {
    files.push(p)
  }
}
for (const r of roots) collect(r)
if (!files.length) {
  console.error('没有找到任何 .qml 文件。')
  process.exit(2)
}

// qmlformat 在 PATH 里找不到时，退回 Qt 安装目录（本机 6.8.3）。
const candidates = ['qmlformat', 'qmlformat.exe']
const qtGuess = process.env.QT_BIN || 'D:/Qt/6.8.3/mingw_64/bin/qmlformat.exe'
if (fs.existsSync(qtGuess)) candidates.push(qtGuess)

const run = (bin, file) => {
  const r = spawnSync(bin, [file], { encoding: 'utf8', windowsHide: true })
  if (r.error) return { missing: true }
  const out = `${r.stdout || ''}${r.stderr || ''}`
  return { bad: /Parsed invalid file|Expected token|Unexpected token/i.test(out), out }
}

let bin = null
for (const c of candidates) {
  const probe = run(c, files[0])
  if (!probe.missing) { bin = c; break }
}
if (!bin) {
  console.error('找不到 qmlformat（Qt 的 QML 解析器）。请把 Qt 的 bin 目录加进 PATH，')
  console.error('或用 QT_BIN=<qmlformat 的完整路径> 指定。没有解析器就不做语法检查，不静默放过。')
  process.exit(2)
}

let bad = 0
for (const file of files) {
  const r = run(bin, file)
  if (r.bad) {
    bad++
    const first = r.out.split(/\r?\n/).find((l) => l.trim()) || '未知解析错误'
    console.log(`  ✗ ${file}`)
    console.log(`      ${first.trim().slice(0, 160)}`)
  } else {
    console.log(`  ✓ ${file}`)
  }
}

if (bad) {
  console.error(`\n  ${bad} / ${files.length} 个 QML 文件语法不通过（用 ${bin}）。`)
  process.exit(1)
}
console.log(`\n  ${files.length} 个 QML 文件语法全部通过（${bin}）。`)
