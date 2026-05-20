// Data access layer for Kynection GEO Dashboard.
// Uses Supabase when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set;
// otherwise falls back to local JSON files (legacy behaviour).

const fs   = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const USE_SUPABASE = !!(SUPABASE_URL && SUPABASE_KEY);

const AEO_RESULTS_FILE  = process.env.AEO_RESULTS_FILE  || path.join(__dirname, 'aeo-results.json');
const CONTENT_ITEMS_FILE = process.env.CONTENT_ITEMS_FILE || path.join(__dirname, 'content-items.json');

let supabase = null;
if (USE_SUPABASE) {
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
  console.log('🗄️  Persistence: Supabase');
} else {
  console.log('🗄️  Persistence: local JSON files (set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to use Supabase)');
}

// ============================================================
// AEO
// ============================================================

// Returns the same shape as the legacy in-memory object:
//   { [promptId]: { prompt, topic, tag, runs: [...] } }
async function loadAllAeoResults() {
  if (!USE_SUPABASE) {
    try { return JSON.parse(fs.readFileSync(AEO_RESULTS_FILE, 'utf8')); }
    catch (e) { return {}; }
  }

  const [prompts, runs] = await Promise.all([
    supabase.from('aeo_prompts').select('*'),
    supabase.from('aeo_runs').select('*').order('ordinal', { ascending: false })
  ]);
  if (prompts.error) throw prompts.error;
  if (runs.error)    throw runs.error;

  const out = {};
  for (const p of prompts.data || []) {
    out[p.id] = { prompt: p.prompt, topic: p.topic, tag: p.tag, runs: [] };
  }
  for (const r of runs.data || []) {
    if (!out[r.prompt_id]) continue;
    out[r.prompt_id].runs.push(dbRunToMemory(r));
  }
  return out;
}

function dbRunToMemory(r) {
  return {
    _dbId:                r.id,
    _ordinal:             r.ordinal,
    date:                 r.run_date,
    model:                r.model,
    mentioned:            r.mentioned,
    cited:                r.cited,
    attributedCitation:   r.attributed_citation,
    sources:              r.sources,
    competitorsMentioned: r.competitors_mentioned || [],
    mentionPosition:      r.mention_position,
    mentionRank:          r.mention_rank,
    sentiment:            r.sentiment,
    sourceUrls:           r.source_urls || [],
    promptType:           r.prompt_type,
    prompt:               r.prompt_text,
    response:             r.response
  };
}

function memoryRunToDb(promptId, run, ordinal) {
  return {
    prompt_id:             promptId,
    run_date:              run.date || null,
    model:                 run.model || null,
    mentioned:             !!run.mentioned,
    cited:                 !!run.cited,
    attributed_citation:   !!run.attributedCitation,
    sources:               !!run.sources,
    competitors_mentioned: run.competitorsMentioned || [],
    mention_position:      run.mentionPosition || null,
    mention_rank:          run.mentionRank ?? null,
    sentiment:             run.sentiment || null,
    source_urls:           run.sourceUrls || [],
    prompt_type:           run.promptType || null,
    prompt_text:           run.prompt || null,
    response:              run.response || null,
    ordinal
  };
}

// Ensure prompt row exists.
async function upsertAeoPrompt(promptId, { prompt, topic, tag }) {
  if (!USE_SUPABASE) return; // legacy path persists via saveAllAeoResults
  const { error } = await supabase
    .from('aeo_prompts')
    .upsert({ id: promptId, prompt, topic: topic || null, tag: tag || null });
  if (error) throw error;
}

// Insert a single new run (used by streaming).
// Mutates `run` in place to attach `_dbId` + `_ordinal`.
async function insertAeoRun(promptId, run) {
  if (!USE_SUPABASE) return; // legacy path persists the whole file
  const ordinal = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  const payload = memoryRunToDb(promptId, run, ordinal);
  const { data, error } = await supabase
    .from('aeo_runs').insert(payload).select('id, ordinal').single();
  if (error) throw error;
  run._dbId    = data.id;
  run._ordinal = data.ordinal;
}

// Delete runs by their _dbId values.
async function deleteAeoRuns(dbIds) {
  if (!USE_SUPABASE || !dbIds.length) return;
  const { error } = await supabase.from('aeo_runs').delete().in('id', dbIds);
  if (error) throw error;
}

// Bulk update many runs (used by backfill).
async function updateAeoRuns(updates) {
  if (!USE_SUPABASE || !updates.length) return;
  // Supabase JS has no batch update by id, but upsert with primary key works.
  // Build minimal rows: { id, ...fields_to_update }
  const { error } = await supabase.from('aeo_runs').upsert(updates);
  if (error) throw error;
}

