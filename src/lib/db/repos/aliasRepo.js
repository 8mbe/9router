import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";

const aliasKv = makeKv("modelAliases");
const customKv = makeKv("customModels");
const mitmKv = makeKv("mitmAlias");

// modelAliases: key=alias, value=modelString
export async function getModelAliases() {
  return await aliasKv.getAll();
}

export async function setModelAlias(alias, model) {
  await aliasKv.set(alias, model);
}

export async function deleteModelAlias(alias) {
  await aliasKv.remove(alias);
}

// customModels: key=`${providerAlias}|${id}|${type}`, value=full model object
function customKey(providerAlias, id, type) {
  return `${providerAlias}|${id}|${type}`;
}

export async function getCustomModels() {
  const all = await customKv.getAll();
  return Object.values(all);
}

// Atomic upsert inside transaction to prevent duplicate races.
// Re-adding an existing model updates caps/name without resetting omitted fields.
// `db` is the already-resolved adapter so a batch can run every entry inside one
// transaction instead of opening one per model.
function upsertCustomModel(db, { providerAlias, id, type = "llm", name, caps, contextLength }) {
  const k = customKey(providerAlias, id, type);
  // null clears a previously stored window; undefined leaves it untouched, so a
  // re-add that only sets caps does not wipe a context length found on import.
  const hasContext = contextLength !== undefined;
  const row = db.get(`SELECT value FROM kv WHERE scope = 'customModels' AND key = ?`, [k]);
  if (row) {
    const prev = parseJson(row.value) || {};
    const next = {
      ...prev,
      ...(name ? { name } : {}),
      ...(caps ? { caps } : {}),
      ...(hasContext ? { contextLength } : {}),
    };
    db.run(`UPDATE kv SET value = ? WHERE scope = 'customModels' AND key = ?`, [stringifyJson(next), k]);
    return false;
  }
  const value = stringifyJson({
    providerAlias, id, type, name: name || id,
    ...(caps ? { caps } : {}),
    ...(hasContext ? { contextLength } : {}),
  });
  db.run(`INSERT INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, value]);
  return true;
}

export async function addCustomModel(entry) {
  const db = await getAdapter();
  let added = false;
  db.transaction(() => { added = upsertCustomModel(db, entry); });
  return added;
}

/**
 * Upsert many models in ONE transaction. Importing a 300-model aggregator list one
 * model at a time meant 300 transactions (and, from the dashboard, 300 round trips);
 * this is the same work as a single write.
 * Returns the number of entries that did not already exist.
 */
export async function addCustomModels(entries) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e?.providerAlias && e?.id);
  if (list.length === 0) return 0;
  const db = await getAdapter();
  let added = 0;
  db.transaction(() => {
    for (const entry of list) {
      if (upsertCustomModel(db, entry)) added += 1;
    }
  });
  return added;
}

export async function deleteCustomModel({ providerAlias, id, type = "llm" }) {
  await customKv.remove(customKey(providerAlias, id, type));
}

// mitmAlias: key=toolName, value=mappings object
export async function getMitmAlias(toolName) {
  if (toolName) {
    const v = await mitmKv.get(toolName);
    return v || {};
  }
  return await mitmKv.getAll();
}

export async function setMitmAliasAll(toolName, mappings) {
  await mitmKv.set(toolName, mappings || {});
}
