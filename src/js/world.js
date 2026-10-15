/* ════════════════════════════════════════════
   临文录 · 模块三：世界线与设定
   世界线 = 剧情脉络（可收束）；设定 = 人/地/物/规则
   ════════════════════════════════════════════ */

const WorldView = (() => {
  let el = {};
  let seg = 'line';
  let filter = '';

  const esc = (s) => String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function render() {
    el.seg.querySelectorAll('.seg__btn').forEach((b) => b.classList.toggle('is-on', b.dataset.seg === seg));
    el.body.innerHTML = seg === 'line' ? lineHTML() : settingHTML();
    bind();
  }

  /* ── 世界线 ── */
  function lineHTML() {
    let list = Store.line.all();
    if (filter) list = list.filter((l) => (l.name + l.desc + l.at).includes(filter));
    if (!list.length) {
      return `<div class="blank">
        <div class="blank__icon">◇</div>
        <div class="blank__title">还没有世界线</div>
        <div class="blank__desc">
          把主线、支线、待收的伏笔写在这儿。<br>
          它们会自动进入每次生成的上下文，<br>
          让 AI 不会写着写着就跑偏。
        </div>
        <div class="blank__acts">
          <button class="btn" data-add>添加第一条</button>
        </div>
      </div>`;
    }
    return list.map((l) => `
      <div class="line-item ${l.status === '已收束' ? 'is-closed' : ''}" data-line="${l.id}">
        <div class="line-item__hd">
          <span class="line-item__name">${esc(l.name)}</span>
          ${l.at ? `<span class="line-item__at">${esc(l.at)}</span>` : ''}
          <span class="card__acts">
            <button class="mini-btn" data-ltog="${l.id}">${l.status === '已收束' ? '重启' : '收束'}</button>
            <button class="mini-btn" data-ledit="${l.id}">改</button>
          </span>
        </div>
        ${l.desc ? `<div class="line-item__desc">${esc(l.desc)}</div>` : ''}
      </div>`).join('');
  }

  /* ── 设定 ── */
  function settingHTML() {
    let list = Store.setting.all();
    if (filter) list = list.filter((s) => (s.name + s.desc + s.kind).includes(filter));
    if (!list.length) {
      return `<div class="blank">
        <div class="blank__icon">◆</div>
        <div class="blank__title">还没有设定</div>
        <div class="blank__desc">
          人物、地点、物件、规则都放这儿。<br>
          写作时按相关性自动挑几条带进去，<br>
          不用每次都重复交代。
        </div>
        <div class="blank__acts">
          <button class="btn" data-add>添加第一条</button>
        </div>
      </div>`;
    }
    const byKind = {};
    list.forEach((s) => { (byKind[s.kind] = byKind[s.kind] || []).push(s); });
    return Object.keys(byKind).map((k) => `
      <div class="sec-title">${esc(k)} · ${byKind[k].length}</div>
      ${byKind[k].map((s) => `
        <div class="card" data-set="${s.id}">
          <div class="card__top">
            <span class="card__name">${esc(s.name)}</span>
            <span class="card__kind" data-k="${esc(s.kind)}">${esc(s.kind)}</span>
          </div>
          ${s.desc ? `<div class="card__desc">${esc(s.desc)}</div>` : ''}
          <div class="card__meta">
            <span>${new Date(s.at).toLocaleDateString('zh-CN')}</span>
            <span class="card__acts">
              <button class="mini-btn" data-sedit="${s.id}">改</button>
            </span>
          </div>
        </div>`).join('')}
    `).join('');
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
      </div>
      <div class="field">
        <label class="field__label">说明</label>
        <textarea class="textarea" id="stDesc" placeholder="越具体越好：外貌、脾气、口癖、限制条件">${esc(s ? s.desc : '')}</textarea>
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

  function bind() {
    el.body.querySelectorAll('[data-add]').forEach((b) => b.onclick = () => {
      seg === 'line' ? editLine(null) : editSetting(null);
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
    el.body.querySelectorAll('[data-line]').forEach((n) => n.onclick = () => editLine(n.dataset.line));
    el.body.querySelectorAll('[data-set]').forEach((n) => n.onclick = () => editSetting(n.dataset.set));
  }

  function init(root) {
    el = { seg: root.querySelector('#worldSeg'), body: root.querySelector('#worldBody') };
    el.seg.addEventListener('click', (e) => {
      const b = e.target.closest('[data-seg]');
      if (!b) return;
      seg = b.dataset.seg; render();
    });
    root.querySelector('#btnAddWorld').onclick = () => (seg === 'line' ? editLine(null) : editSetting(null));
    render();
  }

  return { init, render };
})();
