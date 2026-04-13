/**
 * Mixed Latin / CJK tokenizer.
 *
 * - Latin runs are split on non-alphanumerics, lowercased
 * - CJK runs are emitted as character bigrams (two-char windows)
 *
 * Bigrams give the IDF model enough signal to discriminate Chinese
 * task descriptions without pulling a real CJK segmenter (jieba etc.)
 * which would add a multi-MB dictionary.
 *
 * Common stopwords are dropped so they don't dominate the vocabulary.
 */

const CJK_RE = /[\u4e00-\u9fff]/;
const STOP_LATIN = new Set([
  "the", "a", "an", "of", "to", "in", "on", "for", "with", "and", "or",
  "is", "are", "was", "were", "be", "been", "being", "i", "you", "we",
  "this", "that", "it", "its", "as", "at", "by", "from", "if", "so",
  "do", "does", "did", "have", "has", "had", "can", "could", "would",
  "should", "will", "shall", "may", "might", "but", "not", "no", "yes",
  "me", "my", "your", "our", "their", "them", "us", "he", "she", "his",
  "her", "him", "they",
]);
const STOP_CJK = new Set([
  "的", "了", "是", "我", "你", "他", "她", "它", "在", "有", "和",
  "就", "也", "都", "把", "被", "对", "从", "向", "为", "与", "及",
  "或", "但", "却", "因", "所", "之", "那", "这", "些", "什", "么",
  "吗", "呢", "啊", "吧", "嗯",
]);

function normalize(text) {
  return (text || "").toLowerCase();
}

/**
 * @param {string} text
 * @param {{cjkBigram?:boolean, dropStopwords?:boolean, minLen?:number, maxTokens?:number}} opts
 * @returns {string[]}
 */
export function tokenize(text, opts = {}) {
  const cjkBigram = opts.cjkBigram ?? true;
  const dropStopwords = opts.dropStopwords ?? true;
  const minLen = opts.minLen ?? 2;
  const maxTokens = opts.maxTokens ?? 4096;

  const s = normalize(text);
  if (!s) return [];

  const tokens = [];
  let buf = ""; // Latin run buffer
  let cjkRun = ""; // CJK run buffer

  function flushLatin() {
    if (!buf) return;
    for (const w of buf.split(/[^a-z0-9_]+/)) {
      if (w.length < minLen) continue;
      if (dropStopwords && STOP_LATIN.has(w)) continue;
      tokens.push(w);
      if (tokens.length >= maxTokens) return;
    }
    buf = "";
  }
  function flushCjk() {
    if (!cjkRun) return;
    if (cjkBigram && cjkRun.length >= 2) {
      for (let i = 0; i < cjkRun.length - 1; i++) {
        const bg = cjkRun.slice(i, i + 2);
        // Drop bigrams that are pure stopword duplicates ("的的", etc.)
        if (dropStopwords && STOP_CJK.has(bg[0]) && STOP_CJK.has(bg[1])) continue;
        tokens.push(bg);
        if (tokens.length >= maxTokens) return;
      }
    } else {
      for (const ch of cjkRun) {
        if (dropStopwords && STOP_CJK.has(ch)) continue;
        tokens.push(ch);
        if (tokens.length >= maxTokens) return;
      }
    }
    cjkRun = "";
  }

  for (const ch of s) {
    if (CJK_RE.test(ch)) {
      flushLatin();
      cjkRun += ch;
    } else {
      flushCjk();
      buf += ch;
    }
    if (tokens.length >= maxTokens) break;
  }
  flushLatin();
  flushCjk();

  return tokens;
}
