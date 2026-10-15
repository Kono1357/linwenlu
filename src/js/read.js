/* ════════════════════════════════════════════
   临文录 · 模块一：看剧情
   目录 / 正文 / 多版本 / 选中即操作
   ════════════════════════════════════════════ */

const ReadView = (() => {
  let el = {};
  let selText = '';
  let chapQ = '';

  const esc = (s) => String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  /** 字数友好格式：12345 → 1.2万 */
  const fmtNum = (n) => (n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n));

  function renderBody(text, chapter) {
    if (!text || !text.trim()) {
      return `<div class="blank">
        <div class="blank__icon">▤</div>
        <div class="blank__title">这一章还是空的</div>
        <div class="blank__desc">去「提要求」说一句要写什么，<br>生成的内容可以一键写进这里。</div>
        <div class="blank__acts">
          <button class="btn" data-blank="write">去提要求</button>
          <button class="btn btn--ghost" data-blank="edit">手写一段</button>
        </div>
      </div>`;
    }
    return text.split(/\n\s*\n/).map((blk) => {
      const t = blk.trim();
      if (!t) return '';
      if (/^#{1,3}\s/.test(t)) return `<h2>${esc(t.replace(/^#{1,3}\s*/, ''))}</h2>`;
      return `<p>${esc(t).replace(/\n/g, '<br>')}</p>`;
    }).join('');
  }

  function renderList() {
    const all = Store.chapter.all();
    const cur = Store.activeChapterId;

    let list = all;
    if (chapQ) {
      const q = chapQ.toLowerCase();
      list = all.filter((c) =>
        c.title.toLowerCase().includes(q) || Store.chapter.textOf(c).toLowerCase().includes(q));
    }

    if (!all.length) {
      el.list.innerHTML = `<div class="blank" style="padding:36px 14px 24px">
        <div class="blank__icon">✎</div>
        <div class="blank__title">还没有章节</div>
        <div class="blank__desc">建第一章，或者直接去「提要求」<br>让 AI 写一段再落进来。</div>
        <div class="blank__acts" style="flex-direction:column;width:100%">
          <button class="btn" data-new style="width:100%">新建第一章</button>
          <button class="btn btn--ghost" data-goto-chat style="width:100%;margin-top:8px">去提要求</button>
        </div>
      </div>`;
      el.list.querySelector('[data-new]').onclick = () => {
        const c = Store.chapter.add({});
        Store.chapter.setActive(c.id);
        refresh();
        App.toast('已新建 ' + c.title);
      };
      el.list.querySelector('[data-goto-chat]').onclick = () => App.go('chat');
      return;
    }

    if (!list.length) {
      el.list.innerHTML = `<div class="blank" style="padding:36px 14px">
        <div class="blank__icon">⌕</div>
        <div class="blank__title">没有匹配的章节</div>
        <div class="blank__acts"><button class="btn btn--ghost" data-clearq>清除搜索</button></div>
      </div>`;
      el.list.querySelector('[data-clearq]').onclick = () => {
        chapQ = ''; if (el.search) el.search.value = ''; renderList();
      };
      return;
    }

    el.list.innerHTML = list.map((c) => {
      const has = c.drafts.length > 0;
      const n = c.drafts.length;
      const words = Store.chapter.textOf(c).length;
      return `<button class="chapter-item ${c.id === cur ? 'is-on' : ''}" data-ch="${c.id}">
        <span class="chapter-item__tag ${has ? 'chapter-item__tag--has' : ''}">${has ? fmtNum(words) + '字 · ' + n + '稿' : '空'}</span>
        <span class="chapter-item__no">${String(c.no).padStart(3, '0')}</span>${esc(c.title)}
      </button>`;
    }).join('');

    // 「接着上次写」：刷新或隔天回来时，直接把上次那章顶到最上面
    if (!cur && !chapQ) {
      const lo = Store.lastOpened;
      const lc = lo ? Store.chapter.by(lo.id) : null;
      if (lc) {
        const d = new Date(lo.at);
        const when = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        const tip = document.createElement('button');
        tip.className = 'resume-hint';
        tip.dataset.ch = lc.id;
        tip.innerHTML = `<span class="resume-hint__k">继续上次</span>
          <span class="resume-hint__t">${String(lc.no).padStart(3, '0')} · ${esc(lc.title)}</span>
          <span class="resume-hint__w">${when}</span>`;
        el.list.prepend(tip);
      }
    }
  }

  function renderReader() {
    const c = Store.chapter.active();
    if (!c) {
      el.title.textContent = '选择一章开始';
      el.reader.innerHTML = `<div class="blank">
        <div class="blank__icon">▤</div>
        <div class="blank__title">这里放你的剧情</div>
        <div class="blank__desc">
          写好的正文会按章排在这里，<br>
          同一章可以留多份平行稿，随时切换比对。
        </div>
        <div class="blank__acts">
          <button class="btn" data-go-chat>开始写</button>
        </div>
      </div>`;
      el.reader.querySelector('[data-go-chat]').onclick = () => App.go('chat');
      el.ver.textContent = '—';
      return;
    }
    const d = Store.chapter.currentDraft(c);
    el.title.textContent = `${String(c.no).padStart(3, '0')} · ${c.title}`;
    el.ver.textContent = d ? `${d.ver}/${c.drafts.length}` : '0';

    const all = Store.chapter.all();
    const idx = all.findIndex((x) => x.id === c.id);
    const prev = idx > 0 ? all[idx - 1] : null;
    const next = idx >= 0 && idx < all.length - 1 ? all[idx + 1] : null;
    const hasText = !!(d && d.text.trim());

    el.reader.innerHTML = renderBody(d ? d.text : '', c) + (hasText ? `
      <div class="reader__nav">
        <button class="navchap" data-nav="${prev ? prev.id : ''}" ${prev ? '' : 'disabled'}>
          ‹ ${prev ? esc(prev.title) : '已是第一章'}
        </button>
        <span class="reader__navPos">${idx + 1} / ${all.length}</span>
        <button class="navchap" data-nav="${next ? next.id : ''}" ${next ? '' : 'disabled'}>
          ${next ? esc(next.title) : '已是最后一章'} ›
        </button>
      </div>` : '');
    el.reader.scrollTop = 0;

    el.reader.querySelectorAll('[data-nav]').forEach((b) => {
      if (b.disabled) return;
      b.onclick = () => {
        const id = b.dataset.nav;
        if (!id) return;
        Store.chapter.setActive(id);
        renderReader();
        renderList();
        el.reader.scrollTop = 0;
      };
    });

    el.reader.querySelectorAll('[data-blank]').forEach((b) => {
      b.onclick = () => {
        if (b.dataset.blank === 'write') App.go('chat');
        else { document.body.classList.remove('is-reading'); openEditor(); }
      };
    });
  }

  function refresh() {
    renderList();
    renderReader();
  }

  /* ── 选中处理 ── */
  function handleSelection() {
    const sel = window.getSelection();
    const t = sel ? String(sel).trim() : '';
    if (!t || t.length < 2 || !el.reader.contains(sel.anchorNode)) {
      selText = '';
      el.selbar.hidden = true;
      return;
    }
    selText = t;
    el.selCount.textContent = t.length;
    el.selbar.hidden = false;
  }

  function clearSelection() {
    selText = '';
    el.selbar.hidden = true;
    const s = window.getSelection();
    if (s) s.removeAllRanges();
  }

  /* ── 版本 ── */
  function openVersions() {
    const c = Store.chapter.active();
    if (!c) return App.toast('先选一章');
    if (!c.drafts.length) return App.toast('这一章还没有内容');
    const rows = c.drafts.slice().reverse().map((d) => `
      <div class="kv">
        <span class="kv__k">稿 ${d.ver}${d.id === c.activeId ? ' ●' : ''}</span>
        <span class="kv__v">${d.source} · ${new Date(d.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${d.text.length}字</span>
        <button class="mini-btn" data-use="${d.id}">用这版</button>
        <button class="mini-btn mini-btn--danger" data-drop="${d.id}">删</button>
      </div>`).join('');
    App.sheet(`版本 · ${c.title}`, `
      <div class="field__hint" style="margin-bottom:10px">
        同一章可以留多份平行稿。切换只影响阅读与续写，不会删掉其他版本。
      </div>${rows}
      <div class="sec-title">操作</div>
      <button class="btn btn--ghost" id="vNew">从当前稿复制一份新版本</button>
      <button class="btn btn--danger" id="vDel" style="margin-top:8px">删除本章</button>
    `, (root) => {
      root.querySelectorAll('[data-use]').forEach((b) => b.onclick = () => {
        Store.chapter.useDraft(c.id, b.dataset.use);
        App.closeSheet(); refresh(); App.toast('已切换版本');
      });
      root.querySelectorAll('[data-drop]').forEach((b) => b.onclick = () => {
        if (Store.chapter.dropDraft(c.id, b.dataset.drop)) { App.closeSheet(); refresh(); App.toast('已删掉那一稿'); }
        else App.toast('至少要留一稿');
      });
      root.querySelector('#vNew').onclick = () => {
        const d = Store.chapter.currentDraft(c);
        if (!d) return App.toast('没有可复制的稿');
        Store.chapter.newDraft(c.id, d.text, '派生');
        App.closeSheet(); refresh(); App.toast('已复制为新版本');
      };
      root.querySelector('#vDel').onclick = () => {
        if (!confirm(`删除《${c.title}》整章？该操作不可撤销。`)) return;
        Store.chapter.remove(c.id);
        App.closeSheet(); refresh(); App.toast('已删除');
      };
    });
  }

  /* ── 编辑正文 ── */
  function openEditor() {
    const c = Store.chapter.active();
    if (!c) return App.toast('先选一章');
    const d = Store.chapter.currentDraft(c);
    App.sheet(`改写 · ${c.title}`, `
      <div class="field">
        <label class="field__label">章节名</label>
        <input class="input" id="edTitle" value="${esc(c.title)}">
      </div>
      <div class="field">
        <label class="field__label">正文</label>
        <textarea class="textarea" id="edText" style="min-height:46vh">${esc(d ? d.text : '')}</textarea>
      </div>
      <div class="row">
        <button class="btn" id="edSave">覆盖当前稿</button>
        <button class="btn btn--ghost" id="edNew">存为新版本</button>
      </div>
    `, (root) => {
      const titleEl = root.querySelector('#edTitle');
      const textEl = root.querySelector('#edText');
      root.querySelector('#edSave').onclick = () => {
        Store.chapter.update(c.id, { title: titleEl.value.trim() || c.title });
        if (d) Store.chapter.setDraftText(c.id, textEl.value);
        else Store.chapter.newDraft(c.id, textEl.value, '手写');
        App.closeSheet(); refresh(); App.toast('已保存');
      };
      root.querySelector('#edNew').onclick = () => {
        if (!textEl.value.trim()) return App.toast('正文是空的');
        Store.chapter.newDraft(c.id, textEl.value, '手写');
        App.closeSheet(); refresh(); App.toast('已存为新版本');
      };
    });
  }

  function init(root) {
    el = {
      list: root.querySelector('#chapterList'),
      reader: root.querySelector('#reader'),
      title: root.querySelector('#readerTitle'),
      ver: root.querySelector('#verBadge'),
      selbar: root.querySelector('#selbar'),
      selCount: root.querySelector('#selCount'),
      search: root.querySelector('#chapterSearch'),
    };

    let st = null;
    if (el.search) el.search.addEventListener('input', () => {
      clearTimeout(st);
      st = setTimeout(() => { chapQ = el.search.value.trim(); renderList(); }, 170);
    });
    el.list.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ch]');
      if (!b) return;
      Store.chapter.setActive(b.dataset.ch);
      document.body.classList.add('is-reading');
      refresh();
    });

    root.querySelector('#btnBackToList').onclick = () => {
      document.body.classList.remove('is-reading');
      renderList();
    };
    root.querySelector('#btnNewChapter').onclick = () => {
      const c = Store.chapter.add({});
      Store.chapter.setActive(c.id);
      refresh();
      App.toast('已新建 ' + c.title);
    };
    root.querySelector('#btnVersions').onclick = openVersions;
    root.querySelector('#btnEditChapter').onclick = openEditor;

    root.querySelector('#selbar').addEventListener('click', (e) => {
      const b = e.target.closest('[data-sel]');
      if (!b || !selText) return;
      const action = b.dataset.sel;
      const text = selText;
      clearSelection();
      if (action === 'setting') {
        App.sheet('存为设定', `
          <div class="field">
            <label class="field__label">名称</label>
            <input class="input" id="stName" value="${esc(text.slice(0, 12))}">
          </div>
          <div class="field">
            <label class="field__label">类别</label>
            <select class="select" id="stKind">
              <option>人物</option><option>地点</option><option>物件</option><option>规则</option><option>设定</option>
            </select>
          </div>
          <div class="field">
            <label class="field__label">说明</label>
            <textarea class="textarea" id="stDesc">${esc(text)}</textarea>
          </div>
          <button class="btn" id="stSave">存进设定</button>
        `, (r2) => {
          r2.querySelector('#stSave').onclick = () => {
            Store.setting.add({
              name: r2.querySelector('#stName').value.trim() || '未命名',
              kind: r2.querySelector('#stKind').value,
              desc: r2.querySelector('#stDesc').value.trim(),
            });
            App.closeSheet(); App.toast('已存进设定');
          };
        });
        return;
      }
      App.captureSelection(action, text);
    });

    // 选中：桌面 mouseup + 移动 touchend
    el.reader.addEventListener('mouseup', () => setTimeout(handleSelection, 10));
    el.reader.addEventListener('touchend', () => setTimeout(handleSelection, 60));
    el.reader.addEventListener('scroll', () => { if (!el.selbar.hidden) clearSelection(); }, { passive: true });
  }

  return { init, refresh, renderList, renderReader, openEditor, openVersions, clearSelection };
})();
