#!/usr/bin/env node
// 用真正的状态机数 QML 代码里的花括号（跳过行注释、块注释、单双引号串、模板串），
// 并报出【最后一个没配上的 { 在哪一行】。用途：QML 引擎报 “EOF 处 Expected token”
// 时，说明有一个 { 没闭合——这个脚本告诉你它在哪一行。
// 注意：注释里的装饰字符（═ 等）与反引号曾让更简单的计数器误判，所以这里严格按状态机走。
// 用法：node tools/qml-brace-scan.cjs <文件.qml> [...]
const fs = require('fs')

const files = process.argv.slice(2)
if (!files.length) {
  console.error('用法：node tools/qml-brace-scan.cjs <文件.qml> [...]')
  process.exit(2)
}

function scan(text) {
  const stack = []
  let line = 1
  let i = 0
  while (i < text.length) {
    const c = text[i]
    const n = text[i + 1]
    if (c === '\n') { line++; i++; continue }
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (c === '/' && n === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') line++
        i++
      }
      i += 2
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      i++
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') { i += 2; continue }
        if (text[i] === '\n') { line++; break }
        i++
      }
      i++
      continue
    }
    if (c === '{') stack.push(line)
    else if (c === '}') stack.pop()
    i++
  }
  return stack
}

let bad = 0
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8')
  const stack = scan(text)
  const bytes = fs.statSync(file).size
  if (!stack.length) {
    console.log(`  ✓ ${file}（${bytes} 字节，花括号配平）`)
  } else {
    bad++
    console.log(`  ✗ ${file}（${bytes} 字节）：有 ${stack.length} 个 { 没闭合，最近的在第 ${stack[stack.length - 1]} 行`)
  }
}
process.exit(bad ? 1 : 0)
