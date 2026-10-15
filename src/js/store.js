/* ════════════════════════════════════════════
   临文录 · 数据层
   单一真源 = 内存里的 state；持久化 = localStorage + 导出 JSON
   原则：坏数据只降级不崩；任何写入都发变更事件
   ════════════════════════════════════════════ */

const Store = (() => {
  const KEY = 'linwenlu.db.v1';
  const SCHEMA = 1;

  const listeners = new Set();
  let state = null;
  let persistFailed = false;

  /* ── 工具 ── */
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const str = (v, d = '') => (typeof v === 'string' ? v : d);
  const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
  const arr = (v) => (Array.isArray(v) ? v : []);

  function blank() {
    return {
      schema: SCHEMA,
      book: { title: '未命名作品', genre: '', desc: '' },
      chapters: [],
      settings: [],
      lines: [],
      chat: [],
      config: {
        apiBase: 'https://api.deepseek.com/v1',
        apiKey: '',
        model: 'deepseek-chat',
        temperature: 0.9,
        style: '冷峻、白描、少形容词；对话不解释情绪；每段一到三句。',
        ctxSettings: 12,
        ctxPrev: 1,
        ctxTail: 1200,
        commitMode: 'ask',      // ask（每次问）| auto（自动续接）
        lastCommit: 'append',   // 上次选的写入方式，下次排在第一位
      },
    };
  }

  /* ── 规格化：任何来源的数据都要能安全落地 ── */
  function normalize(raw) {
    const base = blank();
    if (!raw || typeof raw !== 'object') return base;

    const out = base;
    if (raw.book && typeof raw.book === 'object') {
      out.book.title = str(raw.book.title, base.book.title) || base.book.title;
      out.book.genre = str(raw.book.genre);
      out.book.desc = str(raw.book.desc);
    }
    Object.assign(out.config, raw.config && typeof raw.config === 'object' ? raw.config : {});

    out.chapters = arr(raw.chapters).map((c, i) => {
      const drafts = arr(c && c.drafts)
        .map((d) => ({
          id: str(d && d.id) || uid(),
          ver: num(d && d.ver, 1),
          text: str(d && d.text),
          source: str(d && d.source, '手写'),
          at: num(d && d.at, Date.now()),
        }))
        .filter((d) => d.text.trim() !== '');
      drafts.sort((a, b) => a.ver - b.ver);
      const activeId = drafts.some((d) => d.id === (c && c.activeId))
        ? c.activeId
        : (drafts.length ? drafts[drafts.length - 1].id : null);
      return {
        id: str(c && c.id) || uid(),
        no: num(c && c.no, i + 1),
        title: str(c && c.title) || `第${num(c && c.no, i + 1)}章`,
        drafts,
        activeId,
        at: num(c && c.at, Date.now()),
      };
    });
    out.chapters.sort((a, b) => a.no - b.no);

    out.settings = arr(raw.settings).map((s) => ({
      id: str(s && s.id) || uid(),
      kind: str(s && s.kind, '设定'),
      name: str(s && s.name, '未命名'),
      desc: str(s && s.desc),
      at: num(s && s.at, Date.now()),
    }));

    out.lines = arr(raw.lines).map((l) => ({
      id: str(l && l.id) || uid(),
      name: str(l && l.name, '未命名'),
      desc: str(l && l.desc),
      at: str(l && l.at, ''),
      status: str(l && l.status, '进行中'),
      at2: num(l && l.at2, Date.now()),
    }));

    out.chat = arr(raw.chat)
      .map((m) => ({
        id: str(m && m.id) || uid(),
        role: m && m.role === 'me' ? 'me' : (m && m.role === 'note' ? 'note' : 'ai'),
        text: str(m && m.text),
        at: num(m && m.at, Date.now()),
        chapterId: m && m.chapterId ? str(m.chapterId) : null,
        clipped: !!(m && m.clipped),
      }))
      .filter((m) => m.text !== '');

    return out;
  }

  /* ── 持久化 ── */
  function load() {
    let raw = null;
    try {
      const s = localStorage.getItem(KEY);
      if (s) raw = JSON.parse(s);
    } catch (e) {
      console.warn('[临文录] 读档失败，用空档启动', e);
    }
    state = normalize(raw);
    return state;
  }

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(KEY, JSON.stringify(state));
        persistFailed = false;
      } catch (e) {
        if (!persistFailed) {
          persistFailed = true;
          emit('persist-failed', { error: String(e && e.message || e) });
        }
      }
    }, 160);
  }

  function emit(type, detail) {
    listeners.forEach((fn) => {
      try { fn(type, detail); } catch (e) { console.error(e); }
    });
  }

  function touch(type, detail) { save(); emit(type, detail); }
  function on(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  /* ── 查询 ── */
  const get = () => state;

  const chapter = {
    all: () => state.chapters,
    by(id) { return state.chapters.find((c) => c.id === id) || null; },
    byNo(no) { return state.chapters.find((c) => c.no === no) || null; },
    active() { return chapter.by(state.__activeChapter) || state.chapters[state.chapters.length - 1] || null; },
    currentDraft(c) {
      if (!c) return null;
      return c.drafts.find((d) => d.id === c.activeId) || c.drafts[c.drafts.length - 1] || null;
    },
    textOf(c) {
      const d = chapter.currentDraft(c);
      return d ? d.text : '';
    },
    add({ title, text = '', source = '手写' } = {}) {
      const no = state.chapters.reduce((m, c) => Math.max(m, c.no), 0) + 1;
      const c = {
        id: uid(), no,
        title: title || `第${no}章`,
        drafts: [],
        activeId: null,
        at: Date.now(),
      };
      if (text.trim()) {
        const d = { id: uid(), ver: 1, text, source, at: Date.now() };
        c.drafts.push(d);
        c.activeId = d.id;
      }
      state.chapters.push(c);
      state.chapters.sort((a, b) => a.no - b.no);
      touch('chapter-add', c);
      return c;
    },
    update(id, patch) {
      const c = chapter.by(id);
      if (!c) return null;
      Object.assign(c, patch);
      touch('chapter-update', c);
      return c;
    },
    remove(id) {
      const i = state.chapters.findIndex((c) => c.id === id);
      if (i < 0) return false;
      state.chapters.splice(i, 1);
      if (state.__activeChapter === id) state.__activeChapter = null;
      touch('chapter-remove', { id });
      return true;
    },
    /** 追加一个新版本（平行稿），并把它设为当前 */
    newDraft(id, text, source = 'AI') {
      const c = chapter.by(id);
      if (!c || !text.trim()) return null;
      const ver = c.drafts.reduce((m, d) => Math.max(m, d.ver), 0) + 1;
      const d = { id: uid(), ver, text, source, at: Date.now() };
      c.drafts.push(d);
      c.activeId = d.id;
      touch('draft-add', { chapter: c, draft: d });
      return d;
    },
    /** 覆盖当前版本 */
    setDraftText(id, text) {
      const c = chapter.by(id);
      if (!c) return null;
      const d = chapter.currentDraft(c);
      if (!d) return chapter.newDraft(id, text);
      d.text = text;
      d.at = Date.now();
      touch('draft-update', { chapter: c, draft: d });
      return d;
    },
    useDraft(id, draftId) {
      const c = chapter.by(id);
      if (!c) return null;
      if (!c.drafts.some((d) => d.id === draftId)) return null;
      c.activeId = draftId;
      touch('draft-switch', { chapter: c });
      return c;
    },
    dropDraft(id, draftId) {
      const c = chapter.by(id);
      if (!c || c.drafts.length <= 1) return false;
      const i = c.drafts.findIndex((d) => d.id === draftId);
      if (i < 0) return false;
      c.drafts.splice(i, 1);
      if (c.activeId === draftId) c.activeId = c.drafts[c.drafts.length - 1].id;
      touch('draft-drop', { chapter: c });
      return true;
    },
    setActive(id) {
      state.__activeChapter = id || null;
      if (id) state.__lastOpened = { id, at: Date.now() };
      save();
    },
  };

  const setting = {
    all: () => state.settings,
    add({ kind = '设定', name = '', desc = '' } = {}) {
      const s = { id: uid(), kind, name, desc, at: Date.now() };
      state.settings.unshift(s);
      touch('setting-add', s);
      return s;
    },
    update(id, patch) {
      const s = state.settings.find((x) => x.id === id);
      if (!s) return null;
      Object.assign(s, patch);
      touch('setting-update', s);
      return s;
    },
    remove(id) {
      const i = state.settings.findIndex((x) => x.id === id);
      if (i < 0) return false;
      state.settings.splice(i, 1);
      touch('setting-remove', { id });
      return true;
    },
  };

  const line = {
    all: () => state.lines,
    add({ name = '', desc = '', at = '', status = '进行中' } = {}) {
      const l = { id: uid(), name, desc, at, status, at2: Date.now() };
      state.lines.unshift(l);
      touch('line-add', l);
      return l;
    },
    update(id, patch) {
      const l = state.lines.find((x) => x.id === id);
      if (!l) return null;
      Object.assign(l, patch);
      touch('line-update', l);
      return l;
    },
    remove(id) {
      const i = state.lines.findIndex((x) => x.id === id);
      if (i < 0) return false;
      state.lines.splice(i, 1);
      touch('line-remove', { id });
      return true;
    },
    toggle(id) {
      const l = state.lines.find((x) => x.id === id);
      if (!l) return null;
      l.status = l.status === '已收束' ? '进行中' : '已收束';
      touch('line-update', l);
      return l;
    },
  };

  const chat = {
    all: () => state.chat,
    push(role, text, extra = {}) {
      const m = { id: uid(), role, text, at: Date.now(), chapterId: null, clipped: false, ...extra };
      state.chat.push(m);
      if (state.chat.length > 400) state.chat.splice(0, state.chat.length - 400);
      touch('chat-push', m);
      return m;
    },
    markClipped(id) {
      const m = state.chat.find((x) => x.id === id);
      if (!m) return null;
      m.clipped = true;
      touch('chat-update', m);
      return m;
    },
    clear() { state.chat = []; touch('chat-clear'); },
  };

  const config = {
    all: () => state.config,
    set(patch) { Object.assign(state.config, patch); touch('config'); },
    ready() { return !!(state.config.apiKey && state.config.apiBase && state.config.model); },
  };

  /* ── 整档导入导出 ── */
  function exportJSON() { return JSON.stringify(state, null, 2); }

  /** 只读解析：给导入预览用，不改动现有数据 */
  function parseArchive(text) {
    let raw;
    try { raw = JSON.parse(text); }
    catch (e) { return { ok: false, reason: 'JSON 解析失败：' + (e.message || e) }; }
    try {
      const inc = normalize(raw);
      return {
        ok: true,
        incoming: inc,
        counts: {
          chapters: inc.chapters.length,
          settings: inc.settings.length,
          lines: inc.lines.length,
          chat: inc.chat.length,
        },
        title: inc.book.title,
      };
    } catch (e) {
      return { ok: false, reason: '数据规格化失败：' + (e.message || e) };
    }
  }

  /**
   * 导入存档。
   * @param {string} text 存档 JSON
   * @param {{parts?:string[], mode?:'merge'|'replace'}} opts
   *   parts 默认全选；mode=merge 追加（同名条目跳过），replace 用存档里的替换掉选中的部分
   */
  function importJSON(text, opts = {}) {
    const parsed = parseArchive(text);
    if (!parsed.ok) return parsed;
    const inc = parsed.incoming;
    const parts = Array.isArray(opts.parts) ? opts.parts : ['chapters', 'settings', 'lines', 'chat'];
    const replace = opts.mode === 'replace';
    const report = { chapters: 0, settings: 0, lines: 0, chat: 0, skipped: 0 };

    if (parts.includes('chapters')) {
      if (replace) {
        state.chapters = inc.chapters;
        report.chapters = inc.chapters.length;
      } else {
        let nextNo = state.chapters.reduce((m, c) => Math.max(m, c.no), 0);
        inc.chapters.forEach((c) => {
          nextNo += 1;
          state.chapters.push({ ...c, id: uid(), no: nextNo });
          report.chapters += 1;
        });
      }
      state.chapters.sort((a, b) => a.no - b.no);
    }

    if (parts.includes('settings')) {
      if (replace) {
        state.settings = inc.settings;
        report.settings = inc.settings.length;
      } else {
        const seen = new Set(state.settings.map((s) => s.kind + '\u0000' + s.name));
        inc.settings.forEach((s) => {
          const k = s.kind + '\u0000' + s.name;
          if (seen.has(k)) { report.skipped += 1; return; }
          seen.add(k);
          state.settings.unshift({ ...s, id: uid() });
          report.settings += 1;
        });
      }
    }

    if (parts.includes('lines')) {
      if (replace) {
        state.lines = inc.lines;
        report.lines = inc.lines.length;
      } else {
        const seen = new Set(state.lines.map((l) => l.name));
        inc.lines.forEach((l) => {
          if (seen.has(l.name)) { report.skipped += 1; return; }
          seen.add(l.name);
          state.lines.unshift({ ...l, id: uid() });
          report.lines += 1;
        });
      }
    }

    if (parts.includes('chat')) {
      if (replace) {
        state.chat = inc.chat;
        report.chat = inc.chat.length;
      } else {
        const seen = new Set(state.chat.map((m) => m.role + '\u0000' + m.text.slice(0, 80)));
        inc.chat.forEach((m) => {
          const k = m.role + '\u0000' + m.text.slice(0, 80);
          if (seen.has(k)) { report.skipped += 1; return; }
          seen.add(k);
          state.chat.push({ ...m, id: uid() });
          report.chat += 1;
        });
      }
    }

    touch('import');
    return { ok: true, report };
  }

  function reset() { state = blank(); touch('reset'); }
  function isPersistFailed() { return persistFailed; }

  return {
    load, save, on, get, uid,
    chapter, setting, line, chat, config,
    exportJSON, parseArchive, importJSON, reset, isPersistFailed,
    get activeChapterId() { return state && state.__activeChapter || null; },
    get lastOpened() { return (state && state.__lastOpened) || null; },
  };
})();
