/* ════════════════════════════════════════════
   临文录 · 模块二：提要求
   对话式创作 + 一键落进章节
   ════════════════════════════════════════════ */

const ChatView = (() => {
  let el = {};
  let busy = false;
  let abort = null;
  let pendingExtra = null;   // { action, text } 来自「看剧情」的选中操作

  const esc = (s) => String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  /* ── 目标章 ── */
  function target() {
    return Store.chapter.active();
  }

  function renderTarget() {
    const c = target();
    el.target.textContent = c ? `${String(c.no).padStart(3, '0')} · ${c.title}` : '（还没建章，点我新建）';
  }

  function hint() {
    if (pendingExtra) {
      el.hint.innerHTML = `已带入选中原文（<b>${pendingExtra.text.length}</b> 字）：<b>${
        { rewrite: '改写', expand: '扩写', ask: '提问' }[pendingExtra.action] || '操作'}</b> · <a href="#" id="dropExtra" style="color:var(--ink-3)">取消</a>`;
      const d = el.hint.querySelector('#dropExtra');
      if (d) d.onclick = (e) => { e.preventDefault(); pendingExtra = null; hint(); };
      return;
    }
    if (!AI_built()) { el.hint.innerHTML = '还没配模型 —— <b>右上 ⋯ → 模型设置</b>'; return; }
    const c = target();
    const n = c ? Store.chapter.textOf(c).length : 0;
    el.hint.innerHTML = `将带入：作品 · 文风 · 设定 · 世界线${c && n ? ` · 本章已写 ${n} 字` : ''}`;
  }

  const AI_built = () => Store.config.ready();

  /* ── 对话渲染 ── */
  function renderFlow() {
    const all = Store.chat.all();
    if (!all.length) {
      const ready = AI_built();
      el.flow.innerHTML = `<div class="blank" style="padding:34px 14px 20px">
        <div class="blank__icon">✎</div>
        <div class="blank__title">说要写什么就行</div>
        <div class="blank__desc" style="text-align:left;display:inline-block">
          · 主角去码头见旧友，气氛要冷<br>
          · 把刚才那段扩成八百字<br>
          · 这一章我想让伏笔收掉<br>
          · 给主角换个更狠的开场
        </div>
        <div class="blank__acts">
          ${ready
          ? '<button class="btn" data-demo="主角在雨里等一个人，气氛要冷">试一段</button>'
          : '<button class="btn" data-cfg>先配置模型</button>'}
        </div>
        ${ready ? '' : '<div class="blank__desc" style="margin-top:6px;font-size:12px">需要填一个 OpenAI 兼容接口的 Key</div>'}
      </div>`;
      const d = el.flow.querySelector('[data-cfg]');
      if (d) d.onclick = () => App.openModelSettings();
      const t = el.flow.querySelector('[data-demo]');
      if (t) t.onclick = () => { el.input.value = t.dataset.demo; autoGrow(); el.input.focus(); };
      return;
    }
    el.flow.innerHTML = all.map(msgHTML).join('');
    bindActs();
    scrollEnd();
  }

  function msgHTML(m) {
    const who = m.role === 'me' ? '我' : (m.role === 'note' ? '·' : '临文');
    const cls = m.role === 'me' ? 'msg--me' : (m.role === 'note' ? 'msg--note' : 'msg--ai');
    const acts = (m.role === 'ai' && !m.clipped) ? `
      <div class="msg__acts" data-acts="${m.id}">
        <button class="mini-btn" data-act="commit">写入剧情</button>
        <button class="mini-btn" data-act="copy">复制</button>
        <button class="mini-btn" data-act="setting">存为设定</button>
      </div>` : (m.clipped ? `<div class="msg__acts"><span class="mini-btn is-on" style="cursor:default">已写入</span></div>` : '');
    return `<div class="msg ${cls}" data-msg="${m.id}">
      <div class="msg__who">${who}</div>
      <div class="msg__body">${esc(m.text)}</div>
      ${acts}
    </div>`;
  }

  function bindActs() {
    el.flow.querySelectorAll('[data-acts]').forEach((box) => {
      const id = box.dataset.acts;
      box.querySelectorAll('[data-act]').forEach((b) => {
        b.onclick = () => {
          const m = Store.chat.all().find((x) => x.id === id);
          if (!m) return;
          if (b.dataset.act === 'copy') {
            navigator.clipboard?.writeText(m.text).then(
              () => App.toast('已复制'), () => App.toast('复制失败'));
          } else if (b.dataset.act === 'setting') {
            App.sheet('存为设定', `
              <div class="field"><label class="field__label">名称</label>
                <input class="input" id="kName" value="${esc(m.text.slice(0, 12))}"></div>
              <div class="field"><label class="field__label">类别</label>
                <select class="select" id="kKind"><option>人物</option><option>地点</option><option>物件</option><option>规则</option><option>设定</option></select></div>
              <div class="field"><label class="field__label">说明</label>
                <textarea class="textarea" id="kDesc">${esc(m.text)}</textarea></div>
              <button class="btn" id="kSave">存进设定</button>
            `, (r) => {
              r.querySelector('#kSave').onclick = () => {
                Store.setting.add({
                  name: r.querySelector('#kName').value.trim() || '未命名',
                  kind: r.querySelector('#kKind').value,
                  desc: r.querySelector('#kDesc').value.trim(),
                });
                App.closeSheet(); App.toast('已存进设定');
              };
            });
          } else if (b.dataset.act === 'commit') {
            openCommit(m);
          }
        };
      });
    });
  }

  function scrollEnd() {
    requestAnimationFrame(() => { el.flow.scrollTop = el.flow.scrollHeight; });
  }

  /* ── 落盘 ── */
  function openCommit(m) {
    const c = target();
    const cur = c ? Store.chapter.currentDraft(c) : null;
    const has = cur && cur.text.trim();
    App.sheet('写入剧情', `
      <div class="field__hint" style="margin-bottom:12px">
        这段 <b>${m.text.length}</b> 字将写进
        <b>${c ? esc(c.title) : '（新章）'}</b>。
      </div>
      <button class="btn" id="cmAppend">续接到本章末尾${has ? '' : '（本章为空，直接写入）'}</button>
      <button class="btn btn--ghost" id="cmNew" style="margin-top:8px">存为一个新版本（旧稿保留）</button>
      <button class="btn btn--ghost" id="cmReplace" style="margin-top:8px">替换当前版本</button>
      ${!c ? '<div class="field__hint" style="margin-top:10px">还没有章节，会先自动建一章。</div>' : ''}
    `, (r) => {
      const ensure = () => c || Store.chapter.add({ title: '第1章' });

      r.querySelector('#cmAppend').onclick = () => {
        const ch = ensure();
        const d = Store.chapter.currentDraft(ch);
        const next = (d && d.text.trim()) ? d.text.replace(/\s+$/, '') + '\n\n' + m.text.trim() : m.text.trim();
        if (d) Store.chapter.setDraftText(ch.id, next);
        else Store.chapter.newDraft(ch.id, next, 'AI');
        Store.chat.markClipped(m.id);
        App.closeSheet(); renderFlow();
        if (ReadView) ReadView.refresh();
        App.toast('已写进 ' + ch.title);
      };

      r.querySelector('#cmNew').onclick = () => {
        const ch = ensure();
        Store.chapter.newDraft(ch.id, m.text.trim(), 'AI');
        Store.chat.markClipped(m.id);
        App.closeSheet(); renderFlow();
        if (ReadView) ReadView.refresh();
        App.toast('已存为新版本');
      };

      const rep = r.querySelector('#cmReplace');
      if (!has) rep.style.display = 'none';
      rep.onclick = () => {
        const ch = ensure();
        Store.chapter.setDraftText(ch.id, m.text.trim());
        Store.chat.markClipped(m.id);
        App.closeSheet(); renderFlow();
        if (ReadView) ReadView.refresh();
        App.toast('已替换当前稿');
      };
    });
  }

  /* ── 发送 ── */
  async function send(askOverride, modeOverride) {
    if (busy) return;
    const ask = (askOverride !== undefined ? askOverride : el.input.value).trim();
    if (!ask && !pendingExtra) return;
    if (!AI_built()) return App.toast('先配置模型（右上 ⋯）');

    const mode = modeOverride || (pendingExtra
      ? (pendingExtra.action === 'rewrite' ? 'rewrite' : 'continue')
      : 'chat');
    const extra = pendingExtra ? pendingExtra.text : '';

    busy = true;
    setSendState('stop');
    if (askOverride === undefined) el.input.value = '';
    autoGrow();

    Store.chat.push('me', ask + (extra ? `\n〔带入选中 ${extra.length} 字〕` : ''));
    pendingExtra = null;
    hint();

    // 流式气泡
    const holder = document.createElement('div');
    holder.className = 'msg msg--ai';
    holder.innerHTML = `<div class="msg__who">临文</div>
      <div class="msg__body"><span class="typing"><i></i><i></i><i></i></span></div>`;
    el.flow.appendChild(holder);
    scrollEnd();
    const body = holder.querySelector('.msg__body');

    let acc = '';
    let first = true;
    abort = new AbortController();

    try {
      const full = await AI.generate({
        ask, chapterId: target() ? target().id : null, mode, extra,
        signal: abort.signal,
        onDelta: (piece) => {
          if (first) { body.textContent = ''; first = false; }
          acc += piece;
          body.textContent = acc;
          body.classList.add('reader__caret');
          scrollEnd();
        },
      });
      body.classList.remove('reader__caret');
      const text = (full || acc || '').trim();
      if (!text) {
        holder.remove();
        Store.chat.push('note', '这次没有返回内容。检查模型名或稍后重试。');
      } else {
        holder.remove();
        Store.chat.push('ai', text, { chapterId: target() ? target().id : null });
      }
    } catch (e) {
      body.classList.remove('reader__caret');
      holder.remove();
      if (e && e.name === 'AbortError') {
        const t = acc.trim();
        if (t) Store.chat.push('ai', t, { chapterId: target() ? target().id : null });
        else Store.chat.push('note', '已停止生成。');
      } else {
        Store.chat.push('note', String(e && e.message || e));
        // 降级：给出可复制提示词
        const p = AI.buildPromptOnly({ ask, chapterId: target() ? target().id : null, mode, extra });
        openFallback(p);
      }
    } finally {
      busy = false;
      setSendState('send');
      abort = null;
      renderFlow();
    }
  }

  /** 发送键在「发送 / 停止」之间切换 */
  function setSendState(state) {
    if (state === 'stop') {
      el.send.textContent = '■';
      el.send.title = '停止生成';
      el.send.classList.add('send-btn--stop');
    } else {
      el.send.textContent = '↑';
      el.send.title = '发送';
      el.send.classList.remove('send-btn--stop');
    }
  }

  function openFallback(prompt) {
    App.sheet('连接失败 · 用提示词继续', `
      <div class="field__hint" style="margin-bottom:10px">
        复制下面这段，粘到任意 AI 对话框里；把返回的正文再粘回「看剧情 → ✎」即可。
      </div>
      <textarea class="textarea" id="fbText" style="min-height:40vh">${esc(prompt)}</textarea>
      <button class="btn" id="fbCopy" style="margin-top:10px">复制提示词</button>
      <button class="btn btn--ghost" id="fbPaste" style="margin-top:8px">粘贴返回的正文</button>
      <div id="fbPasteWrap" hidden style="margin-top:10px">
        <textarea class="textarea" id="fbBack" placeholder="把 AI 返回的正文粘到这里" style="min-height:30vh"></textarea>
        <button class="btn" id="fbSave" style="margin-top:8px">写进本章</button>
      </div>
    `, (r) => {
      r.querySelector('#fbCopy').onclick = () => {
        const t = r.querySelector('#fbText');
        t.select(); navigator.clipboard?.writeText(t.value).then(() => App.toast('已复制'), () => App.toast('请手动复制'));
      };
      r.querySelector('#fbPaste').onclick = () => { r.querySelector('#fbPasteWrap').hidden = false; };
      r.querySelector('#fbSave').onclick = () => {
        const txt = r.querySelector('#fbBack').value.trim();
        if (!txt) return App.toast('还没粘贴内容');
        let ch = target();
        if (!ch) ch = Store.chapter.add({ title: '第1章' });
        const d = Store.chapter.currentDraft(ch);
        const next = (d && d.text.trim()) ? d.text.replace(/\s+$/, '') + '\n\n' + txt : txt;
        if (d) Store.chapter.setDraftText(ch.id, next); else Store.chapter.newDraft(ch.id, next, 'AI');
        App.closeSheet(); ReadView.refresh(); App.toast('已写进 ' + ch.title);
      };
    });
  }

  /* ── 上下文预览 ── */
  function openContext() {
    const c = target();
    const ctx = AI.buildContext(el.input.value.trim(), c ? c.id : null);
    const rows = ctx.sections.map((s) => `
      <div class="sec-title">${esc(s.title)}</div>
      <div class="card__desc" style="font-size:12.5px;max-height:26vh;overflow:auto">${esc(s.text)}</div>
    `).join('');
    App.sheet('这次会带进去的料', `
      <div class="field__hint" style="margin-bottom:6px">共 ${ctx.sections.length} 段。设定按相关性挑选，其余按时间补足。</div>
      ${rows}
      <div style="height:16px"></div>
      <button class="btn btn--ghost" id="ctxCfg">调整带入量</button>
    `, (r) => {
      r.querySelector('#ctxCfg').onclick = () => { App.closeSheet(); App.openModelSettings(); };
    });
  }

  /* ── 输入框自适应高度 ── */
  function autoGrow() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, Math.round(window.innerHeight * 0.34)) + 'px';
  }

  function captureSelection(action, text) {
    pendingExtra = { action, text };
    App.go('chat');
    const preset = { rewrite: '把选中的这段改写一下：', expand: '把选中的这段扩写：', ask: '关于选中的这段：' }[action] || '';
    el.input.value = preset;
    hint();
    autoGrow();
    el.input.focus();
    // 光标移到末尾
    el.input.setSelectionRange(el.input.value.length, el.input.value.length);
  }

  function init(root) {
    el = {
      flow: root.querySelector('#chatFlow'),
      input: root.querySelector('#chatInput'),
      send: root.querySelector('#btnSend'),
      hint: root.querySelector('#chatHint'),
      target: root.querySelector('#btnTarget'),
    };

    el.input.addEventListener('input', autoGrow);
    el.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
    });
    el.send.onclick = () => {
      if (busy) { if (abort) abort.abort(); return; }
      send();
    };
    root.querySelector('#btnQuickContinue').onclick = () => send('接着往下写，保持同一场景与语气。', 'continue');
    root.querySelector('#btnQuickOutline').onclick = () => send('给这一章列一下要点。', 'outline');
    root.querySelector('#btnContext').onclick = openContext;
    root.querySelector('#btnNewChat').onclick = () => {
      if (!Store.chat.all().length) return;
      if (!confirm('清空当前对话？（已写进章节的内容不受影响）')) return;
      Store.chat.clear(); renderFlow();
    };
    el.target.onclick = () => {
      const list = Store.chapter.all();
      if (!list.length) {
        const c = Store.chapter.add({});
        Store.chapter.setActive(c.id); renderTarget(); refreshAll(); App.toast('已新建 ' + c.title);
        return;
      }
      App.sheet('写作目标', list.map((c) => `
        <div class="kv">
          <span class="kv__k">${String(c.no).padStart(3, '0')} · ${esc(c.title)}</span>
          <span class="kv__v">${c.drafts.length} 稿 · ${Store.chapter.textOf(c).length} 字</span>
          <button class="mini-btn" data-pick="${c.id}">选它</button>
        </div>`).join('') + `<button class="btn btn--ghost" id="pkNew" style="margin-top:12px">+ 新建一章</button>`,
        (r) => {
          r.querySelectorAll('[data-pick]').forEach((b) => b.onclick = () => {
            Store.chapter.setActive(b.dataset.pick); App.closeSheet(); refreshAll();
          });
          r.querySelector('#pkNew').onclick = () => {
            const c = Store.chapter.add({}); Store.chapter.setActive(c.id);
            App.closeSheet(); refreshAll();
          };
        });
    };

    renderFlow();
    renderTarget();
    hint();
  }

  function refreshAll() { renderTarget(); hint(); renderFlow(); if (ReadView) ReadView.refresh(); }

  return { init, refreshAll, renderFlow, renderTarget, hint, captureSelection, send };
})();
