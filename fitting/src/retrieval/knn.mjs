/**
 * Brute-force cosine kNN over sparse TF-IDF vectors.
 *
 * 2.7K-document index → query latency ~5 ms. No need for HNSW etc.
 * If the corpus grows past ~50K we should revisit, but until then
 * a flat scan is the simplest correct thing.
 *
 * The scorer optionally adds metadata boosts on top of the cosine
 * similarity:
 *   + skill_match_boost   (same /skill name)
 *   + same_source_boost   (same provider, e.g. claude-code <-> claude-code)
 *   + recency_boost       (gentle linear decay over N days)
 *
 * These mirror the design doc's "structured features as kNN tie-breakers"
 * idea but stay decoupled from the regression head.
 */

/** Cosine similarity between two sparse vectors with sorted indices. */
export function sparseCosine(a, b) {
  const ai = a.indices, av = a.values;
  const bi = b.indices, bv = b.values;
  let i = 0, j = 0, dot = 0;
  while (i < ai.length && j < bi.length) {
    if (ai[i] === bi[j]) { dot += av[i] * bv[j]; i++; j++; }
    else if (ai[i] < bi[j]) i++;
    else j++;
  }
  // Vectors are L2-normalised at vectorize time, so cosine === dot.
  return dot;
}

/**
 * Holds the embedded corpus and supports kNN queries.
 *
 * @typedef {Object} Boosts
 * @property {number} [skill]       added when the candidate's skill_name === query.skill_name
 * @property {number} [source]      added when source matches
 * @property {number} [recencyMaxDays]  half-cosine recency decay window; 0 = off
 * @property {number} [recencyWeight]   max bonus at zero age
 */
export class KnnIndex {
  /**
   * @param {Array<{indices:number[], values:number[]}>} vectors
   * @param {Array<Object>} metas   parallel metadata array; recommended fields:
   *                                {skill_name, source, timestamp, ...}
   */
  constructor(vectors, metas) {
    if (vectors.length !== metas.length) {
      throw new Error("vectors/metas length mismatch");
    }
    this.vectors = vectors;
    this.metas = metas;
  }

  size() { return this.vectors.length; }

  /**
   * @param {{indices:number[], values:number[]}} qVec
   * @param {Object} qMeta  same shape as constructor metas
   * @param {{k?:number, boosts?:Boosts, minScore?:number, asOf?:Date}} opts
   * @returns {Array<{idx:number, score:number, sim:number, boost:number, meta:Object}>}
   */
  search(qVec, qMeta = {}, opts = {}) {
    const k = opts.k ?? 10;
    const minScore = opts.minScore ?? 0;
    const asOfMs = opts.asOf ? opts.asOf.getTime() : Date.now();
    const boosts = opts.boosts ?? {};
    const skillBoost = boosts.skill ?? 0.15;
    const sourceBoost = boosts.source ?? 0.05;
    const recDays = boosts.recencyMaxDays ?? 30;
    const recWeight = boosts.recencyWeight ?? 0.05;

    const scored = [];
    for (let i = 0; i < this.vectors.length; i++) {
      const meta = this.metas[i];
      // Causal filter: never use anything dated at-or-after the query.
      if (opts.asOf && meta.timestamp && Date.parse(meta.timestamp) >= asOfMs) continue;

      const sim = sparseCosine(qVec, this.vectors[i]);
      let boost = 0;
      if (qMeta.skill_name && meta.skill_name && qMeta.skill_name === meta.skill_name) {
        boost += skillBoost;
      }
      if (qMeta.source && meta.source && qMeta.source === meta.source) {
        boost += sourceBoost;
      }
      if (recDays > 0 && meta.timestamp) {
        const ageDays = (asOfMs - Date.parse(meta.timestamp)) / 86400000;
        if (ageDays >= 0 && ageDays <= recDays) {
          boost += recWeight * (1 - ageDays / recDays);
        }
      }
      const score = sim + boost;
      if (score < minScore) continue;
      scored.push({ idx: i, score, sim, boost, meta });
    }

    // Partial sort: heap would be marginally faster but k is tiny.
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }
}
