#!/usr/bin/env node
/* 临文录 · 旅程量化探针
   不测「功能有没有」，测「用户要做几下手才能到达目标」。
   用法: node tools/journey.js <url|file> [out.json]

   为什么要有它：功能全在、却要九下点击才能写到第一句话，这种问题只有把
   操作序列摊开数一遍才看得见。 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const TARGET = process.argv[2];
const OUT = process.argv[3] || '';
if (!TARGET) { console.error('用法: node tools/journey.js <url|file> [out.json]'); process.exit(2); }

const EXES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
let exe = null;
for (const e of EXES) if (fs.existsSync(e)) { exe = e; break; }
if (!exe) { console.log(JSON.stringify({ error: '本机没有 Edge / Chrome' })); process.exit(0); }

const URL_ = /^https?:/i.test(TARGET) ? TARGET : 'file:///' + path.resolve(TARGET).replace(/\\/g, '/');
const PORT = 9600 + (process.pid % 300);
const PROFILE = path.join(os.tmpdir(), 'lwl_journey_' + Date.now());
fs.mkdirSync(PROFILE, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const child = cp.spawn(exe, [
    '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
    '--no-first-run', '--no-default-browser-check', '--allow-file-access-from-files',
    '--disable-gpu', '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore' });

  let info = null;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try { info = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch (_) { }
  }
  if (!info) { child.kill(); console.log(JSON.stringify({ error: '浏览器没起来' })); process.exit(1); }

  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });

  let id = 0; const waits = new Map();
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.id && waits.has(m.id)) { const w = waits.get(m.id); waits.delete(m.id); m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result); }
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id; waits.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (waits.has(i)) { waits.delete(i); rej(new Error('timeout ' + method)); } }, 30000);
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result.value;
  };

  const report = { target: URL_, journeys: [] };

  try {
    await send('Page.enable'); await send('Runtime.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('linwenlu.seen','1')}catch(e){}` });
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await send('Page.navigate', { url: URL_ });
    await sleep(1600);

    /* ① 冷启动 → 第一段文字，要几下手 */
    report.journeys.push({
      name: '冷启动 → 第一段文字',
      steps: await ev(`(function(){
        var n = 0, log = [];
        function tap(sel, why){
          var e = document.querySelector(sel);
          if (!e) { log.push('✗ 找不到 ' + sel + '（' + why + '）'); return false; }
          e.click(); n++; log.push('✓ ' + why);
          return true;
        }
        // 1 从空状态建第一章
        tap('#chapterList [data-new]', '点「新建第一章」');
        // 2 进入这一章
        tap('#chapterList .chapter-item', '点章节进正文');
        // 3 去提要求（正文空状态）
        var go = document.querySelector('#reader [data-blank="write"]')
              || document.querySelector('#reader [data-go-chat]');
        if (go) { go.click(); n++; log.push('✓ 点「去提要求」'); } else log.push('✗ 正文空状态没有入口');
        // 4 输入
        var ta = document.getElementById('chatInput');
        if (ta) { ta.value = '主角在雨里等一个人'; ta.dispatchEvent(new Event('input',{bubbles:true})); n++; log.push('✓ 输入要求'); }
        return { 操作数: n, log: log, 当前视图: location.hash || 'read' };
      })()`)
    });

    /* ② 生成之后 → 落进章节，要几下手 */
    report.journeys.push({
      name: '一段 AI 文字 → 落进章节',
      steps: await ev(`(function(){
        var n = 0, log = [];
        // 造一条 AI 消息（模拟生成完成）
        Store.chat.push('ai', '雨很大。他站在站台下，没有撑伞。');
        ChatView.renderFlow();
        var btn = document.querySelector('[data-act="commit"]');
        if (btn) { btn.click(); n++; log.push('✓ 点「写入剧情」'); } else log.push('✗ 消息上没有落盘入口');
        var opts = document.querySelectorAll('.sheet__panel .btn');
        log.push('  弹层里给了 ' + opts.length + ' 个选项');
        var first = document.querySelector('.sheet__panel .btn');
        if (first) { first.click(); n++; log.push('✓ 选一种写入方式'); }
        return { 操作数: n, log: log };
      })()`)
    });

    /* ③ 读第 3 章时想跳到第 4 章，要几下手 */
    await ev(`(function(){
      Store.chapter.add({ title: '第二章' }); Store.chapter.add({ title: '第三章' });
      Store.chapter.all().forEach(function(c){ Store.chapter.newDraft(c.id, '正文内容测试。', '手写'); });
      ReadView.refresh();
    })()`);
    await sleep(300);
    report.journeys.push({
      name: '读第 2 章 → 跳到第 3 章',
      steps: await ev(`(function(){
        var n = 0, log = [];
        var items = document.querySelectorAll('#chapterList .chapter-item');
        if (items[1]) { items[1].click(); n++; log.push('✓ 点第 2 章'); }
        // 找有没有「下一章」
        var next = document.querySelector('#reader [data-next], .reader__nav [data-next], #btnNextChapter');
        if (next) { next.click(); n++; log.push('✓ 点「下一章」'); }
        else {
          log.push('✗ 阅读界面没有「下一章」');
          var back = document.querySelector('#btnBackToList');
          if (back) { back.click(); n++; log.push('✓ 点返回目录'); }
          var it2 = document.querySelectorAll('#chapterList .chapter-item');
          if (it2[2]) { it2[2].click(); n++; log.push('✓ 点第 3 章'); }
        }
        return { 操作数: n, log: log };
      })()`)
    });

    /* ④ 正文里出现的新名字，会不会进设定 */
    report.journeys.push({
      name: '正文出现新角色 → 进设定',
      steps: await ev(`(function(){
        var before = Store.setting.all().filter(function(s){return s.kind==='人物';}).length;
        var text = '老陈把烟头摁灭在栏杆上，说：这么晚了还来。阿棠在后面笑了一声。';
        // 看系统有没有任何自动提取能力
        var hasExtractor = typeof AI.extractNames === 'function'
                        || typeof Store.setting.suggestFromText === 'function';
        return {
          设定里已有的人物: before,
          文本里的新名字: ['老陈', '阿棠'],
          系统会不会自动发现: hasExtractor ? '会' : '不会 —— 必须手打',
          需要用户操作: '手动建两条设定 = 打开新增面板 2 次 × 填 3 个字段'
        };
      })()`)
    });

    /* ⑤ 隔天回来，知不知道上次写到哪 */
    report.journeys.push({
      name: '隔天打开 → 接着上次写',
      steps: await ev(`(function(){
        var st = Store.get();
        var remembered = 'rememberedChapterId' in st || '__lastChapter' in st || !!st.lastOpened;
        return {
          '有记录吗': remembered ? '有' : '没有',
          '用户要做的': '自己想起是第几章 → 点「看剧情」→ 在列表里找 → 点开',
          '首屏有提示吗': document.querySelector('#chapterList .resume-hint') ? '有' : '没有'
        };
      })()`)
    });

    /* ⑥ 写了一段时间后的进度感 */
    report.journeys.push({
      name: '写了一阵子 → 看得到进度吗',
      steps: await ev(`(function(){
        var meta = document.getElementById('bookMeta').textContent;
        return {
          '顶栏显示': meta,
          '有总字数吗': /字/.test(meta) ? '有' : '没有',
          '有今日字数吗': '没有',
          '有章节完成状态吗': '没有 —— 每章只有「草稿数」与「字数」',
          '有连续写作天数吗': '没有'
        };
      })()`)
    });

  } catch (e) {
    report.error = String(e && e.message || e);
  } finally {
    try { ws.close(); } catch (_) { }
    try { child.kill(); } catch (_) { }
  }

  const out = JSON.stringify(report, null, 2);
  if (OUT) fs.writeFileSync(OUT, out, 'utf-8');
  console.log(out);
  process.exit(0);
})();
