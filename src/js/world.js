/* ════════════════════════════════════════════
   临文录 · 模块三：世界线与设定
   世界线 = 剧情脉络（可收束）；设定 = 人/地/物/规则
   条目一多就要能搜、能折、能批量收拾
   ════════════════════════════════════════════ */

const WorldView = (() => {
  let el = {};
  let seg = 'line';
  let filter = '';
  let pickMode = false;
  const picked = new Set();
  const folded = new Set();

  const esc = (s) => String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const match = (o) => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return (o.name + ' ' + o.desc + ' ' + (o.kind || '') + ' ' + (o.at || '')).toLowerCase().includes(q);
  };

  function render() {
    el.seg.querySelectorAll('.seg__btn').forEach((b) => b.classList.toggle('is-on', b.dataset.seg === seg));
    el.body.innerHTML = seg === 'line' ? lineHTML() : settingHTML();
    el.pickbar.hidden = !pickMode;
    if (el.pickBtn) el.pickBtn.classList.toggle('is-on', pickMode);
    updatePickCount();
    bind();
  }

  function updatePickCount() {
    if (el.pickCount) el.pickCount.textContent = `已选 ${picked.size}`;
  }

  /* ── 世界线 ── */
  function lineHTML() {
    const list = Store.line.all().filter(match);
    if (!Store.line.all().length) {
      return `<div class="blank">
        <div class="blank__icon">◇</div>
        <div class="blank__title">还没有世界线</div>
        <div class="blank__desc">
          把主线、支线、待收的伏笔写在这儿。<br>
          它们会自动进入每次生成的上下文，<br>
          让 AI 不会写着写着就跑偏。
        </div>
        <div class="blank__acts"><button class="btn" data-add>添加第一条</button></div>
      </div>`;
    }
    if (!list.length) return noMatchHTML();
    return list.map((l) => {
      const on = picked.has(l.id);
      return `<div class="line-item ${l.status === '已收束' ? 'is-closed' : ''} ${on ? 'is-picked' : ''}" data-line="${l.id}">
        <div class="line-item__hd">
          <span class="line-item__name">${esc(l.name)}</span>
          ${l.at ? `<span class="line-item__at">${esc(l.at)}</span>` : ''}
          ${pickMode ? '<span class="pickbox" style="position:static;margin-left:auto"></span>' : `
          <span class="card__acts">
            <button class="mini-btn" data-ltog="${l.id}">${l.status === '已收束' ? '重启' : '收束'}</button>
            <button class="mini-btn" data-ledit="${l.id}">改</button>
          </span>`}
        </div>
        ${l.desc ? `<div class="line-item__desc">${esc(l.desc)}</div>` : ''}
      </div>`;
    }).join('');
  }

  /* ── 设定 ── */
  function cardHTML(s, isFolded) {
    const on = picked.has(s.id);
    return `<div class="card ${on ? 'is-picked' : ''} ${isFolded ? 'is-hidden' : ''}" data-set="${s.id}">
      ${pickMode ? '<span class="pickbox"></span>' : ''}
      <div class="card__top">
        <span class="card__name">${esc(s.name)}</span>
        <span class="card__kind" data-k="${esc(s.kind)}">${esc(s.kind)}</span>
      </div>
      ${s.desc ? `<div class="card__desc">${esc(s.desc)}</div>` : ''}
      <div class="card__meta">
        <span>${new Date(s.at).toLocaleDateString('zh-CN')}</span>
        ${pickMode ? '' : `<span class="card__acts"><button class="mini-btn" data-sedit="${s.id}">改</button></span>`}
      </div>
    </div>`;
  }

  function settingHTML() {
    const all = Store.setting.all();
    if (!all.length) {
      return `<div class="blank">
        <div class="blank__icon">◆</div>
        <div class="blank__title">还没有设定</div>
        <div class="blank__desc">
          人物、地点、物件、规则都放这儿。<br>
          <b>人物会整表带进每次生成</b>，这样 AI 就会自己用上配角名字，<br>
          不用每次重新交代。
        </div>
        <div class="blank__acts"><button class="btn" data-add>添加第一条</button></div>
      </div>`;
    }
    const list = all.filter(match);
    if (!list.length) return noMatchHTML();

    const byKind = {};
    list.forEach((s) => { (byKind[s.kind] = byKind[s.kind] || []).push(s); });
    return Object.keys(byKind).map((k) => {
      const isFolded = folded.has(k);
      return `<div class="grouphead ${isFolded ? 'is-folded' : ''}" data-fold="${esc(k)}">
          <span class="grouphead__t">${esc(k)}</span>
          <span class="grouphead__n">${byKind[k].length}</span>
          <span class="grouphead__arrow">▼</span>
        </div>
        ${byKind[k].map((s) => cardHTML(s, isFolded)).join('')}`;
    }).join('');
  }

  function noMatchHTML() {
    return `<div class="blank" style="padding:40px 14px">
      <div class="blank__icon">⌕</div>
      <div class="blank__title">没有匹配「${esc(filter)}」的条目</div>
      <div class="blank__acts"><button class="btn btn--ghost" data-clearfilter>清除搜索</button></div>
    </div>`;
  }

  /* ── 静默把一条设定补完整 ──
     作者要的是"先立住人再写剧情"，所以这件事不该让他看见：
     没有按钮、没有弹窗、没有进度条，写完之后他自己去设定页看就行。 */
  async function fill(id) {
    const s = Store.setting.all().find((x) => x.id === id);
    if (!s) return null;
    if (s.desc && s.desc.trim()) return null;         // 已有内容不动
    if (!Store.config.ready()) return null;            // 没配模型就安静跳过
    try {
      let acc = '';
      const txt = await AI.generate({
        messages: AI.buildEnrichMessages(s),
        onDelta: (p) => { acc += p; },
      });
      const out = (txt || acc).trim();
      if (!out) return null;
      Store.setting.update(id, { desc: out, auto: true });
      return out;
    } catch (e) {
      console.warn('[设定] 自动补全失败（不影响写作）', e);
      return null;
    }
  }

  /** 后台把还没有说明的条目补上，一次最多几条，避免一次烧太多 */
  async function fillMissing(limit = 3) {
    if (!Store.config.ready()) return 0;
    const targets = Store.setting.all().filter((s) => !(s.desc || '').trim()).slice(0, limit);
    let n = 0;
    for (const s of targets) {
      if (await fill(s.id)) n++;
    }
    if (n) render();
    return n;
  }

  /* ── 编辑面板 ── */
  function editLine(id) {
    const l = id ? Store.line.all().find((x) => x.id === id) : null;
    App.sheet(l ? '编辑世界线' : '新增世界线', `
      <div class="field">
        <label class="field__label">名称</label>
        <input class="input" id="lnName" value="${esc(l ? l.name : '')}" placeholder="例如：寻找星门钥匙">
      </div>
      <div class="field">
        <label class="field__label">锚点（可留空）</label>
        <input class="input" id="lnAt" value="${esc(l ? l.at : '')}" placeholder="第12章 / 三日后 / 卷一末">
      </div>
      <div class="field">
        <label class="field__label">说明</label>
        <textarea class="textarea" id="lnDesc" placeholder="这条线要解决什么、现在卡在哪">${esc(l ? l.desc : '')}</textarea>
      </div>
      <button class="btn" id="lnSave">${l ? '保存' : '添加'}</button>
      ${l ? '<button class="btn btn--danger" id="lnDel" style="margin-top:8px">删除</button>' : ''}
    `, (r) => {
      r.querySelector('#lnSave').onclick = () => {
        const patch = {
          name: r.querySelector('#lnName').value.trim() || '未命名',
          at: r.querySelector('#lnAt').value.trim(),
          desc: r.querySelector('#lnDesc').value.trim(),
        };
        if (l) Store.line.update(l.id, patch); else Store.line.add(patch);
        App.closeSheet(); render(); App.toast(l ? '已保存' : '已添加');
      };
      if (l) r.querySelector('#lnDel').onclick = () => {
        if (!confirm('删除这条世界线？')) return;
        Store.line.remove(l.id); App.closeSheet(); render(); App.toast('已删除');
      };
    });
  }

  function editSetting(id) {
    const s = id ? Store.setting.all().find((x) => x.id === id) : null;
    App.sheet(s ? '编辑设定' : '新增设定', `
      <div class="field">
        <label class="field__label">名称</label>
        <input class="input" id="stName" value="${esc(s ? s.name : '')}" placeholder="人物名 / 地点名 / 规则名">
      </div>
      <div class="field">
        <label class="field__label">类别</label>
        <select class="select" id="stKind">
          ${['人物', '地点', '物件', '规则', '设定'].map((k) => `<option ${s && s.kind === k ? 'selected' : ''}>${k}</option>`).join('')}
        </select>
        <div class="field__hint">选「人物」的条目会整表进入每次生成，让 AI 自己把配角写出来。</div>
      </div>
      <div class="field">
        <label class="field__label">说明</label>
        <textarea class="textarea" id="stDesc" style="min-height:150px"
          placeholder="外貌、脾气、口癖、和主角的关系……">${esc(s ? s.desc : '')}</textarea>
        <div class="field__hint">新条目入库时会自动写好；这里随时可以自己改。</div>
      </div>
      <button class="btn" id="stSave">${s ? '保存' : '添加'}</button>
      ${s ? '<button class="btn btn--danger" id="stDel" style="margin-top:8px">删除</button>' : ''}
    `, (r) => {
      r.querySelector('#stSave').onclick = () => {
        const patch = {
          name: r.querySelector('#stName').value.trim() || '未命名',
          kind: r.querySelector('#stKind').value,
          desc: r.querySelector('#stDesc').value.trim(),
        };
        if (s) Store.setting.update(s.id, patch); else Store.setting.add(patch);
        App.closeSheet(); render(); App.toast(s ? '已保存' : '已添加');
      };
      if (s) r.querySelector('#stDel').onclick = () => {
        if (!confirm('删除这条设定？')) return;
        Store.setting.remove(s.id); App.closeSheet(); render(); App.toast('已删除');
      };
    });
  }

  /* ── 多选 ── */
  function setPick(on) {
    pickMode = !!on;
    if (!pickMode) picked.clear();
    render();
    if (pickMode) App.toast('点条目选中，底部可批量删');
  }

  function currentList() {
    return seg === 'line' ? Store.line.all().filter(match) : Store.setting.all().filter(match);
  }

  function bind() {
    el.body.querySelectorAll('[data-add]').forEach((b) => b.onclick = () =>
      (seg === 'line' ? editLine(null) : editSetting(null)));
    el.body.querySelectorAll('[data-clearfilter]').forEach((b) => b.onclick = () => {
      filter = ''; if (el.search) el.search.value = ''; render();
    });
    el.body.querySelectorAll('[data-fold]').forEach((g) => g.onclick = () => {
      const k = g.dataset.fold;
      folded.has(k) ? folded.delete(k) : folded.add(k);
      render();
    });

    el.body.querySelectorAll('[data-ltog]').forEach((b) => b.onclick = (e) => {
      e.stopPropagation(); Store.line.toggle(b.dataset.ltog); render();
    });
    el.body.querySelectorAll('[data-ledit]').forEach((b) => b.onclick = (e) => {
      e.stopPropagation(); editLine(b.dataset.ledit);
    });
    el.body.querySelectorAll('[data-sedit]').forEach((b) => b.onclick = (e) => {
      e.stopPropagation(); editSetting(b.dataset.sedit);
    });

    el.body.querySelectorAll('[data-line]').forEach((n) => n.onclick = () => {
      const id = n.dataset.line;
      if (pickMode) { picked.has(id) ? picked.delete(id) : picked.add(id); render(); return; }
      editLine(id);
    });
    el.body.querySelectorAll('[data-set]').forEach((n) => n.onclick = () => {
      const id = n.dataset.set;
      if (pickMode) { picked.has(id) ? picked.delete(id) : picked.add(id); render(); return; }
      editSetting(id);
    });
  }

  function init(root) {
    el = {
      seg: root.querySelector('#worldSeg'),
      body: root.querySelector('#worldBody'),
      search: root.querySelector('#worldSearch'),
      pickbar: root.querySelector('#worldPickbar'),
      pickCount: root.querySelector('#pickCount'),
      pickBtn: root.querySelector('#btnWorldPick'),
    };

    el.seg.addEventListener('click', (e) => {
      const b = e.target.closest('[data-seg]');
      if (!b) return;
      seg = b.dataset.seg;
      picked.clear();
      render();
    });

    let t = null;
    el.search.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => { filter = el.search.value.trim(); render(); }, 160);
    });

    el.pickBtn.onclick = () => setPick(!pickMode);
    root.querySelector('#pickAll').onclick = () => {
      currentList().forEach((o) => picked.add(o.id)); render();
    };
    root.querySelector('#pickInvert').onclick = () => {
      currentList().forEach((o) => picked.has(o.id) ? picked.delete(o.id) : picked.add(o.id)); render();
    };
    root.querySelector('#pickDel').onclick = () => {
      if (!picked.size) return App.toast('还没选东西');
      if (!confirm(`删除选中的 ${picked.size} 条？不可撤销。`)) return;
      const n = picked.size;
      [...picked].forEach((id) => (seg === 'line' ? Store.line.remove(id) : Store.setting.remove(id)));
      picked.clear();
      render();
      App.toast(`已删除 ${n} 条`);
    };
    root.querySelector('#pickCancel').onclick = () => setPick(false);

    root.querySelector('#btnAddWorld').onclick = () => (seg === 'line' ? editLine(null) : editSetting(null));
    render();
  }

  return { init, render, setPick, fill, fillMissing, editSetting };
})();
