// Data access layer for the GEO Dashboard (multi-tenant).
//
// Tenant routing uses Node's AsyncLocalStorage — every Express request goes
// through tenantStorage.run(req.tenant, next) middleware so that any db.js
// function called downstream (even deeply nested in async chains) can ask
// `currentClient()` and get the right tenant's Supabase client without
// having to thread `tenant` through every function signature.
//
// Lookup order for each tenant's client:
//   1. <TENANT>_SUPABASE_URL + <TENANT>_SUPABASE_SERVICE_ROLE_KEY
//   2. SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (legacy / Kynection default)
//   3. null  →  callers fall back to local JSON files

const fs   = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { createClient } = require('@supabase/supabase-js');

// Tenant context carried through async operations.
const tenantStorage = new AsyncLocalStorage();
function currentTenant() { return tenantStorage.getStore() || 'kyn'; }
function currentClient() { return getClient(currentTenant()); }
function currentUseSupabase() { return !!currentClient(); }
// Run a function with an explicit tenant set on the storage (used by startup
// hydration code that runs outside any HTTP request).
function forTenant(tenant, fn) { return tenantStorage.run(tenant, fn); }

// Per-tenant Supabase data clients. Auth stays with the primary (Kynection)
// Supabase — see auth.js. Each tenant's *data* (aeo runs, content items,
// competitors, stream history, api cache) lives in its own Supabase project
// so the two dashboards stay cleanly isolated.
//
// Resolution per tenant:
//   1. <TENANT>_SUPABASE_URL + <TENANT>_SUPABASE_SERVICE_ROLE_KEY
//   2. SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (legacy / Kynection default)
//   3. Fall back to JSON files (no creds set)
const _clients = {};           // tenant -> Supabase client (cached)
const _persistenceLogged = {}; // tenant -> bool (once-per-tenant startup log)

function getClient(tenant = 'kyn') {
  if (_clients[tenant] !== undefined) return _clients[tenant];
  const prefix = tenant.toUpperCase() + '_';
  const url = process.env[prefix + 'SUPABASE_URL'] || process.env.SUPABASE_URL;
  const key = process.env[prefix + 'SUPABASE_SERVICE_ROLE_KEY'] || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) {
    _clients[tenant] = createClient(url, key, { auth: { persistSession: false } });
    if (!_persistenceLogged[tenant]) {
      console.log(`🗄️  Persistence [${tenant}]: Supabase`);
      _persistenceLogged[tenant] = true;
    }
  } else {
    _clients[tenant] = null;
    if (!_persistenceLogged[tenant]) {
      console.log(`🗄️  Persistence [${tenant}]: local JSON files (set ${prefix}SUPABASE_URL + ${prefix}SUPABASE_SERVICE_ROLE_KEY to use Supabase)`);
      _persistenceLogged[tenant] = true;
    }
  }
  return _clients[tenant];
}

// Eagerly create the default tenant's client so the existing log line still
// prints at boot. Other tenants are lazy on first use.
getClient('kyn');

// Tenant-specific JSON file paths (kept for fallback when Supabase isn't
// configured for that tenant — only the Kynection legacy path is used).
function aeoResultsFile(tenant) {
  if (tenant === 'kyn') return process.env.AEO_RESULTS_FILE || path.join(__dirname, 'aeo-results.json');
  return path.join(__dirname, `aeo-results-${tenant}.json`);
}
function contentItemsFile(tenant) {
  if (tenant === 'kyn') return process.env.CONTENT_ITEMS_FILE || path.join(__dirname, 'content-items.json');
  return path.join(__dirname, `content-items-${tenant}.json`);
}

const AEO_RESULTS_FILE  = aeoResultsFile('kyn');
const CONTENT_ITEMS_FILE = contentItemsFile('kyn');

