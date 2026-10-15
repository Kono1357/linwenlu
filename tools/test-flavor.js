#!/usr/bin/env node
/* 临文录 · AI 味检测的自检
   用法：node tools/test-flavor.js
   检测器要么抓不住（等于没有），要么到处误报（等于烦人）。
   所以每条规则都要有正例和反例。 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'aiflavor.js'), 'utf-8');
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(code + '\n; this.AiFlavor = AiFlavor;', ctx);
const A = ctx.AiFlavor;

const PAD = '老陈把烟头摁在栏杆上，火星溅了一下就灭了。她没接话，把手插进外套口袋。'
  + '风从码头那边过来，带着铁锈味。远处有船在鸣笛，很长，然后停了。';

let pass = 0, fail = 0;
function t(name, fn) {
  try {
    const r = fn();
    if (r === true) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ ' + name + '  → ' + r); }
  } catch (e) { fail++; console.log('  ✗ ' + name + '  → 抛错: ' + (e && e.message || e)); }
}
const hits = (txt) => A.scan(txt).hits.map((h) => h.id);
const has = (txt, id) => hits(txt).includes(id) ? true : `没抓到 ${id}，实际：${hits(txt).join('、') || '无'}`;
const no = (txt, id) => !hits(txt).includes(id) ? true : `误报了 ${id}`;

console.log('\n【该抓的必须抓到】');
t('不是…而是…', () => has('他不是不想说话，而是不知道说什么。' + PAD, 'notbut'));
t('不是…而是…（带逗号）', () => has('他不是坏人，而是个可怜人。' + PAD, 'notbut'));
t('学术腔', () => has('综上所述，他其实没有选择。' + PAD, 'academic'));
t('值得注意的是', () => has('值得注意的是，天已经黑了。' + PAD, 'academic'));
t('三段论', () => has('首先，他要走。其次，他得吃饭。' + PAD, 'enumerate'));
t('叙事时钟词', () => has('当夜色降临的时候，他终于开口。' + PAD, 'clock'));
t('与此同时', () => has('与此同时，另一头也在下雨。' + PAD, 'clock'));
t('给语气打标签', () => has('他的语气里带着一丝疲惫。' + PAD, 'tonetag'));
t('用一种…的口吻', () => has('她用一种平静的口吻说了那句话。' + PAD, 'tonetag'));
t('无中生有内心戏', () => has('他不禁思考这一切的意义。' + PAD, 'inner'));
t('这个念头', () => has('这个念头让他睡不着。' + PAD, 'inner'));
t('圆括号内心', () => has('（心想：算了吧）' + PAD, 'paren'));
t('样板比喻·羽毛', () => has('那声叹息轻得像羽毛。' + PAD, 'stereotype'));
t('样板比喻·涟漪', () => has('话像涟漪一样扩散开。' + PAD, 'stereotype'));
t('明喻超量', () => has('好像变了。仿佛不同了。如同昨日。似的沉默。' + PAD, 'simile'));

console.log('\n【不该抓的绝不能误报】');
t('正常叙事', () => hits(PAD + PAD).length === 0 ? true : '误报：' + hits(PAD + PAD).join('、'));
t('正常对话', () => {
  const s = '「来晚了。」他说。\n\n她没接话，把手插进外套口袋，站着没动。' + PAD;
  return hits(s).length === 0 ? true : '误报：' + hits(s).join('、');
});
t('句子里的「不是」不算', () => no('他不是本地人。' + PAD, 'notbut'));
t('单次「好像」不算', () => no('他好像走了。' + PAD, 'simile'));
t('两次明喻以内', () => no('好像走了。仿佛没来过。' + PAD, 'simile'));
t('「认真」出现一两次不算', () => no('他认真听着。' + PAD, 'cliche'));
t('「微微」出现一两次不算', () => no('她微微点头。' + PAD, 'cliche'));
t('短文本不判定', () => A.scan('不是…而是…').level === 'clean' ? true : '短文本不该报');

console.log('\n【分级与摘要】');
t('脏文本判 heavy', () => A.scan('他不是不想说，而是不知道。综上所述。首先，其次。当夜来时，他开口。语气里带着疲惫。他不禁思考。轻得像羽毛。好像。仿佛。' + PAD).level === 'heavy' ? true : '没判 heavy');
t('干净文本判 clean', () => A.scan(PAD + PAD).level === 'clean' ? true : '没判 clean');
t('label 有内容', () => {
  const l = A.label(A.scan('综上所述，他走了。' + PAD));
  return l && l.indexOf('AI 味') >= 0 ? true : '摘要为空：' + l;
});
t('命中项带解释和改法', () => {
  const h = A.scan('综上所述，他走了。' + PAD).hits[0];
  return h && h.why && h.fix ? true : '缺少 why/fix';
});

console.log(`\n${pass} 通过 · ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
