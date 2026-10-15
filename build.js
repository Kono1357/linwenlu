#!/usr/bin/env node
/* 临文录 · 构建：把 src/ 拼成一个自包含单文件 index.html（仓库根）
   用法：node build.js
   约束：产物零外链、零依赖，file:// 直接打开可用，也能直接被 GitHub Pages 部署。

   为什么产物放在仓库根：GitHub Pages 只能从 root 或 /docs 发布，
   放根目录省掉一整套 Action。所以 index.html 是产物，别手改它 —— 改 src/。 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'src');
const OUT = path.join(__dirname, 'index.html');

function read(p) {
  return fs.readFileSync(path.join(SRC, p), 'utf-8');
}

function build() {
  let html = read('index.html');

  // 1) 内联 CSS
  const css = read('style.css');
  html = html.replace(
    /<link rel="stylesheet" href="style\.css">/,
    () => `<style>\n${css.trim()}\n</style>`
  );

  // 2) 内联 JS（按 index.html 里的引用顺序）
  const scripts = [...html.matchAll(/<script src="(js\/[^"]+)"><\/script>/g)].map((m) => m[1]);
  if (scripts.length === 0) throw new Error('index.html 里没找到任何 <script src="js/…">');
  const bundle = scripts
    .map((rel) => `/* ─── ${rel} ─── */\n${read(rel).trim()}`)
    .join('\n\n');
  html = html.replace(
    /<script src="js\/[^"]+"><\/script>(\s*<script src="js\/[^"]+"><\/script>)*/,
    () => `<script>\n${bundle}\n</script>`
  );

  // 3) 自检：产物里不该再有任何外部引用
  const leftover = html.match(/(?:src|href)="(?!data:|#|javascript:)([^"]+)"/g) || [];
  const external = leftover.filter((s) => !/^\s*(?:src|href)="#/.test(s));
  if (external.length) {
    console.warn('⚠ 产物里还有外部引用：', external.join(', '));
  }

  // 4) 落盘（顶部留一行生成标记，防止有人直接改产物）
  const banner = `<!-- 临文录 · 由 build.js 生成，请勿直接编辑；改 src/ 后重新构建 -->\n`;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, banner + html, 'utf-8');

  const kb = (Buffer.byteLength(html, 'utf-8') / 1024).toFixed(1);
  console.log(`✓ 构建完成  index.html  ${kb} KB  （内联 ${scripts.length} 个脚本）`);
}

build();
