/**
 * Loader for a directory of LightGBM quantile heads + manifest.json.
 *
 * Layout (matches what training/train.py writes):
 *
 *   models/
 *     manifest.json
 *     <target>_<quantile>.txt        e.g. cost_p50.txt
 *
 * `loadBundle()` reads the manifest, resolves each model file path,
 * and parses them into the `QuantileBundle` shape consumed by
 * `predictBundle()`.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import url from "node:url";
import { loadLightgbmText } from "./gbdt.mjs";

/** Absolute path to the bundled demo model directory. */
export function defaultModelsDir() {
  // src/models/bundle.mjs → ../../models
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "models");
}

/**
 * @typedef {Object} LoadedBundle
 * @property {Object} manifest       — manifest.json content
 * @property {Object<string, {p10:Object, p50:Object, p90:Object}>} heads
 * @property {string} dir
 */

/**
 * @param {string} [dir]   defaults to the bundled demo dir
 * @returns {Promise<LoadedBundle | null>}  null if the dir or manifest is missing
 */
export async function loadBundle(dir) {
  const root = dir ?? defaultModelsDir();
  const manifestPath = path.join(root, "manifest.json");
  if (!existsSync(manifestPath)) return null;

  const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
  const heads = {};

  for (const [tgt, qmap] of Object.entries(manifest.files || {})) {
    heads[tgt] = {};
    for (const [qname, fname] of Object.entries(qmap)) {
      const file = path.join(root, fname);
      if (!existsSync(file)) {
        throw new Error(`bundle ${root}: manifest references missing model ${fname}`);
      }
      heads[tgt][qname] = await loadLightgbmText(file);
    }
  }

  return { manifest, heads, dir: root };
}
