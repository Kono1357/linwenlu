/* ════════════════════════════════════════════
   临文录 · AI 层
   ① 上下文装配（按预算挑料，可预览）② 流式调用 ③ 失败降级到「可复制提示词」
   ════════════════════════════════════════════ */

/* ════════════════════════════════════════════
   临文录 · 模型接入
   参考原作者的做法：把「接口协议 / 地址 / 模型 / 密钥」拆成四个独立字段，
   而不是写死一家。协议只有两种，但覆盖了绝大多数服务：
     openai    —— /chat/completions，OpenAI 兼容（DeepSeek、Kimi、GLM、通义、方舟、硅基流动、Ollama…）
     anthropic —— /messages，Claude 原生协议（头、system、流格式都不一样）
   ════════════════════════════════════════════ */

/** 厂家预设：选一个就把地址和常用模型带出来，也可以完全自己填 */
const Providers = [
  {
    id: 'deepseek', name: 'DeepSeek 深度求索', type: 'openai',
    base: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    note: '国内直连、便宜，默认选它',
  },
  {
    id: 'moonshot', name: '月之暗面 Kimi', type: 'openai',
    base: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2-0905-preview', 'moonshot-v1-128k', 'moonshot-v1-32k', 'moonshot-v1-8k'],
    note: '长上下文见长',
  },
  {
    id: 'zhipu', name: '智谱 GLM', type: 'openai',
    base: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'],
    note: 'glm-4-flash 有免费额度',
  },
  {
    id: 'qwen', name: '阿里通义千问', type: 'openai',
    base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen3-max'],
    note: '长文本处理稳',
  },
  {
    id: 'ark', name: '火山方舟 豆包', type: 'openai',
    base: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['doubao-pro-32k', 'doubao-1-5-pro-32k-250115'],
    note: '模型名要填接入点 ID，形如 ep-xxxx',
  },
  {
    id: 'silicon', name: '硅基流动 SiliconFlow', type: 'openai',
    base: 'https://api.siliconflow.cn/v1',
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-R1'],
    note: '一个 Key 调很多开源模型',
  },
  {
    id: 'modelscope', name: '魔搭 ModelScope', type: 'openai',
    base: 'https://api-inference.modelscope.cn/v1',
    models: ['Qwen/Qwen3-235B-A22B-Instruct-2507', 'deepseek-ai/DeepSeek-V3.1'],
    note: '作者自己用的就是这个',
  },
  {
    id: 'openai', name: 'OpenAI', type: 'openai',
    base: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini'],
    note: '需要能连上',
  },
  {
    id: 'anthropic', name: 'Anthropic Claude', type: 'anthropic',
    base: 'https://api.anthropic.com/v1',
    models: ['claude-sonnet-4-5-20250929', 'claude-opus-4-1-20250805', 'claude-3-5-haiku-20241022'],
    note: '原生协议（不是 OpenAI 兼容），系统会走 /messages',
  },
  {
    id: 'gemini', name: 'Google Gemini', type: 'openai',
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    note: '用的是它的 OpenAI 兼容口',
  },
  {
    id: 'ollama', name: '本地 Ollama', type: 'openai',
    base: 'http://localhost:11434/v1',
    models: ['qwen2.5:14b', 'llama3.1:8b', 'gemma2:9b'],
    note: '不用 Key，但得先在本机跑起来',
    noKey: true,
  },
  { id: 'custom', name: '自定义 / 其他中转', type: 'openai', base: '', models: [], note: '地址和模型自己填' },
];

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
      (st.config.deai === false) ? '' : deaiBlock(),
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

  /* ── 去 AI 味铁律：默认注入每次生成 ── */
  const DEAI_RULES = [
    '【写作铁律】逐条遵守：',
    '',
    '· 句式：禁用「不是……而是……」；禁用「综上所述 / 值得注意的是 / 本质上 / 事实上 / 总的来说」这类学术腔',
    '· 句式：禁用「首先 / 其次 / 此外」的三段论；段落靠意思自然衔接，不用过渡词硬连',
    '· 句式：禁用「当……的时候 / 与此同时 / 就在这一刻」——这是把画面"报"出来，直接写动作',
    '· 句式：不给语气打标签（「语气里带着…」「声音里透着…」「用一种…的口吻」），语气靠台词本身承担',
    '· 句式：不写无中生有的内心戏（「他不禁思考」「这个念头」「她心想」），用动作、停顿、沉默来暗示',
    '· 句式：不堆排比，不绕复杂隐喻；一个准的直喻胜过三个华丽的暗喻',
    '',
    '· 用词：尽量别用——认真、光芒、摩挲、挑眉、不易察觉、勾起嘴角、深吸一口气、微微、一丝、眸光、瞳孔',
    '· 用词：「好像 / 似的 / 如同 / 仿佛」克制使用（全篇不超过两次）',
    '· 用词：不许写「轻得像羽毛」「石子入湖」「涟漪扩散」这类样板比喻',
    '· 用词：写具体的东西，不写笼统的评价（不写"很漂亮"，写她具体是什么样子）',
    '',
    '· 对话：像真人说话——允许省略句、语气词（啊 呢 吧 嘛 哼 噢）、打断和抢话',
    '· 对话：长短句交错，不要一人一句轮着来，不要事后解释"她这句话是什么意思"',
    '· 对话：每个角色要有辨识度，遮住名字也能看出是谁在说话',
    '',
    '【不许重复自己】这是最容易翻车的地方：',
    '· 不许复述上文——前面写过的场景、动作、对话，不要再描一遍，直接往下写',
    '· 同一个词、同一个句子、同一个意象，整段里不许出现第二次',
    '· 同一类反应（喘、抖、颤、叫、绷紧）一段里最多两次，第三次必须换一种方式表现',
    '· 每次输出**换一套切入点**：这次从声音进，下次从手上的动作进，再下次从表情、体温或一句台词进',
    '· 身体反应要落在**不同的部位、不同的程度、不同的节奏**上，不要每次都端出同一组',
    '· 节奏要有起伏：有的地方快、有的地方慢、有的地方停住不动，不要匀速从头推到尾',
    '· 不要每次都走同一条流程；可以在任何一个点上停留、拉长、或者干脆跳过去',
    '· 每次输出都必须推进：给出新的动作、新的信息或新的对话，不许原地打转',
  ].join('\n');

  /** 作者改过就用作者的，没改过用这套预设 */
  function deaiBlock() {
    const cfg = Store.get().config;
    if (cfg.deai === false) return '';
    return String(cfg.deaiRules || '').trim() || DEAI_RULES;
  }

  /* ── 针对检测结果做一次「去 AI 味」重写 ── */
  function buildDeaiMessages(text, hits) {
    const list = (hits || []).map((h) =>
      `· ${h.name}${h.count ? '（' + h.count + ' 处）' : ''}：${(h.samples || []).slice(0, 4).join(' ／ ')}`
    ).join('\n');

    const sys = [
      '你是小说编辑，专治机器味。只做一件事：把下面文本里露出的 AI 痕迹改掉。',
      '**情节、人物、信息量、段落顺序一个字都不许变**；不要润色、不要扩写、不要删内容、不要重排。',
      '只输出改完的正文，不要解释、不要标注改了什么。',
      '',
      DEAI_RULES,
    ].join('\n');

    const user = [
      list ? `这一章检测到这些问题：\n${list}\n` : '',
      `【原文】\n${String(text || '').trim()}`,
      '',
      '请改正后输出全文。',
    ].filter(Boolean).join('\n');

    return [{ role: 'system', content: sys }, { role: 'user', content: user }];
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

  /* ── 只生成提示词（降级用） ── */
  function buildPromptOnly(opts) {
    return buildMessages(opts).map((m) => {
      const who = m.role === 'system' ? '系统' : (m.role === 'user' ? '用户' : '助手');
      return `### ${who}\n${m.content}`;
    }).join('\n\n');
  }

  /* ── 请求装配：两种协议的差异全部收在这里 ──
     加一家新厂家只要往 Providers 里加一条，不用碰下面的代码。 */
  function buildRequest(cfg, messages, opts = {}) {
    const type = cfg.apiType || 'openai';
    const base = String(cfg.apiBase || '').replace(/\/+$/, '');
    const temp = Number.isFinite(+opts.temperature) ? +opts.temperature : (Number(cfg.temperature) || 0.9);

    if (type === 'anthropic') {
      // Claude 原生协议：system 是顶层字段、头用 x-api-key、必须给 max_tokens
      const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
      const rest = messages.filter((m) => m.role !== 'system').map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      }));
      return {
        url: /\/messages$/.test(base) ? base : base + '/messages',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',   // 不加这个浏览器会被 CORS 拦掉
        },
        body: {
          model: cfg.model,
          system: sys,
          messages: rest,
          max_tokens: Number(cfg.maxTokens) || 4096,
          temperature: Math.min(temp, 1),    // Claude 的温度上限是 1
          stream: true,
        },
      };
    }

    // OpenAI 兼容（绝大多数厂家走这条）
    const body = { model: cfg.model, messages, stream: true, temperature: temp };
    // 采样层面的防重复：光靠提示词压不住"每次都差不多"，这两个参数直接改概率分布
    if (Number.isFinite(+cfg.freqPenalty) && +cfg.freqPenalty !== 0) body.frequency_penalty = +cfg.freqPenalty;
    if (Number.isFinite(+cfg.presPenalty) && +cfg.presPenalty !== 0) body.presence_penalty = +cfg.presPenalty;
    return {
      url: /\/chat\/completions$/.test(base) ? base : base + '/chat/completions',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
      body,
    };
  }

  /** 从一条 SSE 里取出这段新增的文字（两种协议的事件形状不一样） */
  function pickDelta(type, j) {
    if (type === 'anthropic') {
      if (j.type === 'content_block_delta' && j.delta) return j.delta.text || '';
      return '';
    }
    const d = j.choices && j.choices[0] && j.choices[0].delta;
    return (d && (d.content ?? d.reasoning_content)) || '';
  }

  /* ── 流式调用 ── */
  async function generate(opts) {
    const { onDelta, signal } = opts;
    const st = Store.get();
    const cfg = st.config;
    const type = cfg.apiType || 'openai';
    if (!cfg.apiKey && type !== 'ollama') {
      throw new Error('还没填 API Key —— 点右上「⋯ → 模型设置」');
    }
    if (!cfg.model) throw new Error('还没选模型 —— 点右上「⋯ → 模型设置」');

    const req = buildRequest(cfg, opts.messages || buildMessages(opts), opts);

    let res;
    try {
      res = await fetch(req.url, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify(req.body),
        signal,
      });
    } catch (e) {
      const err = new Error('连接失败：' + (e && e.message || e) +
        '\n\n可能是：① 地址填错 ② 浏览器跨域被拦 ③ 网络不通。\n可以点「复制提示词」，把请求粘到任意 AI 里先写着。');
      err.code = 'NETWORK';
      throw err;
    }

    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 400); } catch (_) { }
      let hint = '';
      if (res.status === 401 || res.status === 403) hint = '\n→ 多半是 Key 不对，或者 Key 跟这个厂家不匹配。';
      else if (res.status === 404) hint = '\n→ 地址或模型名不对。检查一下厂家的 Base URL 和模型名。';
      else if (res.status === 400) hint = '\n→ 请求被拒：常见是模型名错，或者这个厂家不支持某些参数（试试把「重复惩罚」「新鲜度」调成 0）。';
      else if (res.status === 429) hint = '\n→ 触发限流或余额不足。';
      const e = new Error(`接口返回 ${res.status}${res.statusText ? ' ' + res.statusText : ''}${hint}\n${detail}`);
      e.code = 'HTTP';
      throw e;
    }

    if (!res.body) {  // 某些环境不支持流
      const j = await res.json();
      const txt = type === 'anthropic'
        ? ((j.content || [])[0] || {}).text || ''
        : (j.choices?.[0]?.message?.content || '');
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
          const piece = pickDelta(type, j);
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
    const type = cfg.apiType || 'openai';
    if (!cfg.apiKey && type !== 'ollama') return { ok: false, reason: '未填 API Key' };
    if (!cfg.model) return { ok: false, reason: '未填模型名' };

    const req = buildRequest(cfg, [{ role: 'user', content: 'ping' }], { temperature: 0 });
    req.body.stream = false;
    if (type === 'anthropic') req.body.max_tokens = 8;
    else req.body.max_tokens = 8;
    try {
      const res = await fetch(req.url, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify(req.body),
      });
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status}：${(await res.text()).slice(0, 200)}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: '网络/跨域失败：' + (e && e.message || e) };
    }
  }

  return {
    buildContext, buildMessages, buildPromptOnly, buildSmoothMessages,
    buildDeaiMessages, buildRequest, pickDelta,
    DEAI_RULES, PROVIDERS: Providers,
    generate, probe, cut,
  };
})();
