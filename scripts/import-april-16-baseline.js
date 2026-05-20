// One-shot: import the latest run per prompt (all dated 2026-04-16) from
// aeo-results-4017.json into Supabase aeo_runs, plus a single stream_history
// entry tagged with an explanatory note. Idempotent: skips prompts that
// already have a 2026-04-16 run in Supabase.
//
// Run:  node scripts/import-april-16-baseline.js

const path = require('path');
const fs   = require('fs');

// Load .env
try {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
      const t = line.trim(); if (!t || t.startsWith('#')) return;
      const i = t.indexOf('='); if (i < 1) return;
      const k = t.slice(0, i).trim();
      const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
      if (k && !(k in process.env)) process.env[k] = v;
    });
  }
} catch(e) {}

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  process.exit(1);
}

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

const SOURCE_FILE = path.join(__dirname, '..', 'aeo-results-4017.json');
const TARGET_DATE = '2026-04-16';
const HISTORY_NOTE = 'Imported from pre-dashboard snapshot. Latest run per prompt from 2026-04-16. Use this as a baseline for period-comparison vs streams run after the dashboard went live.';

async function main() {
  console.log('━━━ Import April 16 baseline ━━━');

  if (!fs.existsSync(SOURCE_FILE)) {
    console.error('❌ ' + SOURCE_FILE + ' not found');
    process.exit(1);
  }

  // Idempotency: skip if any 2026-04-16 runs already exist
  const { count, error: cntErr } = await supabase
    .from('aeo_runs').select('*', { count: 'exact', head: true }).eq('run_date', TARGET_DATE);
  if (cntErr) throw cntErr;
  if (count > 0) {
    console.log(`⚠️  ${count} rows with run_date=${TARGET_DATE} already exist in aeo_runs. Aborting to avoid duplicates.`);
    console.log('    If you want to re-import, delete those rows first:');
    console.log(`    DELETE FROM aeo_runs WHERE run_date = '${TARGET_DATE}';`);
    process.exit(0);
  }

  // Read source data
  const data = JSON.parse(fs.readFileSync(SOURCE_FILE, 'utf8'));
  const promptIds = Object.keys(data);
  console.log(`📄 source file: ${promptIds.length} prompts`);

  // Make sure each prompt exists in aeo_prompts (upsert)
  const promptRows = promptIds
    .filter(id => (data[id].runs || []).some(r => r.date === TARGET_DATE) || (data[id].runs || []).length > 0)
    .map(id => ({
      id,
      prompt: data[id].prompt,
      topic:  data[id].topic  || null,
      tag:    data[id].tag    || null
    }));
  for (const c of chunk(promptRows, 500)) {
    const { error } = await supabase.from('aeo_prompts').upsert(c);
    if (error) throw error;
  }
  console.log(`✓ upserted ${promptRows.length} prompts`);

  // Build run rows — for each prompt, take the latest April-16 run PER MODEL.
  // The source file has multiple runs per (prompt, model) on the same day
  // (re-runs); since the array uses unshift order, runs[0] is newest. We walk
  // the array and keep the first occurrence of each model name.
  const runRows = [];
  let ordinalCounter = 1;
  for (const id of promptIds) {
    const april16 = (data[id].runs || []).filter(r => r.date === TARGET_DATE);
    if (!april16.length) continue;
    const seenModels = new Set();
    for (const r of april16) {
      if (!r.model || seenModels.has(r.model)) continue;
      seenModels.add(r.model);
      runRows.push({
        prompt_id:             id,
        run_date:              r.date,
        model:                 r.model,
        mentioned:             !!r.mentioned,
        cited:                 !!r.cited,
        attributed_citation:   !!r.attributedCitation,
        sources:               !!r.sources,
        competitors_mentioned: r.competitorsMentioned || [],
        mention_position:      r.mentionPosition || null,
        mention_rank:          r.mentionRank ?? null,
        sentiment:             r.sentiment || null,
        source_urls:           r.sourceUrls || [],
        prompt_type:           r.promptType || null,
        prompt_text:           r.prompt || null,
        response:              r.response || null,
        ordinal:               ordinalCounter++
      });
    }
  }

  console.log(`📥 inserting ${runRows.length} runs (date=${TARGET_DATE})`);
  for (const c of chunk(runRows, 500)) {
    const { error } = await supabase.from('aeo_runs').insert(c);
    if (error) throw error;
    process.stdout.write('.');
  }
  console.log(' ✓ runs inserted');

  // Build a single stream_history entry summarising the import
  const modelsSet = new Set(runRows.map(r => r.model).filter(Boolean));
  const { data: hist, error: histErr } = await supabase.from('stream_history').insert({
    run_date:      TARGET_DATE,
    prompts_count: runRows.length,
    models:        Array.from(modelsSet),
    runs_count:    runRows.length,
    source:        'import',
    note:          HISTORY_NOTE
  }).select('*').single();
  if (histErr) throw histErr;
  console.log(`✓ stream_history entry: ${hist.id}`);

  console.log('━━━ Done ━━━');
}

function chunk(arr, n) {
  const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out;
}

main().catch(e => { console.error('❌', e); process.exit(1); });
