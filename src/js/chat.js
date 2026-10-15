/* ════════════════════════════════════════════
   临文录 · 模块二：提要求
   对话式创作 + 一键落进章节
   ════════════════════════════════════════════ */

const ChatView = (() => {
  let el = {};
  let busy = false;
  let abort = null;
  let pendingExtra = null;   // { action, text } 来自「看剧情」的选中操作
  let replyTo = null;        // { id, text } 续写基线：从哪一段接着写

  // 查找 / 筛选状态
  let findOn = false;
  let findQ = '';
  let findChap = 'auto';     // 'auto'（跟当前写作目标）| 'all' | 'draft' | chapterId
  let lastRendered = -1;     // 用来判断"是不是新消息进来"，只有新消息才自动滚到底
  let lastTargetId = null;   // 上次的写作目标，用来判断"换章了"

  const esc = (s) => String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  /** 命中高亮（先转义再包） */
  function hl(text) {
    const e = esc(text);
    if (!findQ) return e;
    try {
      const re = new RegExp(findQ.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      return e.replace(re, (m) => `<span class="hit">${m}</span>`);
    } catch (_) { return e; }
  }

  /** 当前筛选下的消息。
      默认只显示「当前写作目标」那一章的对话 —— 翻找起来才不费劲。
      系统提示（note）不分章，始终显示。 */
  function currentScope() {
    if (findChap !== 'auto') return findChap;
    const t = target();
    return t ? t.id : 'all';
  }

  function filtered() {
    let all = Store.chat.all();
    const scope = currentScope();

    if (scope === 'draft') {
      all = all.filter((m) => !m.clipped && m.role === 'ai');
    } else if (scope !== 'all') {
      // 系统提示不分章；**没有章标记的（旧数据）也要留着**，否则升级后老对话会凭空消失
      all = all.filter((m) => m.role === 'note' || !m.chapterId || m.chapterId === scope);
    }
    if (findQ) {
      const q = findQ.toLowerCase();
      all = all.filter((m) => m.text.toLowerCase().includes(q));
    }
    return all;
  }

  /* ── 目标章 ── */
  function target() {
    return Store.chapter.active();
  }

  function renderTarget() {
    const c = target();
    el.target.textContent = c ? `${String(c.no).padStart(3, '0')} · ${c.title}` : '（还没建章，点我新建）';
  }

  function hint() {
    const lines = [];

    if (pendingExtra) {
      const act = { rewrite: '改写', expand: '扩写', ask: '提问' }[pendingExtra.action] || '操作';
      lines.push(`已带入选中原文（<b>${pendingExtra.text.length}</b> 字）：<b>${act}</b> · <a href="#" data-drop="extra" style="color:var(--ink-3)">取消</a>`);
    }
    if (replyTo) {
      const preview = replyTo.text.replace(/\s/g, '').slice(0, 18);
      lines.push(`从这一段接着写：<b>${esc(preview)}…</b> · <a href="#" data-drop="base" style="color:var(--ink-3)">取消</a>`);
    }

    if (!lines.length) {
      if (!AI_built()) {
        el.hint.innerHTML = '还没配模型 —— <b>右上 ⚙ → 模型设置</b>';
        return;
      }
      const c = target();
      const n = c ? Store.chapter.textOf(c).length : 0;
      const tw = Number(Store.get().config.targetWords) || 0;
      el.hint.innerHTML = `将带入：作品 · 文风 · 设定 · 世界线${c && n ? ` · 本章已写 ${n} 字` : ''}${tw ? ` · 每次约 ${tw} 字` : ''}`;
      return;
    }

    el.hint.innerHTML = lines.join('<br>');
    el.hint.querySelectorAll('[data-drop]').forEach((a) => a.onclick = (e) => {
      e.preventDefault();
      if (a.dataset.drop === 'extra') { pendingExtra = null; hint(); }
      else clearReplyTo();
    });
  }

  const AI_built = () => Store.config.ready();

  /* ── 对话渲染 ── */
  function renderFlow() {
    const total = Store.chat.all().length;
    const all = filtered();

    if (!total) {
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

    if (!all.length) {
      const scope = currentScope();
      const scoped = scope !== 'all' && scope !== 'draft';
      const t = target();
      el.flow.innerHTML = `<div class="blank" style="padding:34px 14px">
        <div class="blank__icon">${scoped && !findQ ? '✎' : '⌕'}</div>
        <div class="blank__title">${scoped && !findQ ? '本章还没有对话' : '没有匹配的对话'}</div>
        <div class="blank__acts">
          ${scoped && !findQ
          ? '<button class="btn btn--ghost" data-showall>看全部章节的对话</button>'
          : '<button class="btn btn--ghost" data-clearfind>清除筛选</button>'}
        </div>
      </div>`;
      const c1 = el.flow.querySelector('[data-clearfind]');
      if (c1) c1.onclick = () => { findQ = ''; findChap = 'auto'; syncFind(); renderFlow(); };
      const c2 = el.flow.querySelector('[data-showall]');
      if (c2) c2.onclick = () => { findChap = 'all'; syncFind(); renderFlow(); };
      return;
    }

    el.flow.innerHTML = all.map(msgHTML).join('');
    bindActs();
    if (el.chips) renderChips();
    // 只有"来了新消息"才自动滚到底；翻旧记录时不打扰
    if (lastRendered < 0 || all.length > lastRendered) scrollEnd();
    lastRendered = all.length;
  }

  /** 把查找/筛选状态同步到控件 */
  function syncFind() {
    el.find.hidden = !findOn;
    if (el.search) el.search.value = findQ;
    renderChips();
  }

  function renderChips() {
    const all = Store.chat.all();
    const t = target();
    const mine = t ? all.filter((m) => m.chapterId === t.id) : [];
    const chips = [
      { k: 'auto', t: '本章', n: mine.length, hint: t ? t.title : '' },
      { k: 'all', t: '全部', n: all.length },
      { k: 'draft', t: '未写入', n: all.filter((m) => !m.clipped && m.role === 'ai').length },
    ];
    el.chips.innerHTML = chips.map((c) =>
      `<button class="chip-btn ${findChap === c.k ? 'is-on' : ''}" data-fc="${esc(c.k)}"
        title="${esc(c.hint || c.t)}">${esc(c.t)}<span class="chip-btn__n">${c.n}</span></button>`
    ).join('');
    el.chips.querySelectorAll('[data-fc]').forEach((b) => b.onclick = () => {
      findChap = b.dataset.fc; syncFind(); renderFlow();
    });
  }

  function toggleFind(on) {
    findOn = on === undefined ? !findOn : !!on;
    if (!findOn) { findQ = ''; findChap = 'auto'; }
    syncFind();
    renderFlow();
    if (findOn && el.search) setTimeout(() => el.search.focus(), 60);
  }

  function msgHTML(m) {
    const who = m.role === 'me' ? '我' : (m.role === 'note' ? '·' : '临文');
    const cls = m.role === 'me' ? 'msg--me' : (m.role === 'note' ? 'msg--note' : 'msg--ai');
    const len = m.text.replace(/\s/g, '').length;
    const tw = Number(Store.get().config.targetWords) || 0;
    const short = m.role === 'ai' && tw > 0 && len < tw * 0.85;
    const lenTag = (m.role === 'ai')
      ? `<span class="msg__len ${short ? 'is-short' : ''}">${len} 字${short ? ` · 差 ${tw - len}` : ''}</span>`
      : '';

    // AI 味：每条生成就地体检一次
    let flavorTag = '';
    if (m.role === 'ai') {
      const f = AiFlavor.scan(m.text);
      if (f.hits.length) {
        flavorTag = `<button class="msg__ai ${f.level === 'heavy' ? 'is-heavy' : ''}" data-flavor="${m.id}">${AiFlavor.label(f)}</button>`;
      }
    }

    const isBase = replyTo && replyTo.id === m.id;
    const acts = (m.role === 'ai') ? `
      <div class="msg__acts" data-acts="${m.id}">
        ${m.clipped
        ? '<span class="mini-btn is-on" style="cursor:default">已写入</span>'
        : '<button class="mini-btn" data-act="commit">写入剧情</button>'}
        <button class="mini-btn ${isBase ? 'is-on' : ''}" data-act="from">${isBase ? '续写基线 ✓' : '以这段续写'}</button>
        <button class="mini-btn" data-act="copy">复制</button>
        ${m.clipped ? '' : '<button class="mini-btn" data-act="setting">存为设定</button>'}
      </div>` : '';
    return `<div class="msg ${cls}" data-msg="${m.id}">
      <div class="msg__who">${who}${lenTag}${flavorTag}</div>
      <div class="msg__body">${hl(m.text)}</div>
      ${acts}
    </div>`;
  }

  /* ── AI 味详情 + 一键重写 ── */
  function openFlavor(id) {
    const m = Store.chat.all().find((x) => x.id === id);
    if (!m) return;
    const res = AiFlavor.scan(m.text);
    if (!res.hits.length) return App.toast('这一段挺干净的');

    App.sheet('AI 味体检', `
      <div class="tidystat">
        <span>${res.len} 字</span>
        <span class="${res.level === 'heavy' ? 'tidystat__warn' : ''}">密度 ${res.per1k} 分/千字</span>
        <span class="${res.level === 'clean' ? 'tidystat__ok' : 'tidystat__warn'}">${res.level === 'heavy' ? '偏重' : (res.level === 'some' ? '有一些' : '干净')}</span>
      </div>
      ${res.hits.map((h) => `
        <div class="flavorhit">
          <div class="flavorhit__hd">
            <span class="flavorhit__n">${esc(h.name)}</span>
            <span class="flavorhit__c">${h.count} 处${h.allow ? ` / 建议 ≤ ${h.allow}` : ''}</span>
          </div>
          <div class="flavorhit__why">${esc(h.why)}</div>
          <div class="flavorhit__s">${h.samples.map((s) => '「' + esc(s) + '」').join(' ')}</div>
          <div class="flavorhit__fix">→ ${esc(h.fix)}</div>
        </div>`).join('')}
      <button class="btn" id="fvRewrite" style="margin-top:16px">让 AI 按这些改一遍</button>
      <div class="field__hint" style="margin-top:8px">只改这些痕迹，情节与信息量一个字不动。</div>
    `, (r) => {
      r.querySelector('#fvRewrite').onclick = () => runDeai(m, res);
    });
  }

  async function runDeai(m, res) {
    if (!Store.config.ready()) return App.toast('先配置模型（右上 ⚙）');
    let keep = false;
    App.sheet('正在去 AI 味', `
      <div class="field__hint">只改机器痕迹，情节与信息量不动。</div>
      <div class="tidyview" id="dvOut" style="margin-top:12px;min-height:140px"></div>
      <button class="btn btn--ghost" id="dvStop" style="margin-top:12px">停止</button>
    `, (r) => {
      const out = r.querySelector('#dvOut');
      let acc = '';
      const ac = new AbortController();
      r.querySelector('#dvStop').onclick = () => { keep = true; ac.abort(); };
      AI.generate({
        messages: AI.buildDeaiMessages(m.text, res.hits),
        signal: ac.signal,
        onDelta: (p) => { acc += p; out.textContent = acc; out.scrollTop = out.scrollHeight; },
      }).then((full) => {
        if (keep) return;
        const txt = (full || acc).trim();
        if (!txt) return App.toast('没有返回内容');
        const after = AiFlavor.scan(txt);
        App.sheet('改完了', `
          <div class="tidystat">
            <span>${res.hits.length} 类 → ${after.hits.length} 类</span>
            <span>密度 ${res.per1k} → ${after.per1k}</span>
          </div>
          <div class="field__label" style="margin-top:14px">预览</div>
          <div class="tidyview">${esc(txt.slice(0, 700))}${txt.length > 700 ? '\n…' : ''}</div>
          <button class="btn" id="dvNew" style="margin-top:16px">改后的作为新一段</button>
          <button class="btn btn--ghost" id="dvReplace" style="margin-top:8px">替换这一段</button>
          <button class="btn btn--ghost" id="dvBack" style="margin-top:8px">不要</button>
        `, (r2) => {
          r2.querySelector('#dvNew').onclick = () => {
            Store.chat.push('ai', txt, { chapterId: m.chapterId });
            App.closeSheet(); renderFlow(); App.toast('已作为新一段');
          };
          r2.querySelector('#dvReplace').onclick = () => {
            m.text = txt;
            Store.save();
            App.closeSheet(); renderFlow(); App.toast('已替换');
          };
          r2.querySelector('#dvBack').onclick = () => { App.closeSheet(); openFlavor(m.id); };
        });
      }).catch((e) => {
        if (e && e.name === 'AbortError') return App.toast('已停止');
        App.toast(String(e && e.message || e), 3400);
      });
    });
  }

  function bindActs() {
    el.flow.querySelectorAll('[data-flavor]').forEach((b) => {
      b.onclick = () => openFlavor(b.dataset.flavor);
    });
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
          } else if (b.dataset.act === 'from') {
            setReplyTo(m);
          }
        };
      });
    });
  }

  function scrollEnd() {
    requestAnimationFrame(() => {
      el.flow.scrollTop = el.flow.scrollHeight;
      if (el.jump) el.jump.hidden = true;
    });
  }

  /* ── 续写基线：从「某一段」接着写，而不是只能从章末 ── */
  function setReplyTo(m) {
    if (replyTo && replyTo.id === m.id) {
      replyTo = null;
      App.toast('已取消续写基线');
    } else {
      replyTo = { id: m.id, text: m.text };
      App.toast('基线已设为这一段，接着说要写什么', 2400);
    }
    renderFlow();
    hint();
    el.input.focus();
  }

  /** 从「看剧情」选中一段直接设为基线 */
  function setBaseText(text) {
    const t = String(text || '').trim();
    if (!t) return;
    replyTo = { id: 'sel', text: t };
    renderFlow();
    hint();
    el.input.focus();
    App.toast('已把选中的这一段设为续写基线，接着说写什么', 2600);
  }

  function clearReplyTo(silent) {
    if (!replyTo) return;
    replyTo = null;
    renderFlow();
    hint();
    if (!silent) App.toast('已取消续写基线');
  }

  /* ── 查看本章各段（段落混在一起就没法单独处理）── */
  function openSegments() {
    const t = target();
    const segs = Store.chat.all().filter((m) =>
      m.role === 'ai' && (!t || !m.chapterId || m.chapterId === t.id));
    const others = Store.chat.all().filter((m) =>
      m.role === 'ai' && t && m.chapterId && m.chapterId !== t.id).length;
    if (!segs.length) {
      return App.toast(others ? '本章还没生成过内容（别章有 ' + others + ' 段）' : '还没有生成过内容', 2600);
    }
    App.sheet('本章的段落', `
      <div class="field__hint" style="margin-bottom:12px">
        每次生成都是一段，可以各自处理。点「设为基线」就用它接着写。
        ${others ? `<br>（另外 ${others} 段属于别的章，没列在这里）` : ''}
      </div>
      ${segs.slice().reverse().map((m) => {
      const c = m.chapterId ? Store.chapter.by(m.chapterId) : null;
      const on = replyTo && replyTo.id === m.id;
      const len = m.text.replace(/\s/g, '').length;
      return `<div class="segrow ${on ? 'is-on' : ''}">
          <div class="segrow__hd">
            <span class="segrow__len">${len} 字</span>
            ${c ? `<span class="segrow__ch">→ ${esc(c.title)}</span>` : '<span class="segrow__ch">未写入</span>'}
            ${m.clipped ? '<span class="segrow__tag">已写入</span>' : ''}
          </div>
          <div class="segrow__txt">${esc(m.text.slice(0, 46))}…</div>
          <div class="segrow__acts">
            <button class="mini-btn ${on ? 'is-on' : ''}" data-base="${m.id}">${on ? '当前基线 ✓' : '设为基线'}</button>
            <button class="mini-btn" data-goto="${m.id}">定位</button>
            <button class="mini-btn" data-ins="${m.id}">写入剧情</button>
          </div>
        </div>`;
    }).join('')}
    `, (r) => {
      r.querySelectorAll('[data-base]').forEach((b) => b.onclick = () => {
        const m = Store.chat.all().find((x) => x.id === b.dataset.base);
        if (m) { replyTo = { id: m.id, text: m.text }; }
        App.closeSheet(); renderFlow(); hint(); App.toast('基线已设好');
      });
      r.querySelectorAll('[data-goto]').forEach((b) => b.onclick = () => {
        App.closeSheet();
        const node = document.querySelector(`[data-msg="${b.dataset.goto}"]`);
        if (node) node.scrollIntoView({ block: 'center' });
      });
      r.querySelectorAll('[data-ins]').forEach((b) => b.onclick = () => {
        const m = Store.chat.all().find((x) => x.id === b.dataset.ins);
        App.closeSheet();
        if (m) openCommit(m);
      });
    });
  }

  /* ── 落盘 ──
     写进的章以「这条消息属于哪一章」为准，而不是"此刻选中的章" ——
     否则翻到旧对话里点写入，会莫名其妙写进另一章。 */
  function openCommit(m) {
    const owner = m.chapterId ? Store.chapter.by(m.chapterId) : null;
    const c = owner || target();
    const wrongChapter = !!(owner && target() && owner.id !== target().id);
    const cur = c ? Store.chapter.currentDraft(c) : null;
    const has = !!(cur && cur.text.trim());
    const last = Store.get().config.lastCommit || 'append';

    // 上次用的那种排最前，减少一次判断
    const opts = [
      { k: 'append', label: `续接到本章末尾${has ? '' : '（本章为空，直接写入）'}`, cls: 'btn' },
      { k: 'new', label: '存为一个新版本（旧稿保留）', cls: 'btn btn--ghost' },
      { k: 'replace', label: '替换当前版本', cls: 'btn btn--ghost' },
    ].filter((o) => !(o.k === 'replace' && !has));
    opts.sort((a, b) => (a.k === last ? -1 : b.k === last ? 1 : 0));

    App.sheet('写入剧情', `
      <div class="field__hint" style="margin-bottom:14px">
        这段 <b>${m.text.length}</b> 字将写进
        <b>${c ? esc(c.title) : '（新章）'}</b>。
        ${wrongChapter ? `<br><span style="color:var(--gold-2)">这段对话属于「${esc(owner.title)}」，所以写到那一章去 —— 不是你现在选中的「${esc(target().title)}」。</span>` : ''}
      </div>
      ${opts.map((o, i) => `<button class="${o.cls} cm-opt" data-k="${o.k}"
        style="margin-top:${i ? 8 : 0}px">${o.label}${o.k === last ? '　· 上次用这个' : ''}</button>`).join('')}
      <label class="pickrow" style="margin-top:16px;border-bottom:none">
        <input type="checkbox" id="cmNoAsk">
        <span class="pickrow__k" style="font-size:12.5px;color:var(--ink-3)">以后不再问我，直接用「续接到末尾」</span>
      </label>
    `, (r) => {
      const ensure = () => c || Store.chapter.add({ title: '第1章' });

      const doCommit = (kind) => {
        const ch = ensure();
        const d = Store.chapter.currentDraft(ch);
        if (kind === 'append') {
          const next = (d && d.text.trim()) ? d.text.replace(/\s+$/, '') + '\n\n' + m.text.trim() : m.text.trim();
          if (d) Store.chapter.setDraftText(ch.id, next); else Store.chapter.newDraft(ch.id, next, 'AI');
        } else if (kind === 'new') {
          Store.chapter.newDraft(ch.id, m.text.trim(), 'AI');
        } else {
          Store.chapter.setDraftText(ch.id, m.text.trim());
        }
        Store.config.set({ lastCommit: kind });
        Store.chat.markClipped(m.id);
        Store.chat.attach(m.id, ch.id);   // 落盘后才算真属于这一章

        // 顺带把「已经在库里的角色」的新原句补成佐证，设定会自己长厚
        const known = Store.setting.all();
        const q = AI.quotesFor(m.text, known.map((s) => s.name));
        let added = 0;
        Object.keys(q).forEach((name) => {
          const s = known.find((x) => x.name === name);
          if (s) { Store.setting.addQuotes(s.id, q[name]); added++; }
        });

        App.closeSheet(); renderFlow();
        if (ReadView) ReadView.refresh();

        if (r.querySelector('#cmNoAsk') && r.querySelector('#cmNoAsk').checked) {
          Store.config.set({ commitMode: 'auto' });
          App.toast('已设置：以后直接续接到末尾');
        } else {
          App.toast(`已写进 ${ch.title}${added ? ` · 顺带补了 ${added} 条设定佐证` : ''}`, 2400);
        }

        // 顺手认一下新名字 —— 只做建议，不自动入库
        const names = AI.findNewNames(m.text);
        if (names.length) setTimeout(() => openNameSuggest(names), 420);
      };

      r.querySelectorAll('.cm-opt').forEach((b) => b.onclick = () => doCommit(b.dataset.k));
    });
  }

  /* ── 自动续接：开关打开时，生成完直接落到本章末尾 ── */
  function autoAppend(m) {
    let ch = target();
    if (!ch) ch = Store.chapter.add({ title: '第1章' });
    const d = Store.chapter.currentDraft(ch);
    const next = (d && d.text.trim()) ? d.text.replace(/\s+$/, '') + '\n\n' + m.text.trim() : m.text.trim();
    if (d) Store.chapter.setDraftText(ch.id, next); else Store.chapter.newDraft(ch.id, next, 'AI');
    Store.chat.markClipped(m.id);
    Store.chat.attach(m.id, ch.id);
    if (ReadView) ReadView.refresh();
    App.toast('已自动写进 ' + ch.title + '（可在设置里关掉）', 2400);
    const names = AI.findNewNames(m.text);
    if (names.length) setTimeout(() => openNameSuggest(names), 900);
  }

  /* ── 新名字入库：连原句一起收进去，设定才有肉 ── */
  function openNameSuggest(names) {
    App.sheet('发现新名字', `
      <div class="field__hint" style="margin-bottom:12px">
        这些名字在刚才那段里反复出现。<br>
        入库时会<b>把它们出现过的原句一并存成「正文佐证」</b>——以后要把设定写厚，就从这些句子里长。
      </div>
      ${names.map((n, i) => `
        <div class="nameblock">
          <div class="namerow">
            <input type="checkbox" data-nm="${i}" checked style="width:17px;height:17px;accent-color:var(--gold)">
            <span class="namerow__k">${esc(n.name)}</span>
            <span class="namerow__n">${n.n} 处</span>
            <select class="select" data-nk="${i}">
              <option>人物</option><option>地点</option><option>物件</option><option>规则</option><option>设定</option>
            </select>
          </div>
          ${(n.quotes && n.quotes.length)
        ? `<div class="namequote">${n.quotes.map((q) => '· ' + esc(q)).join('<br>')}</div>`
        : ''}
        </div>`).join('')}
      <label class="pickrow" style="border-bottom:none;margin-top:10px">
        <input type="checkbox" id="nmEnrich" checked>
        <span class="pickrow__k" style="font-size:13px">入库后让 AI 把说明也补全</span>
      </label>
      <button class="btn" id="nmSave" style="margin-top:14px">存进设定</button>
      <button class="btn btn--ghost" id="nmSkip" style="margin-top:8px">先不用（以后别再问这些名字）</button>
    `, (r) => {
      r.querySelector('#nmSkip').onclick = () => {
        names.forEach((x) => Store.setting.ignoreName(x.name));
        App.closeSheet();
        if (WorldView) WorldView.render();
        App.toast('已加入忽略名单，以后不再问', 2400);
      };
      r.querySelector('#nmSave').onclick = () => {
        const wantEnrich = r.querySelector('#nmEnrich') && r.querySelector('#nmEnrich').checked;
        const ids = [];
        names.forEach((x, i) => {
          const cb = r.querySelector(`[data-nm="${i}"]`);
          if (!cb || !cb.checked) return;
          const kind = r.querySelector(`[data-nk="${i}"]`).value;
          const s = Store.setting.add({ kind, name: x.name, desc: '', quotes: x.quotes || [] });
          ids.push(s.id);
        });
        App.closeSheet();
        if (WorldView) WorldView.render();
        if (!ids.length) return App.toast('没有新增');
        App.toast(`已存进设定 ${ids.length} 条${wantEnrich ? '，正在补全说明…' : ''}`, 2600);
        if (wantEnrich && typeof WorldView !== 'undefined' && WorldView) {
          (async () => {
            for (const id of ids) await WorldView.enrich(id, { silent: true });
            WorldView.render();
            App.toast(`说明已补全 ${ids.length} 条`, 2400);
          })();
        }
      };
    });
  }

  /* ── 发送 ── */
  async function send(askOverride, modeOverride) {
    if (busy) return;
    const ask = (askOverride !== undefined ? askOverride : el.input.value).trim();
    if (!ask && !pendingExtra && !replyTo) return;
    if (!AI_built()) return App.toast('先配置模型（右上 ⚙）');

    const mode = modeOverride || (replyTo ? 'from'
      : (pendingExtra ? (pendingExtra.action === 'rewrite' ? 'rewrite' : 'continue') : 'chat'));
    const extra = pendingExtra ? pendingExtra.text : '';
    const baseText = replyTo ? replyTo.text : '';

    busy = true;
    setSendState('stop');
    if (askOverride === undefined) el.input.value = '';
    autoGrow();

    const msgChapId = target() ? target().id : null;
    Store.chat.push('me', ask + (extra ? `\n〔带入选中 ${extra.length} 字〕` : ''), { chapterId: msgChapId });
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
        ask, chapterId: target() ? target().id : null, mode, extra, baseText,
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
        const msg = Store.chat.push('ai', text, { chapterId: target() ? target().id : null });
        // 开了自动续接就直接落盘，不再弹层
        if ((Store.get().config.commitMode || 'ask') === 'auto') autoAppend(msg);
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
        const p = AI.buildPromptOnly({ ask, chapterId: target() ? target().id : null, mode, extra, baseText });
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
      find: root.querySelector('#chatFind'),
      search: root.querySelector('#chatSearch'),
      chips: root.querySelector('#chatChips'),
      jump: root.querySelector('#btnJumpDown'),
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
    root.querySelector('#btnFind').onclick = () => toggleFind();
    if (el.search) {
      let t = null;
      el.search.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => { findQ = el.search.value.trim(); renderFlow(); }, 180);
      });
    }
    root.querySelector('#btnNewChat').onclick = () => {
      const t = target();
      const n = t ? Store.chat.all().filter((m) => m.chapterId === t.id).length : 0;
      if (!n) return App.toast('本章还没有对话');
      if (!confirm(`清空《${t.title}》的对话？（已写进章节的内容不受影响）`)) return;
      Store.chat.clearChapter(t.id);
      renderFlow(); renderChips();
      App.toast('已清空本章对话');
    };

    // 不在底部时给「跳到最新」
    el.flow.addEventListener('scroll', () => {
      const near = el.flow.scrollHeight - el.flow.scrollTop - el.flow.clientHeight < 90;
      if (el.jump) el.jump.hidden = near;
    }, { passive: true });
    if (el.jump) el.jump.onclick = () => scrollEnd();

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
    syncFind();
  }

  function refreshAll() {
    // 换了写作目标 → 旧基线作废（否则会把上一章的内容当基线写进这一章）
    const t = target();
    const tid = t ? t.id : null;
    if (tid !== lastTargetId) {
      if (replyTo) replyTo = null;
      lastTargetId = tid;
    }
    lastRendered = -1;   // 换目标了，重新判断要不要滚到底
    renderTarget(); hint(); renderFlow();
    if (ReadView) ReadView.refresh();
  }

  return {
    init, refreshAll, renderFlow, renderTarget, hint, captureSelection, send,
    toggleFind, openContext, openSegments, setReplyTo, setBaseText, clearReplyTo,
  };
})();
