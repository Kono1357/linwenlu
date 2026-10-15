#!/usr/bin/env node
/* 临文录 · 浏览器验收探针
   用法: node tools/probe.js <url|file> <outPrefix> [W] [H]
   做四件事：① 抓 console 错误 ② 三个视图各截一张图 ③ 检查关键元素与溢出 ④ 跑一遍最小交互

   为什么要有它：Windows 上 headless Edge 的窗口有最小宽度（~482px），
   手机布局只能用 CDP 的 Emulation.setDeviceMetricsOverride 才能真的量到。 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const TARGET = process.argv[2];
const PREFIX = process.argv[3] || 'probe';
const W = +(process.argv[4] || 390);
const H = +(process.argv[5] || 844);
if (!TARGET) { console.error('用法: node tools/probe.js <url|file> <outPrefix> [W] [H]'); process.exit(2); }

const EXES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
let exe = null;
for (const e of EXES) if (fs.existsSync(e)) { exe = e; break; }
if (!exe) { console.log(JSON.stringify({ error: '本机没有 Edge / Chrome' })); process.exit(0); }

const URL_ = /^https?:/i.test(TARGET) ? TARGET : 'file:///' + path.resolve(TARGET).replace(/\\/g, '/');
const PORT = 9300 + (process.pid % 400);
const PROFILE = path.join(os.tmpdir(), 'lwl_probe_' + Date.now());
fs.mkdirSync(PROFILE, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 最小 CDP 客户端（node 22+ 自带 WebSocket） ── */
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.waits = new Map(); this.events = [];
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.id && this.waits.has(m.id)) {
        const { res, rej } = this.waits.get(m.id); this.waits.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      } else if (m.method) {
        this.events.push(m);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.waits.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.waits.has(id)) { this.waits.delete(id); rej(new Error('CDP 超时: ' + method)); }
      }, 30000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' +
      (r.exceptionDetails.exception && r.exceptionDetails.exception.description || ''));
    return r.result.value;
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  }
}

