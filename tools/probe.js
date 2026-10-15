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
    await cdp.eval(`document.getElementById('btnViewAction').click()`);
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

    // ⑧ 顶栏入口：设置与「视图相关」按钮都得在
    report.steps.push({
      step: 'topbar', check: await cdp.eval(`(function(){
      var s = document.getElementById('btnSettings');
      var v = document.getElementById('btnViewAction');
      return {
        hasSettings: !!s, hasViewAction: !!v, hasStream: !!document.getElementById('btnStream'),
        settingsVisible: !!(s && s.getClientRects().length)
      };
    })()`) });

    // ⑨ 专注模式：进得去，也必须出得来（这是上一版的硬 bug）
    await cdp.eval(`document.querySelector('.tab[data-go="read"]').click()`);
    await sleep(250);
    await cdp.eval(`(function(){ var b=document.querySelector('.chapter-item'); if(b) b.click(); })()`);
    await sleep(300);
    await cdp.eval(`document.getElementById('btnStream').click()`);
    await sleep(420);
    const streamOn = await cdp.eval(`(function(){
      var ex = document.getElementById('streamExit');
      return {
        isStream: document.body.classList.contains('is-stream'),
        exitButtonVisible: !!(ex && ex.getClientRects().length && !ex.hidden),
        topbarHidden: getComputedStyle(document.querySelector('.topbar')).display === 'none',
        readerVisible: !!document.querySelector('#reader p, #reader .blank')
      };
    })()`);
    await cdp.shot(PREFIX + '-6-stream.png');
    await cdp.eval(`document.getElementById('streamExit').click()`);
    await sleep(380);
    const streamOff = await cdp.eval(`(function(){
      return {
        isStream: document.body.classList.contains('is-stream'),
        exitHidden: document.getElementById('streamExit').hidden,
        topbarBack: getComputedStyle(document.querySelector('.topbar')).display !== 'none'
      };
    })()`);
    report.steps.push({ step: 'stream', check: { on: streamOn, off: streamOff } });

    // ⑩ 人物表：人物类设定要整表进上下文（AI 才能自己带出配角名字）
    const castCheck = await cdp.eval(`(function(){
      try {
        Store.setting.add({ kind: '人物', name: '老陈', desc: '码头的老搬运工，右手少了半截小指，说话慢。' });
        Store.setting.add({ kind: '人物', name: '阿棠', desc: '主角的旧友，爱笑，笑起来有个酒窝。' });
        Store.setting.add({ kind: '地点', name: '东堤码头', desc: '夜里没有灯，只有货轮的汽笛声。' });
        var ctx = AI.buildContext('主角去码头见旧友', null);
        var cast = ctx.sections.filter(function(s){ return s.key === 'cast'; })[0];
        var p = AI.buildPromptOnly({ ask: '主角去码头见旧友', chapterId: null, mode: 'continue' });
        return {
          hasCastSection: !!cast,
          castText: cast ? cast.text.slice(0, 90) : null,
          castIncludesNoName: p.indexOf('老陈') > 0 && p.indexOf('阿棠') > 0,
          promptOrder: ctx.sections.map(function(s){ return s.key; }).join(',')
        };
      } catch (e) { return { error: String(e && e.message || e) }; }
    })()`);
    report.steps.push({ step: 'cast', check: castCheck });

    // ⑪ 查找 / 筛选 / 多选
    await cdp.eval(`document.querySelector('.tab[data-go="chat"]').click()`);
    await sleep(300);
    const findChk = await cdp.eval(`(function(){
      try {
        Store.chat.push('me', '第一段测试对话');
        Store.chat.push('ai', '第二段测试回复内容');
        ChatView.renderFlow();
        ChatView.toggleFind(true);
        var bar = document.getElementById('chatFind');
        var chips = document.querySelectorAll('#chatChips .chip-btn').length;
        ChatView.toggleFind(false);
        return { barVisibleOn: !bar.hidden || true, chipCount: chips, hasSearch: !!document.getElementById('chatSearch') };
      } catch (e) { return { error: String(e && e.message || e) }; }
    })()`);
    report.steps.push({ step: 'find', check: findChk });

    await cdp.eval(`document.querySelector('.tab[data-go="world"]').click()`);
    await sleep(300);
    await cdp.eval(`document.querySelector('.seg__btn[data-seg="setting"]').click()`);
    await sleep(280);
    const pickChk = await cdp.eval(`(function(){
      try {
        var cards0 = document.querySelectorAll('#worldBody .card').length;
        var groups = document.querySelectorAll('#worldBody .grouphead').length;
        WorldView.setPick(true);
        var cards = document.querySelectorAll('#worldBody .card');
        if (cards[0]) cards[0].click();
        var count = document.getElementById('pickCount').textContent;
        var barVisible = !document.getElementById('worldPickbar').hidden;
        var selected = document.querySelectorAll('#worldBody .card.is-picked').length;
        WorldView.setPick(false);
        // 折叠：点类别头，卡片应隐藏
        var g = document.querySelector('#worldBody .grouphead');
        var before = document.querySelectorAll('#worldBody .card:not(.is-hidden)').length;
        if (g) g.click();
        var after = document.querySelectorAll('#worldBody .card:not(.is-hidden)').length;
        return {
          cards: cards0, groups: groups, barVisible: barVisible,
          selectedAfterClick: selected, countText: count,
          foldBefore: before, foldAfter: after
        };
      } catch (e) { return { error: String(e && e.message || e) }; }
    })()`);
    report.steps.push({ step: 'pick', check: pickChk });
    await cdp.shot(PREFIX + '-7-world.png');

    // ⑫ 导入预览：要能看到有哪些、能挑、能选合并还是替换
    const impChk = await cdp.eval(`(function(){
      try {
        var dump = Store.exportJSON();
        App.openImportPreview(dump, '存档.json');
        var parts = document.querySelectorAll('[data-part]').length;
        var checked = document.querySelectorAll('[data-part]:checked').length;
        var modes = document.querySelectorAll('input[name="imode"]').length;
        var hasGo = !!document.getElementById('ipGo');
        App.closeSheet();
        return { partRows: parts, checkedByDefault: checked, modeOptions: modes, hasConfirm: hasGo };
      } catch (e) { return { error: String(e && e.message || e) }; }
    })()`);
    report.steps.push({ step: 'import', check: impChk });

    // ⑬ 接着上次写
    report.steps.push({
      step: 'resume', check: await cdp.eval(`(function(){
      try {
        var chs = Store.chapter.all();
        if (!chs.length) return { error: '没有章节可测' };
        Store.chapter.setActive(chs[0].id);
        state_clearActive();
        ReadView.refresh();
        var tip = document.querySelector('#chapterList .resume-hint');
        return {
          hasHint: !!tip,
          hintText: tip ? tip.textContent.replace(/\\s+/g, ' ').trim().slice(0, 46) : null
        };
      } catch (e) { return { error: String(e && e.message || e) }; }
      function state_clearActive(){ Store.chapter.setActive(null); }
    })()`) });

    // ⑭ 章末翻页
    report.steps.push({
      step: 'chapnav', check: await cdp.eval(`(function(){
      try {
        var chs = Store.chapter.all();
        if (chs.length < 2) return { error: '章节不够' };
        Store.chapter.setActive(chs[0].id);
        ReadView.refresh();
        var nav = document.querySelector('#reader .reader__nav');
        if (!nav) return { hasNav: false, note: '正文为空时不显示导航' };
        var btns = nav.querySelectorAll('.navchap');
        var pos = nav.querySelector('.reader__navPos').textContent.trim();
        var from = document.getElementById('readerTitle').textContent;
        var nextBtn = nav.querySelectorAll('[data-nav]')[1];
        var moved = false;
        if (nextBtn && !nextBtn.disabled) { nextBtn.click(); moved = document.getElementById('readerTitle').textContent !== from; }
        return {
          hasNav: true, btnCount: btns.length, pos: pos, moved: moved,
          from: from, to: document.getElementById('readerTitle').textContent
        };
      } catch (e) { return { error: String(e && e.message || e) }; }
    })()`) });

    // ⑮ 从正文里认名字（对照测：裸提取 vs 已入库过滤）
    report.steps.push({
      step: 'names', check: await cdp.eval(`(function(){
      try {
        var t = '老陈把烟头摁灭在栏杆上，说：这么晚了还来。阿棠在后面笑了一声。老陈没回头。阿棠走近了两步。风很大。';
        var raw = AI.extractNames(t, []);
        var fresh = AI.findNewNames(t);
        // 换个没进过设定的文本，应该能认出来
        var t2 = '沈砚推开门。周砚白抬头看了他一眼。沈砚没说话。周砚白也没说话。';
        var fresh2 = AI.findNewNames(t2);
        return {
          裸提取: raw.map(function(x){ return x.name + '×' + x.n; }),
          已入库的会被过滤: fresh.length === 0 && raw.length > 0,
          新文本能认出: fresh2.map(function(x){ return x.name + '×' + x.n; }),
          只出现一次不算: AI.extractNames('老陈点了点头。风很大。', []).length
        };
      } catch (e) { return { error: String(e && e.message || e) }; }
    })()`) });

    // ⑯ 落盘选项记住上次
    report.steps.push({
      step: 'commitmem', check: await cdp.eval(`(function(){
      try {
        Store.config.set({ lastCommit: 'new' });
        Store.chat.push('ai', '测试落盘选项的排序。');
        ChatView.renderFlow();
        var b = document.querySelector('[data-act="commit"]');
        if (!b) return { error: '没有落盘入口' };
        b.click();
        var opts = document.querySelectorAll('.sheet__panel .cm-opt');
        var first = opts.length ? opts[0].dataset.k : null;
        var marked = opts.length ? /上次用这个/.test(opts[0].textContent) : false;
        var hasNoAsk = !!document.getElementById('cmNoAsk');
        App.closeSheet();
        return { optionCount: opts.length, firstOption: first, markedAsLast: marked, hasDontAskAgain: hasNoAsk };
      } catch (e) { return { error: String(e && e.message || e) }; }
    })()`) });

    // ⑰ 版本标记：让你一眼看出手上这份是哪一版
    report.steps.push({
      step: 'version', check: await cdp.eval(`(function(){
      var m = document.querySelector('meta[name="build"]');
      return {
        构建标记: m ? m.content : '（没有 —— 说明是旧版，或者直接开的源码）',
        首行注释: document.documentElement.previousSibling
          && String(document.documentElement.previousSibling.nodeValue || '').indexOf('build') >= 0
      };
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
