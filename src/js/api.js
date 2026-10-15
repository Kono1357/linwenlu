/* ════════════════════════════════════════════
   临文录 · AI 层
   ① 上下文装配（按预算挑料，可预览）② 流式调用 ③ 失败降级到「可复制提示词」
   ════════════════════════════════════════════ */

const AI = (() => {
  const cut = (s, n) => {
    s = String(s || '');
    if (n <= 0) return '';
    return s.length <= n ? s : '…' + s.slice(-n);
  };
  const cutHead = (s, n) => {
    s = String(s || '');
    if (n <= 0) return '';
    return s.length <= n ? s : s.slice(0, n) + '…';
  };

  /* ── 相关性：设定是否和这段文本有关 ── */
  function relevant(text, s) {
    if (!text) return false;
    const hay = String(text);
    const name = String(s.name || '').trim();
    if (name.length >= 2 && hay.includes(name)) return true;
    // 描述里的 2 字以上词块命中一次即算相关
    const desc = String(s.desc || '');
    if (!desc) return false;
    const chunks = desc.split(/[\s，。、；：！？（）()【】\[\]「」,.;:!?—\-/]+/).filter((w) => w.length >= 2);
    return chunks.some((w) => hay.includes(w));
  }

  /* ── 装配上下文：返回 {sections:[{key,title,text}], text} ── */
  function buildContext(ask, chapterId) {
    const st = Store.get();
    const cfg = st.config;
    const c = chapterId ? Store.chapter.by(chapterId) : Store.chapter.active();
    const sections = [];

    const head = [`《${st.book.title}》`];
    if (st.book.genre) head.push(st.book.genre);
    if (st.book.desc) head.push(cutHead(st.book.desc, 200));
    sections.push({ key: 'book', title: '作品', text: head.join(' · ') });

    if (cfg.style) sections.push({ key: 'style', title: '文风', text: cfg.style });

    // 设定：先相关命中，再按时间补足
    const probe = [ask, c ? Store.chapter.textOf(c) : ''].join('\n');
    const all = st.settings;
    const people = all.filter((s) => s.kind === '人物');

    // 人物表：整表带上，不受条数限制 —— 这是让 AI 自己把配角写出来的前提
    if (people.length) {
      const ranked = people.slice().sort((a, b) => {
        const ai = relevant(probe, a) ? 0 : 1;
        const bi = relevant(probe, b) ? 0 : 1;
        return ai - bi || b.at - a.at;
      });
      sections.push({
        key: 'cast',
        title: `人物表（共 ${people.length} 人，必须使用这些名字）`,
        text: ranked.slice(0, 40).map((s) => `· ${s.name}${s.desc ? '：' + cutHead(s.desc, 130) : ''}`).join('\n'),
      });
    }

    const rest0 = all.filter((s) => s.kind !== '人物');
    const hit = rest0.filter((s) => relevant(probe, s));
    const rest = rest0.filter((s) => !hit.includes(s));
    const picked = hit.concat(rest).slice(0, Math.max(0, cfg.ctxSettings | 0));
    if (picked.length) {
      sections.push({
        key: 'settings',
        title: `设定（${picked.length}/${rest0.length}）`,
        text: picked.map((s) => `· ${s.name}〔${s.kind}〕${s.desc ? '：' + cutHead(s.desc, 160) : ''}`).join('\n'),
      });
    }

    const open = st.lines.filter((l) => l.status !== '已收束');
    if (open.length) {
      sections.push({
        key: 'lines',
        title: `世界线（未收束 ${open.length}）`,
        text: open.slice(0, 10).map((l) => `· ${l.at ? `[${l.at}] ` : ''}${l.name}${l.desc ? '：' + cutHead(l.desc, 120) : ''}`).join('\n'),
      });
    }

    // 上一章结尾
    if (c && (cfg.ctxPrev | 0) > 0) {
      const prev = st.chapters.filter((x) => x.no < c.no).pop();
      const pt = prev ? Store.chapter.textOf(prev) : '';
      if (pt.trim()) {
        sections.push({ key: 'prev', title: `上一章结尾 · ${prev.title}`, text: cut(pt, 500) });
      }
    }

    // 本章已写
    if (c) {
      const ct = Store.chapter.textOf(c);
      if (ct.trim()) sections.push({ key: 'cur', title: `本章已写 · ${c.title}`, text: cut(ct, Math.max(200, cfg.ctxTail | 0)) });
      else sections.push({ key: 'cur', title: `本章 · ${c.title}`, text: '（还没写）' });
    }

    const text = sections.map((s) => `【${s.title}】\n${s.text}`).join('\n\n');
    return { sections, text, chapter: c };
  }

  /* ── 组装 messages ── */
  function buildMessages(opts) {
    const { ask, chapterId, mode = 'chat', extra = '' } = opts;
    const ctx = buildContext(ask, chapterId);
    const st = Store.get();

    const modeRule = {
      continue: '写作模式：接着本章已有内容往下写。只输出正文本身，不要标题、不要解释、不要点评。',
      rewrite: '改写模式：按作者要求改写给定的原文。只输出改写后的正文，不要解释。',
      outline: '规划模式：为本章给出 3—6 条要点（一行一条，以「· 」开头），每条一句话，说明这一章要发生什么。不要写正文。',
      chat: '对话模式：先直接回答作者的问题；如果作者在要正文，就按续写的方式给出正文。',
    }[mode] || '';

    const sys = [
      `你是长篇小说写作助手，正在协助作者创作《${st.book.title}》。`,
      st.config.style ? `文风要求：${st.config.style}` : '',
      '严格遵守下面提供的设定与世界线，不要自创与设定冲突的内容。',
      '出场人物必须使用【人物表】里已有的名字，并按表里的性格与关系来写；',
      '需要有新角色出场时，先从人物表里挑最合适的那个，表里确实没有才新建，',
      '并且同一个角色前后的称呼必须保持一致，不要用"某个人""一个男人"这类泛称代替已有角色。',
      modeRule,
    ].filter(Boolean).join('\n');

    const userParts = [ctx.text];
    if (extra) userParts.push(`【选中原文】\n${extra}`);
    userParts.push(`【作者要求】\n${ask || '（无具体要求，按上文续写）'}`);

    // 最近对话（只带 4 轮，省 token）
    const history = Store.chat.all().slice(-8).map((m) => ({
      role: m.role === 'me' ? 'user' : 'assistant',
      content: m.text,
    })).filter((m, i, a) => !(i === a.length - 1 && m.role === 'assistant' && a[a.length - 1].content === ask));

    return [{ role: 'system', content: sys }, ...history, { role: 'user', content: userParts.join('\n\n') }];
  }

  /* ── 只生成提示词（降级用） ── */
  function buildPromptOnly(opts) {
    return buildMessages(opts).map((m) => {
      const who = m.role === 'system' ? '系统' : (m.role === 'user' ? '用户' : '助手');
      return `### ${who}\n${m.content}`;
    }).join('\n\n');
  }

  /* ── 流式调用 ── */
  async function generate(opts) {
    const { onDelta, signal } = opts;
    const st = Store.get();
    const cfg = st.config;
    if (!cfg.apiKey) throw new Error('还没填 API Key —— 点右上「⋯ → 模型设置」');

    const base = String(cfg.apiBase || '').replace(/\/+$/, '');
    const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
    const body = {
      model: cfg.model,
      messages: buildMessages(opts),
      stream: true,
      temperature: Number(cfg.temperature) || 0.9,
    };

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      const err = new Error('连接失败：' + (e && e.message || e) +
        '\n可能是浏览器跨域限制或网络问题。可点「复制提示词」拿到完整请求，粘贴到任意 AI 里。');
      err.code = 'NETWORK';
      throw err;
    }

    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 400); } catch (_) { }
      const e = new Error(`接口返回 ${res.status}${res.statusText ? ' ' + res.statusText : ''}\n${detail}`);
      e.code = 'HTTP';
      throw e;
    }

    if (!res.body) {  // 某些环境不支持流
      const j = await res.json();
      const txt = j?.choices?.[0]?.message?.content || '';
      onDelta && onDelta(txt);
      return txt;
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder('utf-8');
    let buf = '';
    let full = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          const d = j.choices?.[0]?.delta;
          const piece = (d && (d.content ?? d.reasoning_content)) || '';
          if (piece) { full += piece; onDelta && onDelta(piece); }
        } catch (_) { /* 忽略半截 JSON */ }
      }
    }
    return full;
  }

  /* ── 连通性自检 ── */
  async function probe() {
    const st = Store.get();
    const cfg = st.config;
    if (!cfg.apiKey) return { ok: false, reason: '未填 API Key' };
    const base = String(cfg.apiBase || '').replace(/\/+$/, '');
    const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
        body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 4, stream: false }),
      });
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status}：${(await res.text()).slice(0, 200)}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: '网络/跨域失败：' + (e && e.message || e) };
    }
  }

  /* ── 从正文里认名字：给「新角色入库」用 ──
     中文人名没有形态标记，只能靠字头 + 上下文。策略是宁可漏、不可错：
     ① 只认百家姓与「老/小/阿」这类称呼头；② 必须出现在词首（前面是标点或开头）；
     ③ 末字不能是虚词动词（否则「老陈把」会被人当成名字）；④ 全文出现 ≥2 次才算候选。
     结果只是「建议」，要用户勾选后才入库 —— 不自动写。 */
  const SURNAMES = '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯昝管卢莫老小阿大';
  const STOPCHAR = new Set(('把被让给和跟向从又也都没很才就还只像似乎便即这里那着你我他她它们的是了在有不之与其并且但因为所以如果虽然'
    + '说道问答笑走来去站坐看想听见叫喊吃喝拉睡望盯摇点抓拿放推拉踢打').split(''));
  const STOP = new Set(['黄金', '白天', '马上', '高大', '温柔', '江南', '风景', '行李', '手掌', '树木', '花样', '毛病', '程度', '程序', '的确', '仿佛', '石头', '安静', '常常', '通常', '平静', '外面', '上面', '下面', '里面', '前面', '后面', '旁边', '周围', '对方', '结果', '原因', '情况', '时候', '地方', '东西', '事情', '样子', '心里', '眼神', '声音', '问题', '办法', '世界', '人生', '男人', '女人', '孩子', '老人', '学生', '老师', '医生', '警察', '老板', '经理', '司机', '服务',
    '小时', '小心', '小说', '小学', '小气', '小鬼', '老练', '老实', '老是', '老大', '老家', '老百姓', '大爷', '大方', '大家', '大声', '大约', '大量', '大力', '大门', '大多数']);

  function extractNames(text, known) {
    const src = String(text || '');
    if (src.length < 12) return [];
    const knownSet = new Set(known || []);
    const count = new Map();

    for (let i = 0; i < src.length; i++) {
      if (SURNAMES.indexOf(src[i]) < 0) continue;
      // 词首约束：要么开头，要么前面不是汉字
      if (i > 0 && /[\u4e00-\u9fa5]/.test(src[i - 1])) continue;

      let name = null;
      for (const len of [3, 2]) {          // 先试三字，末字是虚词就退回两字
        const cand = src.slice(i, i + len);
        if (cand.length < len) continue;
        if (!/^[\u4e00-\u9fa5]+$/.test(cand)) continue;
        if (STOPCHAR.has(cand[cand.length - 1])) continue;
        name = cand;
        break;
      }
      if (!name || STOP.has(name) || knownSet.has(name)) continue;
      count.set(name, (count.get(name) || 0) + 1);
    }

    return [...count.entries()]
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, n]) => ({ name, n }));
  }

  /** 扫一批文本，找出还没进设定的名字 */
  function findNewNames(text) {
    const known = Store.setting.all().map((s) => s.name);
    return extractNames(text, known);
  }

  return { buildContext, buildMessages, buildPromptOnly, generate, probe, cut, extractNames, findNewNames };
})();
