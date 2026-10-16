/* ════════════════════════════════════════════
   临文录 · 主控
   视图切换 / 抽屉 / 提示 / 设置
   ════════════════════════════════════════════ */

const App = (() => {
  let el = {};
  let cur = 'read';
  let lastSheetError = null;

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

  /* ── 抽屉 ──
     这里必须给 onMount 兜一层：绑定代码里任何一个 querySelector 落空，
     后面所有按钮就全都绑不上 —— 面板显示正常、点哪儿都没反应，
     表现就是"退不出来"。宁可少几个次级按钮，也不能整片失灵。 */
  function sheet(title, html, onMount) {
    el.sheetTitle.textContent = title;
    el.sheetBody.innerHTML = html;
    el.sheet.hidden = false;
    document.body.classList.add('is-sheet');
    lastSheetError = null;
    if (onMount) {
      try {
        onMount(el.sheetBody);
      } catch (e) {
        lastSheetError = { title: title, error: String((e && e.message) || e) };
        console.error('[面板] 「' + title + '」绑定出错：', e);
        // 兜底：至少保证关得掉
        const x = el.sheet.querySelector('.sheet__head [data-close]');
        if (x) x.onclick = () => closeSheet();
        // 把失败的按钮标出来，用户至少知道哪块坏了，而不是怀疑整个应用
        el.sheetBody.querySelectorAll('button[id]').forEach((b) => {
          if (typeof b.onclick !== 'function' && !b.dataset.close) b.classList.add('is-broken');
        });
      }
    }
  }
  function closeSheet() {
    el.sheet.hidden = true;
    el.sheetBody.innerHTML = '';
    document.body.classList.remove('is-sheet');
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
          <div class="field__hint">调高 → 更放得开，也更容易乱。一般 0.8～1.0。</div>
        </div>
      </div>
      <div class="field">
        <label class="field__label">用词重复惩罚 ${Number(c.freqPenalty || 0).toFixed(1)}</label>
        <input type="range" id="cfgFreq" min="0" max="1.5" step="0.1" value="${Number(c.freqPenalty || 0)}" style="width:100%">
        <div class="field__hint">
          调高 → <b>少重复已经用过的词</b>。写长场景老是那几句，可以给到 0.5～0.8。<br>
          <span style="opacity:.75">这是从概率层面压重复，比在提示词里喊"不要重复"管用。</span>
        </div>
      </div>
      <div class="field">
        <label class="field__label">话题新鲜度 ${Number(c.presPenalty || 0).toFixed(1)}</label>
        <input type="range" id="cfgPres" min="0" max="1.5" step="0.1" value="${Number(c.presPenalty || 0)}" style="width:100%">
        <div class="field__hint">调高 → 更愿意写新东西，而不是绕回刚写过的内容。</div>
      </div>
      <div class="field">
        <label class="field__label">文风约束（可以随便改）</label>
        <textarea class="textarea" id="cfgStyle" style="min-height:70px">${esc(c.style)}</textarea>
      </div>
      <div class="sec-title">写作铁律</div>
      <button class="navrow" id="cfgRulesGo">
        <span class="navrow__k">去改写作铁律</span>
        <span class="navrow__v">${Store.get().config.deai === false ? '已关闭' : '单独一页'}</span>
        <span class="navrow__a">›</span>
      </button>

      <div class="sec-title">设定</div>
      <label class="pickrow">
        <input type="checkbox" id="cfgAutoSet" ${c.autoSetting === false ? '' : 'checked'}>
        <span class="pickrow__k">后台自动收录设定并写完整说明</span>
      </label>
      <div class="field__hint">
        写到新的人物/地点时自动入库并把说明写全，过程不打扰你 —— 写完自己去设定页看就行。<br>
        人物 → 外貌、脾气、口癖、和主角的关系<br>
        地点 → 位置环境、不同时段的样子、气氛<br>
        物件 → 外形材质、来历、作用<br>
        规则 → 内容、适用范围、限制、代价
      </div>

      <div class="sec-title">外观</div>
      <label class="pickrow">
        <input type="radio" name="theme" value="light" ${Store.get().config.theme === 'dark' ? '' : 'checked'}>
        <span class="pickrow__k">纸感（浅色）</span>
        <span class="pickrow__n" style="font-size:11px">默认</span>
      </label>
      <label class="pickrow">
        <input type="radio" name="theme" value="dark" ${Store.get().config.theme === 'dark' ? 'checked' : ''}>
        <span class="pickrow__k">夜色（深色）</span>
      </label>

      <div class="sec-title">每次写多少</div>
      <div class="field">
        <label class="field__label">目标字数（0 = 不要求）</label>
        <input class="input" id="cfgWords" type="number" min="0" max="8000" step="100" value="${c.targetWords}">
        <div class="field__hint">会写进系统提示，让模型一次写足；生成后字数不够会标出来提醒你继续。</div>
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
      <div class="sec-title">写完怎么落盘</div>
      <label class="pickrow">
        <input type="radio" name="cmode" value="ask" ${c.commitMode === 'auto' ? '' : 'checked'}>
        <span class="pickrow__k">每次问我</span>
        <span class="pickrow__n" style="font-size:11px">弹三个选项</span>
      </label>
      <label class="pickrow">
        <input type="radio" name="cmode" value="auto" ${c.commitMode === 'auto' ? 'checked' : ''}>
        <span class="pickrow__k">直接续接到末尾</span>
        <span class="pickrow__n" style="font-size:11px">不弹窗，最快</span>
      </label>
      <button class="btn" id="cfgSave" style="margin-top:20px">保存</button>
      <button class="btn btn--ghost" id="cfgTest" style="margin-top:8px">连通性测试</button>
      <div class="field__hint" id="cfgOut" style="margin-top:10px">${ready ? '已配置' : '还没填 Key'}</div>
    `, (r) => {
      const g = (id) => r.querySelector(id);
      const tempRange = g('#cfgTemp');
      const tempLabel = tempRange.previousElementSibling;
      tempRange.oninput = () => { tempLabel.textContent = '温度 ' + Number(tempRange.value).toFixed(1); };
      const freqRange = g('#cfgFreq');
      const freqLabel = freqRange.previousElementSibling;
      freqRange.oninput = () => { freqLabel.textContent = '用词重复惩罚 ' + Number(freqRange.value).toFixed(1); };
      const presRange = g('#cfgPres');
      const presLabel = presRange.previousElementSibling;
      presRange.oninput = () => { presLabel.textContent = '话题新鲜度 ' + Number(presRange.value).toFixed(1); };

      const rst = g('#cfgDeaiReset');
      if (rst) rst.onclick = () => {
        g('#cfgDeaiRules').value = AI.DEAI_RULES;
        toast('已恢复成预设，记得点保存');
      };
      const goRules = g('#cfgRulesGo');
      if (goRules) goRules.onclick = () => { closeSheet(); openRules(); };

      g('#cfgSave').onclick = () => {
        const cm = r.querySelector('input[name="cmode"]:checked');
        const th = r.querySelector('input[name="theme"]:checked');
        Store.config.set({
          apiBase: g('#cfgBase').value.trim() || 'https://api.deepseek.com/v1',
          apiKey: g('#cfgKey').value.trim(),
          model: g('#cfgModel').value.trim() || 'deepseek-chat',
          temperature: Number(tempRange.value),
          freqPenalty: Number(g('#cfgFreq').value) || 0,
          presPenalty: Number(g('#cfgPres').value) || 0,
          style: g('#cfgStyle').value.trim(),
          ctxSettings: Number(g('#cfgSet').value) || 0,
          ctxTail: Number(g('#cfgTail').value) || 0,
          commitMode: cm ? cm.value : 'ask',
          targetWords: Number(g('#cfgWords').value) || 0,
          theme: th ? th.value : 'light',
          deai: Store.get().config.deai,          // 这两项在「写作铁律」那一页改，别在这里覆盖
          deaiRules: Store.get().config.deaiRules,
          autoSetting: g('#cfgAutoSet') ? g('#cfgAutoSet').checked : true,
        });
        applyTheme();
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

  /* ── 作品：多本管理 ── */
  function openBookSettings() {
    const bk = Store.books.current();
    const list = Store.books.all();

    sheet('作品', `
      <div class="sec-title">当前这本</div>
      <div class="field">
        <label class="field__label">书名</label>
        <input class="input" id="bkTitle" value="${esc(bk.title)}">
      </div>
      <div class="field">
        <label class="field__label">题材</label>
        <input class="input" id="bkGenre" value="${esc(bk.genre)}" placeholder="都市异能 / 玄幻 / 悬疑">
      </div>
      <div class="field">
        <label class="field__label">一句话设定</label>
        <textarea class="textarea" id="bkDesc" style="min-height:70px">${esc(bk.desc)}</textarea>
      </div>
      <button class="btn" id="bkSave">保存</button>

      <div class="sec-title">这本的产出</div>
      <div class="kv"><span class="kv__k">章节</span><span class="kv__v">${bk.chapters.length}</span></div>
      <div class="kv"><span class="kv__k">总字数</span><span class="kv__v">${bk.chapters.reduce((n, c) => n + Store.chapter.textOf(c).length, 0)}</span></div>
      <div class="kv"><span class="kv__k">设定</span><span class="kv__v">${bk.settings.length}</span></div>
      <div class="kv"><span class="kv__k">世界线</span><span class="kv__v">${bk.lines.length}（未收束 ${bk.lines.filter((l) => l.status !== '已收束').length}）</span></div>

      <div class="sec-title">我的作品（${list.length} 本）</div>
      ${list.map((b) => `
        <div class="kv">
          <span class="kv__k">${b.id === bk.id ? '● ' : ''}${esc(b.title)}</span>
          <span class="kv__v">${b.chapters.length} 章 · ${b.settings.length} 设定</span>
          ${b.id === bk.id ? '' : `<button class="mini-btn" data-sw="${b.id}">切过去</button>`}
          ${list.length > 1 && b.id !== bk.id ? `<button class="mini-btn mini-btn--danger" data-del="${b.id}">删</button>` : ''}
        </div>`).join('')}
      <button class="btn btn--ghost" id="bkNew" style="margin-top:16px">+ 新开一本</button>
      <div class="field__hint" style="margin-top:10px">
        每本书的章节、设定、世界线、对话都是独立的，互不串。模型设置是全局的。
      </div>
    `, (r) => {
      r.querySelector('#bkSave').onclick = () => {
        Store.books.update(bk.id, {
          title: r.querySelector('#bkTitle').value.trim() || '未命名作品',
          genre: r.querySelector('#bkGenre').value.trim(),
          desc: r.querySelector('#bkDesc').value.trim(),
        });
        renderTop(); toast('已保存'); closeSheet();
      };
      r.querySelectorAll('[data-sw]').forEach((b) => b.onclick = () => {
        Store.books.switchTo(b.dataset.sw);
        closeSheet(); renderAll(); toast('已切到《' + Store.books.current().title + '》');
      });
      r.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => {
        const t = Store.books.all().find((x) => x.id === b.dataset.del);
        if (!confirm(`删除《${t.title}》整本？章节、设定、对话都会一起没。此操作不可撤销。`)) return;
        Store.books.remove(b.dataset.del);
        closeSheet(); renderAll(); toast('已删除');
      });
      r.querySelector('#bkNew').onclick = () => openNewBook();
    });
  }

  /* 新开一本：问清楚要不要把当前的设定带过去 */
  function openNewBook() {
    const src = Store.books.current();
    const kinds = {};
    src.settings.forEach((s) => { kinds[s.kind] = (kinds[s.kind] || 0) + 1; });
    const kindList = Object.keys(kinds);

    sheet('新开一本', `
      <div class="field">
        <label class="field__label">书名</label>
        <input class="input" id="nbTitle" placeholder="第 ${Store.books.all().length + 1} 本">
      </div>
      <div class="field">
        <label class="field__label">题材（可留空）</label>
        <input class="input" id="nbGenre" placeholder="都市异能 / 玄幻 / 悬疑">
      </div>
      <div class="field">
        <label class="field__label">一句话设定（可留空）</label>
        <textarea class="textarea" id="nbDesc" style="min-height:60px"></textarea>
      </div>
      <div class="sec-title">要不要沿用《${esc(src.title)}》的设定</div>
      <div class="field__hint" style="margin-bottom:8px">
        不勾就是**全新开始**，跟这本书完全隔离（推荐，除非你写的是同世界观系列）。
      </div>
      ${kindList.length ? kindList.map((k) => `
        <label class="pickrow">
          <input type="checkbox" data-kind="${esc(k)}">
          <span class="pickrow__k">${esc(k)}</span>
          <span class="pickrow__n">${kinds[k]} 条</span>
        </label>`).join('') : '<div class="field__hint">当前这本还没有设定可带。</div>'}
      <button class="btn" id="nbGo" style="margin-top:18px">建这本</button>
    `, (r) => {
      r.querySelector('#nbGo').onclick = () => {
        const title = r.querySelector('#nbTitle').value.trim();
        const genre = r.querySelector('#nbGenre').value.trim();
        const desc = r.querySelector('#nbDesc').value.trim();
        const picked = [...r.querySelectorAll('[data-kind]:checked')].map((x) => x.dataset.kind);
        const b = Store.books.create({ title, genre, desc });
        let copied = 0;
        if (picked.length) copied = Store.books.copySettingsFrom(src.id, picked);
        closeSheet(); renderAll();
        toast(copied ? `已新建《${b.title}》，带过来 ${copied} 条设定` : `已新建《${b.title}》`, 2600);
      };
    });
  }

  /* ── 设置：数据 ── */
  function openDataSettings(anchor) {
    sheet('数据', `
      <button class="btn" id="dExp">导出存档（.json）</button>
      <button class="btn btn--ghost" id="dImp" style="margin-top:8px">导入存档…</button>
      <input type="file" id="dFile" accept=".json,application/json" hidden>

      <div class="sec-title" id="secText">正文</div>
      <button class="btn btn--ghost" id="dMd">导出正文（.md）</button>
      <button class="btn btn--ghost" id="dTxt" style="margin-top:8px">导入正文（.txt / .md，自动按章切分）</button>
      <input type="file" id="dTxtFile" accept=".txt,.md,text/plain,text/markdown" hidden>
      <div class="field__hint" style="margin-top:10px">
        导入时识别「第N章 / 第N回 / 第N节」这类行作为分章标题，切不开就整篇作为一章。
      </div>

      <div class="sec-title">危险操作</div>
      <button class="btn btn--danger" id="dReset">清空全部数据</button>
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
      <div class="buildstamp" id="buildStamp"></div>
    `, (r) => {
      r.querySelector('#dExp').onclick = () => {
        const name = (Store.books.current().title || '临文录').replace(/[\\/:*?"<>|]/g, '_');
        download(name + '.json', Store.exportJSON(), 'application/json');
        toast('已导出');
      };
      r.querySelector('#dImp').onclick = () => r.querySelector('#dFile').click();
      r.querySelector('#dFile').onchange = (e) => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        const rd = new FileReader();
        rd.onload = () => openImportPreview(String(rd.result || ''), f.name);
        rd.readAsText(f, 'utf-8');
      };
      r.querySelector('#dMd').onclick = () => { exportText(); };
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
        Store.reset(); closeSheet(); renderAll(); toast('已清空');
      };
      const bs = r.querySelector('#buildStamp');
      if (bs) {
        bs.innerHTML = `当前版本 build ${currentBuild()}　
          <button class="mini-btn" id="bsCheck">检查更新</button>`;
        r.querySelector('#bsCheck').onclick = async () => {
          bs.querySelector('#bsCheck').textContent = '检查中…';
          await checkUpdate();
          setTimeout(() => {
            const btn = bs.querySelector('#bsCheck');
            if (!btn) return;
            btn.textContent = document.getElementById('updateBar') ? '有新版本，点下面刷新' : '已是最新';
          }, 1400);
        };
      }
      if (anchor === 'text') {
        const s = r.querySelector('#secText');
        if (s) s.scrollIntoView({ block: 'start' });
      }
    });
  }

  /* ── 导入预览：先看清楚，再决定怎么放 ── */
  function openImportPreview(text, filename) {
    const p = Store.parseArchive(text);
    if (!p.ok) return toast('导入失败：' + p.reason, 3400);
    const n = p.counts;
    const row = (label, num) => `
      <div class="kv"><span class="kv__k">${label}</span><span class="kv__v">${num}</span></div>`;
    sheet('导入预览', `
      <div class="field__hint" style="margin-bottom:12px">
        文件：${esc(filename || '（未命名）')}<br>
        作品：<b>${esc(p.title)}</b>
      </div>
      <div class="sec-title">里面有什么</div>
      ${row('作品', n.books)}
      ${row('章节', n.chapters)}
      ${row('设定', n.settings)}
      ${row('世界线', n.lines)}
      ${row('对话记录', n.chat)}
      <div class="sec-title">怎么放</div>
      <label class="pickrow">
        <input type="radio" name="imode" value="merge" checked>
        <span class="pickrow__k">装成新书</span>
        <span class="pickrow__n" style="font-size:11px">不碰现有的</span>
      </label>
      <label class="pickrow">
        <input type="radio" name="imode" value="replace">
        <span class="pickrow__k">替换全部</span>
        <span class="pickrow__n" style="font-size:11px">现有作品会被清掉</span>
      </label>
      <button class="btn" id="ipGo" style="margin-top:18px">开始导入</button>
    `, (r) => {
      r.querySelector('#ipGo').onclick = () => {
        const mode = (r.querySelector('input[name="imode"]:checked') || {}).value || 'merge';
        if (mode === 'replace' && !confirm('这会把现有全部作品替换掉，确定？')) return;
        const res = Store.importJSON(text, { mode });
        if (!res.ok) return toast('导入失败：' + res.reason, 3400);
        const g = res.report;
        closeSheet(); renderAll();
        toast(`已导入 ${g.books} 本 · 章节${g.chapters} · 设定${g.settings} · 世界线${g.lines}`, 3200);
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

  /* ── 外观：默认纸感浅色，深色只是可选项 ── */
  function applyTheme() {
    const t = (Store.get().config.theme) || 'light';
    document.body.classList.toggle('theme-dark', t === 'dark');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = t === 'dark' ? '#17150f' : '#f6f3ee';
  }

  /* ── 顶栏渲染 ── */
  function renderTop() {
    const bk = Store.books.current();
    el.bookName.textContent = bk.title || '临文录';
    const chs = Store.chapter.all();
    const total = chs.reduce((n, c) => n + Store.chapter.textOf(c).length, 0);
    const parts = [];
    if (bk.genre) parts.push(bk.genre);
    parts.push(`${chs.length} 章`);
    if (total > 0) parts.push(total >= 10000 ? (total / 10000).toFixed(1) + ' 万字' : total + ' 字');
    el.bookMeta.textContent = parts.join(' · ');
  }

  /* ── 设置中心：⚙ 一键直达，改模型不用翻 ── */
  function openSettings() {
    const ready = Store.config.ready();
    const cfg = Store.get().config;
    const ruleState = cfg.deai === false ? '已关闭'
      : (String(cfg.deaiRules || '').trim() ? '已自定义' : '预设 11 条');
    sheet('设置', `
      <button class="navrow" id="mRules">
        <span class="navrow__k">写作铁律</span>
        <span class="navrow__v">${ruleState} · 点开就能改</span>
        <span class="navrow__a">›</span>
      </button>
      <button class="navrow" id="mModel">
        <span class="navrow__k">模型设置</span>
        <span class="navrow__v">${ready ? esc(cfg.model) : '<span style="color:var(--red)">还没配</span>'}</span>
        <span class="navrow__a">›</span>
      </button>
      <button class="navrow" id="mBook">
        <span class="navrow__k">作品信息</span>
        <span class="navrow__v">${esc(Store.books.current().title)}</span>
        <span class="navrow__a">›</span>
      </button>
      <button class="navrow" id="mData">
        <span class="navrow__k">数据与导出</span>
        <span class="navrow__v">存档 / 正文 / 导入</span>
        <span class="navrow__a">›</span>
      </button>
      <div class="sec-title">快捷键</div>
      <div class="field__hint">
        Ctrl / ⌘ + Enter —— 发送<br>
        选中正文 —— 续写 / 改写 / 扩写 / 提问 / 存设定<br>
        手机上点章节进正文，左上角 ‹ 回目录
      </div>
    `, (r) => {
      r.querySelector('#mRules').onclick = () => { closeSheet(); openRules(); };
      r.querySelector('#mModel').onclick = () => { closeSheet(); openModelSettings(); };
      r.querySelector('#mBook').onclick = () => { closeSheet(); openBookSettings(); };
      r.querySelector('#mData').onclick = () => { closeSheet(); openDataSettings(); };
    });
  }

  /* ── 写作铁律：单独一个面板 ──
     之前它埋在「模型设置」里，那个面板有 1900px 高，手机上要滚很久才看得到，
     等于没有。现在从 ⚙ 进来第一眼就是它。 */
  function openRules() {
    const cfg = Store.get().config;
    sheet('写作铁律', `
      <div class="field__hint" style="margin-bottom:16px">
        这里写的东西会<b>原样</b>跟着每次生成送进模型。<br>
        下面这段是<b>预设</b>，不是规定 —— 改、删、加都随你。
      </div>
      <label class="pickrow">
        <input type="checkbox" id="rlOn" ${cfg.deai === false ? '' : 'checked'}>
        <span class="pickrow__k">启用（关掉就完全不注入）</span>
      </label>
      <div class="field" style="margin-top:14px">
        <label class="field__label">内容（一行一条）</label>
        <textarea class="textarea" id="rlText" style="min-height:320px">${esc(cfg.deaiRules || AI.DEAI_RULES)}</textarea>
      </div>
      <button class="btn" id="rlSave">保存</button>
      <button class="btn btn--ghost" id="rlReset" style="margin-top:8px">恢复成预设</button>
      <div class="field__hint" style="margin-top:12px">
        例：想加一条「对话不许超过三句连着说」，直接在末尾另起一行写就行。
        哪条不要，把那一行删掉。
      </div>
    `, (r) => {
      const ta = r.querySelector('#rlText');
      const on = r.querySelector('#rlOn');
      r.querySelector('#rlSave').onclick = () => {
        Store.config.set({ deai: on.checked, deaiRules: ta.value.trim() });
        closeSheet();
        ChatView.hint();
        toast('已保存');
      };
      r.querySelector('#rlReset').onclick = () => {
        ta.value = AI.DEAI_RULES;
        on.checked = true;
        toast('已恢复成预设，记得点保存');
      };
    });
  }

  /* ── 顶栏的 ⋯ ──
     以前每个模块一个菜单，切了模块图标不变、内容全变，很容易"点了没反应"。
     现在改成两层：上面是当前模块能做的事，下面固定是全局入口（作品/模型/数据/外观），
     所以任何页面点开都有东西，也永远找得到设置。 */
  function globalRows() {
    const cfg = Store.get().config;
    return `
      <div class="sec-title">全局</div>
      <button class="navrow" id="vaBook">
        <span class="navrow__k">作品</span>
        <span class="navrow__v">${esc(Store.books.current().title)}</span><span class="navrow__a">›</span>
      </button>
      <button class="navrow" id="vaModel">
        <span class="navrow__k">模型与外观</span>
        <span class="navrow__v">${esc(cfg.model || '未配置')} · ${cfg.theme === 'dark' ? '夜色' : '纸感'}</span>
        <span class="navrow__a">›</span>
      </button>
      <button class="navrow" id="vaData">
        <span class="navrow__k">数据与备份</span>
        <span class="navrow__v">存档 / 导入 / 导出</span><span class="navrow__a">›</span>
      </button>`;
  }

  function bindGlobal(r) {
    const b = r.querySelector('#vaBook'); if (b) b.onclick = () => { closeSheet(); openBookSettings(); };
    const m = r.querySelector('#vaModel'); if (m) m.onclick = () => { closeSheet(); openModelSettings(); };
    const d = r.querySelector('#vaData'); if (d) d.onclick = () => { closeSheet(); openDataSettings(); };
  }

  function openViewAction() {
    if (cur === 'read') {
      const c = Store.chapter.active();
      sheet('看剧情 · 菜单', `
        <button class="navrow" id="vaNew"><span class="navrow__k">新建一章</span><span class="navrow__a">+</span></button>
        ${c ? `<button class="navrow" id="vaVers"><span class="navrow__k">本章版本</span><span class="navrow__v">${c.drafts.length} 稿</span><span class="navrow__a">›</span></button>
        <button class="navrow" id="vaEdit"><span class="navrow__k">改写正文</span><span class="navrow__a">✎</span></button>` : ''}
        <div class="sec-title">正文</div>
        <button class="navrow" id="vaImp"><span class="navrow__k">导入正文</span><span class="navrow__v">.txt / .md 按章切分</span><span class="navrow__a">›</span></button>
        <button class="navrow" id="vaExp"><span class="navrow__k">导出正文</span><span class="navrow__v">.md</span><span class="navrow__a">›</span></button>
        ${globalRows()}
      `, (r) => {
        r.querySelector('#vaNew').onclick = () => {
          const ch = Store.chapter.add({});
          Store.chapter.setActive(ch.id);
          closeSheet(); renderAll(); toast('已新建 ' + ch.title);
        };
        const v = r.querySelector('#vaVers'); if (v) v.onclick = () => { closeSheet(); ReadView.openVersions(); };
        const e = r.querySelector('#vaEdit'); if (e) e.onclick = () => { closeSheet(); ReadView.openEditor(); };
        r.querySelector('#vaImp').onclick = () => { closeSheet(); openDataSettings('text'); };
        r.querySelector('#vaExp').onclick = () => { closeSheet(); exportText(); };
        bindGlobal(r);
      });
      return;
    }
    if (cur === 'chat') {
      sheet('提要求 · 菜单', `
        <button class="navrow" id="vaSegs">
          <span class="navrow__k">本章的段落</span>
          <span class="navrow__v">挑一段单独续写 / 写入</span>
          <span class="navrow__a">›</span>
        </button>
        <button class="navrow" id="vaFind"><span class="navrow__k">查找对话</span><span class="navrow__v">按内容 / 按章筛选</span><span class="navrow__a">›</span></button>
        <button class="navrow" id="vaCtx"><span class="navrow__k">查看本次上下文</span><span class="navrow__a">›</span></button>
        <button class="navrow" id="vaPull"><span class="navrow__k">把全部对话导出</span><span class="navrow__v">.md</span><span class="navrow__a">›</span></button>
        <div class="sec-title">危险操作</div>
        <button class="navrow navrow--danger" id="vaClear"><span class="navrow__k">清空本章对话</span><span class="navrow__v">已写进章节的不受影响</span></button>
        ${globalRows()}
      `, (r) => {
        r.querySelector('#vaSegs').onclick = () => { closeSheet(); ChatView.openSegments(); };
        r.querySelector('#vaFind').onclick = () => { closeSheet(); ChatView.toggleFind(true); };
        r.querySelector('#vaCtx').onclick = () => { closeSheet(); ChatView.openContext(); };
        r.querySelector('#vaPull').onclick = () => {
          const md = Store.chat.all().map((m) => `### ${m.role === 'me' ? '我' : (m.role === 'ai' ? '临文' : '·')}\n${m.text}`).join('\n\n');
          download((Store.books.current().title || '临文录') + '-对话.md', md, 'text/markdown');
          toast('已导出对话');
        };
        r.querySelector('#vaClear').onclick = () => {
          const t = Store.chapter.active();
          if (!t) return toast('先选一章');
          if (!confirm(`清空《${t.title}》的对话？已写进章节的内容不受影响。`)) return;
          Store.chat.clearChapter(t.id);
          closeSheet(); ChatView.renderFlow(); ChatView.refreshAll(); toast('已清空本章对话');
        };
        bindGlobal(r);
      });
      return;
    }
    // world
    sheet('世界线与设定 · 菜单', `
      <button class="navrow" id="vaPick"><span class="navrow__k">多选管理</span><span class="navrow__v">批量删除 / 整理</span><span class="navrow__a">›</span></button>
      <button class="navrow" id="vaIgnored"><span class="navrow__k">忽略名单</span><span class="navrow__v">${Store.setting.ignoredNames().length} 个名字不再收</span><span class="navrow__a">›</span></button>
      <div class="sec-title">存档</div>
      <button class="navrow" id="vaWorldExp"><span class="navrow__k">导出设定与世界线</span><span class="navrow__v">.json</span><span class="navrow__a">›</span></button>
      <button class="navrow" id="vaWorldImp"><span class="navrow__k">导入存档</span><span class="navrow__v">装成新书 / 替换</span><span class="navrow__a">›</span></button>
      <div class="sec-title">清理</div>
      <button class="navrow" id="vaCleanAuto">
        <span class="navrow__k">删掉自动收录的</span>
        <span class="navrow__v">你自己加的会留下</span>
      </button>
      <button class="navrow navrow--danger" id="vaCleanAll">
        <span class="navrow__k">清空全部设定</span>
        <span class="navrow__v">世界线不受影响</span>
      </button>
      <div class="field__hint" style="margin-top:14px">
        写到有戏份的新角色时，系统会把它收进设定，并**只把正文里已经写到的**信息摘出来
        —— 正文没写的不许编。不想要这个行为，可以在设置里关掉。
      </div>
      ${globalRows()}
    `, (r) => {
      r.querySelector('#vaIgnored').onclick = () => { closeSheet(); openIgnored(); };
      r.querySelector('#vaPick').onclick = () => { closeSheet(); WorldView.setPick(true); };
      r.querySelector('#vaCleanAuto').onclick = () => {
        const n = Store.setting.all().filter((s) => s.auto).length;
        if (!n) return toast('没有自动收录的条目');
        if (!confirm(`删掉 ${n} 条自动收录的设定？你自己加的会留下。`)) return;
        const gone = Store.setting.clearAuto();
        closeSheet(); renderAll(); toast(`已删掉 ${gone} 条`);
      };
      r.querySelector('#vaCleanAll').onclick = () => {
        const n = Store.setting.all().length;
        if (!n) return toast('设定是空的');
        if (!confirm(`清空全部 ${n} 条设定？此操作不可撤销。`)) return;
        Store.setting.clearAll();
        closeSheet(); renderAll(); toast('已清空设定');
      };
      r.querySelector('#vaWorldExp').onclick = () => {
        const bk = Store.books.current();
        download((bk.title || '临文录') + '-设定.json',
          JSON.stringify({ settings: bk.settings, lines: bk.lines }, null, 2), 'application/json');
        toast('已导出');
      };
      r.querySelector('#vaWorldImp').onclick = () => { closeSheet(); openDataSettings('import'); };
      bindGlobal(r);
    });
  }

  /* ── 忽略名单：被拒绝过的名字，可以放出来重新问 ── */
  function openIgnored() {
    const list = Store.setting.ignoredNames();
    sheet('忽略名单', `
      <div class="field__hint" style="margin-bottom:12px">
        这些名字你选过「不用」，系统不会再拿它们问你。放出来之后会重新参与识别。
      </div>
      ${list.length ? list.map((n) => `
        <div class="kv">
          <span class="kv__k">${esc(n)}</span>
          <button class="mini-btn" data-un="${esc(n)}">放出来</button>
        </div>`).join('') : '<div class="field__hint">名单是空的。</div>'}
      ${list.length > 1 ? '<button class="btn btn--ghost" id="igClear" style="margin-top:16px">全部放出来</button>' : ''}
    `, (r) => {
      r.querySelectorAll('[data-un]').forEach((b) => b.onclick = () => {
        Store.setting.unignore(b.dataset.un);
        closeSheet(); openIgnored();
      });
      const c = r.querySelector('#igClear');
      if (c) c.onclick = () => {
        [...list].forEach((n) => Store.setting.unignore(n));
        closeSheet(); openIgnored();
      };
    });
  }

  function exportText() {
    const bk = Store.books.current();
    const md = [`# ${bk.title}`, bk.genre ? `> ${bk.genre}` : '', '']
      .concat(Store.chapter.all().map((c) => `\n\n## ${c.title}\n\n${Store.chapter.textOf(c)}`)).join('\n');
    download((bk.title || '临文录') + '.md', md, 'text/markdown');
    toast('已导出正文');
  }

  function renderAll() {
    renderTop();
    if (ReadView) ReadView.refresh();
    if (ChatView) ChatView.refreshAll();
    if (WorldView) WorldView.render();
  }

  /* ── 版本自检 ──
     GitHub Pages 会给 HTML 挂 10 分钟缓存，手机上更顽固，导致"我明明发了你看不到"。
     所以打开页面后主动取一次最新 HTML，比对构建标记，不一样就提示刷新。 */
  function currentBuild() {
    const m = document.querySelector('meta[name="build"]');
    return m ? m.content : 'dev';
  }

  function showUpdateBar(remote) {
    if (document.getElementById('updateBar')) return;
    const b = document.createElement('button');
    b.id = 'updateBar';
    b.className = 'updatebar';
    b.textContent = `有新版本 ${remote} · 点此刷新`;
    b.onclick = () => { location.href = location.pathname + '?v=' + Date.now(); };
    document.body.appendChild(b);
  }

  async function checkUpdate() {
    if (!/^https?:$/.test(location.protocol)) return;   // 本地 file:// 直开不做这事
    const mine = currentBuild();
    if (mine === 'dev') return;
    try {
      const res = await fetch(location.pathname + '?_=' + Date.now(), { cache: 'no-store' });
      const txt = await res.text();
      const m = txt.match(/<meta name="build" content="([^"]+)"/);
      if (m && m[1] && m[1] !== mine) showUpdateBar(m[1]);
    } catch (_) { /* 离线就当没有 */ }
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
    applyTheme();

    ReadView.init(el.viewRead);
    ChatView.init(el.viewChat);
    WorldView.init(el.viewWorld);

    el.tabbar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-go]');
      if (b) go(b.dataset.go);
    });
    document.getElementById('btnSettings').onclick = openSettings;
    document.getElementById('btnViewAction').onclick = openViewAction;
    document.getElementById('btnBook').onclick = openBookSettings;

    el.sheet.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { if (!el.sheet.hidden) closeSheet(); else ReadView.clearSelection(); }
    });

    // 手机键盘弹出会把底部输入框盖住，这里把它顶上来
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', () => {
        const ae = document.activeElement;
        if (!ae || (ae.tagName !== 'TEXTAREA' && ae.tagName !== 'INPUT')) return;
        setTimeout(() => {
          const vh = window.visualViewport.height;
          const r = ae.getBoundingClientRect();
          if (r.bottom > vh - 24) ae.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }, 140);
      });
    }

    // 第一次使用：确保至少有一本空书，界面才不会空转
    Store.books.current();

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
    setTimeout(checkUpdate, 2200);
  }

  return {
    boot, go, toast, sheet, closeSheet, renderAll,
    openSettings, openRules, openModelSettings, openBookSettings, openNewBook,
    openDataSettings, openImportPreview, openIgnored, openViewAction, exportText,
    sheetError: () => lastSheetError,
    captureSelection: (a, t) => ChatView.captureSelection(a, t),
  };
})();

document.addEventListener('DOMContentLoaded', App.boot);
