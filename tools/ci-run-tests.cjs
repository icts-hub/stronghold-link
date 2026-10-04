'use strict';
// CI 用测试运行器：跑 package.json 里 test 脚本列出的用例，
// 失败时把失败用例与断言上下文写成 GitHub Actions 注解（::error::），
// 这样即使没有仓库 token，也能通过 check-runs/annotations API 读到失败原因。
//
// 本地也能用：node tools/ci-run-tests.cjs
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const files = String(pkg.scripts.test || '')
  .replace(/^node\s+--test\s+/, '')
  .split(/\s+/)
  .filter(Boolean);

console.log(`[ci] 用例文件 ${files.length} 个：${files.join(' ')}`);

const run = spawnSync(process.execPath, ['--test', ...files], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env },
});
const out = `${run.stdout || ''}${run.stderr || ''}`;
process.stdout.write(out);

const annotate = (level, title, message) => {
  const flat = String(message).replace(/\r?\n/g, ' \\n ').slice(0, 900);
  console.log(`::${level} title=${title}::${flat}`);
};

if (run.status === 0) {
  annotate('notice', '测试通过', `${files.length} 个用例文件全部通过`);
  process.exit(0);
}

// 失败用例名
const failed = [...out.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1]);
for (const name of [...new Set(failed)].slice(0, 6)) annotate('error', '失败用例', name);

// 断言上下文：AssertionError 之后的若干行
const assertionBlocks = out.split(/AssertionError/).slice(1, 5);
assertionBlocks.forEach((block, index) => {
  annotate('error', `断言详情 ${index + 1}`, `AssertionError${block.slice(0, 700)}`);
});

// 兜底：把结尾摘要贴出来
const tail = out.trim().split(/\r?\n/).slice(-25).join('\n');
annotate('error', '输出结尾', tail);

process.exit(1);
