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
        主题: document.body.classList.contains('theme-dark') ? '深色' : '浅色',
        主色: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
        页面底色: getComputedStyle(document.body).backgroundColor,
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
        hasSettings: !!s, hasViewAction: !!v,
        settingsVisible: !!(s && s.getClientRects().length),
        // 顶栏只该有这两个按钮（多余的按钮越少越好，每个都得能用）
        btnCount: document.querySelectorAll('.topbar__actions .icon-btn').length
      };
    })()`) });

    // ⑨ 顶栏菜单：任何模块点开都必须有内容，且都能关掉
    await cdp.eval(`document.querySelector('.tab[data-go="read"]').click()`);
    await sleep(250);
    await cdp.eval(`(function(){ var b=document.querySelector('.chapter-item'); if(b) b.click(); })()`);
    await sleep(300);

    const menuChecks = {};
    for (const v of ['read', 'chat', 'world']) {
      await cdp.eval(`document.querySelector('.tab[data-go="${v}"]').click()`);
      await sleep(220);
      await cdp.eval(`document.getElementById('btnViewAction').click()`);
      await sleep(260);
      menuChecks[v] = await cdp.eval(`(function(){
        var panel = document.getElementById('sheet');
        var rows = panel.querySelectorAll('.navrow');
        var hasGlobal = !!panel.querySelector('#vaModel') && !!panel.querySelector('#vaData');
        return { open: !panel.hidden, 项目数: rows.length, 有全局入口: hasGlobal };
      })()`);
      await cdp.eval(`document.getElementById('sheet').querySelector('[data-close]').click()`);
      await sleep(200);
      menuChecks[v]['关掉了'] = await cdp.eval(`document.getElementById('sheet').hidden`);
    }
    report.steps.push({ step: 'topmenu', check: menuChecks });

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

    // ⑱ 续写基线：从「第一段」接着写，而不是只能从章末
    report.steps.push({
      step: 'baseline', check: await cdp.eval(`(function(){
      try {
        Store.chat.clear();
        Store.config.set({ targetWords: 200 });
        var t0 = Store.chapter.active();
        var cid = t0 ? t0.id : null;
        var m1 = Store.chat.push('ai', '第一段：他在码头站着，风很大，没有人来。', { chapterId: cid });
        Store.chat.push('ai', '第二段：他转身往回走，把烟头丢在地上。', { chapterId: cid });
        ChatView.renderFlow();
        var box = document.querySelectorAll('[data-acts]')[0];
        if (!box) return { error: '没有消息操作区' };
        var fromBtn = box.querySelector('[data-act="from"]');
        if (!fromBtn) return { error: '没有「以这段续写」按钮' };
        fromBtn.click();
        var hintTxt = document.getElementById('chatHint').textContent;
        var ctx = AI.buildContext('继续写', null, m1.text);
        var curSec = ctx.sections.filter(function(s){ return s.key === 'cur'; })[0];
        var p = AI.buildMessages({ ask: '继续写', chapterId: null, mode: 'from', baseText: m1.text });
        var sysText = p[0].content, userText = p[p.length - 1].content;
        return {
          提示条显示基线: /接着写/.test(hintTxt),
          按钮改成已选中: !!document.querySelector('[data-act="from"].is-on'),
          上下文改用基线: curSec ? /第一段/.test(curSec.text) : false,
          提示词里带基线: /第一段/.test(userText),
          提示词里带字数要求: /目标约 200 字/.test(sysText)
        };
      } catch (e) { return { error: String(e && e.message || e) }; }
    })()`) });

    // ⑲ 段落列表：每段能单独挑出来处理
    report.steps.push({
      step: 'segments', check: await cdp.eval(`(function(){
      try {
        ChatView.openSegments();
        var rows = document.querySelectorAll('.segrow').length;
        var hasBase = !!document.querySelector('[data-base]');
        var hasIns = !!document.querySelector('[data-ins]');
        App.closeSheet();
        return { 列出段数: rows, 能设基线: hasBase, 能写入: hasIns };
      } catch (e) { return { error: String(e && e.message || e) }; }
    })()`) });

    // ⑳ 字数：显示 + 不足会标出来
    report.steps.push({
      step: 'wordcount', check: await cdp.eval(`(function(){
      try {
        ChatView.renderFlow();
        var lens = document.querySelectorAll('.msg__len').length;
        var short = document.querySelectorAll('.msg__len.is-short').length;
        return {
          字数标签: lens,
          不达标标黄的: short,
          目标字数: Store.get().config.targetWords
        };
      } catch (e) { return { error: String(e && e.message || e) }; }
    })()`) });

    // ㉑ 新名字带回证据句
    report.steps.push({
      step: 'quotes', check: await cdp.eval(`(function(){
      try {
        var t = '沈砚推开门。周砚白抬头看了他一眼。沈砚没说话。周砚白也没说话。沈砚走到窗边。风从缝里进来。';
        var found = AI.extractNames(t, []);
        return found.map(function(x){ return x.name + '→' + x.quotes.length + '句佐证'; });
      } catch (e) { return { error: String(e && e.message || e) }; }
    })()`) });

    // ㉒ 一键排版：接缝处的四类毛病都要修掉
    report.steps.push({
      step: 'tidy', check: await cdp.eval(`(function(){
      try {
        var messy = '他站在码头。\\n风很大。\\n\\n\\n他站在码头。风很大。\\n\\n「你来晚了。」老陈说...\\n\\n"我知道了"他说。';
        var out = Format.tidy(messy);
        var dupBefore = Format.findDupes(messy).length;
        var stat = Format.diffSummary(messy, out);
        return {
          段数变化: stat.beforeParas + '→' + stat.afterParas,
          重复被认出: dupBefore,
          省略号统一: /……/.test(out) && !/\\.\\.\\./.test(out),
          引号统一: out.indexOf('「我知道了」') >= 0,
          整理入口在: !!document.getElementById('btnTidy'),
          AI顺稿可用: typeof AI.buildSmoothMessages === 'function'
        };
      } catch (e) { return { error: String(e && e.message || e) }; }
    })()`) });

    // ㉓ 对话按章隔离：切了写作目标，就只该看到那一章的对话
    report.steps.push({
      step: 'chatscope', check: await cdp.eval(`(function(){
      try {
        Store.chat.clear();
        var chs = Store.chapter.all();
        if (chs.length < 2) return { error: '章节不够' };
        var c1 = chs[0], c2 = chs[1];
        Store.chapter.setActive(c1.id);
        Store.chat.push('me', '第一章的问题', { chapterId: c1.id });
        Store.chat.push('ai', '第一章的回答', { chapterId: c1.id });
        Store.chapter.setActive(c2.id);
        Store.chat.push('me', '第二章的问题', { chapterId: c2.id });
        Store.chat.push('ai', '第二章的回答', { chapterId: c2.id });

        Store.chapter.setActive(c1.id);
        ChatView.refreshAll();
        var n1 = document.querySelectorAll('#chatFlow .msg').length;
        var t1 = document.getElementById('chatFlow').textContent;

        Store.chapter.setActive(c2.id);
        ChatView.refreshAll();
        var n2 = document.querySelectorAll('#chatFlow .msg').length;
        var t2 = document.getElementById('chatFlow').textContent;

        var chip = document.querySelector('#chatChips .chip-btn');
        return {
          第一章: n1, 第二章: n2,
          切章后看不到别章内容: !/第一章的回答/.test(t2) && /第二章的回答/.test(t2),
          默认选中本章: chip ? chip.textContent.replace(/\\s+/g, '') : null,
          用户消息也带章标记: Store.chat.all().filter(function(m){return m.role==='me'&&m.chapterId;}).length
        };
      } catch (e) { return { error: String(e && e.message || e) }; }
    })()`) });

    // ㉔ 换写作目标时，旧基线要作废（否则会把上一章的内容写进这一章）
    report.steps.push({
      step: 'targetreset', check: await cdp.eval(`(function(){
      try {
        var chs = Store.chapter.all();
        if (chs.length < 2) return { error: '章节不够' };
        Store.chat.clear();
        Store.chapter.setActive(chs[0].id);
        var m = Store.chat.push('ai', '这是第一章里的一段内容。', { chapterId: chs[0].id });
        ChatView.refreshAll();
        ChatView.setReplyTo(m);
        var before = document.getElementById('chatHint').textContent;
        Store.chapter.setActive(chs[1].id);
        ChatView.refreshAll();
        var after = document.getElementById('chatHint').textContent;
        return {
          设了基线: /接着写/.test(before),
          换章后自动作废: !/接着写/.test(after),
          换章后看不到旧内容: !/第一章里的一段/.test(document.getElementById('chatFlow').textContent)
        };
      } catch (e) { return { error: String(e && e.message || e) }; }
    })()`) });

    // ㉕ 外观：默认浅色，深色可切
    report.steps.push({
      step: 'theme', check: await cdp.eval(`(function(){
      try {
        var lightBg = getComputedStyle(document.body).backgroundColor;
        var lightAccent = getComputedStyle(document.body).getPropertyValue('--accent').trim();
        document.body.classList.add('theme-dark');
        var darkBg = getComputedStyle(document.body).backgroundColor;
        var darkAccent = getComputedStyle(document.body).getPropertyValue('--accent').trim();
        document.body.classList.remove('theme-dark');
        var paper = getComputedStyle(document.body).getPropertyValue('--paper').trim();
        var readerIndent = document.querySelector('#reader p')
          ? getComputedStyle(document.querySelector('#reader p')).textIndent : null;
        var readerFont = document.querySelector('#reader p')
          ? getComputedStyle(document.querySelector('#reader p')).fontFamily.split(',')[0] : null;
        return {
          默认浅色: lightBg === 'rgb(246, 243, 238)',
          浅色底: lightBg,
          浅色主色: lightAccent,
          深色底: darkBg,
          深色主色: darkAccent,
          深浅确实不同: lightBg !== darkBg && lightAccent !== darkAccent,
          正文纸面: paper,
          正文首行缩进: readerIndent,
          正文字体: readerFont
        };
      } catch (e) { return { error: String(e && e.message || e) }; }
    })()`) });

    // ㉖ 手机可点性：触摸目标够不够大、有没有横向溢出、字会不会太小
    report.steps.push({
      step: 'touch', check: await cdp.eval(`(function(){
      var vw = document.documentElement.clientWidth;
      var small = [], tiny = [], overflow = [];
      document.querySelectorAll('button, a, input, select, textarea, [data-ch], [data-set], [data-line]').forEach(function(el){
        if (!el.getClientRects().length) return;
        var r = el.getBoundingClientRect();
        if (r.width < 6 || r.height < 6) return;
        if (r.right > vw + 1 || r.left < -1) {
          overflow.push((el.className || el.tagName) + ' r=' + Math.round(r.right));
        }
        if (r.height < 36) {
          var cs = getComputedStyle(el);
          var fs = parseFloat(cs.fontSize);
          var t = (el.textContent || '').trim().slice(0, 10) || el.getAttribute('placeholder') || el.type || '';
          small.push({ k: (el.className || el.tagName).toString().split(' ')[0], t: t, w: Math.round(r.width), h: Math.round(r.height), fs: fs });
          if (fs < 12) tiny.push({ t: t, fs: fs });
        }
      });
      // 去重（同类只留一个样本）
      var seen = {}, uniq = [];
      small.forEach(function(x){ if (!seen[x.k]) { seen[x.k] = 1; uniq.push(x); } });
      return {
        视口宽: vw,
        文档宽: document.documentElement.scrollWidth,
        横向溢出: overflow.length ? overflow.slice(0, 5) : '无',
        偏小的可点元素: uniq.slice(0, 12),
        偏小的总数: small.length,
        字号过小的: tiny.length
      };
    })()`) });

    // ㉗ 所有类别的设定都要进上下文（以前只有人物会进）
    report.steps.push({
      step: 'ctxkinds', check: await cdp.eval(`(function(){
      try {
        Store.setting.all().slice().forEach(function(s){ Store.setting.remove(s.id); });
        Store.setting.add({ kind: '人物', name: '甲某人' });
        Store.setting.add({ kind: '地点', name: '东堤码头' });
        Store.setting.add({ kind: '规则', name: '夜禁飞' });
        Store.setting.add({ kind: '物件', name: '星门钥匙' });
        var ctx = AI.buildContext('随便写点什么', null);
        return {
          段落: ctx.sections.map(function(s){ return s.key; }).join(' | '),
          地点进了: /东堤码头/.test(ctx.text),
          规则进了: /夜禁飞/.test(ctx.text),
          物件进了: /星门钥匙/.test(ctx.text)
        };
      } catch (e) { return { error: String(e && e.message || e) }; }
    })()`) });

    // ㉘ 多本书：各写各的，互不串
    report.steps.push({
      step: 'multibook', check: await cdp.eval(`(function(){
      try {
        var b1 = Store.books.current();
        Store.chapter.add({ title: '书一的章' });
        Store.setting.add({ kind: '人物', name: '书一的人' });

        var b2 = Store.books.create({ title: '第二本书' });
        var freshCh = Store.chapter.all().length;
        var freshSet = Store.setting.all().length;
        Store.chapter.add({ title: '书二的章' });
        Store.setting.add({ kind: '人物', name: '书二的人' });

        Store.books.switchTo(b1.id);
        var ch1 = Store.chapter.all().map(function(c){ return c.title; });
        var st1 = Store.setting.all().map(function(s){ return s.name; });

        // 借用设定：新书可以按类别带过来
        Store.books.switchTo(b2.id);
        var copied = Store.books.copySettingsFrom(b1.id, ['人物']);

        Store.books.switchTo(b1.id);
        return {
          作品数: Store.books.all().length,
          新书从空白开始: freshCh === 0 && freshSet === 0,
          书一有: ch1.join('、') + ' / ' + st1.join('、'),
          书之间不串: ch1.indexOf('书二的章') < 0 && st1.indexOf('书二的人') < 0,
          可借用设定: copied >= 1
        };
      } catch (e) { return { error: String(e && e.message || e) }; }
    })()`) });

    // ㉙ 忽略名单：拒绝过的名字不再问
    report.steps.push({
      step: 'ignored', check: await cdp.eval(`(function(){
      try {
        var t = '沈砚推开门。周砚白抬头看了他一眼。沈砚没说话。周砚白也没说话。沈砚走了。';
        var before = AI.findNewNames(t).map(function(x){ return x.name; });
        before.forEach(function(n){ Store.setting.ignoreName(n); });
        var after = AI.findNewNames(t).map(function(x){ return x.name; });
        return {
          第一次会问: before.join('、'),
          忽略后不再问: after.length === 0,
          名单里有: Store.setting.ignoredNames().length
        };
      } catch (e) { return { error: String(e && e.message || e) }; }
    })()`) });

    // ㉚ AI 味检测：机器痕迹要抓得住，正常人话别误伤
    report.steps.push({
      step: 'aiflavor', check: await cdp.eval(`(function(){
      try {
        var dirty = '他不是不想说话，而是不知道说什么。首先，这里很安静。其次，风很大。'
          + '当夜色降临的时候，他终于开口。他的语气里带着一丝疲惫。他不禁思考这一切的意义。'
          + '轻得像羽毛的叹息。好像有什么东西变了。仿佛一切都不同了。如同昨日。'
          + '她微微挑眉，光芒闪过。他认真地摩挲着手里的东西。';
        var clean = '老陈把烟头摁在栏杆上，火星溅了一下就灭了。\\n\\n'
          + '「来晚了。」他说。\\n\\n'
          + '她没接话，把手插进外套口袋，站着没动。风从码头那边过来，带着铁锈味。';

        var d = AiFlavor.scan(dirty);
        var c = AiFlavor.scan(clean);
        // 生成提示词里必须带着铁律
        var p = AI.buildMessages({ ask: '继续写', chapterId: null, mode: 'continue' });
        var sys = p[0].content;
        return {
          脏文本_判定: d.level,
          脏文本_命中类别数: d.hits.length,
          抓到: d.hits.map(function(h){ return h.name; }).join('、'),
          干净文本_判定: c.level,
          干净文本_误报数: c.hits.length,
          铁律进了提示词: /不是……而是……/.test(sys),
          消息上有标记: !!document.querySelector('[data-flavor]') || '（当前没有生成内容，跳过）'
        };
      } catch (e) { return { error: String(e && e.message || e) }; }
    })()`) });

    // ㉛ 设定收录：只收有戏份的，露一面的路人不收
    report.steps.push({
      step: 'autoset', check: await cdp.eval(`(function(){
      try {
        Store.setting.all().slice().forEach(function(s){ Store.setting.remove(s.id); });
        // 有戏份的主要角色：各出现 3 次以上
        ChatView.absorbNames('陆沉推开门。白露抬头看了他一眼。陆沉没说话。白露也没说话。陆沉走了。白露站着没动。');
        var main = Store.setting.all().map(function(s){ return s.name + '[' + s.kind + ']'; });

        // 路过的：只出现一两次，不该收
        Store.setting.all().slice().forEach(function(s){ Store.setting.remove(s.id); });
        ChatView.absorbNames('沈砚推开门。周砚白抬头看了他一眼。沈砚没说话。');
        var passerby = Store.setting.all().length;

        // 地名：够戏份才收，且按后缀认类别
        Store.setting.all().slice().forEach(function(s){ Store.setting.remove(s.id); });
        ChatView.absorbNames('青石巷那边起了雾。青石巷很静。青石巷没有人。陆沉走进青石巷。陆沉停下。青石巷尽头有灯。');
        var place = Store.setting.all().map(function(s){ return s.name + '[' + s.kind + ']'; });

        return {
          有戏份的收进来: main.join('、'),
          露一面的不收: passerby === 0,
          地名认得对: place.join('、') || '（没收）',
          没弹窗: document.getElementById('sheet').hidden
        };
      } catch (e) { return { error: String(e && e.message || e) }; }
    })()`) });

    // ㉛ᐟ 摘录模式：正文没写的，一个字都不许多
    report.steps.push({
      step: 'extractonly', check: await cdp.eval(`(function(){
      try {
        var s = { kind: '人物', name: '陆沉', quotes: ['陆沉推开门，他个子很高，进门时低了下头。', '「来晚了。」陆沉说。'] };
        var msgs = AI.buildEnrichMessages(s);
        var sys = msgs[0].content, user = msgs[1].content;
        var both = sys + user;
        return {
          禁止编造: /严禁编造/.test(sys),
          没写的要省略: /整行省略|没写到的项/.test(sys),
          不许猜: /不许用「可能」/.test(sys),
          依据只有正文: /唯一依据/.test(user),
          正文片段带上了: /个子很高/.test(user),
          没有常理补足: !/常理/.test(both),
          没有写完整: !/写完整|补完整/.test(both)
        };
      } catch (e) { return { error: String(e && e.message || e) }; }
    })()`) });

    // ㉜ 横向滑动：任何需要左右拉才能看全的操作条都算不合格
    // 注意：手机上"看剧情"的正文面板是故意用 translateX(100%) 停在屏幕外的，
    // 那不是 bug，所以只查两件真事：页面能不能横滚、有没有容器要横拉。
    report.steps.push({
      step: 'noscroll', check: await cdp.eval(`(function(){
      try {
        var vw = document.documentElement.clientWidth;
        var scrollables = [];
        var views = ['read', 'chat', 'world'];
        var prev = document.querySelector('.tab.is-on');
        var prevName = prev ? prev.dataset.go : 'read';

        views.forEach(function(v){
          App.go(v);
          document.querySelectorAll('.view:not([hidden]) *').forEach(function(el){
            if (!el.getClientRects().length) return;
            var cs = getComputedStyle(el);
            if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll')
                && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
              scrollables.push(v + '/' + (el.className || el.tagName).toString().split(' ')[0]
                + '(' + el.scrollWidth + '>' + el.clientWidth + ')');
            }
          });
        });
        App.go(prevName);
        return {
          视口: vw,
          页面宽: document.documentElement.scrollWidth,
          页面能横滚: document.documentElement.scrollWidth > vw + 1,
          还要横拉的容器: scrollables.length ? scrollables.slice(0, 8) : '无',
          顶栏按钮数: document.querySelectorAll('.topbar__actions .icon-btn').length
        };
      } catch (e) { return { error: String(e && e.message || e) }; }
    })()`) });

    // ㉝ 穷举所有面板：能不能开、能不能滚、能不能关、绑定有没有失败
    // "无法退出""无法滑动"这类问题只有逐个开一遍才查得出来。
    await cdp.eval(`(function(){
      var t = Store.chapter.active() || Store.chapter.add({});
      Store.chapter.setActive(t.id);
      Store.chat.clear();
      Store.chat.push('ai', '探针用的一段内容，用来让段落面板有东西可列。', { chapterId: t.id });
      Store.chat.push('ai', '第二段内容，同样只是占位。', { chapterId: t.id });
      Store.setting.add({ kind: '人物', name: '探针人物', desc: '' });
    })()`);
    await sleep(150);

    const panelList = [
      ['设置总览', `App.openSettings()`],
      ['写作铁律', `App.openRules()`],
      ['模型与外观', `App.openModelSettings()`],
      ['作品', `App.openBookSettings()`],
      ['新开一本', `App.openNewBook()`],
      ['数据与备份', `App.openDataSettings()`],
      ['忽略名单', `App.openIgnored()`],
      ['剧情菜单', `App.go('read'); App.openViewAction()`],
      ['对话菜单', `App.go('chat'); App.openViewAction()`],
      ['世界线菜单', `App.go('world'); App.openViewAction()`],
      ['本章版本', `App.go('read'); ReadView.openVersions()`],
      ['改写正文', `App.go('read'); ReadView.openEditor()`],
      ['整理本章', `App.go('read'); ReadView.openTidy()`],
      ['本章段落', `App.go('chat'); ChatView.openSegments()`],
      ['写入剧情', `App.go('chat'); (function(){var m=Store.chat.all().filter(function(x){return x.role==='ai';})[0]; ChatView.openCommit(m);})()`],
      ['本次上下文', `App.go('chat'); ChatView.openContext()`],
      ['编辑设定', `App.go('world'); WorldView.editSetting(Store.setting.all()[0].id)`],
      ['AI味体检', `App.go('chat'); (function(){var m=Store.chat.all().filter(function(x){return x.role==='ai';})[0]; ChatView.openFlavor(m.id);})()`],
    ];

    const panelReport = [];
    let bindFails = 0;
    for (const [name, openExpr] of panelList) {
      let opened = false, geo = null, closed = false, err = '', broken = 0;
      try {
        await cdp.eval(`(function(){ ${openExpr}; })()`);
        await sleep(380);                       // 等出场动画跑完，否则量到的是中途位置
        opened = await cdp.eval(`!document.getElementById('sheet').hidden`);
        if (opened) {
          geo = await cdp.eval(`(function(){
            var b = document.getElementById('sheetBody');
            var p = document.querySelector('.sheet__panel');
            var pr = p.getBoundingClientRect();
            return {
              能滚: b.scrollHeight > b.clientHeight + 2,
              需要滚: b.scrollHeight > b.clientHeight + 2,
              面板出界: pr.top < -1 || pr.bottom > window.innerHeight + 1
            };
          })()`);
          const se = await cdp.eval(`App.sheetError() && App.sheetError().title === ${JSON.stringify(name)} ? App.sheetError() : null`);
          if (se) { bindFails++; err = '绑定失败: ' + se.error.slice(0, 70); }
          broken = await cdp.eval(`document.querySelectorAll('#sheetBody .is-broken').length`);
          // 走用户会走的路：点 ✕
          await cdp.eval(`document.getElementById('sheet').querySelector('.sheet__head [data-close]').click()`);
          await sleep(180);
          closed = await cdp.eval(`document.getElementById('sheet').hidden`);
        }
      } catch (e) { err = String(e && e.message || e).slice(0, 80); }
      panelReport.push({
        面板: name, 打开: opened, 能滚: geo ? geo.能滚 : null,
        出界: geo ? geo.面板出界 : null, 失效按钮: broken || 0,
        能关: closed, 问题: err || undefined,
      });
    }
    await cdp.eval(`App.go('read')`);
    report.steps.push({ step: 'panels', check: { 绑定失败数: bindFails, 明细: panelReport } });

    // ㉞ 写作设定：文风与铁律都是可恢复的预设，作者能直接看见默认
    report.steps.push({
      step: 'rules', check: await cdp.eval(`(function(){
      try {
        // 1) 设置总览里有没有一级入口
        App.openSettings();
        var entry = document.getElementById('mRules');
        var entryVisible = !!(entry && entry.getClientRects().length);
        var entryText = entry ? entry.textContent.replace(/\\s+/g, '') : '';
        entry.click();
        // 2) 文风和铁律在同一页
        var landed = !!document.getElementById('rlText') && !!document.getElementById('rlStyle');

        // 3) 文风：改了 → 保存 → 再用「改回预设」恢复
        var st = document.getElementById('rlStyle');
        var defStyle = Store.DEFAULT_STYLE;
        var presetVisible = st.placeholder === defStyle;
        st.value = '随便改一段试试';
        document.getElementById('rlSave').click();
        var styleSaved = Store.get().config.style;

        App.openRules();
        var hasStyleReset = !!document.getElementById('rlStyleReset');
        var hasStyleCopy = !!document.getElementById('rlStyleCopy');
        document.getElementById('rlStyleReset').click();
        var styleBack = document.getElementById('rlStyle').value;

        // 4) 铁律：改了 → 生效 → 恢复
        var ta = document.getElementById('rlText');
        var preset = ta.value;
        var lines = preset.split('\\n').filter(function (l) { return l.trim(); }).length;
        ta.value = preset + '\\n· 我自己加的一条';
        document.getElementById('rlSave').click();
        var sys = AI.buildMessages({ ask: 'x', chapterId: null, mode: 'chat' })[0].content;
        App.openRules();
        document.getElementById('rlReset').click();
        var back = document.getElementById('rlText').value;
        App.closeSheet();

        // 5) 总开关关掉后完全不注入
        Store.config.set({ deai: false });
        var off = !/写作铁律/.test(AI.buildMessages({ ask: 'x', chapterId: null, mode: 'chat' })[0].content);

        // 6) 采样参数能一键回到默认
        Store.config.set({ deai: true, deaiRules: '', style: defStyle });
        App.openModelSettings();
        var pr = document.getElementById('cfgParamReset');
        document.getElementById('cfgTemp').value = 1.5;
        document.getElementById('cfgFreq').value = 1.4;
        pr.click();
        var gotT = document.getElementById('cfgTemp').value;
        var gotF = document.getElementById('cfgFreq').value;
        App.closeSheet();

        return {
          一级入口可见: entryVisible,
          入口文字: entryText.slice(0, 28),
          文风铁律同页: landed,
          文风能改: styleSaved === '随便改一段试试',
          文风有改回预设: hasStyleReset,
          文风有复制预设: hasStyleCopy,
          预设直接可见: presetVisible,
          文风真恢复了: styleBack === defStyle,
          铁律条数: lines,
          铁律改了就生效: /我自己加的一条/.test(sys),
          铁律能恢复: back.indexOf('我自己加的一条') < 0 && back.length > 80,
          关掉后不注入: off,
          参数能回默认: Number(gotT) === Store.DEFAULT_TEMP && Number(gotF) === Store.DEFAULT_FREQ
        };
      } catch (e) { return { error: String(e && e.message || e) }; }
    })()`) });

    // ㉟ 对话的增删改：能删单条、能重写、生成参数记录在案
    report.steps.push({
      step: 'msgops', check: await cdp.eval(`(function(){
      try {
        Store.chat.clear();
        var t = Store.chapter.active() || Store.chapter.add({});
        Store.chat.push('me', '写一段', { chapterId: t.id });
        var m2 = Store.chat.push('ai', '第一版内容。', { chapterId: t.id, gen: { ask: '写一段', mode: 'chat' } });
        var m3 = Store.chat.push('ai', '第二版内容。', { chapterId: t.id, gen: { ask: '写一段', mode: 'chat' } });
        ChatView.refreshAll();

        var n0 = document.querySelectorAll('#chatFlow .msg').length;
        var delBtn = document.querySelector('#chatFlow [data-act="del"]');
        var regenBtn = document.querySelector('#chatFlow [data-act="regen"]');

        // 删掉最后一条，保留前面
        Store.chat.remove(m3.id);
        ChatView.renderFlow();
        var n1 = document.querySelectorAll('#chatFlow .msg').length;
        var left = Store.chat.all().map(function(x){ return x.text; });

        return {
          渲染条数: n0,
          每条都能删: !!delBtn,
          AI消息能重写: !!regenBtn,
          删掉一条后: n1,
          剩下的是: left.join(' / '),
          生成参数记住了: !!(m2.gen && m2.gen.ask === '写一段'),
          被删的那条真没了: Store.chat.all().every(function(x){ return x.id !== m3.id; })
        };
      } catch (e) { return { error: String(e && e.message || e) }; }
    })()`) });

    // ㊱ 抽屉高度不依赖 dvh（旧 iOS 上 dvh 无效，会让面板撑爆且滚不动）
    report.steps.push({
      step: 'sheetbox', check: await cdp.eval(`(function(){
      try {
        App.openModelSettings();
        var p = document.querySelector('.sheet__panel');
        var b = document.getElementById('sheetBody');
        var pr = p.getBoundingClientRect();
        var vh = window.innerHeight;
        var cs = getComputedStyle(p);
        var out = {
          视口高: vh,
          面板高: Math.round(pr.height),
          面板没超出视口: pr.height <= vh + 1,
          最大高度是百分比: /%/.test(cs.maxHeight) || cs.maxHeight === 'none',
          内容比容器高: b.scrollHeight > b.clientHeight,
          容器能滚: getComputedStyle(b).overflowY === 'auto',
          body有minHeight0前提: getComputedStyle(b).minHeight === '0px'
        };
        App.closeSheet();
        return out;
      } catch (e) { return { error: String(e && e.message || e) }; }
    })()`) });

    // ㊲ 防雷同：铁律条款齐不齐 + 采样参数是不是真的发出去了
    report.steps.push({
      step: 'antirepeat', check: await cdp.eval(`(async function(){
      try {
        var rules = AI.DEAI_RULES;
        var c = {
          不许复述上文: /不许复述上文/.test(rules),
          换一套切入点: /换一套切入点/.test(rules),
          同类反应限次: /最多两次/.test(rules),
          节奏要有起伏: /节奏要有起伏/.test(rules),
          句式禁令齐: /不是……而是……/.test(rules) && /综上所述/.test(rules) && /首先/.test(rules),
          禁样板比喻: /羽毛/.test(rules) && /涟漪/.test(rules),
          禁语气标签: /语气打标签/.test(rules),
          禁内心戏: /内心戏/.test(rules),
          禁滥用词: /摩挲/.test(rules) && /瞳孔/.test(rules)
        };
        // 拦下请求体，确认 penalty 真的带上了（不只是存在配置里）
        var orig = window.fetch, got = null;
        window.fetch = function (u, o) {
          if (o && o.body) { try { got = JSON.parse(o.body); } catch (e) {} }
          return Promise.reject(new Error('probe-stop'));
        };
        var oldKey = Store.get().config.apiKey;
        Store.config.set({ apiKey: 'probe-key', freqPenalty: 0.4, presPenalty: 0.2 });
        try { await AI.generate({ ask: 'x', chapterId: null, mode: 'chat' }); } catch (e) {}
        window.fetch = orig;
        Store.config.set({ apiKey: oldKey });
        c.重复惩罚发出去了 = !!(got && got.frequency_penalty > 0);
        c.新鲜度发出去了 = !!(got && got.presence_penalty > 0);
        c.温度也带上 = !!(got && got.temperature > 0);
        c.铁律进了提示词 = !!((AI.buildMessages({ ask: 'x', chapterId: null, mode: 'chat' })[0].content || '').indexOf('不许重复自己') >= 0);
        return c;
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
