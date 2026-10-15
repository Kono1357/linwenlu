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

  /* ── 装配上下文：返回 {sections:[{key,title,text}], text} ──
     baseText 有值时用它替换「本章已写」那一段 ——
     这是「以某一段为起点续写」的关键：基线可以不是章末，而是任意一段。 */
  function buildContext(ask, chapterId, baseText) {
    const st = Store.get();
    const cfg = st.config;
    const c = chapterId ? Store.chapter.by(chapterId) : Store.chapter.active();
    const sections = [];

    const bk = Store.books.current();
    const head = [`《${bk.title}》`];
    if (bk.genre) head.push(bk.genre);
    if (bk.desc) head.push(cutHead(bk.desc, 200));
    sections.push({ key: 'book', title: '作品', text: head.join(' · ') });

    if (cfg.style) sections.push({ key: 'style', title: '文风', text: cfg.style });

    // 设定：**按类别分组，每类都完整带一份** ——
    // 之前只有「人物」整表带，地点/规则/物件只能靠关键词撞运气，所以那些类别的设定等于没写。
    const probe = [ask, c ? Store.chapter.textOf(c) : ''].join('\n');
    const all = Store.setting.all();
    const people = all.filter((s) => s.kind === '人物');

    // 人物单独成段（最重要，整表带）
    if (people.length) {
      const ranked = people.slice().sort((a, b) => {
        const ai = relevant(probe, a) ? 0 : 1;
        const bi = relevant(probe, b) ? 0 : 1;
        return ai - bi || b.at - a.at;
      });
      sections.push({
        key: 'cast',
        title: `人物表（共 ${people.length} 人，必须使用这些名字）`,
        text: ranked.slice(0, 40).map((s) => `· ${s.name}${s.desc ? '：' + cutHead(s.desc, 150) : ''}`).join('\n'),
      });
    }

    // 其余类别各自成段，每类都给配额，不再互相挤
    const quota = Math.max(4, Math.round((cfg.ctxSettings | 0) / 2) || 6);
    const kinds = {};
    all.filter((s) => s.kind !== '人物').forEach((s) => {
      (kinds[s.kind] = kinds[s.kind] || []).push(s);
    });
    Object.keys(kinds).forEach((kind) => {
      const list = kinds[kind];
      const hit = list.filter((s) => relevant(probe, s));
      const rest = list.filter((s) => !hit.includes(s));
      const picked = hit.concat(rest).slice(0, quota);
      sections.push({
        key: 'set-' + kind,
        title: `${kind}（${picked.length}/${list.length}${list.length > quota ? '，与本章相关优先' : ''}）`,
        text: picked.map((s) => `· ${s.name}${s.desc ? '：' + cutHead(s.desc, 170) : ''}`).join('\n'),
      });
    });

    const open = Store.line.all().filter((l) => l.status !== '已收束');
    if (open.length) {
      sections.push({
        key: 'lines',
        title: `世界线（未收束 ${open.length}）`,
        text: open.slice(0, 10).map((l) => `· ${l.at ? `[${l.at}] ` : ''}${l.name}${l.desc ? '：' + cutHead(l.desc, 120) : ''}`).join('\n'),
      });
    }

    // 上一章结尾
    if (c && (cfg.ctxPrev | 0) > 0) {
      const prev = Store.chapter.all().filter((x) => x.no < c.no).pop();
      const pt = prev ? Store.chapter.textOf(prev) : '';
      if (pt.trim()) {
        sections.push({ key: 'prev', title: `上一章结尾 · ${prev.title}`, text: cut(pt, 500) });
      }
    }

    // 已写内容：默认取本章末尾；指定了基线就用基线那一段
    if (baseText && baseText.trim()) {
      sections.push({
        key: 'cur',
        title: '续写基线（从这里接着往下写）',
        text: cut(baseText, Math.max(200, cfg.ctxTail | 0)),
      });
    } else if (c) {
      const ct = Store.chapter.textOf(c);
      if (ct.trim()) sections.push({ key: 'cur', title: `本章已写 · ${c.title}`, text: cut(ct, Math.max(200, cfg.ctxTail | 0)) });
      else sections.push({ key: 'cur', title: `本章 · ${c.title}`, text: '（还没写）' });
    }

    const text = sections.map((s) => `【${s.title}】\n${s.text}`).join('\n\n');
    return { sections, text, chapter: c };
  }

  /* ── 组装 messages ── */
  function buildMessages(opts) {
    const { ask, chapterId, mode = 'chat', extra = '', baseText = '' } = opts;
    const ctx = buildContext(ask, chapterId, baseText);
    const st = Store.get();

    const modeRule = {
      continue: '写作模式：接着本章已有内容往下写。只输出正文本身，不要标题、不要解释、不要点评。',
      from: '写作模式：接着给定的「续写基线」那一段往下写，保持同一场景、同一语气、同一批人物。只输出正文本身，不要标题、不要解释。',
      rewrite: '改写模式：按作者要求改写给定的原文。只输出改写后的正文，不要解释。',
      outline: '规划模式：为本章给出 3—6 条要点（一行一条，以「· 」开头），每条一句话，说明这一章要发生什么。不要写正文。',
      chat: '对话模式：先直接回答作者的问题；如果作者在要正文，就按续写的方式给出正文。',
    }[mode] || '';

    // 字数要求：不写清，模型就会草草收尾
    const tw = Number(st.config.targetWords) || 0;
    const lenRule = (tw > 0 && (mode === 'continue' || mode === 'from' || mode === 'chat'))
      ? `本次目标约 ${tw} 字。一次写够，不要提前收尾，也不要用重复句凑字数；`
      : '';

    const sys = [
      `你是长篇小说写作助手，正在协助作者创作《${Store.books.current().title}》。`,
      st.config.style ? `文风要求：${st.config.style}` : '',
      '严格遵守下面提供的设定与世界线，不要自创与设定冲突的内容。',
      '出场人物必须使用【人物表】里已有的名字，并按表里的性格与关系来写；',
      '需要有新角色出场时，先从人物表里挑最合适的那个，表里确实没有才新建，',
      '并且同一个角色前后的称呼必须保持一致，不要用"某个人""一个男人"这类泛称代替已有角色。',
      lenRule,
      modeRule,
    ].filter(Boolean).join('\n');

    const userParts = [ctx.text];
    if (extra) userParts.push(`【选中原文】\n${extra}`);
    if (baseText && baseText.trim()) userParts.push(`【从这一段接着写】\n${baseText.trim()}`);
    userParts.push(`【作者要求】\n${ask || '（无具体要求，按上文续写）'}`);

    // 最近对话（只带 4 轮，省 token）
    const history = Store.chat.all().slice(-8).map((m) => ({
      role: m.role === 'me' ? 'user' : 'assistant',
      content: m.text,
    })).filter((m, i, a) => !(i === a.length - 1 && m.role === 'assistant' && a[a.length - 1].content === ask));

    return [{ role: 'system', content: sys }, ...history, { role: 'user', content: userParts.join('\n\n') }];
  }

  /* ── 整章顺稿：不做上下文装配，直接把全文交给模型修接缝 ── */
  function buildSmoothMessages(text) {
    const st = Store.get();
    const sys = [
      '你是一位长篇小说编辑。作者这一章是分几次写成的，接缝处可能有重复、跳跃、语气断裂。',
      '请通读全文，做**最小必要**的修改，让它读起来像一次写完的：',
      '· 删掉重复的句子与意思相近的段落（续接时重发上文是常见毛病）',
      '· 补上场景之间缺失的过渡，一两句即可，不要展开',
      '· 统一人物称呼、叙述人称与语气',
      '· 保留原有的分段节奏与文风，不要润色、不要拔高、不要加形容词',
      '· **不要改动情节，不要增删事件，不要改变任何人的行为**',
      st.config.style ? `· 本书文风：${st.config.style}` : '',
      '直接输出修改后的全文，不要任何解释、不要小标题、不要用 markdown 标记。',
    ].filter(Boolean).join('\n');

    return [
      { role: 'system', content: sys },
      { role: 'user', content: `【本章全文】\n${String(text || '').trim()}\n\n请输出修改后的全文。` },
    ];
  }

  /* ── 让 AI 把一条设定「写厚」：只依据正文原句归纳，不许编 ── */
  const KIND_GUIDE = {
    人物: '外貌特征（体型、常穿什么、有无疤痕饰物）、性格脾气、说话习惯或口癖、和主角及其他人的关系',
    地点: '位置与环境、不同时段的样子、气氛、有什么特殊之处',
    物件: '外形与材质、来历、作用或象征意义',
    规则: '规则内容、适用范围、限制条件、违反的代价',
    设定: '它是什么、怎么运作、对故事有什么影响',
  };

  function buildEnrichMessages(setting) {
    const kind = setting.kind || '设定';
    const guide = KIND_GUIDE[kind] || '它是什么、有什么特点';
    const quotes = (setting.quotes || []).filter(Boolean).slice(0, 8);

    const sys = '你在整理小说设定集。**只根据给出的原文片段归纳**，原文没写的不要编。'
      + '输出 3—6 行，每行以「· 」开头，每行一句，不要标题、不要小标题、不要解释、不要 markdown。';

    const user = [
      `【条目】${setting.name}（${kind}）`,
      quotes.length ? `【正文原句】\n${quotes.map((q) => '· ' + q).join('\n')}` : '【正文原句】（还没有，请只根据名字给出最保守的推测，并在每行末尾标注「待补」）',
      '',
      `请归纳这个${kind}的：${guide}。`,
      '原文只提到一部分就只写那一部分，不要凑数。',
    ].join('\n');

    return [{ role: 'system', content: sys }, { role: 'user', content: user }];
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
      messages: opts.messages || buildMessages(opts),
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
    '小时', '小心', '小说', '小学', '小气', '小鬼', '老练', '老实', '老是', '老大', '老家', '老百姓', '大爷', '大方', '大家', '大声', '大约', '大量', '大力', '大门', '大多数',
    '文明', '文章', '文化', '天气', '风度', '风格', '风景', '风里', '高处', '高兴', '高手', '高处', '市场', '市里', '安全', '面子', '个子', '影子', '影子', '日子', '样子', '曲子', '嗓子',
    '于是', '终于', '关于', '由于', '对于', '至于', '甚至', '尤其', '曾经', '已经', '立刻', '马上', '忽然', '突然', '果然', '竟然', '居然', '虽然', '固然',
    '马路', '马上', '道路', '路口', '门口', '巷口', '街口', '出口', '入口', '窗口', '港口', '借口', '伤口', '开口',
    '白天', '白天', '白色', '白菜', '白发', '白酒', '明白', '坦白', '空白',
    '空气', '空白', '抽空', '天空', '星空', '太空', '高空',
    '黄金', '黄土', '黄昏', '黄河', '黄河', '黄沙',
    '林子', '林里', '林中', '森林', '树林',
    '沈默', '沉着', '沉着']);

  /** 名字附近出现这些字，才像是在写"人" */
  const HUMAN_CTX = /[说道问答喊叫哭笑走来去站坐看想听望盯点摇抬低转沉默咬回身手动]/;

  /** 两个名字是不是同一个人的不同叫法（老陈 / 陈） */
  function similarName(a, b) {
    const x = String(a || '').trim(), y = String(b || '').trim();
    if (!x || !y) return false;
    if (x === y) return true;
    if (x.length >= 2 && y.length >= 2 && Math.abs(x.length - y.length) <= 1) {
      return x.includes(y) || y.includes(x);
    }
    return false;
  }

  /**
   * 从正文里认名字，并带回「证据句」——
   * 只有名字没用，设定要能长出内容，所以把这个人出现过的原句一起带出来。
   * 返回 [{ name, n, quotes:[原句…] }]
   */
  function extractNames(text, known) {
    const src = String(text || '');
    if (src.length < 12) return [];
    const knownSet = new Set(known || []);
    const count = new Map();
    const quotes = new Map();
    const human = new Map();     // 「像人」的证据数，用来滤掉"高大""安静"这类词

    const sentences = src.split(/(?<=[。！？!?…\n])/).map((s) => s.trim()).filter(Boolean);

    for (const sent of sentences) {
      const seenHere = new Set();
      for (let i = 0; i < sent.length; i++) {
        if (SURNAMES.indexOf(sent[i]) < 0) continue;
        if (i > 0 && /[\u4e00-\u9fa5]/.test(sent[i - 1])) continue;

        let name = null;
        for (const len of [3, 2]) {          // 先试三字，末字是虚词就退回两字
          const cand = sent.slice(i, i + len);
          if (cand.length < len) continue;
          if (!/^[\u4e00-\u9fa5]+$/.test(cand)) continue;
          if (STOPCHAR.has(cand[cand.length - 1])) continue;
          name = cand;
          break;
        }
        if (!name || STOP.has(name) || knownSet.has(name)) continue;

        if (!seenHere.has(name)) {
          seenHere.add(name);
          count.set(name, (count.get(name) || 0) + 1);

          const around = sent.slice(Math.max(0, i - 2), i + name.length + 4);
          const after = sent.slice(i + name.length, i + name.length + 1);
          if (HUMAN_CTX.test(around)) human.set(name, (human.get(name) || 0) + 1);
          if (/^[「『"]/.test(after)) human.set(name, (human.get(name) || 0) + 1);

          const arr = quotes.get(name) || [];
          if (arr.length < 3 && !arr.includes(sent)) arr.push(sent);
          quotes.set(name, arr);
        }
        i += name.length - 1;
      }
    }

    return [...count.entries()]
      .filter(([name, n]) => n >= 2 && (human.get(name) || 0) >= 1)   // 出现过两次以上，且至少有"像人"的上下文
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, n]) => ({ name, n, quotes: quotes.get(name) || [] }));
  }

  /** 扫一批文本，找出「还值得问一句」的名字：
      已经在设定里的（含"老陈/陈"这种叫法差异）不问，用户拒绝过的不问。 */
  function findNewNames(text) {
    const known = Store.setting.all().map((s) => s.name);
    const ignored = Store.setting.ignoredNames();
    return extractNames(text, [])
      .filter((x) => {
        if (ignored.includes(x.name)) return false;
        if (known.some((k) => similarName(k, x.name))) return false;
        return true;
      });
  }

  /** 反过来：从文本里给「已经入库的名字」收集原句，用来补佐证 */
  function quotesFor(text, names) {
    const src = String(text || '');
    if (!src) return {};
    const sentences = src.split(/(?<=[。！？!?…\n])/).map((s) => s.trim()).filter(Boolean);
    const out = {};
    (names || []).forEach((n) => {
      const name = String(n || '').trim();
      if (name.length < 2) return;
      const hit = sentences.filter((s) => s.includes(name));
      if (hit.length) out[name] = hit.slice(0, 3);
    });
    return out;
  }

  return {
    buildContext, buildMessages, buildPromptOnly, buildSmoothMessages, buildEnrichMessages,
    generate, probe, cut, extractNames, findNewNames, quotesFor,
  };
})();
