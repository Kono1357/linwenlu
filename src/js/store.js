/* ════════════════════════════════════════════
   临文录 · 数据层
   现在支持多本书：每本书各自独立的章节 / 设定 / 世界线 / 对话。
   配置（模型、主题等）是全局的，跨书共用。

   对外 API 与单书时期保持一致（chapter / setting / line / chat 操作的都是"当前这本书"），
   所以上层视图代码不需要改动。
   ════════════════════════════════════════════ */

const Store = (() => {
  const KEY = 'linwenlu.db.v1';
  const SCHEMA = 2;

  const listeners = new Set();
  let state = null;
  let persistFailed = false;

  /* ── 工具 ── */
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const str = (v, d = '') => (typeof v === 'string' ? v : d);
  const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
  const arr = (v) => (Array.isArray(v) ? v : []);

  function blankConfig() {
    return {
      apiBase: 'https://api.deepseek.com/v1',
      apiKey: '',
      model: 'deepseek-chat',
      temperature: 0.9,
      style: '冷峻、白描、少形容词；对话不解释情绪；每段一到三句。',
      ctxSettings: 12,
      ctxPrev: 1,
      ctxTail: 1200,
      commitMode: 'ask',      // ask（每次问）| auto（自动续接）
      lastCommit: 'append',
      targetWords: 800,
      theme: 'light',
      deai: true,          // 每次生成都注入「去 AI 味铁律」
      deaiRules: '',       // 作者自己追加的禁令（会拼在铁律后面）
      autoSetting: true,   // 写到新人物/地点时，后台自动收录并把说明写完整
    };
  }

  function blankBook(title) {
    return {
      id: uid(),
      title: title || '未命名作品',
      genre: '',
      desc: '',
      chapters: [],
      settings: [],
      lines: [],
      chat: [],
      ignored: [],          // 用户拒绝过的名字（每本书独立）
      createdAt: Date.now(),
      at: Date.now(),
    };
  }

  function blank() {
    const b = blankBook();
    return { schema: SCHEMA, books: [b], activeBookId: b.id, config: blankConfig() };
  }

  /* ── 规格化 ── */
  function normChapter(c, i) {
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
      drafts, activeId,
      at: num(c && c.at, Date.now()),
    };
  }

  function normSetting(s) {
    return {
      id: str(s && s.id) || uid(),
      kind: str(s && s.kind, '设定'),
      name: str(s && s.name, '未命名'),
      desc: str(s && s.desc),
      quotes: arr(s && s.quotes).map(String).filter(Boolean).slice(0, 6),
      at: num(s && s.at, Date.now()),
    };
  }

  function normLine(l) {
    return {
      id: str(l && l.id) || uid(),
      name: str(l && l.name, '未命名'),
      desc: str(l && l.desc),
      at: str(l && l.at, ''),
      status: str(l && l.status, '进行中'),
      at2: num(l && l.at2, Date.now()),
    };
  }

  function normMsg(m) {
    return {
      id: str(m && m.id) || uid(),
      role: m && m.role === 'me' ? 'me' : (m && m.role === 'note' ? 'note' : 'ai'),
      text: str(m && m.text),
      at: num(m && m.at, Date.now()),
      chapterId: m && m.chapterId ? str(m.chapterId) : null,
      clipped: !!(m && m.clipped),
    };
  }

  function normBook(b) {
    const out = blankBook(str(b && b.title, '未命名作品') || '未命名作品');
    out.id = str(b && b.id) || out.id;
    out.genre = str(b && b.genre);
    out.desc = str(b && b.desc);
    out.createdAt = num(b && (b.createdAt || b.at), Date.now());
    out.at = num(b && b.at, Date.now());
    out.chapters = arr(b && b.chapters).map(normChapter);
    out.chapters.sort((a, b2) => a.no - b2.no);
    out.settings = arr(b && b.settings).map(normSetting);
    out.lines = arr(b && b.lines).map(normLine);
    out.chat = arr(b && b.chat).map(normMsg).filter((m) => m.text !== '');
    out.ignored = arr(b && b.ignored).map(String).filter(Boolean).slice(0, 500);
    return out;
  }

  function normalize(raw) {
    const base = blank();
    if (!raw || typeof raw !== 'object') return base;

    const out = base;
    Object.assign(out.config, raw.config && typeof raw.config === 'object' ? raw.config : {});

    if (raw.schema >= 2 && arr(raw.books).length) {
      // 新结构
      out.books = arr(raw.books).map(normBook);
      const want = str(raw.activeBookId);
      out.activeBookId = out.books.some((b) => b.id === want) ? want : out.books[0].id;
    } else if (arr(raw.chapters).length || arr(raw.settings).length || arr(raw.lines).length || arr(raw.chat).length) {
      // 老的单书存档 → 包成第一本书
      const b = normBook({
        title: (raw.book && raw.book.title) || '未命名作品',
        genre: raw.book && raw.book.genre,
        desc: raw.book && raw.book.desc,
        chapters: raw.chapters, settings: raw.settings, lines: raw.lines,
        chat: raw.chat, ignored: raw.ignored,
      });
      out.books = [b];
      out.activeBookId = b.id;
      if (raw.__lastOpened && raw.__lastOpened.id) {
        b.__lastOpened = { id: str(raw.__lastOpened.id), at: num(raw.__lastOpened.at, Date.now()) };
      }
    } else {
      // 完全空的存档
      if (raw.book && typeof raw.book === 'object') {
        out.books[0].title = str(raw.book.title, '未命名作品') || '未命名作品';
        out.books[0].genre = str(raw.book.genre);
        out.books[0].desc = str(raw.book.desc);
      }
    }

    if (raw.__lastOpened && raw.__lastOpened.id && out.books[0] && !out.books[0].__lastOpened) {
      out.books[0].__lastOpened = { id: str(raw.__lastOpened.id), at: num(raw.__lastOpened.at, Date.now()) };
    }

    return out;
  }

  /* ── 当前书 ── */
  function book() {
    if (!state.books.length) {
      const b = blankBook();
      state.books.push(b);
      state.activeBookId = b.id;
    }
    let b = state.books.find((x) => x.id === state.activeBookId);
    if (!b) { b = state.books[0]; state.activeBookId = b.id; }
    return b;
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
  function touch(type, detail) { book().at = Date.now(); save(); emit(type, detail); }
  function on(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  /* ── 查询 ── */
  const get = () => state;

  /* ── 书 ── */
  const books = {
    all: () => state.books,
    current: book,
    currentId: () => book().id,
    create({ title, genre = '', desc = '' } = {}) {
      const n = state.books.length + 1;
      const b = blankBook(title || `第 ${n} 本`);
      b.genre = genre; b.desc = desc;
      state.books.push(b);
      state.activeBookId = b.id;
      touch('book-create', b);
      return b;
    },
    switchTo(id) {
      if (!state.books.some((b) => b.id === id)) return null;
      state.activeBookId = id;
      touch('book-switch', { id });
      return book();
    },
    update(id, patch) {
      const b = state.books.find((x) => x.id === id);
      if (!b) return null;
      Object.assign(b, patch);
      touch('book-update', b);
      return b;
    },
    remove(id) {
      if (state.books.length <= 1) return false;   // 至少留一本
      const i = state.books.findIndex((b) => b.id === id);
      if (i < 0) return false;
      state.books.splice(i, 1);
      if (state.activeBookId === id) state.activeBookId = state.books[0].id;
      touch('book-remove', { id });
      return true;
    },
    /** 从另一本书拷设定过来（新书要不要沿用旧设定，交给用户决定） */
    copySettingsFrom(fromId, kinds) {
      const src = state.books.find((b) => b.id === fromId);
      if (!src) return 0;
      const dst = book();
      const want = arr(kinds);
      let n = 0;
      src.settings.forEach((s) => {
        if (want.length && !want.includes(s.kind)) return;
        if (dst.settings.some((x) => x.name === s.name && x.kind === s.kind)) return;
        dst.settings.push({ ...s, id: uid(), at: Date.now() });
        n++;
      });
      touch('book-copy', { from: fromId, n });
      return n;
    },
  };

  /* ── 章节 ── */
  const chapter = {
    all: () => book().chapters,
    by(id) { return book().chapters.find((c) => c.id === id) || null; },
    byNo(no) { return book().chapters.find((c) => c.no === no) || null; },
    active() {
      const b = book();
      return chapter.by(b.__activeChapter) || b.chapters[b.chapters.length - 1] || null;
    },
    currentDraft(c) {
      if (!c) return null;
      return c.drafts.find((d) => d.id === c.activeId) || c.drafts[c.drafts.length - 1] || null;
    },
    textOf(c) {
      const d = chapter.currentDraft(c);
      return d ? d.text : '';
    },
    add({ title, text = '', source = '手写' } = {}) {
      const b = book();
      const no = b.chapters.reduce((m, c) => Math.max(m, c.no), 0) + 1;
      const c = { id: uid(), no, title: title || `第${no}章`, drafts: [], activeId: null, at: Date.now() };
      if (text.trim()) {
        const d = { id: uid(), ver: 1, text, source, at: Date.now() };
        c.drafts.push(d);
        c.activeId = d.id;
      }
      b.chapters.push(c);
      b.chapters.sort((x, y) => x.no - y.no);
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
      const b = book();
      const i = b.chapters.findIndex((c) => c.id === id);
      if (i < 0) return false;
      b.chapters.splice(i, 1);
      if (b.__activeChapter === id) b.__activeChapter = null;
      touch('chapter-remove', { id });
      return true;
    },
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
      const b = book();
      b.__activeChapter = id || null;
      if (id) b.__lastOpened = { id, at: Date.now() };
      save();
    },
  };

  /* ── 设定 ── */
  const setting = {
    all: () => book().settings,
    add({ kind = '设定', name = '', desc = '', quotes = [] } = {}) {
      const s = {
        id: uid(), kind, name, desc,
        quotes: arr(quotes).map(String).filter(Boolean).slice(0, 6),
        at: Date.now(),
      };
      book().settings.unshift(s);
      touch('setting-add', s);
      return s;
    },
    update(id, patch) {
      const s = book().settings.find((x) => x.id === id);
      if (!s) return null;
      Object.assign(s, patch);
      touch('setting-update', s);
      return s;
    },
    remove(id) {
      const b = book();
      const i = b.settings.findIndex((x) => x.id === id);
      if (i < 0) return false;
      b.settings.splice(i, 1);
      touch('setting-remove', { id });
      return true;
    },
    addQuotes(id, lines) {
      const s = book().settings.find((x) => x.id === id);
      if (!s) return null;
      const set = new Set(s.quotes || []);
      arr(lines).forEach((l) => { const t = String(l).trim(); if (t) set.add(t); });
      s.quotes = [...set].slice(-6);
      touch('setting-update', s);
      return s;
    },
    ignoreName(name) {
      const n = String(name || '').trim();
      if (!n) return false;
      const b = book();
      if (b.ignored.includes(n)) return false;
      b.ignored.push(n);
      touch('setting-ignore', { name: n });
      return true;
    },
    isIgnored(name) { return book().ignored.includes(String(name || '').trim()); },
    ignoredNames() { return book().ignored; },
    /** 清掉自动收录的条目（作者自己加的不动） */
    clearAuto() {
      const b = book();
      const before = b.settings.length;
      b.settings = b.settings.filter((s) => !s.auto);
      touch('setting-clear');
      return before - b.settings.length;
    },
    /** 全清 */
    clearAll() {
      const b = book();
      const n = b.settings.length;
      b.settings = [];
      touch('setting-clear');
      return n;
    },
    unignore(name) {
      const b = book();
      b.ignored = b.ignored.filter((x) => x !== name);
      touch('setting-ignore', { name });
    },
  };

  /* ── 世界线 ── */
  const line = {
    all: () => book().lines,
    add({ name = '', desc = '', at = '', status = '进行中' } = {}) {
      const l = { id: uid(), name, desc, at, status, at2: Date.now() };
      book().lines.unshift(l);
      touch('line-add', l);
      return l;
    },
    update(id, patch) {
      const l = book().lines.find((x) => x.id === id);
      if (!l) return null;
      Object.assign(l, patch);
      touch('line-update', l);
      return l;
    },
    remove(id) {
      const b = book();
      const i = b.lines.findIndex((x) => x.id === id);
      if (i < 0) return false;
      b.lines.splice(i, 1);
      touch('line-remove', { id });
      return true;
    },
    toggle(id) {
      const l = book().lines.find((x) => x.id === id);
      if (!l) return null;
      l.status = l.status === '已收束' ? '进行中' : '已收束';
      touch('line-update', l);
      return l;
    },
  };

  /* ── 对话 ── */
  const chat = {
    all: () => book().chat,
    push(role, text, extra = {}) {
      const b = book();
      const m = { id: uid(), role, text, at: Date.now(), chapterId: null, clipped: false, ...extra };
      b.chat.push(m);
      if (b.chat.length > 400) b.chat.splice(0, b.chat.length - 400);
      touch('chat-push', m);
      return m;
    },
    markClipped(id) {
      const m = book().chat.find((x) => x.id === id);
      if (!m) return null;
      m.clipped = true;
      touch('chat-update', m);
      return m;
    },
    attach(id, chapterId) {
      const m = book().chat.find((x) => x.id === id);
      if (!m || !chapterId) return null;
      m.chapterId = chapterId;
      touch('chat-update', m);
      return m;
    },
    clear() { book().chat = []; touch('chat-clear'); },
    /** 删掉一条 */
    remove(id) {
      const b = book();
      const i = b.chat.findIndex((x) => x.id === id);
      if (i < 0) return false;
      b.chat.splice(i, 1);
      touch('chat-remove', { id });
      return true;
    },
    clearChapter(chapterId) {
      if (!chapterId) return 0;
      const b = book();
      const before = b.chat.length;
      b.chat = b.chat.filter((m) => m.chapterId !== chapterId);
      touch('chat-clear');
      return before - b.chat.length;
    },
  };

  /* ── 配置（全局，跨书共用） ── */
  const config = {
    all: () => state.config,
    set(patch) { Object.assign(state.config, patch); touch('config'); },
    ready() { return !!(state.config.apiKey && state.config.apiBase && state.config.model); },
  };

  /* ── 整档导入导出 ── */
  function exportJSON() { return JSON.stringify(state, null, 2); }

  function parseArchive(text) {
    let raw;
    try { raw = JSON.parse(text); }
    catch (e) { return { ok: false, reason: 'JSON 解析失败：' + (e.message || e) }; }
    try {
      const inc = normalize(raw);
      const b0 = inc.books[0] || blankBook();
      const counts = {
        books: inc.books.length,
        chapters: inc.books.reduce((n, b) => n + b.chapters.length, 0),
        settings: inc.books.reduce((n, b) => n + b.settings.length, 0),
        lines: inc.books.reduce((n, b) => n + b.lines.length, 0),
        chat: inc.books.reduce((n, b) => n + b.chat.length, 0),
      };
      return { ok: true, incoming: inc, counts, title: b0.title };
    } catch (e) {
      return { ok: false, reason: '数据规格化失败：' + (e.message || e) };
    }
  }

  /**
   * 导入存档。
   * mode=merge 追加（新开一本书装进去，不碰现有的）；replace 用存档替换现有全部书。
   */
  function importJSON(text, opts = {}) {
    const parsed = parseArchive(text);
    if (!parsed.ok) return parsed;
    const inc = parsed.incoming;
    const replace = opts.mode === 'replace';
    const report = { books: 0, chapters: 0, settings: 0, lines: 0, chat: 0 };

    if (replace) {
      state.books = inc.books.map((b) => normBook(b));
      state.activeBookId = state.books[0].id;
    } else {
      // 每一本都原样收进来（重发 id 避免撞车），并切到第一本
      inc.books.forEach((b) => {
        const nb = normBook(b);
        nb.id = uid();
        nb.chapters.forEach((c) => { c.id = uid(); c.drafts.forEach((d) => { d.id = uid(); }); c.activeId = c.drafts.length ? c.drafts[c.drafts.length - 1].id : null; });
        nb.settings.forEach((s) => { s.id = uid(); });
        nb.lines.forEach((l) => { l.id = uid(); });
        nb.chat.forEach((m) => { m.id = uid(); });
        state.books.push(nb);
        report.books++;
        report.chapters += nb.chapters.length;
        report.settings += nb.settings.length;
        report.lines += nb.lines.length;
        report.chat += nb.chat.length;
      });
      state.activeBookId = state.books[state.books.length - inc.books.length].id;
    }
    touch('import');
    return { ok: true, report };
  }

  function reset() { state = blank(); touch('reset'); }
  function isPersistFailed() { return persistFailed; }

  return {
    load, save, on, get, uid,
    books, chapter, setting, line, chat, config,
    exportJSON, parseArchive, importJSON, reset, isPersistFailed,
    get activeChapterId() { return book().__activeChapter || null; },
    get lastOpened() { return book().__lastOpened || null; },
  };
})();
