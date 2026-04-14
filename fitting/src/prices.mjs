/**
 * Shared pricing constants.
 *
 * Single source of truth for per-million-token prices used by the
 * Predictor, evaluation scripts, and Python trainer. If you update
 * prices here, also mirror them into training/train.py:COST_PRICES.
 */

/** Sonnet 4.6 prices — canonical "what one task cost" for benchmarks. */
export const SONNET = Object.freeze({
  input: 3,
  output: 15,
  cache_read: 0.30,
});

/** Compute USD cost at Sonnet 4.6 prices for a token breakdown. */
export function sonnetCost(tokens) {
  return ((tokens.input || 0) * SONNET.input
        + (tokens.output || 0) * SONNET.output
        + (tokens.cache_read || 0) * SONNET.cache_read) / 1_000_000;
}

/** Compute USD cost from a Task record at Sonnet 4.6 prices. */
export function costFromTask(task) {
  return sonnetCost({
    input: task.token_usage.input,
    output: task.token_usage.output,
    cache_read: task.token_usage.cache_read,
  });
}

/** Full provider table for multi-provider cost comparison. */
export const PROVIDERS = Object.freeze([
  { name: "Claude Sonnet 4.6",  input: 3,    output: 15,   cache_read: 0.30 },
  { name: "Claude Opus 4.6",    input: 5,    output: 25,   cache_read: 0.50 },
  { name: "Claude Haiku 4.5",   input: 1,    output: 5,    cache_read: 0.10 },
  { name: "GPT-5.4",            input: 2.5,  output: 15,   cache_read: 0    },
  { name: "GPT-5.2 Codex",      input: 1.07, output: 8.5,  cache_read: 0    },
  { name: "Gemini 2.5 Pro",     input: 1.25, output: 5,    cache_read: 0    },
  { name: "Gemini 2.5 Flash",   input: 0.15, output: 0.6,  cache_read: 0    },
]);

/** Compute cost at a specific provider's rates. */
export function priceCost(provider, tokens) {
  return ((tokens.input || 0) * provider.input
        + (tokens.output || 0) * provider.output
        + (tokens.cache_read || 0) * provider.cache_read) / 1_000_000;
}
