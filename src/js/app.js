/* ════════════════════════════════════════════
   临文录 · 主控
   视图切换 / 抽屉 / 提示 / 设置
   ════════════════════════════════════════════ */

const App = (() => {
  let el = {};
  let cur = 'read';
  let sheetOnMount = null;

  const esc = (s) => String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  /* ── 视图切换 ── */
  function go(name) {
    if (!['read', 'chat', 'world'].includes(name)) return;
    cur = name;
    const map = { read: el.viewRead, chat: el.viewChat, world: el.viewWorld };
    Object.entries(map).forEach(([k, node]) => { node.hidden = k !== name; });
    el.tabbar.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-on', t.dataset.go === name));
    if (name !== 'read') document.body.classList.remove('is-reading');
    if (name === 'chat' && ChatView) ChatView.refreshAll();
    if (name === 'world' && WorldView) WorldView.render();
    if (name === 'read' && ReadView) ReadView.refresh();
  }

  /* ── Toast ── */
  let toastTimer = null;
  function toast(msg, ms = 1900) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms);
  }

  /* ── 抽屉 ── */
  function sheet(title, html, onMount) {
    el.sheetTitle.textContent = title;
    el.sheetBody.innerHTML = html;
    el.sheet.hidden = false;
    sheetOnMount = onMount;
    if (onMount) onMount(el.sheetBody);
  }
  function closeSheet() {
    el.sheet.hidden = true;
    el.sheetBody.innerHTML = '';
    sheetOnMount = null;
  }

  /* ── 设置：模型 ── */
  function openModelSettings() {
    const c = Store.get().config;
    const ready = Store.config.ready();
    sheet('模型设置', `
      <div class="field">
        <label class="field__label">接口地址（OpenAI 兼容）</label>
        <input class="input" id="cfgBase" value="${esc(c.apiBase)}" placeholder="https://api.deepseek.com/v1">
        <div class="field__hint">尾部可带或不带 <code>/chat/completions</code>，会自动补全。</div>
      </div>
      <div class="field">
        <label class="field__label">API Key</label>
        <input class="input" id="cfgKey" type="password" value="${esc(c.apiKey)}" placeholder="sk-…">
        <div class="field__hint">只存在这台设备的浏览器里，不会上传到别处。</div>
      </div>
      <div class="field">
        <label class="field__label">模型名</label>
        <input class="input" id="cfgModel" value="${esc(c.model)}" placeholder="deepseek-chat">
      </div>
      <div class="row">
        <div class="field">
          <label class="field__label">温度 ${Number(c.temperature).toFixed(1)}</label>
          <input type="range" id="cfgTemp" min="0" max="1.6" step="0.1" value="${c.temperature}" style="width:100%">
        </div>
      </div>
      <div class="field">
        <label class="field__label">文风约束</label>
        <textarea class="textarea" id="cfgStyle" style="min-height:70px">${esc(c.style)}</textarea>
      </div>
      <div class="sec-title">带入量（省 token）</div>
      <div class="row">
        <div class="field">
          <label class="field__label">设定条数</label>
          <input class="input" id="cfgSet" type="number" min="0" max="60" value="${c.ctxSettings}">
        </div>
        <div class="field">
          <label class="field__label">本章尾部字数</label>
          <input class="input" id="cfgTail" type="number" min="0" max="6000" step="100" value="${c.ctxTail}">
        </div>
      </div>
      <button class="btn" id="cfgSave">保存</button>
      <button class="btn btn--ghost" id="cfgTest" style="margin-top:8px">连通性测试</button>
      <div class="field__hint" id="cfgOut" style="margin-top:10px">${ready ? '已配置' : '还没填 Key'}</div>
    `, (r) => {
      const g = (id) => r.querySelector(id);
      const tempRange = g('#cfgTemp');
      const tempLabel = tempRange.previousElementSibling;
      tempRange.oninput = () => { tempLabel.textContent = '温度 ' + Number(tempRange.value).toFixed(1); };

      g('#cfgSave').onclick = () => {
        Store.config.set({
          apiBase: g('#cfgBase').value.trim() || 'https://api.deepseek.com/v1',
          apiKey: g('#cfgKey').value.trim(),
          model: g('#cfgModel').value.trim() || 'deepseek-chat',
          temperature: Number(tempRange.value),
          style: g('#cfgStyle').value.trim(),
          ctxSettings: Number(g('#cfgSet').value) || 0,
          ctxTail: Number(g('#cfgTail').value) || 0,
        });
        closeSheet(); ChatView.hint(); toast('已保存');
      };
      g('#cfgTest').onclick = async () => {
        g('#cfgSave').click();
        g('#cfgOut').textContent = '测试中…';
        const res = await AI.probe();
        g('#cfgOut').innerHTML = res.ok
          ? '<span style="color:var(--green)">连通正常 ✓</span>'
          : '<span style="color:var(--red)">失败：' + esc(res.reason) + '</span>';
      };
    });
  }

  /* ── 设置：作品 ── */
  function openBookSettings() {
    const b = Store.get().book;
    const st = Store.get();
    sheet('作品', `
      <div class="field">
        <label class="field__label">书名</label>
        <input class="input" id="bkTitle" value="${esc(b.title)}">
      </div>
      <div class="field">
        <label class="field__label">题材</label>
        <input class="input" id="bkGenre" value="${esc(b.genre)}" placeholder="都市异能 / 玄幻 / 悬疑">
      </div>
      <div class="field">
        <label class="field__label">一句话设定</label>
        <textarea class="textarea" id="bkDesc" style="min-height:70px">${esc(b.desc)}</textarea>
      </div>
      <button class="btn" id="bkSave">保存</button>
      <div class="sec-title">概览</div>
      <div class="kv"><span class="kv__k">章节</span><span class="kv__v">${st.chapters.length}</span></div>
      <div class="kv"><span class="kv__k">总字数</span><span class="kv__v">${st.chapters.reduce((n, c) => n + Store.chapter.textOf(c).length, 0)}</span></div>
      <div class="kv"><span class="kv__k">设定</span><span class="kv__v">${st.settings.length}</span></div>
      <div class="kv"><span class="kv__k">世界线</span><span class="kv__v">${st.lines.length}（未收束 ${st.lines.filter((l) => l.status !== '已收束').length}）</span></div>
    `, (r) => {
      r.querySelector('#bkSave').onclick = () => {
        Store.get().book.title = r.querySelector('#bkTitle').value.trim() || '未命名作品';
        Store.get().book.genre = r.querySelector('#bkGenre').value.trim();
        Store.get().book.desc = r.querySelector('#bkDesc').value.trim();
        Store.save(); renderTop(); toast('已保存');
        closeSheet();
      };
    });
  }

  /* ── 设置：数据 ── */
  function openDataSettings() {
    sheet('数据', `
      <button class="btn" id="dExp">导出存档（.json）</button>
      <button class="btn btn--ghost" id="dImp" style="margin-top:8px">导入存档</button>
      <input type="file" id="dFile" accept=".json,application/json" hidden>
      <div class="sec-title">正文</div>
      <button class="btn btn--ghost" id="dMd">导出正文（.md）</button>
      <button class="btn btn--ghost" id="dTxt" style="margin-top:8px">导入正文（.txt / .md，自动按章切分）</button>
      <input type="file" id="dTxtFile" accept=".txt,.md,text/plain,text/markdown" hidden>
      <div class="field__hint" style="margin-top:10px">
        导入时会识别「第N章 / 第N回 / 第N节」这类行作为分章标题，切不开就整篇作为一章。
      </div>
      <button class="btn btn--danger" id="dReset" style="margin-top:22px">清空全部数据</button>
      <div class="field__hint" style="margin-top:14px">
        数据存在这台设备的浏览器里。换设备、换浏览器、清理缓存都会丢，<b>重要内容请定期导出</b>。
      </div>
      <div class="sec-title">关于</div>
      <div class="field__hint">
        临文录 · 纯前端小说创作台<br>
        看剧情 / 提要求 / 世界线与设定<br>
        零依赖、零外链，可离线使用。<br>
        <span style="opacity:.7">一致性设计参考自 webnovel-writer（GPL-3.0）。</span>
      </div>
    `, (r) => {
      r.querySelector('#dExp').onclick = () => {
        const name = (Store.get().book.title || '临文录').replace(/[\\/:*?"<>|]/g, '_');
        download(name + '.json', Store.exportJSON(), 'application/json');
        toast('已导出');
      };
      r.querySelector('#dImp').onclick = () => r.querySelector('#dFile').click();
      r.querySelector('#dFile').onchange = (e) => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        const rd = new FileReader();
        rd.onload = () => {
          const res = Store.importJSON(String(rd.result || ''));
          if (!res.ok) return toast('导入失败：' + res.reason, 3200);
          closeSheet(); renderAll();
          toast(`已导入：${res.chapters} 章 / ${res.settings} 设定 / ${res.lines} 世界线`, 2600);
        };
        rd.readAsText(f, 'utf-8');
      };
      r.querySelector('#dMd').onclick = () => {
        const st = Store.get();
        const md = [`# ${st.book.title}`, st.book.genre ? `> ${st.book.genre}` : '', '']
          .concat(st.chapters.map((c) => `\n\n## ${c.title}\n\n${Store.chapter.textOf(c)}`)).join('\n');
        download((st.book.title || '临文录') + '.md', md, 'text/markdown');
        toast('已导出正文');
      };
      r.querySelector('#dTxt').onclick = () => r.querySelector('#dTxtFile').click();
      r.querySelector('#dTxtFile').onchange = (e) => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        const rd = new FileReader();
        rd.onload = () => {
          const n = importPlainText(String(rd.result || ''));
          closeSheet(); renderAll();
          toast(n ? `已导入 ${n} 章` : '没找到可导入的内容', 2600);
        };
        rd.readAsText(f, 'utf-8');
      };
      r.querySelector('#dReset').onclick = () => {
        if (!confirm('清空全部数据？这会删掉所有章节、设定和对话，且不可恢复。')) return;
        if (!confirm('真的确定？建议先导出存档。')) return;
        Store.reset(); Store.load && null; closeSheet(); renderAll(); toast('已清空');
      };
    });
  }

  function download(filename, text, mime) {
    try {
      const blob = new Blob([text], { type: mime + ';charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    } catch (e) {
      toast('导出失败：' + (e.message || e), 3000);
    }
  }

  /* ── 导入纯文本：按「第N章」切分，切不开就整篇一章 ── */
  function importPlainText(text) {
    const src = text.replace(/\r\n/g, '\n').trim();
    if (!src) return 0;
    const re = /^(?:#{1,3}\s*)?(第\s*[0-9一二三四五六七八九十百千零两]+\s*[章卷回节]\s*[^\n]{0,30})$/;
    const lines = src.split('\n');
    const marks = [];
    lines.forEach((l, i) => { if (re.test(l.trim()) && l.trim().length <= 40) marks.push(i); });

    let count = 0;
    if (marks.length === 0) {
      Store.chapter.add({ title: '导入的正文', text: src, source: '导入' });
      return 1;
    }
    if (marks[0] > 0) {  // 章标题之前的序言也保留
      const head = lines.slice(0, marks[0]).join('\n').trim();
      if (head) { Store.chapter.add({ title: '序', text: head, source: '导入' }); count++; }
    }
    marks.forEach((start, k) => {
      const end = k + 1 < marks.length ? marks[k + 1] : lines.length;
      const title = lines[start].trim().replace(/^#{1,3}\s*/, '');
      const body = lines.slice(start + 1, end).join('\n').trim();
      Store.chapter.add({ title, text: body, source: '导入' });
      count++;
    });
    return count;
  }

  /* ── 顶栏渲染 ── */
  function renderTop() {
    const st = Store.get();
    el.bookName.textContent = st.book.title || '临文录';
    const total = st.chapters.reduce((n, c) => n + Store.chapter.textOf(c).length, 0);
    const parts = [];
    if (st.book.genre) parts.push(st.book.genre);
    parts.push(`${st.chapters.length} 章`);
    if (total > 0) parts.push((total >= 10000 ? (total / 10000).toFixed(1) + ' 万字' : total + ' 字'));
    el.bookMeta.textContent = parts.join(' · ');
  }

  /* ── 更多菜单 ── */
  function openMenu() {
    sheet('菜单', `
      <button class="btn btn--ghost" id="mModel">模型设置</button>
      <button class="btn btn--ghost" id="mBook" style="margin-top:8px">作品信息</button>
      <button class="btn btn--ghost" id="mData" style="margin-top:8px">数据与导出</button>
      <div class="sec-title">快捷键</div>
      <div class="field__hint">
        Ctrl / ⌘ + Enter —— 发送<br>
        选中正文后 —— 改写 / 扩写 / 提问 / 存为设定
      </div>
    `, (r) => {
      r.querySelector('#mModel').onclick = () => { closeSheet(); openModelSettings(); };
      r.querySelector('#mBook').onclick = () => { closeSheet(); openBookSettings(); };
      r.querySelector('#mData').onclick = () => { closeSheet(); openDataSettings(); };
    });
  }

  function renderAll() {
    renderTop();
    if (ReadView) ReadView.refresh();
    if (ChatView) ChatView.refreshAll();
    if (WorldView) WorldView.render();
  }

  /* ── 启动 ── */
  function boot() {
    el = {
      viewRead: document.getElementById('viewRead'),
      viewChat: document.getElementById('viewChat'),
      viewWorld: document.getElementById('viewWorld'),
      tabbar: document.getElementById('tabbar'),
      bookName: document.getElementById('bookName'),
      bookMeta: document.getElementById('bookMeta'),
      sheet: document.getElementById('sheet'),
      sheetTitle: document.getElementById('sheetTitle'),
      sheetBody: document.getElementById('sheetBody'),
      toast: document.getElementById('toast'),
    };

    Store.load();

    ReadView.init(el.viewRead);
    ChatView.init(el.viewChat);
    WorldView.init(el.viewWorld);

    el.tabbar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-go]');
      if (b) go(b.dataset.go);
    });
    document.getElementById('btnMenu').onclick = openMenu;
    document.getElementById('btnBook').onclick = openBookSettings;
    document.getElementById('btnStream').onclick = () => {
      document.body.classList.toggle('is-stream');
      toast(document.body.classList.contains('is-stream') ? '专注模式（再点一次退出）' : '已退出专注');
    };

    el.sheet.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { if (!el.sheet.hidden) closeSheet(); else ReadView.clearSelection(); }
    });

    // 第一次使用：没有书也没有章节时给一点起手素材
    const st = Store.get();
    if (!st.chapters.length && !st.settings.length) {
      st.book.title = '未命名作品';
      Store.save();
    }

    Store.on((type) => {
      if (type === 'persist-failed') {
        toast('本地存储失败：浏览器可能禁用了存储。请用「数据 → 导出存档」保存。', 6000);
      }
      renderTop();
    });

    // 第一次打开：直接把模型设置摆到面前，省得找
    let seen = false;
    try { seen = !!localStorage.getItem('linwenlu.seen'); } catch (_) { }
    if (!seen) {
      try { localStorage.setItem('linwenlu.seen', '1'); } catch (_) { }
      if (!Store.config.ready()) setTimeout(() => openModelSettings(), 620);
    }

    go('read');
    renderTop();
    ChatView.hint();
  }

  return {
    boot, go, toast, sheet, closeSheet,
    openModelSettings, openBookSettings, openDataSettings,
    captureSelection: (a, t) => ChatView.captureSelection(a, t),
  };
})();

document.addEventListener('DOMContentLoaded', App.boot);
