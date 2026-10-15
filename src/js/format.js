/* ════════════════════════════════════════════
   临文录 · 排版整理
   分几次续接出来的正文，接缝处常见四类毛病：
     ① 标点不统一（... 与 ……、英文引号与「」混用）
     ② 段落没分开，或者空行忽多忽少
     ③ 同一段被写了两遍（续接时重发了上文）
     ④ 段内被硬换行切碎
   这里全部本地处理，不调用模型，立刻见效。
   ════════════════════════════════════════════ */

const Format = (() => {
  const PUNCT = /[\s，。！？；：、""''「」『』（）—－…·\n]/g;

  /** 去标点去空白，用来判断两段是不是在说同一件事 */
  function bare(s) {
    return String(s || '').replace(PUNCT, '');
  }

  /** 重复判定：完全同 / 短的被长的包住 / 首尾大段重叠
      这里的核心场景就是「续接时把上文重发了一遍」——
      上一段和这一段的开头重复，所以要认前缀包含，而不只是全等。 */
  function similar(a, b) {
    const na = bare(a), nb = bare(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    const s = na.length <= nb.length ? na : nb;
    const l = na.length <= nb.length ? nb : na;
    // 短的整个出现在长的里
    if (s.length >= 6 && l.includes(s)) return true;
    // 首尾重叠八成以上
    const k = Math.floor(s.length * 0.8);
    if (k >= 6 && (l.startsWith(s.slice(0, k)) || l.endsWith(s.slice(-k)))) return true;
    return false;
  }

  /** 统一标点 */
  function tidyPunct(t) {
    return t
      .replace(/\.{3,}/g, '……')
      .replace(/…{3,}/g, '……')
      .replace(/(?<!—)-{2,}(?!—)/g, '——')
      .replace(/~{2,}/g, '——')
      .replace(/"([^"\n]{1,120})"/g, '「$1」')
      .replace(/'([^'\n]{1,60})'/g, '「$1」')
      .replace(/[ \t]+([，。！？；：、）】」』…—])/g, '$1')
      .replace(/([（【「『])[ \t]+/g, '$1')
      .replace(/[ \t]{2,}/g, ' ');
  }

  /** 主入口：返回整理后的全文 */
  function tidy(text) {
    let t = String(text || '').replace(/\r\n?/g, '\n');
    t = tidyPunct(t);

    let paras = t.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

    // 整篇没有空行（一次生成的常见形态）→ 按行切
    if (paras.length <= 1 && t.includes('\n')) {
      paras = t.split('\n').map((p) => p.trim()).filter(Boolean);
    }

    const out = [];
    const seen = new Set();
    for (let p of paras) {
      // 段内硬换行合并回一段，多余空格压掉
      p = p.replace(/\s*\n\s*/g, '').replace(/[ \t]{2,}/g, ' ').trim();
      if (!p) continue;
      const key = bare(p);
      if (key.length >= 6 && seen.has(key)) continue;                 // 全文重复
      if (out.length && similar(out[out.length - 1], p)) continue;    // 与上一段重复
      seen.add(key);
      out.push(p);
    }

    return out.join('\n\n');
  }

  /** 给用户看的改动摘要 */
  function diffSummary(before, after) {
    const cnt = (s) => String(s || '').split(/\n\s*\n/).filter((x) => x.trim()).length;
    const ch = (s) => String(s || '').replace(/\s/g, '').length;
    const b = cnt(before), a = cnt(after);
    return {
      beforeParas: b, afterParas: a,
      merged: Math.max(0, b - a),
      beforeChars: ch(before), afterChars: ch(after),
      changed: before !== after,
    };
  }

  /** 找出最像「重复」的那些段，给用户看一眼 */
  function findDupes(text) {
    const paras = String(text || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    const hits = [];
    for (let i = 0; i < paras.length; i++) {
      for (let j = i + 1; j < paras.length; j++) {
        if (similar(paras[i], paras[j])) {
          hits.push({ i, j, text: paras[j].slice(0, 40) });
          break;
        }
      }
    }
    return hits;
  }

  return { tidy, tidyPunct, similar, bare, diffSummary, findDupes };
})();
