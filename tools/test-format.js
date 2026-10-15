#!/usr/bin/env node
/* 临文录 · 排版整理的自检
   用法：node tools/test-format.js
   排版是"改用户原文"的操作，改错了比不改更糟，所以每个规则都要有正反例。 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'format.js'), 'utf-8');
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(code + '\n; this.Format = Format;', ctx);
const Format = ctx.Format;

let pass = 0, fail = 0;
function t(name, fn) {
  try {
    const r = fn();
    if (r === true) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ ' + name + '  → ' + r); }
  } catch (e) {
    fail++; console.log('  ✗ ' + name + '  → 抛错: ' + (e && e.message || e));
  }
}
const has = (s, sub) => s.includes(sub) ? true : `缺「${sub}」，实际：${JSON.stringify(s.slice(0, 60))}`;
const not = (s, sub) => !s.includes(sub) ? true : `不该有「${sub}」：${JSON.stringify(s.slice(0, 60))}`;

console.log('\n【标点统一】');
t('三个点 → 省略号', () => has(Format.tidy('他说...完了。'), '……'));
t('四个点也归一', () => has(Format.tidy('他说....完了。'), '……'));
t('省略号不会越换越长', () => has(Format.tidy('他说……完了。'), '……') && not(Format.tidy('他说……完了。'), '………'));
t('连续短横线 → 破折号', () => has(Format.tidy('她走了--没有回头。'), '——'));
t('已有破折号不变', () => has(Format.tidy('她走了——没有回头。'), '——'));
t('英文双引号 → 「」', () => has(Format.tidy('他说"你来晚了"。'), '「你来晚了」'));
t('中文标点前空格清掉', () => has(Format.tidy('他说 ，走吧 。'), '他说，走吧。'));

console.log('\n【分段与合并】');
t('多余空行归一', () => Format.tidy('第一段。\n\n\n\n第二段。') === '第一段。\n\n第二段。' ? true : '空行没归一');
t('段内硬换行合并', () => Format.tidy('他站在码头。\n风很大。\n\n第二段。') === '他站在码头。风很大。\n\n第二段。' ? true : '段内换行没合并');
t('整篇无空行时按行切', () => {
  const r = Format.tidy('第一句。\n第二句。\n第三句。');
  return r.split('\n\n').length === 3 ? true : '应切成 3 段，实际 ' + r.split('\n\n').length;
});
t('首尾空白清掉', () => Format.tidy('\n\n  正文。  \n\n') === '正文。' ? true : '没清干净');

console.log('\n【去重复】');
t('完全相同的段去掉一个', () => {
  const r = Format.tidy('他站在码头。\n\n他站在码头。');
  return r.split('\n\n').length === 1 ? true : '实际 ' + r.split('\n\n').length + ' 段';
});
t('标点不同但内容相同也去掉', () => {
  const r = Format.tidy('他站在码头，风很大。\n\n他站在码头。风很大。');
  return r.split('\n\n').length === 1 ? true : '实际 ' + r.split('\n\n').length + ' 段';
});
t('续接时重发上文只留一份', () => {
  const r = Format.tidy('他站在码头，风很大。\n\n他站在码头，风很大。没有人来。');
  return r.split('\n\n').length === 1 ? true : '实际 ' + r.split('\n\n').length + ' 段：' + r;
});
t('不同段落不能误删', () => {
  const r = Format.tidy('他站在码头。\n\n她走进了屋子。\n\n风从窗缝里钻进来。');
  return r.split('\n\n').length === 3 ? true : '被误删，剩 ' + r.split('\n\n').length + ' 段';
});
t('短段落不参与包含判定', () => {
  const r = Format.tidy('好。\n\n好。');
  return r.split('\n\n').length === 1 ? true : '短句重复应合并';
});

console.log('\n【不能改坏】');
t('正常章节原样保留', () => {
  const src = '夜里的风从窗缝里钻进来，桌面上的纸角被掀起又落下。\n\n她没有去关窗。';
  return Format.tidy(src) === src ? true : '被改动了：' + JSON.stringify(Format.tidy(src));
});
t('对话引号保留', () => {
  const src = '「……没什么，一般。」\n\n他把烟头摁灭。';
  return Format.tidy(src) === src ? true : '被改动了：' + JSON.stringify(Format.tidy(src));
});
t('空文本不炸', () => Format.tidy('') === '' ? true : '空文本出问题');
t('非字符串不炸', () => Format.tidy(null) === '' ? true : 'null 出问题');

console.log('\n【辅助】');
t('diffSummary 数得对', () => {
  const s = Format.diffSummary('甲。\n\n乙。\n\n丙。', '甲。\n\n乙。');
  return s.beforeParas === 3 && s.afterParas === 2 && s.merged === 1 ? true : JSON.stringify(s);
});
t('findDupes 找得出', () => {
  const d = Format.findDupes('他站在码头，风很大。\n\n他站在码头，风很大。');
  return d.length >= 1 ? true : '没找出来';
});
t('findDupes 不误报', () => {
  const d = Format.findDupes('他站在码头。\n\n她走进屋子。');
  return d.length === 0 ? true : '误报 ' + d.length + ' 处';
});

console.log(`\n${pass} 通过 · ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
