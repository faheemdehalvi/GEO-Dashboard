// One-shot migration: pushes aeo-results.json and content-items.json into Supabase.
// Usage:
//   1. Run supabase-schema.sql in the Supabase SQL editor.
//   2. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to .env in repo root.
//   3. node scripts/migrate-to-supabase.js
//
// Safe to re-run: it WIPES the destination tables before inserting.

const path = require('path');
const fs   = require('fs');

// Load .env (same parser as server.js)
try {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return;
      const i = t.indexOf('='); if (i < 1) return;
      const k = t.slice(0, i).trim();
      const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
      if (k && !(k in process.env)) process.env[k] = v;
    });
  }
} catch(e) {}

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
  process.exit(1);
}

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

const AEO_FILE     = path.join(__dirname, '..', 'aeo-results.json');
const CONTENT_FILE = path.join(__dirname, '..', 'content-items.json');

async function main() {
  console.log('━━━ Supabase migration ━━━');

  // 1. Wipe both tables (cascade will clear aeo_runs via FK)
  console.log('🧹 Clearing existing tables...');
  let r = await supabase.from('aeo_runs').delete().not('id', 'is', null);
  if (r.error) throw r.error;
  r = await supabase.from('aeo_prompts').delete().not('id', 'is', null);
  if (r.error) throw r.error;
  r = await supabase.from('content_items').delete().not('id', 'is', null);
  if (r.error) throw r.error;

  // 2. AEO
  if (fs.existsSync(AEO_FILE)) {
    const aeo = JSON.parse(fs.readFileSync(AEO_FILE, 'utf8'));
    const promptIds = Object.keys(aeo);
    console.log(`📥 AEO: ${promptIds.length} prompts`);

    const promptRows = promptIds.map(id => ({
      id,
      prompt: aeo[id].prompt,
      topic:  aeo[id].topic  || null,
      tag:    aeo[id].tag    || null
    }));

    const runRows = [];
    let totalRuns = 0;
    for (const id of promptIds) {
      const runs = aeo[id].runs || [];
      totalRuns += runs.length;
      for (let i = 0; i < runs.length; i++) {
        const run = runs[i];
        // Front of array = newest. Give it the highest ordinal so DESC sort
        // by ordinal mirrors the original insertion order.
        const ordinal = runs.length - i;
        runRows.push({
          prompt_id:             id,
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
        });
      }
    }
    console.log(`📥 AEO: ${totalRuns} runs across ${promptIds.length} prompts`);

    for (const c of chunk(promptRows, 500)) {
      const { error } = await supabase.from('aeo_prompts').insert(c);
      if (error) throw error;
      process.stdout.write('.');
    }
    console.log(' ✓ prompts inserted');

    for (const c of chunk(runRows, 500)) {
      const { error } = await supabase.from('aeo_runs').insert(c);
      if (error) throw error;
      process.stdout.write('.');
    }
    console.log(' ✓ runs inserted');
  } else {
    console.log('⚠️  aeo-results.json not found — skipping');
  }

  // 3. Content items
  if (fs.existsSync(CONTENT_FILE)) {
    const items = JSON.parse(fs.readFileSync(CONTENT_FILE, 'utf8'));
    console.log(`📥 Content items: ${items.length}`);
    const rows = items.map(it => ({
      id:         it.id,
      url:        it.url,
      title:      it.title || '',
      snipe_type: it.snipeType || null,
      snipe:      it.snipe || null,
      cost:       it.cost  || null,
      created_at: it.createdAt || new Date().toISOString()
    }));
    for (const c of chunk(rows, 500)) {
      const { error } = await supabase.from('content_items').insert(c);
      if (error) throw error;
    }
    console.log(' ✓ content_items inserted');
  } else {
    console.log('⚠️  content-items.json not found — skipping');
  }

  console.log('━━━ Done ━━━');
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

main().catch(e => { console.error('❌ Migration failed:', e); process.exit(1); });