// Replace the entire dataset (used by migration script + JSON fallback save).
async function saveAllAeoResults(aeoResults) {
  if (!USE_SUPABASE) {
    try { fs.writeFileSync(AEO_RESULTS_FILE, JSON.stringify(aeoResults)); } catch(e) {}
    return;
  }

  // For Supabase we don't do a full nuke-and-replace here — too expensive and
  // racy. The runtime mutation paths call insertAeoRun / deleteAeoRuns /
  // updateAeoRuns directly. This function exists only for the migration tool.
  const promptRows = [];
  const runRows    = [];
  for (const [id, data] of Object.entries(aeoResults || {})) {
    promptRows.push({ id, prompt: data.prompt, topic: data.topic || null, tag: data.tag || null });
    const runs = data.runs || [];
    // Earliest run gets lowest ordinal; latest gets highest. Reverse so the
    // unshift order is preserved (latest first when ordered DESC).
    for (let i = 0; i < runs.length; i++) {
      const ordinal = runs.length - i; // highest = newest (front of array)
      runRows.push(memoryRunToDb(id, runs[i], ordinal));
    }
  }
  // Chunk to stay under PostgREST request-size limits
  const chunk = (arr, n) => arr.reduce((acc, _, i) => (i % n ? acc : [...acc, arr.slice(i, i+n)]), []);
  for (const c of chunk(promptRows, 500)) {
    const { error } = await supabase.from('aeo_prompts').upsert(c);
    if (error) throw error;
  }
  for (const c of chunk(runRows, 500)) {
    const { error } = await supabase.from('aeo_runs').insert(c);
    if (error) throw error;
  }
}

// ============================================================
// Content items
// ============================================================

async function listContentItems() {
  if (!USE_SUPABASE) {
    try { return JSON.parse(fs.readFileSync(CONTENT_ITEMS_FILE, 'utf8')); }
    catch (e) { return []; }
  }
  const { data, error } = await supabase
    .from('content_items')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(dbContentToMemory);
}

async function getContentItem(id) {
  if (!USE_SUPABASE) {
    const items = await listContentItems();
    return items.find(i => i.id === id) || null;
  }
  const { data, error } = await supabase.from('content_items').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? dbContentToMemory(data) : null;
}

async function insertContentItems(items) {
  if (!USE_SUPABASE) {
    const all = await listContentItems();
    items.forEach(it => all.unshift(it));
    fs.writeFileSync(CONTENT_ITEMS_FILE, JSON.stringify(all, null, 2));
    return;
  }
  const rows = items.map(memoryContentToDb);
  const { error } = await supabase.from('content_items').insert(rows);
  if (error) throw error;
}

async function updateContentItem(id, patch) {
  if (!USE_SUPABASE) {
    const all = await listContentItems();
    const idx = all.findIndex(i => i.id === id);
    if (idx === -1) return null;
    Object.assign(all[idx], patch);
    fs.writeFileSync(CONTENT_ITEMS_FILE, JSON.stringify(all, null, 2));
    return all[idx];
  }
  const dbPatch = memoryContentToDb({ id, ...patch }, /*onlyProvided*/ true);
  delete dbPatch.id; // never update primary key
  delete dbPatch.created_at; // immutable
  const { data, error } = await supabase
    .from('content_items')
    .update(dbPatch)
    .eq('id', id)
    .select('*')
    .maybeSingle();
  if (error) throw error;
  return data ? dbContentToMemory(data) : null;
}

async function deleteContentItem(id) {
  if (!USE_SUPABASE) {
    const all = await listContentItems();
    const before = all.length;
    const filtered = all.filter(i => i.id !== id);
    if (filtered.length === before) return false;
    fs.writeFileSync(CONTENT_ITEMS_FILE, JSON.stringify(filtered, null, 2));
    return true;
  }
  const { error, count } = await supabase
    .from('content_items')
    .delete({ count: 'exact' })
    .eq('id', id);
  if (error) throw error;
  return (count || 0) > 0;
}

function dbContentToMemory(row) {
  return {
    id:         row.id,
    url:        row.url,
    title:      row.title || '',
    snipeType:  row.snipe_type || null,
    snipe:      row.snipe || undefined,
    cost:       row.cost || undefined,
    createdAt:  row.created_at
  };
}

function memoryContentToDb(item, onlyProvided = false) {
  const row = {};
  if (!onlyProvided || 'id' in item)         row.id         = item.id;
  if (!onlyProvided || 'url' in item)        row.url        = item.url;
  if (!onlyProvided || 'title' in item)      row.title      = item.title ?? '';
  if (!onlyProvided || 'snipeType' in item)  row.snipe_type = item.snipeType ?? null;
  if (!onlyProvided || 'snipe' in item)      row.snipe      = item.snipe ?? null;
  if (!onlyProvided || 'cost' in item)       row.cost       = item.cost ?? null;
  if (!onlyProvided && item.createdAt)       row.created_at = item.createdAt;
  return row;
}

module.exports = {
  USE_SUPABASE,
  loadAllAeoResults,
  upsertAeoPrompt,
  insertAeoRun,
  deleteAeoRuns,
  updateAeoRuns,
  saveAllAeoResults,
  listContentItems,
  getContentItem,
  insertContentItems,
  updateContentItem,
  deleteContentItem
};