// USE_SUPABASE used to be a module-level constant for the single tenant. Kept
// as a property accessor for legacy callers that branch on it — now reports
// whether *Kynection* has Supabase configured. Tenant-aware code paths below
// take a tenant arg and use getClient(tenant) directly.
const USE_SUPABASE = !!getClient('kyn');

// `supabase` is the legacy global pointer used by some helpers that haven't
// been refactored to take a tenant arg yet. Maps to the Kynection client.
const supabase = getClient('kyn');

// ============================================================
// AEO
// ============================================================

// Returns the same shape as the legacy in-memory object:
//   { [promptId]: { prompt, topic, tag, runs: [...] } }
async function loadAllAeoResults() {
  if (!currentClient()) {
    try { return JSON.parse(fs.readFileSync(aeoResultsFile(currentTenant()), 'utf8')); }
    catch (e) { return {}; }
  }

  const [prompts, runs] = await Promise.all([
    currentClient().from('aeo_prompts').select('*'),
    currentClient().from('aeo_runs').select('*').order('ordinal', { ascending: false })
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
  if (!currentClient()) return; // legacy path persists via saveAllAeoResults
  const { error } = await currentClient()
    .from('aeo_prompts')
    .upsert({ id: promptId, prompt, topic: topic || null, tag: tag || null });
  if (error) throw error;
}

// Insert a single new run (used by streaming).
// Mutates `run` in place to attach `_dbId` + `_ordinal`.
async function insertAeoRun(promptId, run) {
  if (!currentClient()) return; // legacy path persists the whole file
  const ordinal = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  const payload = memoryRunToDb(promptId, run, ordinal);
  const { data, error } = await currentClient()
    .from('aeo_runs').insert(payload).select('id, ordinal').single();
  if (error) throw error;
  run._dbId    = data.id;
  run._ordinal = data.ordinal;
}

// Delete runs by their _dbId values.
async function deleteAeoRuns(dbIds) {
  if (!currentClient() || !dbIds.length) return;
  const { error } = await currentClient().from('aeo_runs').delete().in('id', dbIds);
  if (error) throw error;
}

// Bulk update many runs (used by backfill).
async function updateAeoRuns(updates) {
  if (!currentClient() || !updates.length) return;
  // Supabase JS has no batch update by id, but upsert with primary key works.
  // Build minimal rows: { id, ...fields_to_update }
  const { error } = await currentClient().from('aeo_runs').upsert(updates);
  if (error) throw error;
}

// Replace the entire dataset (used by migration script + JSON fallback save).
async function saveAllAeoResults(aeoResults) {
  if (!currentClient()) {
    try { fs.writeFileSync(aeoResultsFile(currentTenant()), JSON.stringify(aeoResults)); } catch(e) {}
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
    const { error } = await currentClient().from('aeo_prompts').upsert(c);
    if (error) throw error;
  }
  for (const c of chunk(runRows, 500)) {
    const { error } = await currentClient().from('aeo_runs').insert(c);
    if (error) throw error;
  }
}

// ============================================================
// Content items
// ============================================================

async function listContentItems() {
  if (!currentClient()) {
    try { return JSON.parse(fs.readFileSync(contentItemsFile(currentTenant()), 'utf8')); }
    catch (e) { return []; }
  }
  const { data, error } = await currentClient()
    .from('content_items')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(dbContentToMemory);
}

async function getContentItem(id) {
  if (!currentClient()) {
    const items = await listContentItems();
    return items.find(i => i.id === id) || null;
  }
  const { data, error } = await currentClient().from('content_items').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? dbContentToMemory(data) : null;
}

async function insertContentItems(items) {
  if (!currentClient()) {
    const all = await listContentItems();
    items.forEach(it => all.unshift(it));
    fs.writeFileSync(contentItemsFile(currentTenant()), JSON.stringify(all, null, 2));
    return;
  }
  const rows = items.map(memoryContentToDb);
  const { error } = await currentClient().from('content_items').insert(rows);
  if (error) throw error;
}

async function updateContentItem(id, patch) {
  if (!currentClient()) {
    const all = await listContentItems();
    const idx = all.findIndex(i => i.id === id);
    if (idx === -1) return null;
    Object.assign(all[idx], patch);
    fs.writeFileSync(contentItemsFile(currentTenant()), JSON.stringify(all, null, 2));
    return all[idx];
  }
  const dbPatch = memoryContentToDb({ id, ...patch }, /*onlyProvided*/ true);
  delete dbPatch.id; // never update primary key
  delete dbPatch.created_at; // immutable
  const { data, error } = await currentClient()
    .from('content_items')
    .update(dbPatch)
    .eq('id', id)
    .select('*')
    .maybeSingle();
  if (error) throw error;
  return data ? dbContentToMemory(data) : null;
}

async function deleteContentItem(id) {
  if (!currentClient()) {
    const all = await listContentItems();
    const before = all.length;
    const filtered = all.filter(i => i.id !== id);
    if (filtered.length === before) return false;
    fs.writeFileSync(contentItemsFile(currentTenant()), JSON.stringify(filtered, null, 2));
    return true;
  }
  const { error, count } = await currentClient()
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

// ============================================================
// Competitors (tracked brands looked for in AEO responses + SEMrush)
// ============================================================

async function listCompetitors({ activeOnly = true } = {}) {
  if (!currentClient()) return [];
  let q = currentClient().from('competitors').select('*').order('display_name', { ascending: true });
  if (activeOnly) q = q.eq('is_active', true);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function addCompetitor({ domain, display_name, added_by }) {
  if (!currentClient()) return null;
  const cleanDomain = String(domain).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  if (!cleanDomain || !cleanDomain.includes('.')) throw new Error('Invalid domain: ' + domain);
  const cleanName = (display_name && display_name.trim()) || cleanDomain.split('.')[0].replace(/\b\w/g, c => c.toUpperCase());
  const { data, error } = await currentClient()
    .from('competitors')
    .upsert({ domain: cleanDomain, display_name: cleanName, is_active: true, added_by: added_by || null }, { onConflict: 'domain' })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function deleteCompetitor(id) {
  if (!currentClient()) return false;
  const { error, count } = await currentClient().from('competitors').delete({ count: 'exact' }).eq('id', id);
  if (error) throw error;
  return (count || 0) > 0;
}

async function setCompetitorActive(id, isActive) {
  if (!currentClient()) return null;
  const { data, error } = await currentClient().from('competitors').update({ is_active: !!isActive }).eq('id', id).select('*').maybeSingle();
  if (error) throw error;
  return data;
}

// First-boot seed: if the competitors table is empty, populate it with the
// legacy hardcoded list so nothing breaks for existing deploys.
async function seedCompetitorsIfEmpty(legacyDomainMap) {
  if (!currentClient()) return;
  const { count, error } = await currentClient().from('competitors').select('*', { count: 'exact', head: true });
  if (error) { console.warn('competitors seed check failed:', error.message); return; }
  if (count > 0) return;
  const rows = Object.entries(legacyDomainMap).map(([domain, display_name]) => ({
    domain, display_name, is_active: true, added_by: 'system-seed'
  }));
  if (!rows.length) return;
  const { error: insErr } = await currentClient().from('competitors').insert(rows);
  if (insErr) console.warn('competitors seed insert failed:', insErr.message);
  else console.log(`🌱 Seeded ${rows.length} default competitors`);
}

// ============================================================
// Stream history
// ============================================================

async function listStreamHistory(limit = 100) {
  if (!currentClient()) return [];
  const { data, error } = await currentClient()
    .from('stream_history')
    .select('*')
    .order('ran_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

async function recordStreamHistory({ run_date, prompts_count, models, runs_count, source = 'manual', note = null }) {
  if (!currentClient()) return null;
  const { data, error } = await currentClient()
    .from('stream_history')
    .insert({ run_date, prompts_count, models, runs_count, source, note })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function updateStreamHistoryNote(id, note) {
  if (!currentClient()) return null;
  const { data, error } = await currentClient()
    .from('stream_history')
    .update({ note })
    .eq('id', id)
    .select('*')
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function deleteStreamHistoryEntry(id) {
  if (!currentClient()) return false;
  const { error, count } = await currentClient()
    .from('stream_history')
    .delete({ count: 'exact' })
    .eq('id', id);
  if (error) throw error;
  return (count || 0) > 0;
}

// ============================================================
// Generic API response cache (SEMrush, PageSpeed, YouTube, etc.)
// L1: in-process Map keyed by cache_key
// L2: Supabase api_cache table (persists across restarts)
// TTL is applied at read time so we don't need a sweeper job.
// If the api_cache table doesn't exist yet, L2 silently no-ops.
// ============================================================
const _l1 = new Map(); // cache_key -> { data, ts }
let _cacheTableMissing = false; // sticky after the first 42P01

async function cacheGet(cacheKey, ttlSeconds) {
  const ttlMs = ttlSeconds * 1000;
  const now = Date.now();

  // L1
  const mem = _l1.get(cacheKey);
  if (mem && now - mem.ts < ttlMs) return mem.data;

  // L2 — Supabase
  if (!currentClient() || _cacheTableMissing) return null;
  try {
    const { data, error } = await supabase
      .from('api_cache')
      .select('data, cached_at')
      .eq('cache_key', cacheKey)
      .maybeSingle();
    if (error) {
      if (error.code === '42P01' || /api_cache/.test(error.message || '')) _cacheTableMissing = true;
      return null;
    }
    if (!data) return null;
    const ts = new Date(data.cached_at).getTime();
    if (now - ts >= ttlMs) return null;
    _l1.set(cacheKey, { data: data.data, ts });
    return data.data;
  } catch (e) { return null; }
}

async function cacheSet(cacheKey, scope, data) {
  _l1.set(cacheKey, { data, ts: Date.now() });
  if (!currentClient() || _cacheTableMissing) return;
  try {
    const { error } = await supabase
      .from('api_cache')
      .upsert({ cache_key: cacheKey, scope, data, cached_at: new Date().toISOString() });
    if (error) {
      if (error.code === '42P01' || /api_cache/.test(error.message || '')) _cacheTableMissing = true;
    }
  } catch (e) { /* swallow — cache is best-effort */ }
}

// Read-but-allow-stale: same as cacheGet but also returns the stale row if
// the TTL has expired, so callers can fall back to it when the live API fails.
async function cacheGetWithStale(cacheKey, ttlSeconds) {
  const ttlMs = ttlSeconds * 1000;
  const now = Date.now();
  const mem = _l1.get(cacheKey);
  if (mem) return { data: mem.data, ts: mem.ts, fresh: now - mem.ts < ttlMs };
  if (!currentClient() || _cacheTableMissing) return null;
  try {
    const { data, error } = await supabase
      .from('api_cache')
      .select('data, cached_at')
      .eq('cache_key', cacheKey)
      .maybeSingle();
    if (error || !data) {
      if (error?.code === '42P01' || /api_cache/.test(error?.message || '')) _cacheTableMissing = true;
      return null;
    }
    const ts = new Date(data.cached_at).getTime();
    _l1.set(cacheKey, { data: data.data, ts });
    return { data: data.data, ts, fresh: now - ts < ttlMs };
  } catch (e) { return null; }
}

module.exports = {
  // Tenant context
  tenantStorage,
  forTenant,
  currentTenant,
  getClient,
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
  deleteContentItem,
  listCompetitors,
  addCompetitor,
  deleteCompetitor,
  setCompetitorActive,
  seedCompetitorsIfEmpty,
  listStreamHistory,
  recordStreamHistory,
  updateStreamHistoryNote,
  deleteStreamHistoryEntry,
  cacheGet,
  cacheSet,
  cacheGetWithStale
};