(async () => {
  const report = { target: URL_, viewport: { w: W, h: H }, errors: [], warnings: [], steps: [] };

  const child = cp.spawn(exe, [
    '--headless=new',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    '--window-size=' + W + ',' + H,
    '--no-first-run', '--no-default-browser-check',
    '--allow-file-access-from-files',
    '--disable-gpu', '--hide-scrollbars',
    'about:blank',
  ], { stdio: 'ignore' });

  // 等 DevTools 就绪
  let info = null;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      info = await res.json();
      break;
    } catch (_) { }
  }
  if (!info) { child.kill(); console.log(JSON.stringify({ error: '浏览器没起来' })); process.exit(1); }

  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  const cdp = new CDP(ws);

  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    // 关掉首次访问的「模型设置」自动弹出，避免干扰取证
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try{localStorage.setItem('linwenlu.seen','1')}catch(e){}`,
    });
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: W, height: H, deviceScaleFactor: 3, mobile: true,
      screenOrientation: { angle: W > H ? 90 : 0, type: W > H ? 'landscapePrimary' : 'portraitPrimary' },
    });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await cdp.send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });

    await cdp.send('Page.navigate', { url: URL_ });
    await sleep(2200);

    report.metrics = await cdp.eval(`({
      innerW: window.innerWidth, innerH: window.innerHeight,
      clientW: document.documentElement.clientWidth,
      screenW: screen.width, dpr: window.devicePixelRatio,
      outerW: window.outerWidth, isMobileUA: /Mobi|Android/i.test(navigator.userAgent),
      visualW: window.visualViewport ? Math.round(window.visualViewport.width) : null,
      mq760: matchMedia('(max-width: 760px)').matches,
      mq900: matchMedia('(max-width: 900px)').matches,
      listFlex: getComputedStyle(document.querySelector('.pane--list')).flexGrow,
      listBasis: getComputedStyle(document.querySelector('.pane--list')).flexBasis,
      backDisplay: getComputedStyle(document.querySelector('.reader__back')).display
    })`);

    // ① 看剧情
    report.steps.push({ step: 'read', check: await cdp.eval(`(function(){
      var q=function(s){return document.querySelector(s)};
      return {
        title: document.title,
        bookName: q('#bookName') ? q('#bookName').textContent : null,
        hasTabbar: !!q('#tabbar'),
        tabCount: document.querySelectorAll('.tab').length,
        viewReadVisible: !q('#viewRead').hidden,
        bodyScrollW: document.documentElement.scrollWidth,
        viewportW: document.documentElement.clientWidth,
        hasBlank: !!q('.blank'),
        listHasEmpty: !!q('#chapterList .blank'),
        ls: (function(){ try { localStorage.setItem('__t','1'); localStorage.removeItem('__t'); return 'ok'; } catch(e){ return 'blocked:'+e.name; } })(),
        storeReady: (typeof Store !== 'undefined') && !!Store.get(),
        aiReady: (typeof AI !== 'undefined'),
        toastHidden: q('#toast') ? q('#toast').hidden : null
      };
    })()`) });
    await cdp.shot(PREFIX + '-1-read.png');

    // ② 提要求
    await cdp.eval(`document.querySelector('.tab[data-go="chat"]').click()`);
    await sleep(400);
    report.steps.push({ step: 'chat', check: await cdp.eval(`(function(){
      var q=function(s){return document.querySelector(s)};
      return {
        viewChatVisible: !q('#viewChat').hidden,
        hint: q('#chatHint') ? q('#chatHint').textContent.trim().slice(0,60) : null,
        target: q('#btnTarget') ? q('#btnTarget').textContent.trim() : null,
        composerVisible: !!q('.composer') && q('.composer').getClientRects().length>0
      };
    })()`) });
    await cdp.shot(PREFIX + '-2-chat.png');

    // ③ 世界线
    await cdp.eval(`document.querySelector('.tab[data-go="world"]').click()`);
    await sleep(400);
    report.steps.push({ step: 'world', check: await cdp.eval(`(function(){
      var q=function(s){return document.querySelector(s)};
      return {
        viewWorldVisible: !q('#viewWorld').hidden,
        segCount: document.querySelectorAll('.seg__btn').length,
        emptyText: q('#worldBody') ? q('#worldBody').textContent.trim().slice(0,40) : null
      };
    })()`) });
    await cdp.shot(PREFIX + '-3-world.png');

    // ④ 最小交互：建一章 → 手写落盘 → 回看剧情
    const flow = await cdp.eval(`(function(){
      try {
        var c = Store.chapter.add({ title: '第一章 试笔' });
        Store.chapter.setActive(c.id);
        Store.chapter.newDraft(c.id, '夜里的风从窗缝里钻进来，桌面上的纸角被掀起又落下。\\n\\n她没有去关窗。', '手写');
        var c2 = Store.chapter.add({ title: '第二章 试笔' });
        Store.chapter.newDraft(c2.id, '第二版测试材料。', 'AI');
        Store.chapter.newDraft(c2.id, '这是同一章的另一个平行版本。', 'AI');
        return { chapters: Store.chapter.all().length, draftsOfCh2: Store.chapter.by(c2.id).drafts.length };
      } catch(e) { return { error: String(e && e.message || e) }; }
    })()`);
    report.steps.push({ step: 'flow', check: flow });

    await cdp.eval(`document.querySelector('.tab[data-go="read"]').click()`);
    await sleep(300);
    await cdp.eval(`(function(){ var b=document.querySelector('.chapter-item'); if(b) b.click(); })()`);
    await sleep(400);
    report.steps.push({ step: 'reader', check: await cdp.eval(`(function(){
      var q=function(s){return document.querySelector(s)};
      var r=q('#reader');
      return {
        listItems: document.querySelectorAll('.chapter-item').length,
        readerTitle: q('#readerTitle').textContent,
        verBadge: q('#verBadge').textContent,
        readerTextLen: r ? r.textContent.trim().length : 0,
        readerHasP: !!(r && r.querySelector('p')),
        overflowX: document.documentElement.scrollWidth > window.innerWidth + 1
      };
    })()`) });
    await cdp.shot(PREFIX + '-4-reader.png');

    // ⑤ 抽屉几何：手机端应当铺满视口
    await cdp.eval(`document.getElementById('btnMenu').click()`);
    await sleep(520);
    report.steps.push({
      step: 'sheet', check: await cdp.eval(`(function(){
      var p = document.querySelector('.sheet__panel');
      if (!p) return { error: 'no panel' };
      var r = p.getBoundingClientRect();
      var vw = document.documentElement.clientWidth;
      return {
        panelLeft: Math.round(r.left), panelW: Math.round(r.width),
        vw: vw, fillsViewport: r.width >= vw - 2,
        rangeStyled: !!getComputedStyle(document.documentElement).getPropertyValue('--gold').trim(),
        overflowX: document.documentElement.scrollWidth > vw + 2
      };
    })()`) });
    await cdp.shot(PREFIX + '-5-sheet.png');
    await cdp.eval(`document.querySelector('.sheet__panel [data-close]').click()`);
    await sleep(200);

    // ⑥ 上下文装配（不出网，纯逻辑）：验证带进去的料与预算裁剪
    report.steps.push({
      step: 'context', check: await cdp.eval(`(function(){
      try {
        var ctx = AI.buildContext('主角去码头找旧友', null);
        var p = AI.buildPromptOnly({ ask: '主角去码头找旧友', chapterId: null, mode: 'continue' });
        return {
          sections: ctx.sections.map(function(s){ return s.key; }),
          ctxChars: ctx.text.length,
          promptChars: p.length,
          hasSystem: p.indexOf('### 系统') === 0,
          carriesAsk: p.indexOf('码头') > 0,
          hasStyleRule: p.indexOf('文风') > 0
        };
      } catch (e) { return { error: String(e && e.message || e) }; }
    })()`) });

    // ⑦ 数据往返：导出 → 清空 → 导入，看章节是否原样回来
    report.steps.push({
      step: 'roundtrip', check: await cdp.eval(`(function(){
      try {
        var before = Store.chapter.all().length;
        var dump = Store.exportJSON();
        Store.reset();
        var mid = Store.chapter.all().length;
        var res = Store.importJSON(dump);
        return {
          before: before, afterReset: mid, afterImport: Store.chapter.all().length,
          ok: res.ok, drafts: Store.chapter.by(Store.chapter.all()[1] && Store.chapter.all()[1].id)
            ? Store.chapter.by(Store.chapter.all()[1].id).drafts.length : 0
        };
      } catch (e) { return { error: String(e && e.message || e) }; }
    })()`) });

    // 收 console 里的报错
    for (const e of cdp.events) {
      if (e.method === 'Runtime.exceptionThrown') {
        const d = e.params.exceptionDetails;
        report.errors.push(d.exception ? (d.exception.description || d.text) : d.text);
      }
      if (e.method === 'Runtime.consoleAPICalled' && (e.params.type === 'error' || e.params.type === 'warning')) {
        const txt = (e.params.args || []).map((a) => a.value || a.description || '').join(' ');
        (e.params.type === 'error' ? report.errors : report.warnings).push(txt);
      }
      if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') {
        report.errors.push(e.params.entry.text);
      }
    }
  } catch (e) {
    report.errors.push('PROBE: ' + (e && e.message || e));
  } finally {
    try { ws.close(); } catch (_) { }
    try { child.kill(); } catch (_) { }
  }

  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
})();
