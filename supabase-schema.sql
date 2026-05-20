-- Kynection GEO Dashboard — Supabase schema
-- Paste this into Supabase: SQL Editor → New query → Run

create extension if not exists pgcrypto;

-- ============================================================
-- AEO prompts (one row per tracked prompt, e.g. aeo_101)
-- ============================================================
create table if not exists aeo_prompts (
  id          text primary key,
  prompt      text not null,
  topic       text,
  tag         text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ============================================================
-- AEO runs (one row per model run; many per prompt)
-- ============================================================
create table if not exists aeo_runs (
  id                    uuid primary key default gen_random_uuid(),
  prompt_id             text not null references aeo_prompts(id) on delete cascade,
  run_date              date,
  model                 text,
  mentioned             boolean,
  cited                 boolean,
  attributed_citation   boolean,
  sources               boolean,
  competitors_mentioned text[],
  mention_position      text,
  mention_rank          int,
  sentiment             text,
  source_urls           jsonb,
  prompt_type           text,
  prompt_text           text,
  response              text,
  ordinal               bigint not null,
  created_at            timestamptz not null default now()
);

create index if not exists aeo_runs_prompt_id_idx on aeo_runs(prompt_id);
create index if not exists aeo_runs_ordinal_idx  on aeo_runs(prompt_id, ordinal desc);
create index if not exists aeo_runs_run_date_idx on aeo_runs(run_date desc);

-- ============================================================
-- Content items (snipe / import)
-- ============================================================
create table if not exists content_items (
  id          text primary key,
  url         text not null,
  title       text default '',
  snipe_type  text,
  snipe       jsonb,
  cost        jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists content_items_created_idx on content_items(created_at desc);

-- ============================================================
-- Generic API response cache (SEMrush, PageSpeed, YouTube, etc.)
-- One row per cache key. TTL is applied at read time by the app.
-- ============================================================
create table if not exists api_cache (
  cache_key   text primary key,
  scope       text not null,
  data        jsonb not null,
  cached_at   timestamptz not null default now()
);

create index if not exists api_cache_scope_idx on api_cache(scope);
create index if not exists api_cache_cached_at_idx on api_cache(cached_at desc);

-- ============================================================
-- updated_at triggers
-- ============================================================
create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists aeo_prompts_touch on aeo_prompts;
create trigger aeo_prompts_touch before update on aeo_prompts
  for each row execute function touch_updated_at();

drop trigger if exists content_items_touch on content_items;
create trigger content_items_touch before update on content_items
  for each row execute function touch_updated_at();
