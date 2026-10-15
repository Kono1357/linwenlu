/* ════════════════════════════════════════════
   临文录 · AI 味检测
   把"写作设定"里那套去 AI 味的判据做成可执行的规则：
   生成完自动扫一遍，告诉你哪几句露了机器痕迹，能直接改。

   设计取向：**只报有把握的**。
   中文里「眼神」「有些」「一丝」本身完全正常，只有当它们在一段里
   密集堆叠时才说明问题 —— 所以频次类判据按"每千字密度"算，
   而不是见一次报一次。
   ════════════════════════════════════════════ */

const AiFlavor = (() => {

  /* ── 一、句式类：命中即算，不看密度 ── */
  const PATTERNS = [
    {
      id: 'notbut', name: '伪反转句', weight: 6,
      re: /不是[^。！？；\n]{1,30}?而是/g,   // 中间允许逗号（"不是不想说话，而是……"）
      why: '「不是……而是……」是机器最深的肌肉记忆，用来制造假的深度',
      fix: '改成直接陈述：把你要说的那句正面写出来就行',
    },
    {
      id: 'academic', name: '学术腔', weight: 5,
      re: /(综上所述|值得注意的是|本质上|事实上|总的来说|不难看出|显而易见|换言之)/g,
      why: '小说里没有人这样说话',
      fix: '删掉这个过渡，直接写下一句',
    },
    {
      id: 'enumerate', name: '三段论结构', weight: 4,
      re: /(?:^|[。！？\n])\s*(首先|其次|再者|最后|第一|第二|第三)[，、]/g,
      why: '叙述被拆成了编号清单',
      fix: '把顺序词去掉，让意思自己流动',
    },
    {
      id: 'clock', name: '叙事时钟词', weight: 4,
      re: /(当[^，。！？\n]{1,14}的时候|与此同时|就在这一刻|就在此时|就在这时候|这一刻)/g,
      why: '这是把画面"报"出来，不是写出来',
      fix: '直接写那个动作，不要先报时间',
    },
    {
      id: 'tonetag', name: '给语气打标签', weight: 6,
      re: /(语气里(?:带着|透着|有)|声音里(?:带着|透着)|用一种[^，。！？\n]{1,12}的(?:口吻|语气)|用[^，。！？\n]{0,8}的语气(?:说|道)|语气(?:平静|冰冷|温柔|低沉|生硬)地)/g,
      why: '语气应该由说的话本身传达，贴标签等于替读者下结论',
      fix: '删掉标签，让台词自己说话；或者补一个具体动作',
    },
    {
      id: 'inner', name: '无中生有的内心戏', weight: 6,
      re: /(不禁(?:思考|想|感慨|感叹)|这个念头|这个认知|心中(?:暗道|想道)|(tā|他|她)心想|(?:他|她)想着)/g,
      why: '心理活动被直接解说，读者失去了自己体会的空间',
      fix: '用动作、停顿、台词暗示；写"她停了很久"比写"她在想"强',
    },
    {
      id: 'paren', name: '圆括号内心戏', weight: 5,
      re: /（(?:心想|心道|暗想|内心)[:：]/g,
      why: '括号里塞独白，是剧本写法不是小说写法',
      fix: '改成正文里的动作或对白',
    },
    {
      id: 'stereotype', name: '样板比喻', weight: 8,
      re: /(轻得像羽毛|像羽毛一?样|石子(?:投|入)湖|涟漪(?:般|似的|一样)?(?:扩散|荡开|散开)|像涟漪|如同一潭|像(?:平静的)?湖面)/g,
      why: '这三个是机器比喻的样板间',
      fix: '删掉比喻，直接写状态',
    },
    {
      id: 'bannedDetail', name: '套路化身体细节', weight: 3,
      re: /(水钻|choker|腰封|流苏|尾椎骨|肩胛骨|耻骨|骨节|茧子|踉跄)/g,
      why: '这类词在某批模型里高频到成了指纹',
      fix: '换成这个角色真正会有的东西',
    },
  ];

  /* ── 二、明喻总量：整篇有配额 ── */
  const SIMILE = {
    id: 'simile', name: '明喻词偏多', weight: 2,
    re: /(好像|似的|如同|仿佛)/g,
    quota: 2,   // 每千字
    why: '「好像/似的/如同/仿佛」一多，文风立刻变软',
    fix: '直接写状态，不要"像……一样"',
  };

  /* ── 三、滥用词：按密度算，不是见一次就报 ── */
  const CLICHES = [
    '认真', '火花', '光芒', '摩挲', '不容置疑', '挑眉', '低声', '不易察觉',
    '一丝', '勾起嘴角', '坚定', '深吸一口气', '闪过', '微微', '轻微', '眼神',
    '夜色如墨', '几不可闻', '仿佛', '嘴角', '眸光', '瞳孔',
  ];
  const CLICHE_DENSITY = 4;   // 每千字出现多少次算密集

  const esc = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** 数一段里出现几次（用 split 不用正则，避免特殊字符问题） */
  function countOf(text, word) {
    if (!word) return 0;
    let n = 0, i = 0;
    while ((i = text.indexOf(word, i)) !== -1) { n++; i += word.length; }
    return n;
  }

  /**
   * 扫一段文本，返回 { score, level, len, per1k, hits:[…] }
   * score 是"每千字扣分"，越低越干净。
   */
  function scan(text) {
    const src = String(text || '');
    const len = src.replace(/\s/g, '').length;
    if (len < 60) return { score: 0, level: 'clean', len, per1k: 0, hits: [] };

    const k = len / 1000;
    const hits = [];

    // 句式：命中即报
    PATTERNS.forEach((p) => {
      const m = src.match(p.re) || [];
      if (!m.length) return;
      const uniq = [...new Set(m.map((x) => x.replace(/^[。！？\n]\s*/, '')))];
      hits.push({
        id: p.id, name: p.name,
        count: m.length,
        samples: uniq.slice(0, 4),
        why: p.why, fix: p.fix,
        penalty: p.weight * Math.min(m.length, 4),
      });
    });

    // 明喻：超配额才报。下限给 2 —— 短段落里出现一两次"好像"完全正常，
    // 「整篇不超过 2 次」是给单次回复定的规矩，长章按密度折算更合理。
    const sm = src.match(SIMILE.re) || [];
    const smAllow = Math.max(2, Math.round(SIMILE.quota * k));
    if (sm.length > smAllow) {
      hits.push({
        id: SIMILE.id, name: SIMILE.name,
        count: sm.length, allow: smAllow,
        samples: [...new Set(sm)].slice(0, 4),
        why: SIMILE.why, fix: SIMILE.fix,
        penalty: SIMILE.weight * Math.min(sm.length - smAllow, 5),
      });
    }

    // 滥用词：按密度
    const dense = [];
    CLICHES.forEach((w) => {
      const n = countOf(src, w);
      if (n >= 3) dense.push({ w, n });
    });
    dense.sort((a, b) => b.n - a.n);
    const denseTotal = dense.reduce((n, x) => n + x.n, 0);
    const allowTotal = Math.max(2, Math.round(CLICHE_DENSITY * k));
    if (denseTotal > allowTotal) {
      hits.push({
        id: 'cliche', name: '高频词堆叠',
        count: denseTotal, allow: allowTotal,
        samples: dense.slice(0, 6).map((x) => `${x.w}×${x.n}`),
        why: '这些词不是不能用，是密起来就成了机器味',
        fix: '能换具体说法就换；同一段里不要重复',
        penalty: 3 * Math.min(denseTotal - allowTotal, 6),
      });
    }

    const penalty = hits.reduce((n, h) => n + h.penalty, 0);
    const per1k = Math.round((penalty / Math.max(k, 0.3)) * 10) / 10;
    const level = per1k >= 14 ? 'heavy' : (per1k >= 7 ? 'some' : 'clean');

    return { score: per1k, level, len, per1k, hits };
  }

  /** 一行摘要，给消息标签用 */
  function label(res) {
    if (!res || !res.hits.length) return '';
    return res.level === 'heavy' ? `AI 味重 · ${res.hits.length} 类`
      : `AI 味 ${res.hits.length} 类`;
  }

  /**
   * 整理整章：给正文做一次全文扫描（按整章密度算，比逐段准）
   */
  function scanChapter(text) {
    return scan(text);
  }

  return { scan, scanChapter, label, PATTERNS, CLICHES };
})();
