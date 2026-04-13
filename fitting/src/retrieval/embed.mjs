/**
 * TF-IDF vectorizer with sublinear TF and L2 normalisation.
 *
 * Stays purely in-process and dependency-free — fits a 2.7K-document
 * corpus in <500 ms on a laptop. Vectors are sparse Maps so we never
 * materialise the full vocabulary × document matrix.
 *
 * The same interface (fit / transform / vocab size) makes it possible
 * to swap a real sentence-transformer in later without touching the
 * kNN or downstream layers — they only ever see {indices, values}.
 */

import { tokenize } from "./tokenizer.mjs";

/** Sublinear term frequency: 1 + log(count). */
function sublinearTf(count) {
  return 1 + Math.log(count);
}

/** L2-normalise a sparse vector in place. Returns the same vector. */
function l2NormalizeSparse(vec) {
  let norm = 0;
  for (const v of vec.values()) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (const [k, v] of vec) vec.set(k, v / norm);
  }
  return vec;
}

export class TfidfVectorizer {
  constructor(opts = {}) {
    this.minDf = opts.minDf ?? 2;          // term must appear in ≥ this many docs
    this.maxDfRatio = opts.maxDfRatio ?? 0.6; // drop terms in > this fraction of docs
    this.tokenize = opts.tokenize ?? tokenize;
    this.tokenizerOpts = opts.tokenizerOpts ?? {};
    /** @type {Map<string, number>} term -> column index */
    this.vocab = new Map();
    /** @type {number[]} idf indexed by column */
    this.idf = [];
    this.nDocs = 0;
  }

  /** Fit on a corpus of strings. */
  fit(corpus) {
    const df = new Map();
    let n = 0;
    for (const doc of corpus) {
      const seen = new Set();
      for (const tok of this.tokenize(doc, this.tokenizerOpts)) {
        if (seen.has(tok)) continue;
        seen.add(tok);
        df.set(tok, (df.get(tok) || 0) + 1);
      }
      n++;
    }
    this.nDocs = n;
    const maxDf = Math.floor(this.maxDfRatio * n);
    let col = 0;
    for (const [term, freq] of df) {
      if (freq < this.minDf) continue;
      if (freq > maxDf) continue;
      this.vocab.set(term, col);
      // Smoothed IDF — prevents log(1) from zeroing common terms.
      this.idf.push(Math.log((1 + n) / (1 + freq)) + 1);
      col++;
    }
    return this;
  }

  /**
   * Vectorize one document into a sparse representation.
   * @param {string} doc
   * @returns {{indices:number[], values:number[]}}
   */
  transform(doc) {
    const counts = new Map();
    for (const tok of this.tokenize(doc, this.tokenizerOpts)) {
      counts.set(tok, (counts.get(tok) || 0) + 1);
    }
    /** @type {Map<number,number>} */
    const vec = new Map();
    for (const [term, c] of counts) {
      const col = this.vocab.get(term);
      if (col === undefined) continue;
      vec.set(col, sublinearTf(c) * this.idf[col]);
    }
    l2NormalizeSparse(vec);
    // Emit as parallel arrays sorted by index — kNN consumes sorted form.
    const indices = [...vec.keys()].sort((a, b) => a - b);
    const values = indices.map((i) => vec.get(i));
    return { indices, values };
  }

  /** Convenience: fit and transform a corpus into sparse vectors. */
  fitTransform(corpus) {
    this.fit(corpus);
    return corpus.map((d) => this.transform(d));
  }

  /** Diagnostics. */
  stats() {
    return {
      n_docs: this.nDocs,
      vocab_size: this.vocab.size,
      idf_min: Math.min(...this.idf),
      idf_max: Math.max(...this.idf),
    };
  }
}
