const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

// Load .env file manually (no dotenv dependency needed)
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 1) return;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (key && !(key in process.env)) process.env[key] = val;
    });
  }
} catch(e) { console.warn('Could not load .env file:', e.message); }

const db = require('./db');
const { requireAuth } = require('./auth');
const { buildConfig, resolveTenant, KNOWN_TENANTS } = require('./tenant');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Tenant resolution — every /api/* request reads the x-tenant header
// ("kyn" | "ir"), populates req.tenant + req.config, and runs downstream
// middleware/handlers inside an AsyncLocalStorage context so db.js can
// resolve the right Supabase data client without thread-through args.
app.use('/api', (req, res, next) => {
  req.tenant = resolveTenant(req.headers['x-tenant']);
  req.config = buildConfig(req.tenant);
  db.tenantStorage.run(req.tenant, () => next());
});

// Auth gate: every /api/* route requires a valid Supabase JWT EXCEPT the
// small set of public sub-paths listed below. Place this BEFORE all route
// handlers so the gate runs first.
const PUBLIC_API_SUBPATHS = new Set([
  '/health',         // platform liveness
  '/auth/config'     // frontend needs to know which Supabase project to log in to
]);
app.use('/api', (req, res, next) => {
  if (PUBLIC_API_SUBPATHS.has(req.path)) return next();
  // /api/_diag/* — read-only diagnostics, no secrets. Public so we can
  // verify tenant DB routing without logging in.
  if (req.path.startsWith('/_diag/')) return next();
  return requireAuth(req, res, next);
});

// Public: lets the frontend bootstrap its Supabase client AND learn what
// tenants are configured so it can render the tenant switcher + filter the
// nav per tenant's enabledSections.
app.get('/api/auth/config', (req, res) => {
  const tenants = KNOWN_TENANTS.map(t => {
    const cfg = buildConfig(t);
    return {
      slug: t,
      brand: cfg.brand,
      title: cfg.title,
      enabledSections: cfg.enabledSections,
      contentFeatures: cfg.contentFeatures || ['snipe']
    };
  });
  res.json({
    // Auth uses the primary (Kynection) Supabase — see auth.js + db.js
    supabaseUrl:            process.env.SUPABASE_URL || null,
    supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || null,
    tenants
  });
});

// ============================================================
// CONFIG
// ============================================================
const CONFIG = {
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
  },
  youtube: {
    // Kynection YouTube channel owner account (has YouTube Analytics access).
    // Falls back to the main Google OAuth client if dedicated YouTube creds
    // aren't set — kept so existing deploys without YOUTUBE_CLIENT_ID still
    // work the same as before.
    clientId:     process.env.YOUTUBE_CLIENT_ID     || process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET,
    refreshToken: process.env.YOUTUBE_REFRESH_TOKEN,
  },
  ga4: { propertyId: process.env.GA4_PROPERTY_ID || '386242225' },
  gsc: { siteUrl: null },
  semrush: { apiKey: process.env.SEMRUSH_API_KEY, domain: process.env.SEMRUSH_DOMAIN || 'kynection.com.au', database: process.env.SEMRUSH_DATABASE || 'au' },
  hubspot: { accessToken: process.env.HUBSPOT_ACCESS_TOKEN },
  gemini:  { apiKey: process.env.GEMINI_API_KEY },
  openai:  { apiKey: process.env.OPENAI_API_KEY }
};

// ============================================================
// Token management
// ============================================================
const TOKEN_FILE = path.join(__dirname, 'ga4-gsc-tokens.json');
const YT_TOKEN_FILE = path.join(__dirname, 'youtube-tokens.json');
const _tokens = {};

function getRefreshToken() {
  // GA4 + GSC token (anthony@intelligentresourcing.co — has analytics & search console access)
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const saved = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      if (saved.refresh_token) return saved.refresh_token;
    }
  } catch(e) {}
  return CONFIG.google.refreshToken;
}

function getYTRefreshToken() {
  // YouTube token (Kynection channel owner account — has YouTube Analytics access)
  try {
    if (fs.existsSync(YT_TOKEN_FILE)) {
      const saved = JSON.parse(fs.readFileSync(YT_TOKEN_FILE, 'utf8'));
      if (saved.refresh_token) return saved.refresh_token;
    }
  } catch(e) {}
  return CONFIG.youtube.refreshToken;
}

async function getToken(key, clientId, clientSecret, refreshToken) {
  const t = _tokens[key];
  if (t && Date.now() < t.expiry) return t.token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' })
  });
  const d = await res.json();
  if (!d.access_token) throw new Error('Token refresh failed: ' + JSON.stringify(d));
  _tokens[key] = { token: d.access_token, expiry: Date.now() + (d.expires_in - 120) * 1000 };
  return d.access_token;
}

// Tenant-aware token getters. Cache key includes the tenant slug so KYN and
// IR don't trample each other's cached access tokens. Refresh tokens come
// from req.config.{google,youtube}.refreshToken (resolved per-tenant by the
// tenant middleware). Local fallback: if req isn't available (startup code),
// read from the global CONFIG (Kynection-era behaviour).
function tenantOf(req) { return req?.tenant || 'kyn'; }
function googleCreds(req) {
  if (req?.config?.google) return req.config.google;
  return { clientId: CONFIG.google.clientId, clientSecret: CONFIG.google.clientSecret, refreshToken: getRefreshToken() };
}
function youtubeCreds(req) {
  if (req?.config?.youtube) return req.config.youtube;
  return { clientId: CONFIG.youtube.clientId, clientSecret: CONFIG.youtube.clientSecret, refreshToken: getYTRefreshToken() };
}
const getGoogleToken = (req) => {
  const c = googleCreds(req);
  return getToken('google:' + tenantOf(req), c.clientId, c.clientSecret, c.refreshToken);
};
const getYTToken = (req) => {
  const c = youtubeCreds(req);
  return getToken('youtube:' + tenantOf(req), c.clientId, c.clientSecret, c.refreshToken);
};

// ============================================================
// Helpers
// ============================================================
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString(), cwd: process.cwd(), version: 'v3-fixed-attribution' }));

// Public diagnostic — no secrets, just confirms which tenant has a Supabase
// client configured and which Supabase project it points to (host only).
// Use to debug "wrong tenant's data on the wrong dashboard" issues.
app.get('/api/_diag/db', (req, res) => {
  const out = {};
  for (const t of KNOWN_TENANTS) {
    const client = db.getClient(t);
    let urlHost = null;
    try {
      // Inspect resolved env var without leaking the key
      const prefix = t.toUpperCase() + '_';
      const url = process.env[prefix + 'SUPABASE_URL'] || (t === 'kyn' ? process.env.SUPABASE_URL : null);
      if (url) urlHost = new URL(url).hostname;
    } catch(e) {}
    out[t] = {
      hasClient: !!client,
      supabaseHost: urlHost,
      urlEnvSet: !!process.env[t.toUpperCase() + '_SUPABASE_URL'],
      keyEnvSet: !!process.env[t.toUpperCase() + '_SUPABASE_SERVICE_ROLE_KEY']
    };
  }
  res.json({ tenants: out, processCwd: process.cwd(), nodeVersion: process.version });
});

// Public diagnostic — hits loadAllAeoResults for a tenant and returns the
// count. No secrets exposed. Confirms whether the data layer is actually
// returning prompts (independent of auth and frontend). Hit:
//   /api/_diag/aeo?tenant=ir
app.get('/api/_diag/aeo', async (req, res) => {
  const tenant = (req.query.tenant || 'ir').toLowerCase();
  try {
    const data = await db.forTenant(tenant, () => db.loadAllAeoResults());
    const ids = Object.keys(data || {});
    const totalRuns = Object.values(data || {}).reduce((s, e) => s + (e.runs?.length || 0), 0);
    const first = ids.length ? { id: ids[0], prompt: data[ids[0]]?.prompt?.slice(0, 80), topic: data[ids[0]]?.topic, tag: data[ids[0]]?.tag, runs: data[ids[0]]?.runs?.length || 0 } : null;
    res.json({ tenant, promptCount: ids.length, totalRuns, firstPrompt: first });
  } catch (e) {
    res.status(500).json({ tenant, error: e.message });
  }
});
app.get('/api/config', (req, res) => res.json({
  tenant: req.tenant,
  brand: req.config.brand,
  gscSiteUrl:    req.config.gsc.siteUrl,
  ga4PropertyId: req.config.ga4.propertyId,
  semrushDomain: req.config.semrush.domain,
  enabledSections: req.config.enabledSections
}));

app.get('/api/test/gemini', async (req, res) => {
  const key = process.env.GEMINI_API_KEY || CONFIG.gemini.apiKey;
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'Say hello in one word' }] }] })
    });
    const d = await r.json();
    res.json({ status: r.status, keyUsed: key.slice(0,8)+'...', response: d });
  } catch(e) {
    res.json({ error: e.message });
  }
});

function gscDates(days = 28) {
  const end = new Date(); end.setDate(end.getDate() - 3);
  const start = new Date(end); start.setDate(start.getDate() - days);
  const prevEnd = new Date(start); prevEnd.setDate(prevEnd.getDate() - 1);
  const prevStart = new Date(prevEnd); prevStart.setDate(prevStart.getDate() - days);
  const fmt = d => d.toISOString().split('T')[0];
  return { start: fmt(start), end: fmt(end), prevStart: fmt(prevStart), prevEnd: fmt(prevEnd) };
}

// Resolve date range from request query — supports ?days=N or ?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
function parseDateRange(query, defaultDays = 28) {
  const fmt = d => (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);
  if (query.startDate && query.endDate) {
    const since = query.startDate;
    const until = query.endDate;
    const days = Math.round((new Date(until) - new Date(since)) / 86400000) + 1;
    const prevUntil = fmt(new Date(new Date(since) - 86400000));
    const prevSince = fmt(new Date(new Date(since) - days * 86400000));
    return { since, until, days, prevSince, prevUntil };
  }
  const days = parseInt(query.days) || defaultDays;
  const since = fmt(new Date(Date.now() - days * 86400000));
  const until = fmt(new Date());
  const prevUntil = fmt(new Date(Date.now() - days * 86400000 - 86400000));
  const prevSince = fmt(new Date(Date.now() - days * 2 * 86400000));
  return { since, until, days, prevSince, prevUntil };
}

// GSC-aware date range (GSC data lags ~3 days)
function parseDateRangeGSC(query, defaultDays = 28) {
  if (query.startDate && query.endDate) {
    const since = query.startDate;
    const until = query.endDate;
    const days = Math.round((new Date(until) - new Date(since)) / 86400000) + 1;
    const prevUntil = new Date(new Date(since) - 86400000).toISOString().slice(0,10);
    const prevSince = new Date(new Date(since) - days * 86400000).toISOString().slice(0,10);
    return { start: since, end: until, prevStart: prevSince, prevEnd: prevUntil };
  }
  return gscDates(parseInt(query.days) || defaultDays);
}

async function gscQuery(token, site, body) {
  const r = await fetch(
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  return r.json();
}

async function ga4Report(req, token, body) {
  const r = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${req.config.ga4.propertyId}:runReport`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  return r.json();
}

function parseSemrushCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(';').map(h => h.trim());
  return lines.slice(1).map(line => {
    const vals = line.split(';');
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] ? vals[i].trim() : ''; });
    return obj;
  });
}

// ============================================================
// GSC routes
// ============================================================
// Middleware that ensures req.config.gsc.siteUrl is populated for any
// /api/gsc/* request. Registered BEFORE the routes so it actually fires
// (Express dispatches in registration order). Implementation of
// detectGSCSite is hoisted below; closures evaluate at request time.
app.use('/api/gsc', async (req, res, next) => {
  try {
    if (!req.config.gsc.siteUrl) {
      req.config.gsc.siteUrl = await detectGSCSite(req.tenant);
    }
  } catch (e) { /* leave siteUrl null — routes will surface their own error */ }
  next();
});

app.get('/api/gsc/sites', async (req, res) => {
  try { const t = await getGoogleToken(req); const r = await fetch('https://www.googleapis.com/webmasters/v3/sites', { headers: { Authorization: `Bearer ${t}` } }); res.json(await r.json()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/gsc/overview', async (req, res) => {
  try {
    const t = await getGoogleToken(req);
    const { start, end, prevStart, prevEnd } = parseDateRangeGSC(req.query);
    const site = req.query.site || req.config.gsc.siteUrl;
    const [curr, prev] = await Promise.all([
      gscQuery(t, site, { startDate: start, endDate: end, dimensions: [], rowLimit: 1 }),
      gscQuery(t, site, { startDate: prevStart, endDate: prevEnd, dimensions: [], rowLimit: 1 })
    ]);
    res.json({ current: curr, previous: prev });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/gsc/keywords', async (req, res) => {
  try {
    const t = await getGoogleToken(req);
    const site = req.query.site || req.config.gsc.siteUrl;
    const limit = parseInt(req.query.limit) || 100;
    const { start, end, prevStart, prevEnd } = parseDateRangeGSC(req.query);
    const [curr, prev] = await Promise.all([
      gscQuery(t, site, { startDate: start, endDate: end, dimensions: ['query'], rowLimit: limit, orderBy: [{ fieldName: 'clicks', sortOrder: 'DESCENDING' }] }),
      gscQuery(t, site, { startDate: prevStart, endDate: prevEnd, dimensions: ['query'], rowLimit: 25000 })
    ]);
    const prevMap = {};
    (prev.rows || []).forEach(r => { prevMap[r.keys[0]] = r; });
    const rows = (curr.rows || []).map(r => {
      const kw = r.keys[0]; const p = prevMap[kw];
      return {
        query: kw, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position,
        prevClicks: p?.clicks ?? null, prevImpressions: p?.impressions ?? null,
        prevCtr: p?.ctr ?? null, prevPosition: p?.position ?? null,
        clicksPct:      p?.clicks      ? ((r.clicks      - p.clicks)      / p.clicks)      * 100 : null,
        impressionsPct: p?.impressions ? ((r.impressions  - p.impressions) / p.impressions) * 100 : null,
        ctrPct:         p?.ctr         ? ((r.ctr          - p.ctr)         / p.ctr)         * 100 : null,
        posChange: p ? (p.position - r.position) : null  // positive = improved (went up in rankings)
      };
    });
    res.json({ rows, dateRange: { start, end } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/gsc/pages', async (req, res) => {
  try {
    const t = await getGoogleToken(req);
    const site = req.query.site || req.config.gsc.siteUrl;
    const { start, end, prevStart, prevEnd } = parseDateRangeGSC(req.query);
    const [curr, prev] = await Promise.all([
      gscQuery(t, site, { startDate: start, endDate: end, dimensions: ['page'], rowLimit: 25, orderBy: [{ fieldName: 'clicks', sortOrder: 'DESCENDING' }] }),
      gscQuery(t, site, { startDate: prevStart, endDate: prevEnd, dimensions: ['page'], rowLimit: 25 })
    ]);
    const prevMap = {};
    (prev.rows || []).forEach(r => { prevMap[r.keys[0]] = r; });
    const rows = (curr.rows || []).map(r => ({ url: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position, prevClicks: prevMap[r.keys[0]]?.clicks ?? null }));
    res.json({ rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/gsc/devices', async (req, res) => {
  try {
    const t = await getGoogleToken(req);
    const site = req.query.site || req.config.gsc.siteUrl;
    const { start, end } = parseDateRangeGSC(req.query);
    res.json(await gscQuery(t, site, { startDate: start, endDate: end, dimensions: ['device'], rowLimit: 10 }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/gsc/countries', async (req, res) => {
  try {
    const t = await getGoogleToken(req);
    const site = req.query.site || req.config.gsc.siteUrl;
    const { start, end } = parseDateRangeGSC(req.query);
    res.json(await gscQuery(t, site, { startDate: start, endDate: end, dimensions: ['country'], rowLimit: 15, orderBy: [{ fieldName: 'clicks', sortOrder: 'DESCENDING' }] }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/gsc/trend', async (req, res) => {
  try {
    const t = await getGoogleToken(req);
    const site = req.query.site || req.config.gsc.siteUrl;
    let startDate, endDate, rowLimit;
    if (req.query.startDate && req.query.endDate) {
      startDate = req.query.startDate;
      endDate = req.query.endDate;
      rowLimit = Math.min(Math.round((new Date(endDate) - new Date(startDate)) / 86400000) + 2, 500);
    } else {
      const days = parseInt(req.query.days) || 90;
      const end = new Date(); end.setDate(end.getDate() - 3);
      const start = new Date(end); start.setDate(start.getDate() - days);
      const fmt = d => d.toISOString().split('T')[0];
      startDate = fmt(start); endDate = fmt(end); rowLimit = days;
    }
    res.json(await gscQuery(t, site, { startDate, endDate, dimensions: ['date'], rowLimit, orderBy: [{ fieldName: 'date', sortOrder: 'ASCENDING' }] }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// GA4 routes
// ============================================================
app.post('/api/ga4/report', async (req, res) => {
  try { const t = await getGoogleToken(req); res.json(await ga4Report(req, t, req.body)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ga4/overview', async (req, res) => {
  try {
    const { since, until, prevSince, prevUntil } = parseDateRange(req.query);
    const t = await getGoogleToken(req);
    const metrics = [
      { name: 'sessions' }, { name: 'totalUsers' }, { name: 'newUsers' },
      { name: 'engagementRate' }, { name: 'averageSessionDuration' },
      { name: 'bounceRate' }, { name: 'screenPageViews' }
    ];
    const [curr, prev] = await Promise.all([
      ga4Report(req, t, { dateRanges: [{ startDate: since, endDate: until }], metrics }),
      ga4Report(req, t, { dateRanges: [{ startDate: prevSince, endDate: prevUntil }], metrics })
    ]);
    // Normalise: flatten single-row responses into key-value objects
    const flatten = (report) => {
      if (!report || !report.rows || !report.rows[0]) return {};
      const mh = (report.metricHeaders || []).map(h => h.name);
      const obj = {};
      mh.forEach((m, i) => { obj[m] = parseFloat(report.rows[0].metricValues[i]?.value || 0); });
      return obj;
    };
    res.json({ current: flatten(curr), previous: flatten(prev) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ga4/by-channel', async (req, res) => {
  try {
    const { since, until, prevSince, prevUntil } = parseDateRange(req.query);
    const t = await getGoogleToken(req);
    const body = (dr) => ({
      dateRanges: [dr],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'engagementRate' }, { name: 'bounceRate' }, { name: 'averageSessionDuration' }],
      dimensions: [{ name: 'sessionDefaultChannelGrouping' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }]
    });
    const [curr, prev] = await Promise.all([
      ga4Report(req, t, body({ startDate: since, endDate: until })),
      ga4Report(req, t, body({ startDate: prevSince, endDate: prevUntil }))
    ]);
    res.json({ current: curr, previous: prev });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ga4/by-source', async (req, res) => {
  try {
    const { since, until, prevSince, prevUntil } = parseDateRange(req.query);
    const t = await getGoogleToken(req);
    const body = (dr) => ({
      dateRanges: [dr],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'engagementRate' }],
      dimensions: [{ name: 'sessionSource' }, { name: 'sessionMedium' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 20
    });
    const [curr, prev] = await Promise.all([
      ga4Report(req, t, body({ startDate: since, endDate: until })),
      ga4Report(req, t, body({ startDate: prevSince, endDate: prevUntil }))
    ]);
    res.json({ current: curr, previous: prev });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ga4/top-pages', async (req, res) => {
  try {
    const { since, until } = parseDateRange(req.query);
    const t = await getGoogleToken(req);
    res.json(await ga4Report(req, t, {
      dateRanges: [{ startDate: since, endDate: until }],
      metrics: [
        { name: 'screenPageViews' }, { name: 'totalUsers' }, { name: 'sessions' },
        { name: 'averageSessionDuration' }, { name: 'bounceRate' },
        { name: 'eventsPerSession' }, { name: 'userEngagementDuration' }
      ],
      dimensions: [{ name: 'pageTitle' }],
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      limit: 25
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ga4/devices', async (req, res) => {
  try {
    const { since, until } = parseDateRange(req.query);
    const t = await getGoogleToken(req);
    res.json(await ga4Report(req, t, {
      dateRanges: [{ startDate: since, endDate: until }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'engagementRate' }],
      dimensions: [{ name: 'deviceCategory' }]
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ga4/geography', async (req, res) => {
  try {
    const { since, until } = parseDateRange(req.query);
    const t = await getGoogleToken(req);
    res.json(await ga4Report(req, t, {
      dateRanges: [{ startDate: since, endDate: until }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
      dimensions: [{ name: 'country' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 15
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ga4/daily-trend', async (req, res) => {
  try {
    const { since, until } = parseDateRange(req.query, 90);
    const t = await getGoogleToken(req);
    res.json(await ga4Report(req, t, {
      dateRanges: [{ startDate: since, endDate: until }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'newUsers' }],
      dimensions: [{ name: 'date' }],
      orderBys: [{ dimension: { dimensionName: 'date' }, desc: false }]
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// SEMrush routes — with 24-hour persistent cache
// ============================================================
const SR_CACHE_TTL_SECONDS = 23 * 60 * 60; // 23 hours

function srCached(key, fn) {
  return async (req, res) => {
    const cacheKey = 'semrush:' + key + ':' + JSON.stringify(req.query);
    const lookup = await db.cacheGetWithStale(cacheKey, SR_CACHE_TTL_SECONDS);
    // Serve immediately if fresh and not an error blob
    if (lookup?.fresh && !lookup.data?.error) {
      return res.json({ ...lookup.data, cached: true, cachedAt: new Date(lookup.ts).toISOString() });
    }
    // Try to refresh, but always fall back to stale cache on any failure
    try {
      const data = await fn(req);
      if (!data?.error) {
        await db.cacheSet(cacheKey, 'semrush', data);
        return res.json(data);
      }
      throw new Error(data.error);
    } catch(e) {
      if (lookup && !lookup.data?.error) {
        const age = Math.round((Date.now() - lookup.ts) / 36e5);
        console.warn(`SEMrush (${key}) serving stale cache (${age}h old): ${e.message}`);
        return res.json({ ...lookup.data, cached: true, stale: true, cachedAt: new Date(lookup.ts).toISOString() });
      }
      res.status(500).json({ error: e.message });
    }
  };
}

app.get('/api/semrush/overview', srCached('overview', async (req) => {
  const domain = req.query.domain || req.config.semrush.domain;
  const db = req.query.db || req.config.semrush.database;
  const r = await fetch(`https://api.semrush.com/?type=domain_rank&key=${req.config.semrush.apiKey}&export_columns=Dn,Rk,Or,Ot,Oc,Ad,At,Ac&domain=${domain}&database=${db}`);
  const text = await r.text();
  if (text.includes('ERROR')) throw new Error(text.trim());
  return { data: parseSemrushCSV(text)[0] || null };
}));

app.get('/api/semrush/keywords', srCached('keywords', async (req) => {
  const domain = req.query.domain || req.config.semrush.domain;
  const db = req.query.db || req.config.semrush.database;
  const limit = req.query.limit || 500;
  const r = await fetch(`https://api.semrush.com/?type=domain_organic&key=${req.config.semrush.apiKey}&display_limit=${limit}&export_columns=Ph,Po,Pp,Nq,Cp,Ur,Tr,Kd,Td&domain=${domain}&database=${db}&display_sort=tr_desc`);
  const text = await r.text();
  if (text.startsWith('ERROR')) throw new Error(text.trim());
  return { rows: parseSemrushCSV(text) };
}));

app.get('/api/semrush/position-distribution', srCached('posdist', async (req) => {
  const domain = req.query.domain || req.config.semrush.domain;
  const db = req.query.db || req.config.semrush.database;
  const r = await fetch(`https://api.semrush.com/?type=domain_organic&key=${req.config.semrush.apiKey}&display_limit=500&export_columns=Ph,Po,Nq&domain=${domain}&database=${db}`);
  const text = await r.text();
  if (text.startsWith('ERROR')) throw new Error(text.trim());
  const rows = parseSemrushCSV(text);
  const dist = { '1-3': 0, '4-10': 0, '11-20': 0, '21-50': 0, '51-100': 0 };
  rows.forEach(r => {
    const pos = parseInt(r['Position'] || r['Po'] || 0);
    if (pos <= 3) dist['1-3']++;
    else if (pos <= 10) dist['4-10']++;
    else if (pos <= 20) dist['11-20']++;
    else if (pos <= 50) dist['21-50']++;
    else dist['51-100']++;
  });
  return { distribution: dist, total: rows.length };
}));

app.get('/api/semrush/competitors', srCached('competitors', async (req) => {
  const domain = req.query.domain || req.config.semrush.domain;
  const db = req.query.db || req.config.semrush.database;
  const r = await fetch(`https://api.semrush.com/?type=domain_organic_organic&key=${req.config.semrush.apiKey}&display_limit=8&export_columns=Dn,Cr,Np,Or,Ot,Oc,Ad&domain=${domain}&database=${db}`);
  const text = await r.text();
  if (text.startsWith('ERROR')) throw new Error(text.trim());
  return { rows: parseSemrushCSV(text) };
}));

app.get('/api/semrush/backlinks', srCached('backlinks', async (req) => {
  const domain = req.query.domain || req.config.semrush.domain;
  const db = req.query.db || req.config.semrush.database;
  const r = await fetch(`https://api.semrush.com/?type=domain_rank&key=${req.config.semrush.apiKey}&export_columns=Dn,Rk,Or,Ot,Oc,Bl&domain=${domain}&database=${db}`);
  const text = await r.text();
  if (text.startsWith('ERROR')) throw new Error(text.trim());
  const row = parseSemrushCSV(text)[0] || {};
  return { data: { domain, backlinks: row['Backlinks'] || row['Bl'] || 0, organicKw: row['Organic Keywords'] || row['Or'] || 0, organicTraffic: row['Organic Traffic'] || row['Ot'] || 0 } };
}));

// Default competitor list — used to seed the DB on first boot AND as fallback
// when Supabase isn't configured. Once seeded, the dynamic in-memory cache
// below (_competitors) is the source of truth.
const DEFAULT_COMPETITORS = {
  'allotrac.io':'Allotrac','aroflo.com':'AroFlo','ascora.com.au':'Ascora',
  'assetpanda.com':'Asset Panda','assetvision.com.au':'AssetVision','assignar.com':'Assignar',
  'cloudcon.com':'Cloudcon','deputy.com':'Deputy','donesafe.com':'Donesafe','eroad.com':'EROAD',
  'fergus.com':'Fergus','fieldinsight.com':'FieldInsight','fogwing.io':'Fogwing',
  'geotab.com':'Geotab','hammertech.com':'Hammertech','hubfleet.com.au':'HubFleet',
  'getjobber.com':'Jobber','linxio.com':'Linxio','logmaster.com.au':'LogMaster',
  'mtdata.com.au':'MTData','netstaraustralia.com.au':'Netstar','nexvia.com.au':'Nexvia',
  'procore.com':'Procore','pronto.net':'Pronto','randmcnally.com':'Rand McNally',
  'safetyculture.com':'SafetyCulture','seeingmachines.com':'Seeing Machines',
  'servicetitan.com':'ServiceTitan','servicem8.com':'ServiceM8','simprogroup.com':'Simpro',
  'sitemate.com':'Sitemate','smartrak.com':'Smartrak','teletracnavman.com':'Teletrac Navman',
  'tradifyhq.com.au':'Tradify','transportsystems.com.au':'Transport Systems',
  'transvirtual.com':'Transvirtual','varicon.com.au':'Varicon',
  'verizonconnect.com':'Verizon Connect','workdiarymate.com.au':'Work Diary Mate',
  'workbenchcentral.com':'Workbench'
};

// Per-tenant in-memory competitor cache. Each tenant has its own list of
// tracked brands looked for in AEO responses + SEMrush metrics.
//   _competitorsByTenant[tenant] = [{id, domain, display_name, is_active}, ...]
//   _trackedByTenant[tenant]     = [domain, ...]  (active-only)
//   _compNamesByTenant[tenant]   = { domain: display_name } (active-only)
const _competitorsByTenant = {};
const _trackedByTenant     = {};
const _compNamesByTenant   = {};

// Seed each tenant with the Kynection-era defaults until the first DB hydrate
// finishes — keeps mention detection working from t=0.
for (const t of KNOWN_TENANTS) {
  _competitorsByTenant[t] = Object.entries(DEFAULT_COMPETITORS).map(([domain, display_name]) => ({ id: domain, domain, display_name, is_active: true }));
  _trackedByTenant[t]     = Object.keys(DEFAULT_COMPETITORS);
  _compNamesByTenant[t]   = { ...DEFAULT_COMPETITORS };
}

function getCompetitorList(tenant) { return _competitorsByTenant[tenant] || []; }
function getTrackedDomains(tenant)  { return _trackedByTenant[tenant] || []; }
function getCompNamesMap(tenant)    { return _compNamesByTenant[tenant] || {}; }

async function refreshCompetitorsCache(tenant) {
  if (!tenant) {
    // Default behaviour: refresh all known tenants.
    for (const t of KNOWN_TENANTS) await refreshCompetitorsCache(t);
    return;
  }
  try {
    await db.forTenant(tenant, async () => {
      // One-time cleanup: earlier builds seeded EVERY tenant with Kynection's
      // 40 defaults. For non-KYN tenants, remove any rows that were inserted
      // by that legacy seed (added_by='system-seed'). User-added competitors
      // have a different added_by value and are preserved.
      if (tenant !== 'kyn') {
        try {
          const client = db.currentClient();
          if (!client) return;
          const { error: delErr, count: delCount } = await client
            .from('competitors').delete({ count: 'exact' }).eq('added_by', 'system-seed');
          if (!delErr && delCount) console.log(`🧹 Competitors [${tenant}]: cleaned ${delCount} legacy seed rows`);
        } catch (e) { /* table-missing or already clean — fine */ }
      }
      // Only KYN gets the legacy hardcoded defaults seeded if empty.
      // Other tenants start with a clean slate; the user adds competitors
      // through the Competitors UI.
      if (tenant === 'kyn') {
        await db.seedCompetitorsIfEmpty(DEFAULT_COMPETITORS);
      }
      const rows = await db.listCompetitors({ activeOnly: false });
      _competitorsByTenant[tenant] = rows || [];
      const active = (rows || []).filter(r => r.is_active);
      _trackedByTenant[tenant]   = active.map(r => r.domain);
      _compNamesByTenant[tenant] = Object.fromEntries(active.map(r => [r.domain, r.display_name]));
      console.log(`🏁 Competitors [${tenant}]: ${active.length} active (of ${(rows || []).length})`);
    });
  } catch (e) { console.warn(`competitors hydrate [${tenant}] failed:`, e.message); }
}
refreshCompetitorsCache();

app.get('/api/semrush/tracked-competitors', srCached('tracked-comp', async (req) => {
  const db = req.query.db || req.config.semrush.database;
  const fetchDomain = async (domain) => {
    try {
      const r = await fetch(`https://api.semrush.com/?type=domain_rank&key=${req.config.semrush.apiKey}&export_columns=Dn,Rk,Or,Ot,Oc,Bl&domain=${domain}&database=${db}`);
      const text = await r.text();
      if (text.startsWith('ERROR')) return { Dn: domain, Or: 0, Ot: 0, Oc: 0, Bl: 0, Rk: 0 };
      return parseSemrushCSV(text)[0] || { Dn: domain };
    } catch(e) { return { Dn: domain }; }
  };
  // Fetch all tracked competitors for THIS tenant in parallel, batched in groups of 8
  const tracked = getTrackedDomains(req.tenant);
  const results = [];
  for (let i = 0; i < tracked.length; i += 8) {
    const batch = tracked.slice(i, i + 8);
    results.push(...await Promise.all(batch.map(fetchDomain)));
  }
  return { rows: results };
}));

const PS_CACHE_TTL_SECONDS = 23 * 60 * 60; // 23 hours
const PS_API_KEY = process.env.PSI_KEY || ''; // optional: set PSI_KEY env var for higher quota

app.get('/api/pagespeed', async (req, res) => {
  try {
    const url = req.query.url || 'https://kynection.com.au';
    const strategy = req.query.strategy || 'mobile';
    const cacheKey = `pagespeed:${strategy}:${url}`;
    const cached = await db.cacheGet(cacheKey, PS_CACHE_TTL_SECONDS);
    if (cached) return res.json(cached);
    const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=${strategy}${PS_API_KEY ? '&key=' + PS_API_KEY : ''}`;
    const r = await fetch(apiUrl);
    const d = await r.json();
    if (d.error) return res.status(400).json({ error: d.error.message });
    const cats = d.lighthouseResult?.categories || {};
    const audits = d.lighthouseResult?.audits || {};
    const result = {
      strategy, url,
      performance: Math.round((cats.performance?.score || 0) * 100),
      seo: Math.round((cats.seo?.score || 0) * 100),
      accessibility: Math.round((cats.accessibility?.score || 0) * 100),
      bestPractices: Math.round((cats['best-practices']?.score || 0) * 100),
      fcp: audits['first-contentful-paint']?.displayValue || '—',
      lcp: audits['largest-contentful-paint']?.displayValue || '—',
      cls: audits['cumulative-layout-shift']?.displayValue || '—',
      tbt: audits['total-blocking-time']?.displayValue || '—',
      tti: audits['interactive']?.displayValue || '—',
      speedIndex: audits['speed-index']?.displayValue || '—',
      fetchedAt: new Date().toISOString()
    };
    await db.cacheSet(cacheKey, 'pagespeed', result);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// HubSpot routes
// ============================================================
async function hubPost(ep, body) {
  const r = await fetch(`https://api.hubapi.com${ep}`, { method: 'POST', headers: { Authorization: `Bearer ${CONFIG.hubspot.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
async function hubGet(ep) {
  const r = await fetch(`https://api.hubapi.com${ep}`, { headers: { Authorization: `Bearer ${CONFIG.hubspot.accessToken}` } });
  return r.json();
}

app.get('/api/hubspot/mqls', async (req, res) => {
  try {
    res.json(await hubPost('/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters: [{ propertyName: 'lifecyclestage', operator: 'EQ', value: 'marketingqualifiedlead' }] }],
      properties: ['firstname','lastname','email','lifecyclestage','createdate','company','jobtitle','hs_analytics_source','hs_analytics_source_data_1','hs_analytics_source_data_2','hubspotscore','hs_lead_status','phone'],
      limit: 100, sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }]
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/hubspot/mql-trend', async (req, res) => {
  try {
    res.json(await hubPost('/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters: [{ propertyName: 'lifecyclestage', operator: 'EQ', value: 'marketingqualifiedlead' }, { propertyName: 'createdate', operator: 'GTE', value: String(Date.now() - 90 * 864e5) }] }],
      properties: ['createdate','hs_analytics_source'], limit: 200, sorts: [{ propertyName: 'createdate', direction: 'ASCENDING' }]
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/hubspot/deals', async (req, res) => {
  try {
    const { since: sinceDate } = parseDateRange(req.query, 365);
    const since = new Date(sinceDate).getTime();
    const chunkArr = (arr, n) => Array.from({length: Math.ceil(arr.length/n)}, (_,i) => arr.slice(i*n, i*n+n));

    // Paginate through ALL matching deals
    let allDeals = [];
    let after = undefined;
    do {
      const body = {
        filterGroups: [{ filters: [
          { propertyName: 'createdate', operator: 'GTE', value: String(since) }
        ]}],
        properties: ['dealname','amount','dealstage','closedate','createdate','pipeline','hs_analytics_source','hs_analytics_source_data_1','hs_analytics_source_data_2','hs_deal_stage_probability'],
        limit: 200, sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }]
      };
      if (after) body.after = after;
      const r = await hubPost('/crm/v3/objects/deals/search', body);
      allDeals = allDeals.concat(r.results || []);
      after = r.paging?.next?.after;
    } while (after);

    if (!allDeals.length) return res.json({ results: [], total: 0 });

    const dealIds = allDeals.map(d => d.id);
    const contactAssoc = {}, companyAssoc = {};

    // Associations: deals → contacts + companies
    for (const batch of chunkArr(dealIds, 100)) {
      try {
        const [cr, compr] = await Promise.all([
          hubPost('/crm/v4/associations/deals/contacts/batch/read', { inputs: batch.map(id=>({id})) }),
          hubPost('/crm/v4/associations/deals/companies/batch/read', { inputs: batch.map(id=>({id})) })
        ]);
        (cr.results||[]).forEach(row => { if(row.from?.id && row.to?.length) contactAssoc[row.from.id] = row.to[0].toObjectId; });
        (compr.results||[]).forEach(row => { if(row.from?.id && row.to?.length) companyAssoc[row.from.id] = row.to[0].toObjectId; });
      } catch(e) {}
    }

    // Fetch contacts
    const contactIds = [...new Set(Object.values(contactAssoc))].filter(Boolean);
    const contactMap = {};
    for (const batch of chunkArr(contactIds, 100)) {
      try {
        const r = await hubPost('/crm/v3/objects/contacts/batch/read', {
          inputs: batch.map(id=>({id})),
          properties: ['firstname','lastname','email','how_did_you_hear_about_kynection_','hs_analytics_source']
        });
        (r.results||[]).forEach(c => { contactMap[c.id] = c.properties; });
      } catch(e) {}
    }

    // Fetch companies
    const companyIds = [...new Set(Object.values(companyAssoc))].filter(Boolean);
    const companyMap = {};
    for (const batch of chunkArr(companyIds, 100)) {
      try {
        const r = await hubPost('/crm/v3/objects/companies/batch/read', {
          inputs: batch.map(id=>({id})),
          properties: ['name','how_did_you_hear_about_kynection_','hs_analytics_source']
        });
        (r.results||[]).forEach(c => { companyMap[c.id] = c.properties; });
      } catch(e) {}
    }

    // Enrich deals
    const enriched = allDeals.map(deal => {
      const p = deal.properties || {};
      const cid = contactAssoc[deal.id];
      const compId = companyAssoc[deal.id];
      const contact = cid ? (contactMap[cid] || {}) : {};
      const company = compId ? (companyMap[compId] || {}) : {};
      return {
        id: deal.id,
        dealname: p.dealname || '—',
        amount: p.amount || '0',
        dealstage: p.dealstage || '',
        closedate: p.closedate || '',
        createdate: p.createdate || '',
        pipeline: p.pipeline || '',
        source: p.hs_analytics_source || '',
        keyword: p.hs_analytics_source_data_1 || p.hs_analytics_source_data_2 || '',
        probability: p.hs_deal_stage_probability || '',
        contactId: cid || null,
        contactName: [contact.firstname, contact.lastname].filter(Boolean).join(' ') || '',
        contactEmail: contact.email || '',
        contactHowHeard: contact.how_did_you_hear_about_kynection_ || '',
        contactSource: contact.hs_analytics_source || '',
        companyId: compId || null,
        companyName: company.name || '',
        companyHowHeard: company.how_did_you_hear_about_kynection_ || '',
        companySource: company.hs_analytics_source || ''
      };
    });

    res.json({ results: enriched, total: enriched.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/hubspot/deal-stages', async (req, res) => {
  try { res.json(await hubGet('/crm/v3/pipelines/deals')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/hubspot/lifecycle-options', async (req, res) => {
  try {
    const r = await hubGet('/crm/v3/properties/contacts/lifecyclestage');
    res.json({ options: r.options || [] });
  } catch(e) { res.status(500).json({ error: e.message, options: [] }); }
});

app.get('/api/hubspot/demos', async (req, res) => {
  try {
    const { since: sinceDate } = parseDateRange(req.query);
    const since = new Date(sinceDate).getTime();
    const [r1, r2] = await Promise.all([
      hubPost('/crm/v3/objects/meetings/search', {
        filterGroups: [{ filters: [
          { propertyName: 'hs_meeting_title', operator: 'CONTAINS_TOKEN', value: 'Demo Booked' },
          { propertyName: 'hs_createdate', operator: 'GTE', value: String(since) }
        ]}],
        properties: ['hs_meeting_title','hs_timestamp','hs_createdate','hs_meeting_outcome','hs_activity_type'],
        limit: 100, sorts: [{ propertyName: 'hs_createdate', direction: 'DESCENDING' }]
      }),
      hubPost('/crm/v3/objects/meetings/search', {
        filterGroups: [{ filters: [
          { propertyName: 'hs_activity_type', operator: 'EQ', value: 'Sales - Demo' },
          { propertyName: 'hs_createdate', operator: 'GTE', value: String(since) }
        ]}],
        properties: ['hs_meeting_title','hs_timestamp','hs_createdate','hs_meeting_outcome','hs_activity_type'],
        limit: 100, sorts: [{ propertyName: 'hs_createdate', direction: 'DESCENDING' }]
      })
    ]);
    const all = [...(r1.results||[]), ...(r2.results||[])];
    const seen = new Set();
    const meetings = all.filter(m => { if(seen.has(m.id)) return false; seen.add(m.id); return true; });
    if (!meetings.length) return res.json({ results: [] });
    const chunk = (arr,n) => Array.from({length:Math.ceil(arr.length/n)},(_,i)=>arr.slice(i*n,i*n+n));
    const contactAssoc = {}, meetingCompanyAssoc = {};
    for (const batch of chunk(meetings.map(m=>m.id), 100)) {
      try {
        const [cr, compr] = await Promise.all([
          hubPost('/crm/v4/associations/meetings/contacts/batch/read', { inputs: batch.map(id=>({id})) }),
          hubPost('/crm/v4/associations/meetings/companies/batch/read', { inputs: batch.map(id=>({id})) })
        ]);
        (cr.results||[]).forEach(row => { if(row.from?.id && row.to?.length) contactAssoc[row.from.id] = row.to[0].toObjectId; });
        (compr.results||[]).forEach(row => { if(row.from?.id && row.to?.length) meetingCompanyAssoc[row.from.id] = row.to[0].toObjectId; });
      } catch(e) {}
    }
    const contactIds = [...new Set(Object.values(contactAssoc))].filter(Boolean);
    const contactMap = {};
    if (contactIds.length) {
      for (const batch of chunk(contactIds, 100)) {
        try {
          const r = await hubPost('/crm/v3/objects/contacts/batch/read', {
            inputs: batch.map(id=>({id})),
            properties: ['firstname','lastname','hs_analytics_source','how_did_you_hear_about_kynection_','lifecyclestage']
          });
          (r.results||[]).forEach(c => { contactMap[c.id] = c.properties; });
        } catch(e) {}
      }
    }
    // Batch read companies — from meeting→company assoc, fall back to contact→company assoc
    const contactCompanyAssoc = {};
    for (const batch of chunk(contactIds, 100)) {
      try {
        const r = await hubPost('/crm/v4/associations/contacts/companies/batch/read', { inputs: batch.map(id=>({id})) });
        (r.results||[]).forEach(row => { if(row.from?.id && row.to?.length) contactCompanyAssoc[row.from.id] = row.to[0].toObjectId; });
      } catch(e) {}
    }
    const allCompanyIds = [...new Set([
      ...Object.values(meetingCompanyAssoc),
      ...Object.values(contactCompanyAssoc)
    ])].filter(Boolean);
    const companyMap = {};
    if (allCompanyIds.length) {
      for (const batch of chunk(allCompanyIds, 100)) {
        try {
          const r = await hubPost('/crm/v3/objects/companies/batch/read', {
            inputs: batch.map(id=>({id})),
            properties: ['name','how_did_you_hear_about_kynection_','hs_analytics_source']
          });
          (r.results||[]).forEach(c => { companyMap[c.id] = c.properties; });
        } catch(e) {}
      }
    }
    const enriched = meetings.map(m => {
      const mp = m.properties||{};
      const cid = contactAssoc[m.id];
      const contact = cid ? (contactMap[cid]||{}) : {};
      // Company: prefer meeting→company assoc, then contact→company assoc, then title regex
      const companyId = meetingCompanyAssoc[m.id] || (cid ? contactCompanyAssoc[cid] : null) || null;
      const company = companyId ? (companyMap[companyId]||{}) : {};
      const tm = (mp.hs_meeting_title||'').match(/Demo Booked with (.+?) From (.+)/i);
      return {
        id: m.id,
        title: mp.hs_meeting_title||'',
        activityType: mp.hs_activity_type||'',
        outcome: mp.hs_meeting_outcome||'',
        scheduledAt: mp.hs_timestamp||'',
        bookedAt: mp.hs_createdate||'',
        contactId: cid || null,
        companyId: companyId || null,
        contactName: [contact.firstname,contact.lastname].filter(Boolean).join(' ') || (tm?.[1]||'—'),
        company: company.name || (tm?.[2]||'—'),
        howHeard: contact.how_did_you_hear_about_kynection_ || company.how_did_you_hear_about_kynection_ || '—',
        source: contact.hs_analytics_source || company.hs_analytics_source || '—',
        lifecycleStage: contact.lifecyclestage||''
      };
    });
    enriched.sort((a,b) => new Date(b.bookedAt) - new Date(a.bookedAt));
    res.json({ results: enriched, total: enriched.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Leads Pipeline (object 0-136) ──────────────────────────────
app.get('/api/hubspot/leads-pipeline', async (req, res) => {
  try {
    // Step 1: Get pipeline stages for object 0-136
    let stageMap = {};
    let excludedStageIds = [];
    try {
      const pd = await hubGet('/crm/v3/pipelines/0-136');
      (pd.results || []).forEach(pl => {
        (pl.stages || []).forEach(s => {
          stageMap[s.id] = s.label;
          if (/channel.?referred|client.?referred/i.test(s.label)) {
            excludedStageIds.push(s.id);
          }
        });
      });
    } catch(e) { console.log('Pipeline stages error:', e.message); }

    // Step 2: Search leads (no date filter — pipeline shows all active leads)
    const baseFilters = [];
    // Always exclude Disqualified stage
    const disqualifiedId = Object.entries(stageMap).find(([k,v]) => /disqualif/i.test(v))?.[0] || 'unqualified-stage-id';
    if (!excludedStageIds.includes(disqualifiedId)) excludedStageIds.push(disqualifiedId);
    if (excludedStageIds.length > 0) baseFilters.push({ propertyName: 'hs_pipeline_stage', operator: 'NOT_IN', values: excludedStageIds });
    const searchBody = {
      properties: ['hs_pipeline','hs_pipeline_stage','hs_lead_name','hs_lead_status','hs_createdate','hs_analytics_source','hs_priority'],
      limit: 200,
      sorts: [{ propertyName: 'hs_createdate', direction: 'DESCENDING' }]
    };
    if (baseFilters.length > 0) searchBody.filterGroups = [{ filters: baseFilters }];
    const leadsData = await hubPost('/crm/v3/objects/0-136/search', searchBody);
    const leads = leadsData.results || [];

    if (!leads.length) return res.json({ results: [], total: 0, stageMap });

    const leadIds = leads.map(l => l.id);

    // Helper: chunk array into batches of n
    const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length/n) }, (_,i) => arr.slice(i*n, i*n+n));

    // Helper: batch association lookup in chunks of 100
    async function batchAssoc(fromType, toType, ids) {
      const map = {};
      for (const batch of chunk(ids, 100)) {
        try {
          const r = await hubPost(`/crm/v4/associations/${fromType}/${toType}/batch/read`, { inputs: batch.map(id => ({ id })) });
          (r.results || []).forEach(row => { if (row.from?.id && row.to?.length) map[row.from.id] = row.to[0].toObjectId; });
        } catch(e) { console.log(`Assoc ${fromType}→${toType} error:`, e.message); }
      }
      return map;
    }

    // Helper: batch read object properties in chunks of 100
    async function batchRead(objectType, ids, properties) {
      const map = {};
      for (const batch of chunk(ids, 100)) {
        try {
          const r = await hubPost(`/crm/v3/objects/${objectType}/batch/read`, { inputs: batch.map(id => ({ id })), properties });
          (r.results || []).forEach(o => { map[o.id] = o.properties; });
        } catch(e) { console.log(`Batch read ${objectType} error:`, e.message); }
      }
      return map;
    }

    // Step 3: Get associations (leads → contacts, leads → companies)
    const [contactAssoc, companyAssoc] = await Promise.all([
      batchAssoc('0-136', '0-1', leadIds),
      batchAssoc('0-136', '0-2', leadIds)
    ]);

    // Step 4: Batch read contacts
    const contactIds = [...new Set(Object.values(contactAssoc))].filter(Boolean);
    const contactMap = contactIds.length
      ? await batchRead('contacts', contactIds, ['firstname','lastname','email','lifecyclestage','company','hs_analytics_source','jobtitle','phone','how_did_you_hear_about_kynection_'])
      : {};

    // Step 5: Batch read companies for ICP
    const companyIds = [...new Set(Object.values(companyAssoc))].filter(Boolean);
    const companyMap = companyIds.length
      ? await batchRead('companies', companyIds, ['name','numberofemployees','number_of_users___company_based_','industry','city','country','hs_analytics_source','how_did_you_hear_about_kynection_'])
      : {};

    // Lifecycle stage filter:
    // EXCLUDE: Channel referred leads (1096846716) and Client referred leads (1096778645)
    // INCLUDE: MQL (172692338), Cold Leads (208016527), Lead/Contacts (marketingqualifiedlead), SQL (salesqualifiedlead), and others from marketing
    const EXCLUDED_LC = new Set(['1096846716', '1096778645']);
    const MARKETING_LC = new Set(['172692338', '208016527', 'marketingqualifiedlead', 'salesqualifiedlead', '208028254', '1233052814', '1096196739', 'lead', 'opportunity']);

    // Step 6: Enrich and filter
    const enriched = [];
    for (const lead of leads) {
      const p = lead.properties || {};
      const cid = contactAssoc[lead.id];
      const compid = companyAssoc[lead.id];
      const contact = cid ? (contactMap[cid] || {}) : {};
      const company = compid ? (companyMap[compid] || {}) : {};
      const lc = contact.lifecyclestage || '';

      // Exclude channel/client referred leads
      if (lc && EXCLUDED_LC.has(lc)) continue;

      const employees = parseInt(company.numberofemployees || 0);
      const estUsers = parseInt(company.number_of_users___company_based_ || 0);
      enriched.push({
        id: lead.id,
        name: p.hs_lead_name || [contact.firstname, contact.lastname].filter(Boolean).join(' ') || '(no name)',
        email: contact.email || '',
        company: company.name || contact.company || '',
        industry: company.industry || '',
        jobtitle: contact.jobtitle || '',
        pipelineStageId: p.hs_pipeline_stage || '',
        pipelineStage: stageMap[p.hs_pipeline_stage] || p.hs_pipeline_stage || 'Unknown',
        lifecycleStage: lc,
        source: contact.hs_analytics_source || p.hs_analytics_source || company.hs_analytics_source || '',
        createdate: p.hs_createdate || p.createdate || '',
        icpQualified: employees > 20 || estUsers > 20,
        employees,
        estUsers,
        howHeard: contact.how_did_you_hear_about_kynection_ || company.how_did_you_hear_about_kynection_ || '',
        contactId: cid || null,
        companyId: compid || null
      });
    }

    res.json({ results: enriched, total: leadsData.total || enriched.length, stageMap, excludedStageIds });
  } catch(e) {
    console.error('leads-pipeline error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// YouTube Analytics routes
// ============================================================
const _ytChannelIdByTenant = {};

// YouTube response cache (30-minute TTL — YT Analytics data lags 24-48h anyway).
// Now backed by db.cache* (L1 in-memory + L2 Supabase api_cache).
// Cache keys are prefixed with the tenant so KYN and IR don't collide.
const YT_CACHE_TTL_SECONDS = 30 * 60;
const ytCacheGet = (req, key) => db.cacheGet(`youtube:${req.tenant}:` + key, YT_CACHE_TTL_SECONDS);
const ytCacheSet = (req, key, data) => db.cacheSet(`youtube:${req.tenant}:` + key, 'youtube', data);

async function getChannelId(req) {
  if (_ytChannelIdByTenant[req.tenant]) return _ytChannelIdByTenant[req.tenant];
  const t = await getYTToken(req);
  const r = await fetch('https://www.googleapis.com/youtube/v3/channels?part=id,snippet,statistics&mine=true', { headers: { Authorization: `Bearer ${t}` } });
  const d = await r.json();
  _ytChannelIdByTenant[req.tenant] = d.items?.[0]?.id;
  return _ytChannelIdByTenant[req.tenant];
}

function ytDateRange(days) {
  const end = new Date();
  const start = new Date(Date.now() - days * 864e5);
  const fmt = d => d.toISOString().split('T')[0];
  return { start: fmt(start), end: fmt(end) };
}

app.get('/api/youtube/overview', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 28;
    const cacheKey = `overview_${days}`;
    const cached = await ytCacheGet(req, cacheKey);
    if (cached) return res.json(cached);
    const t = await getYTToken(req);
    const { start, end } = ytDateRange(days);
    const prevEnd = new Date(Date.now() - days * 864e5); const prevFmtEnd = prevEnd.toISOString().split('T')[0];
    const prevStart = new Date(prevEnd.getTime() - days * 864e5); const prevFmtStart = prevStart.toISOString().split('T')[0];
    const [channel, curr, prev] = await Promise.all([
      fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true', { headers: { Authorization: `Bearer ${t}` } }).then(r => r.json()),
      fetch(`https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate=${start}&endDate=${end}&metrics=views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost,likes,comments`, { headers: { Authorization: `Bearer ${t}` } }).then(r => r.json()),
      fetch(`https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate=${prevFmtStart}&endDate=${prevFmtEnd}&metrics=views,estimatedMinutesWatched,averageViewDuration,subscribersGained`, { headers: { Authorization: `Bearer ${t}` } }).then(r => r.json())
    ]);
    const result = { channel: channel.items?.[0], current: curr, previous: prev };
    ytCacheSet(req, cacheKey, result);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/youtube/top-videos', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 28;
    const cacheKey = `top-videos_${days}`;
    const cached = await ytCacheGet(req, cacheKey);
    if (cached) return res.json(cached);
    const t = await getYTToken(req);
    const { start, end } = ytDateRange(days);
    const analytics = await fetch(
      `https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate=${start}&endDate=${end}&metrics=views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes&dimensions=video&sort=-views&maxResults=20`,
      { headers: { Authorization: `Bearer ${t}` } }
    ).then(r => r.json());

    if (!analytics.rows?.length) { ytCacheSet(req, cacheKey, { rows: [] }); return res.json({ rows: [] }); }
    const videoIds = analytics.rows.map(r => r[0]).join(',');
    const videos = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${videoIds}`, { headers: { Authorization: `Bearer ${t}` } }).then(r => r.json());
    const vMap = {};
    (videos.items || []).forEach(v => { vMap[v.id] = v; });
    const cols = analytics.columnHeaders?.map(c => c.name) || ['video','views','estimatedMinutesWatched','averageViewDuration','averageViewPercentage','likes'];
    const result = { rows: analytics.rows.map(row => ({ videoId: row[0], title: vMap[row[0]]?.snippet?.title || row[0], thumbnail: vMap[row[0]]?.snippet?.thumbnails?.default?.url, publishedAt: vMap[row[0]]?.snippet?.publishedAt, views: row[1], watchMinutes: row[2], avgDuration: row[3], avgPercentage: row[4], likes: row[5] })) };
    ytCacheSet(req, cacheKey, result);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/youtube/traffic-sources', async (req, res) => {
  try {
    const cached = await ytCacheGet(req, 'traffic-sources');
    if (cached) return res.json(cached);
    const t = await getYTToken(req);
    const { start, end } = ytDateRange(28);
    const result = await fetch(`https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate=${start}&endDate=${end}&metrics=views,estimatedMinutesWatched&dimensions=insightTrafficSourceType&sort=-views`, { headers: { Authorization: `Bearer ${t}` } }).then(r => r.json());
    ytCacheSet(req, 'traffic-sources', result);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/youtube/trend', async (req, res) => {
  try {
    const cached = await ytCacheGet(req, 'trend');
    if (cached) return res.json(cached);
    const t = await getYTToken(req);
    const { start, end } = ytDateRange(90);
    const result = await fetch(`https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate=${start}&endDate=${end}&metrics=views,estimatedMinutesWatched,subscribersGained&dimensions=day&sort=day`, { headers: { Authorization: `Bearer ${t}` } }).then(r => r.json());
    ytCacheSet(req, 'trend', result);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/youtube/demographics', async (req, res) => {
  try {
    const cached = await ytCacheGet(req, 'demographics');
    if (cached) return res.json(cached);
    const t = await getYTToken(req);
    const { start, end } = ytDateRange(28);
    const result = await fetch(`https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate=${start}&endDate=${end}&metrics=viewerPercentage&dimensions=ageGroup,gender`, { headers: { Authorization: `Bearer ${t}` } }).then(r => r.json());
    ytCacheSet(req, 'demographics', result);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// GSC auto-detect (per-tenant)
// ============================================================
// Each tenant has its own Google account / refresh token / verified domain.
// We discover the right GSC site once per tenant, cache it, and inject it
// into req.config.gsc.siteUrl via the middleware below so all the existing
// GSC routes just read req.config.gsc.siteUrl as before.
const _gscSiteByTenant = {};  // tenant -> resolved site URL string
const _gscDetectionPromise = {}; // tenant -> in-flight promise (dedupe concurrent first hits)

async function detectGSCSite(tenant) {
  if (_gscSiteByTenant[tenant]) return _gscSiteByTenant[tenant];
  if (_gscDetectionPromise[tenant]) return _gscDetectionPromise[tenant];
  _gscDetectionPromise[tenant] = (async () => {
    const tenantCfg = buildConfig(tenant);
    const fakeReq = { tenant, config: tenantCfg };
    const fallback = `https://www.${tenantCfg.brand.domain}/`;
    try {
      const t = await getGoogleToken(fakeReq);
      const d = await fetch('https://www.googleapis.com/webmasters/v3/sites', { headers: { Authorization: `Bearer ${t}` } }).then(r => r.json());
      const sites = (d.siteEntry || []).map(s => s.siteUrl);
      // Match by the brand's bare domain root (kynection / intelligentresourcing)
      const bareDomain = tenantCfg.brand.domain.split('.')[0].toLowerCase();
      const matched = sites.find(s => s.startsWith('sc-domain:') && s.toLowerCase().includes(bareDomain))
                   || sites.find(s => s.toLowerCase().includes(bareDomain));
      _gscSiteByTenant[tenant] = matched || sites[0] || fallback;
      console.log(`✅ GSC [${tenant}]: ${_gscSiteByTenant[tenant]}`);
    } catch (e) {
      _gscSiteByTenant[tenant] = fallback;
      console.warn(`⚠ GSC [${tenant}] detection failed: ${e.message} — using fallback ${fallback}`);
    } finally {
      delete _gscDetectionPromise[tenant];
    }
    return _gscSiteByTenant[tenant];
  })();
  return _gscDetectionPromise[tenant];
}

// ── AEO Results persistence (per-tenant) ────────────────────
// In-memory cache, keyed by tenant. Each tenant's data hydrates from its own
// Supabase project on startup. Mutation paths persist incrementally via the
// tenant-scoped db helpers (db.forTenant(t, () => ...)).
const _aeoResultsByTenant = {};
for (const t of KNOWN_TENANTS) _aeoResultsByTenant[t] = {};

// Hydrate each tenant's cache in parallel at boot.
for (const t of KNOWN_TENANTS) {
  db.forTenant(t, () => db.loadAllAeoResults())
    .then(d => { _aeoResultsByTenant[t] = d; console.log(`📊 AEO [${t}]: hydrated ${Object.keys(d).length} prompts`); })
    .catch(e => console.error(`Failed to load AEO results [${t}]:`, e.message));
}

// Helper for routes — `req.tenant` is set by the tenant middleware.
function aeoResultsFor(req) { return _aeoResultsByTenant[req.tenant] || (_aeoResultsByTenant[req.tenant] = {}); }

// JSON-fallback writer (only used when Supabase isn't configured for this
// tenant). Each tenant has its own JSON file path. Run from within a
// db.forTenant() context so currentTenant() resolves correctly inside db.js.
function saveAeoResults(req) {
  const tenant = req?.tenant || 'kyn';
  if (db.getClient(tenant)) return; // Supabase path persists per-mutation
  const file = tenant === 'kyn'
    ? (process.env.AEO_RESULTS_FILE || path.join(__dirname, 'aeo-results.json'))
    : path.join(__dirname, `aeo-results-${tenant}.json`);
  try { fs.writeFileSync(file, JSON.stringify(_aeoResultsByTenant[tenant] || {})); } catch(e) {}
}

// COMP_NAMES is now declared as `let` near the top of the file alongside
// the dynamic competitors cache — see refreshCompetitorsCache().

// Tenant-aware mention detector. `opts` is { brandName, brandDomain, tenant }.
// Without opts (legacy callers), falls back to the original Kynection
// hardcoded behaviour.
function checkMentions(text, opts = {}) {
  const tenant     = opts.tenant || 'kyn';
  const brandName  = (opts.brandName  || 'Kynection').toLowerCase();
  // The "brand needle" for short-text scans — first word of the brand name,
  // lowercase, alpha-only. "Intelligent Resourcing" -> "intelligent",
  // "Kynection" -> "kynection".
  const brandNeedle = brandName.split(/\s+/)[0].replace(/[^a-z0-9]/g,'') || brandName;
  const brandDomain = (opts.brandDomain || 'kynection.com').toLowerCase();
  const tracked     = getTrackedDomains(tenant);
  const compNames   = getCompNamesMap(tenant);

  const lower = text.toLowerCase();
  const mentioned = lower.includes(brandNeedle);
  const cited = lower.includes(brandDomain);
  // attributedCitation is now determined by sourceUrls (structured annotations), not text matching.
  // It is set to false here and overridden after the call when sourceUrls are available.
  const attributedCitation = false;
  const sources = lower.includes('http') || lower.includes('www.') || (lower.match(/\[[\d]+\]/) !== null);
  const competitorsMentioned = tracked.filter(domain => {
    const name = (compNames[domain] || domain.split('.')[0]).toLowerCase();
    return lower.includes(domain) || lower.includes(name);
  });

  // Position tracking: early/mid/late + numeric rank
  let mentionPosition = null;
  let mentionRank = null;
  if (mentioned) {
    const brandPos = lower.indexOf(brandNeedle);
    const frac = brandPos / lower.length;
    if (frac < 0.25) mentionPosition = 'early';
    else if (frac < 0.60) mentionPosition = 'mid';
    else mentionPosition = 'late';
    // Rank: count how many competitor brands appear before our brand (1 = first mentioned)
    mentionRank = 1;
    competitorsMentioned.forEach(domain => {
      const name = (compNames[domain] || domain.split('.')[0]).toLowerCase();
      const positions = [lower.indexOf(name), lower.indexOf(domain)].filter(p => p !== -1);
      if (positions.length) {
        const firstPos = Math.min(...positions);
        if (firstPos < brandPos) mentionRank++;
      }
    });
  }

  // Sentiment: analyse context around brand mention
  let sentiment = null;
  if (mentioned) {
    const brandPos = lower.indexOf(brandNeedle);
    const ctx = lower.slice(Math.max(0, brandPos - 150), brandPos + 350);
    const posWords = ['leading','best','excellent','top','recommend','trusted','preferred','proven','comprehensive','robust','powerful','popular','strong','effective','ideal','great','impressive','purpose-built','specialised','specialized','dedicated','award','innovative','advanced'];
    const negWords = ['limited','lacks','lacking','poor','expensive','costly','difficult','complex','unreliable','slow','outdated','basic','weak','inferior','concern','however','but ','although','despite','not ideal','smaller','niche'];
    const posScore = posWords.filter(w => ctx.includes(w)).length;
    const negScore = negWords.filter(w => ctx.includes(w)).length;
    sentiment = posScore > negScore ? 'positive' : negScore > posScore ? 'negative' : 'neutral';
  }

  return { mentioned, cited, attributedCitation, sources, competitorsMentioned, mentionPosition, mentionRank, sentiment };
}

app.get('/api/aeo/results', async (req, res) => {
  // Always load fresh from Supabase. The in-memory _aeoResultsByTenant
  // cache hydrates async at module boot and is unreliable on Vercel
  // serverless cold starts — a request on a cold function would get
  // an empty {} before hydration completes, producing a blank Prompts
  // tab even though the data exists in Supabase. Refreshing the cache
  // here keeps subsequent in-process accesses fast while guaranteeing
  // the response is correct on every request.
  try {
    const data = await db.forTenant(req.tenant, () => db.loadAllAeoResults());
    _aeoResultsByTenant[req.tenant] = data;
    res.json(data);
  } catch (e) {
    // Supabase blip — fall back to whatever's in the in-memory cache
    console.warn(`/api/aeo/results [${req.tenant}] load failed:`, e.message);
    res.json(aeoResultsFor(req));
  }
});

// ── Competitors ───────────────────────────────────────────────
app.get('/api/aeo/competitors', async (req, res) => {
  try { res.json(await db.listCompetitors({ activeOnly: false })); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Accepts either { domain, display_name } for one, or { bulk: "domain,name\n..." }
// for many at once. Returns the list of inserted rows.
app.post('/api/aeo/competitors', async (req, res) => {
  const { domain, display_name, bulk } = req.body || {};
  const userEmail = req.user?.email || null;
  try {
    const out = [];
    if (bulk && typeof bulk === 'string') {
      for (const raw of bulk.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        const [d, ...nameParts] = line.split(/[,\t]/).map(s => s.trim());
        if (!d) continue;
        try {
          const row = await db.addCompetitor({ domain: d, display_name: nameParts.join(' ') || null, added_by: userEmail });
          if (row) out.push(row);
        } catch(e) { /* skip invalid line, keep going */ }
      }
    } else if (domain) {
      const row = await db.addCompetitor({ domain, display_name, added_by: userEmail });
      if (row) out.push(row);
    } else {
      return res.status(400).json({ error: 'Provide `domain` (and optional `display_name`), or `bulk` text' });
    }
    await refreshCompetitorsCache();
    res.json({ added: out.length, rows: out });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/aeo/competitors/:id', async (req, res) => {
  try {
    const ok = await db.deleteCompetitor(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    await refreshCompetitorsCache();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/aeo/competitors/:id', async (req, res) => {
  const { is_active } = req.body || {};
  try {
    const row = await db.setCompetitorActive(req.params.id, !!is_active);
    if (!row) return res.status(404).json({ error: 'Not found' });
    await refreshCompetitorsCache();
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Stream history ────────────────────────────────────────────
app.get('/api/aeo/stream-history', async (req, res) => {
  try { res.json(await db.listStreamHistory(parseInt(req.query.limit) || 100)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/aeo/stream-history', async (req, res) => {
  const { run_date, prompts_count, models, runs_count, source, note } = req.body || {};
  if (!run_date || !Array.isArray(models)) return res.status(400).json({ error: 'run_date and models[] required' });
  try {
    const row = await db.recordStreamHistory({
      run_date,
      prompts_count: prompts_count || 0,
      models,
      runs_count: runs_count || 0,
      source: source || 'manual',
      note: note || null
    });
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/aeo/stream-history/:id', async (req, res) => {
  const { note } = req.body || {};
  try {
    const row = await db.updateStreamHistoryNote(req.params.id, note ?? null);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/aeo/stream-history/:id', async (req, res) => {
  try {
    const ok = await db.deleteStreamHistoryEntry(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/aeo/delete-runs', async (req, res) => {
  const { promptId, indices } = req.body || {};
  if (!promptId || !Array.isArray(indices)) return res.status(400).json({ error: 'Invalid request' });
  const results = aeoResultsFor(req);
  if (results[promptId]?.runs) {
    const runs = results[promptId].runs;
    const valid = indices.filter(i => i >= 0 && i < runs.length);
    const dbIds = valid.map(i => runs[i]._dbId).filter(Boolean);
    const sorted = [...valid].sort((a, b) => b - a);
    sorted.forEach(i => runs.splice(i, 1));
    try {
      await db.deleteAeoRuns(dbIds);
      saveAeoResults(req);
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }
  res.json({ ok: true });
});

// Backfill mentionPosition, mentionRank, sentiment AND attributedCitation on old runs
app.post('/api/aeo/backfill', async (req, res) => {
  let updated = 0;
  const dbUpdates = [];
  const brandNeedle = req.config.brand.name.toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9]/g,'');
  const brandDomainLower = req.config.brand.domain.toLowerCase();
  for (const data of Object.values(aeoResultsFor(req))) {
    for (const run of (data.runs || [])) {
      let changed = false;
      const text = run.response || '';
      const checks = checkMentions(text, { tenant: req.tenant, brandName: req.config.brand.name, brandDomain: req.config.brand.domain });

      // Re-derive attributedCitation from sourceUrls ONLY (structured annotations)
      const urls = run.sourceUrls || [];
      const brandInSources = urls.some(s => {
        const d = (typeof s === 'string' ? s : (s.domain || '')).toLowerCase();
        const t = (typeof s === 'object' ? (s.title || '') : '').toLowerCase();
        return d.includes(brandDomainLower) || d.includes(brandNeedle) || t.includes(brandNeedle);
      });

      // mentioned: brand named anywhere in response text
      if (run.mentioned !== checks.mentioned) { run.mentioned = checks.mentioned; changed = true; }

      // cited: purely text-based — brand domain appears in response text
      if (run.cited !== checks.cited) { run.cited = checks.cited; changed = true; }

      // attributedCitation: structured source annotation only (strictest)
      if (run.attributedCitation !== brandInSources) { run.attributedCitation = brandInSources; changed = true; }

      // Backfill position/rank/sentiment if missing
      if (run.mentionPosition === undefined || run.mentionRank === undefined || run.sentiment === undefined) {
        run.mentionPosition  = checks.mentionPosition;
        run.mentionRank      = checks.mentionRank;
        run.sentiment        = checks.sentiment;
        changed = true;
      }

      if (changed) {
        updated++;
        if (run._dbId) {
          dbUpdates.push({
            id: run._dbId,
            mentioned: run.mentioned,
            cited: run.cited,
            attributed_citation: run.attributedCitation,
            mention_position: run.mentionPosition,
            mention_rank: run.mentionRank ?? null,
            sentiment: run.sentiment
          });
        }
      }
    }
  }
  try {
    await db.updateAeoRuns(dbUpdates);
    saveAeoResults(req);
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
  res.json({ ok: true, updated });
});

app.post('/api/aeo/stream', async (req, res) => {
  const { prompts = [], models = [] } = req.body || {};
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const send = (d) => { res.write(`data: ${JSON.stringify(d)}\n\n`); };

  const callClaude = async (prompt) => {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY not configured');
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{'x-api-key':key,'anthropic-version':'2023-06-01','content-type':'application/json'},
      body: JSON.stringify({ model:'claude-opus-4-5', max_tokens:1024, messages:[{role:'user',content:prompt}] })
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    return d.content?.[0]?.text || '';
  };

  const callOpenAI = async (prompt) => {
    const key = process.env.OPENAI_API_KEY || CONFIG.openai?.apiKey;
    if (!key) throw new Error('OPENAI_API_KEY not configured');
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-search-preview',
        web_search_options: { user_location: { type: 'approximate', approximate: { country: 'AU', city: 'Sydney', timezone: 'Australia/Sydney' } } },
        messages: [
          { role: 'system', content: 'You are searching from Australia. Prioritise Australian sources, websites and search results.' },
          { role: 'user', content: prompt }
        ]
      })
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    const msg = d.choices?.[0]?.message || {};
    const text = typeof msg.content === 'string' ? msg.content : (msg.content || []).map(c => c.text || '').join('');
    const annotations = msg.annotations || [];
    // Build deduplicated source list
    const urlMap = {};
    annotations.forEach(a => { const c = a.url_citation || a; if (c.url && !urlMap[c.url]) urlMap[c.url] = c.title || c.url; });
    const sources = Object.entries(urlMap).map(([uri, title], i) => ({
      index: i + 1, title, uri,
      domain: (() => { try { return new URL(uri).hostname.replace('www.', ''); } catch(e) { return 'openai.com'; } })()
    }));
    // Insert [n] citation markers into text (work backwards to preserve indices)
    let annotatedText = text;
    const sorted = [...annotations]
      .map(a => a.url_citation || a)
      .filter(c => c.end_index != null && c.url)
      .sort((a, b) => b.end_index - a.end_index);
    for (const c of sorted) {
      const idx = sources.findIndex(s => s.uri === c.url) + 1;
      if (idx > 0) annotatedText = annotatedText.slice(0, c.end_index) + `[${idx}]` + annotatedText.slice(c.end_index);
    }
    return { text: annotatedText, sourceUrls: sources };
  };

  const callPerplexity = async (prompt) => {
    const key = process.env.PERPLEXITY_API_KEY;
    if (!key) throw new Error('PERPLEXITY_API_KEY not configured');
    // Australian context: ask Perplexity to prefer AU sources, matching the
    // behaviour of the other callers (Gemini + AIOverview both bias AU).
    const r = await fetch('https://api.perplexity.ai/chat/completions', {
      method:'POST',
      headers:{'Authorization':`Bearer ${key}`,'Content-Type':'application/json'},
      body: JSON.stringify({
        model: 'sonar',
        messages: [
          { role: 'system', content: 'You are searching from Australia. Prioritise Australian sources, websites and search results when relevant.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 1024,
        return_citations: true,
        return_related_questions: false
      })
    });
    const d = await r.json();
    if (d.error) throw new Error(JSON.stringify(d.error));
    const text = d.choices?.[0]?.message?.content || '';

    // Extract sources. Perplexity returns citations in one of two shapes
    // depending on API version:
    //   1. search_results: [{ title, url, date }]    (newer Sonar)
    //   2. citations: ["https://...", "https://..."] (older format, flat URLs)
    // Normalise to the { index, title, uri, domain } shape used by the
    // other callers so the UI shows them in the Sources column.
    let sources = [];
    if (Array.isArray(d.search_results) && d.search_results.length) {
      sources = d.search_results.map((s, i) => {
        let domain = '';
        try { domain = new URL(s.url).hostname.replace(/^www\./, ''); } catch(e) {}
        return { index: i + 1, title: s.title || `Source ${i+1}`, uri: s.url, domain };
      });
    } else if (Array.isArray(d.citations) && d.citations.length) {
      sources = d.citations.map((url, i) => {
        let domain = '';
        try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch(e) {}
        return { index: i + 1, title: domain || `Source ${i+1}`, uri: url, domain };
      });
    }
    return { text, sourceUrls: sources };
  };

  const callGemini = async (prompt) => {
    const key = process.env.GEMINI_API_KEY || CONFIG.gemini.apiKey;
    if (!key) throw new Error('GEMINI_API_KEY not configured');
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
      contents:[{parts:[{text:prompt}]}],
      tools:[{"google_search":{}}],
      systemInstruction:{ parts:[{ text:'You are searching from Australia. Prioritise Australian sources, websites and search results.' }] }
    })
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    const parts = d.candidates?.[0]?.content?.parts || [];
    const text = parts.filter(p=>p.text).map(p=>p.text).join('') || '';
    // Extract sources: keep ALL chunks with original index (1-based) — no deduplication
    // so citation markers [n] in text match source numbers
    const chunks = d.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    const rawSources = chunks.map((c, i) => {
      const title = c.web?.title || '';
      const uri = c.web?.uri || '';
      // Try to extract real domain from page title (e.g. "Field Service Software | kynection.com.au")
      const domainMatch = title.match(/([a-zA-Z0-9-]+\.(?:com\.au|org\.au|net\.au|gov\.au|edu\.au|com|org|net|io|co|app|ai|au))(?:\s*[|\-,]|\s*$)/i);
      let domain;
      if (domainMatch) {
        domain = domainMatch[1].toLowerCase();
      } else {
        // Fall back to URI hostname (will be vertexaisearch for Gemini, but better than nothing)
        try { domain = new URL(uri).hostname.replace('www.', ''); } catch(e) { domain = 'google.com'; }
      }
      return { index: i + 1, title: title || `Source ${i+1}`, uri, domain };
    });

    // Resolve Gemini's grounding-redirect URLs to their real destinations.
    // Those redirects (vertexaisearch.cloud.google.com/grounding-api-redirect/...)
    // expire within ~24-48h so storing them is useless for archival. We HEAD
    // each one in parallel with a tight timeout; if anything fails the raw
    // URI is kept as-is rather than blocking the whole response.
    const sources = await Promise.all(rawSources.map(async (s) => {
      if (!s.uri || !s.uri.includes('vertexaisearch.cloud.google.com')) return s;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 3500);
        const r = await fetch(s.uri, { redirect: 'follow', method: 'GET', signal: ctrl.signal });
        clearTimeout(timer);
        if (r.url && !r.url.includes('vertexaisearch.cloud.google.com')) {
          let finalDomain = s.domain;
          try { finalDomain = new URL(r.url).hostname.replace(/^www\./, ''); } catch(e) {}
          return { ...s, uri: r.url, domain: finalDomain };
        }
      } catch(e) { /* keep raw redirect — it'll show as expired in UI */ }
      return s;
    }));
    // Build groundingSupports citation map for inline references
    const supports = d.candidates?.[0]?.groundingMetadata?.groundingSupports || [];
    // Annotate text with citation markers [n] at end of supported segments
    let annotatedText = text;
    if (supports.length) {
      // Work backwards through supports to preserve indices
      const sorted = [...supports].sort((a,b) => (b.segment?.endIndex||0)-(a.segment?.endIndex||0));
      for (const s of sorted) {
        const end = s.segment?.endIndex;
        const indices = s.groundingChunkIndices || [];
        if (end && indices.length) {
          const markers = indices.map(i => `[${i+1}]`).join('');
          annotatedText = annotatedText.slice(0,end) + markers + annotatedText.slice(end);
        }
      }
    }
    return { text: annotatedText, sourceUrls: sources };
  };

  const callAIOverview = async (prompt) => {
    const token = process.env.DATAFORSEO_TOKEN;
    if (!token) throw new Error('DATAFORSEO_TOKEN not configured');
    const r = await fetch('https://api.dataforseo.com/v3/serp/google/organic/live/advanced', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ keyword: prompt, location_name: 'Australia', language_name: 'English', device: 'desktop', os: 'windows' }])
    });
    const d = await r.json();
    if (d.status_code !== 20000) throw new Error(d.status_message || 'DataForSEO error');
    const task = d.tasks?.[0];
    if (task?.status_code !== 20000) throw new Error(task?.status_message || 'DataForSEO task error');
    const items = task?.result?.[0]?.items || [];
    const aiOverview = items.find(item => item.type === 'ai_overview');
    if (!aiOverview) return { text: '[No AI Overview shown for this query in Google Australia]', sourceUrls: [] };
    const text = aiOverview.text || aiOverview.description || '';
    const references = aiOverview.references || aiOverview.items || [];
    const sourceUrls = references.map((ref, i) => ({
      index: i + 1,
      title: ref.title || ref.source || `Source ${i + 1}`,
      uri: ref.url || ref.source || '',
      domain: (() => { try { return new URL(ref.url || ref.source || '').hostname.replace('www.', ''); } catch(e) { return ref.domain || ''; } })()
    }));
    return { text, sourceUrls };
  };

  const CALLERS = { 'ChatGPT':callOpenAI, 'Gemini':callGemini, 'AIOverview':callAIOverview, 'Perplexity':callPerplexity };
  const total = prompts.length * models.length;
  let done = 0;

  // Prompt-level concurrency. Lower bound 1 (sequential), upper bound 10
  // (10 prompts × N models = 10N parallel API calls — be mindful of
  // upstream rate limits). Default 5 keeps OpenAI tier-2 happy.
  const PROMPT_CONCURRENCY = Math.max(1, Math.min(10,
    parseInt(req.body?.promptConcurrency) || parseInt(process.env.AEO_PROMPT_CONCURRENCY) || 5
  ));

  // Process a single prompt: fire all selected models in parallel, await all.
  const processPrompt = async (p) => {
    const store = aeoResultsFor(req);
    if (!store[p.id]) store[p.id] = { prompt:p.text, topic:p.topic, tag:p.tag, runs:[] };
    try { await db.upsertAeoPrompt(p.id, { prompt:p.text, topic:p.topic, tag:p.tag }); } catch(e) { console.error('upsertAeoPrompt:', e.message); }

    // Each model's IIFE streams its own result/error SSE event as soon as it
    // resolves; allSettled gates moving on until the whole prompt is done.
    // JS is single-threaded so the `done++` increments are race-free.
    const modelTasks = models.map(model => (async () => {
      send({ type:'progress', done, total, model, prompt:p.text });
      const caller = CALLERS[model];
      if (!caller) { send({ type:'skip', model, prompt:p.text, reason:'Not available' }); done++; return; }
      try {
        let responseText, sourceUrls = [];
        const result = await caller(p.text);
        if (result && typeof result === 'object' && result.text !== undefined) {
          responseText = result.text;
          sourceUrls = result.sourceUrls || [];
        } else {
          responseText = result || '';
        }
        const checks = checkMentions(responseText, { tenant: req.tenant, brandName: req.config.brand.name, brandDomain: req.config.brand.domain });
        // Attributed Citation: true ONLY when sourceUrls contain a tenant brand-domain link
        const brandNeedle = req.config.brand.name.toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9]/g,'');
        const brandDomainLower = req.config.brand.domain.toLowerCase();
        const brandInSources = sourceUrls.some(s => {
          const d = (typeof s === 'string' ? s : (s.domain||'')).toLowerCase();
          const t = (typeof s === 'object' ? (s.title||'') : '').toLowerCase();
          return d.includes(brandDomainLower) || d.includes(brandNeedle) || t.includes(brandNeedle);
        });
        checks.attributedCitation = brandInSources;
        const run = { date:new Date().toISOString().slice(0,10), model, ...checks, sourceUrls, promptType:p.tag, prompt:p.text, response:responseText.slice(0,15000) };
        try { await db.insertAeoRun(p.id, run); } catch(e) { console.error('insertAeoRun:', e.message); }
        store[p.id].runs.unshift(run);
        saveAeoResults(req);
        send({ type:'result', promptId:p.id, run, done:++done, total });
      } catch(e) { send({ type:'error', model, prompt:p.text, error:e.message }); done++; }
    })());
    await Promise.allSettled(modelTasks);
  };

  // Worker pool: N workers pull prompts off a shared queue. When the queue
  // is empty, each worker exits. Outer await ensures all workers have
  // drained before we send 'complete'.
  const queue = prompts.slice();
  const workers = Array.from(
    { length: Math.min(PROMPT_CONCURRENCY, queue.length) },
    async () => { while (queue.length) { const p = queue.shift(); if (p) await processPrompt(p); } }
  );
  await Promise.all(workers);

  send({ type:'complete', total:done });
  res.end();
});

// ── AEO Prompt Suggestions ──────────────────────────────────
app.post('/api/aeo/suggest', async (req, res) => {
  const { topic, type, country } = req.body || {};
  if (!topic) return res.status(400).json({ error: 'topic required' });
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || CONFIG.anthropic?.apiKey;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  const brand = req.config.brand;
  const systemPrompt = `You are an AEO (Answer Engine Optimisation) expert helping a company called ${brand.name} (${brand.domain}) generate search prompts that people type into AI assistants like ChatGPT, Gemini, and Perplexity.

Generate 10 realistic, specific prompts that a potential buyer in ${country || 'Australia'} might type into an AI assistant when searching for solutions related to: "${topic}".

Prompt type: ${type || 'Non-Branded'} (${type === 'Branded' ? `may include ${brand.name} by name` : `should NOT mention ${brand.name} by name — these are discovery queries`}).

Rules:
- Each prompt should be a natural question or search phrase (not a command)
- Make them specific to the topic and country context
- Vary the intent (comparison, how-to, pricing, best-of, problem-solving)
- Keep each prompt under 15 words
- Return ONLY a JSON array of strings, no other text

Example output format: ["prompt 1","prompt 2","prompt 3"]`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 1024,
        messages: [{ role: 'user', content: systemPrompt }]
      })
    });
    const data = await r.json();
    const text = data.content?.[0]?.text || '[]';
    // Extract JSON array from response
    const match = text.match(/\[[\s\S]*\]/);
    const suggestions = match ? JSON.parse(match[0]) : [];
    res.json({ suggestions });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// ── AEO Deep-Dive Reasoning ──────────────────────────────────
app.post('/api/aeo/deep-dive', async (req, res) => {
  const { prompts = [] } = req.body || {};
  if (!prompts.length) return res.status(400).json({ error: 'No prompts provided' });
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || CONFIG.anthropic?.apiKey;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const send = (d) => { res.write(`data: ${JSON.stringify(d)}\n\n`); };

  let done = 0;
  const total = prompts.length;

  for (const p of prompts) {
    send({ type: 'progress', done, total, prompt: p.text });
    // Heartbeat while waiting on Claude so Vercel's edge doesn't drop the SSE
    // connection during the silent gap.
    const heartbeat = setInterval(() => { try { res.write(': keepalive\n\n'); } catch(_) {} }, 5000);
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-opus-4-6',
          max_tokens: 2000,
          system: 'You are an AI search visibility expert. Analyse why certain brands appear in AI search responses while others do not. Be specific and actionable. Respond in plain text with clear sections.',
          messages: [{ role: 'user', content: `Search prompt: "${p.text}"\n\nKynection (kynection.com.au) was NOT mentioned in AI responses to this prompt, but these competitors WERE cited: ${(p.competitors || []).slice(0,5).join(', ') || 'industry competitors'}.\n\nProvide:\n1. WHY KYNECTION WAS EXCLUDED (2-3 sentences on likely content/authority gaps)\n2. TOP 3 RECOMMENDATIONS (specific content or SEO actions Kynection should take to appear in responses to this query)\n\nBe direct and specific — reference the query topic, not generic advice.` }]
        })
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error.message);
      const textBlock = d.content?.find(b => b.type === 'text');
      send({ type: 'result', promptId: p.id, prompt: p.text, analysis: textBlock?.text || '', done: ++done, total });
    } catch(e) {
      send({ type: 'error', prompt: p.text, error: e.message });
      done++;
    } finally {
      clearInterval(heartbeat);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  send({ type: 'complete', total: done });
  res.end();
});

// ── Content Items ──────────────────────────────────────────────
app.get('/api/content-items', async (req, res) => {
  try { res.json(await db.listContentItems()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/content-items', async (req, res) => {
  const { urls, snipeType } = req.body;
  if (!Array.isArray(urls) || !urls.length) return res.status(400).json({ error: 'urls required' });
  const newItems = urls.map(url => ({
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    url,
    title: '',
    snipeType: snipeType || 'import',
    createdAt: new Date().toISOString()
  }));
  try {
    await db.insertContentItems(newItems);
    const items = await db.listContentItems();
    res.json(items); // respond immediately — no waiting for page title
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }

  // Fetch page titles in background after responding
  for (const item of newItems) {
    try {
      const mod = item.url.startsWith('https') ? require('https') : require('http');
      const title = await new Promise((resolve) => {
        const r2 = mod.get(item.url, { headers:{'User-Agent':'Mozilla/5.0'}, timeout:5000 }, (r) => {
          let data=''; r.on('data', c => { data+=c; if(data.length>40000) r2.destroy(); });
          r.on('end', () => { const m=data.match(/<title[^>]*>([^<]{1,200})<\/title>/i); resolve(m?m[1].trim().replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/&lt;/g,'<').replace(/&gt;/g,'>'):'' ); });
        }); r2.on('error',()=>resolve('')); r2.on('timeout',()=>{r2.destroy();resolve('');});
      });
      if (title) {
        try { await db.updateContentItem(item.id, { title }); } catch(e) {}
      }
    } catch(e) {}
  }
});

// ── Snipe: Scrape competitor page content ──────────────────────
async function scrapePageContent(url) {
  const empty = { title: '', h1: '', metaDesc: '', text: '' };
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    // Hard 8-second guarantee — regardless of socket/error events
    const hardTimer = setTimeout(() => finish(empty), 8000);
    try {
      // Strip URL fragments — servers don't use them
      let cleanUrl = url;
      try { const u = new URL(url); u.hash = ''; cleanUrl = u.toString(); } catch(e) {}
      const mod = cleanUrl.startsWith('https') ? require('https') : require('http');
      const req = mod.get(cleanUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, timeout: 6000 }, (r) => {
        let data = '';
        r.on('data', c => { data += c; if (data.length > 200000) req.destroy(); });
        r.on('end', () => {
          clearTimeout(hardTimer);
          const titleMatch = data.match(/<title[^>]*>([^<]{1,300})<\/title>/i);
          const title = titleMatch ? titleMatch[1].trim().replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/&lt;/g,'<').replace(/&gt;/g,'>') : '';
          const h1Match = data.match(/<h1[^>]*>([^<]{1,300})<\/h1>/i);
          const h1 = h1Match ? h1Match[1].replace(/<[^>]+>/g,'').trim() : '';
          const metaMatch = data.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,500})["']/i)
                         || data.match(/<meta[^>]+content=["']([^"']{1,500})["'][^>]+name=["']description["']/i);
          const metaDesc = metaMatch ? metaMatch[1].trim() : '';
          const text = data.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s{2,}/g,' ').trim().slice(0, 8000);
          finish({ title, h1, metaDesc, text });
        });
      });
      req.on('error', () => { clearTimeout(hardTimer); finish(empty); });
      req.on('timeout', () => { req.destroy(); });
    } catch(e) {
      clearTimeout(hardTimer);
      finish(empty);
    }
  });
}

async function fetchSitemapUrls(sitemapUrl) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    const hardTimer = setTimeout(() => finish([]), 10000);
    try {
      const mod = sitemapUrl.startsWith('https') ? require('https') : require('http');
      const req = mod.get(sitemapUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => {
        let data = '';
        r.on('data', c => { data += c; });
        r.on('end', () => {
          clearTimeout(hardTimer);
          const urls = [];
          const matches = data.matchAll(/<loc>([^<]+)<\/loc>/g);
          for (const m of matches) urls.push(m[1].trim());
          finish(urls);
        });
      });
      req.on('error', () => { clearTimeout(hardTimer); finish([]); });
    } catch(e) { clearTimeout(hardTimer); finish([]); }
  });
}

function scoreUrlRelevance(urls, topic) {
  const topicWords = topic.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3);
  return urls.map(url => {
    const slug = url.toLowerCase().replace(/^https?:\/\/[^/]+/, '').replace(/[-_/]/g, ' ');
    const score = topicWords.reduce((s, w) => s + (slug.includes(w) ? 1 : 0), 0);
    return { url, score, slug: slug.trim() };
  }).sort((a, b) => b.score - a.score);
}

async function searchExternalSourcesForSnipe(topic, excludeDomain) {
  const token = process.env.DATAFORSEO_TOKEN;
  if (!token) return [];
  // Run two targeted searches to get diverse, high-quality sources
  const queries = [
    `${topic} Australia statistics industry report`,
    `${topic} software comparison guide`
  ];
  const allResults = [];
  for (const query of queries) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch('https://api.dataforseo.com/v3/serp/google/organic/live/advanced', {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Authorization': `Basic ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify([{ keyword: query, location_name: 'Australia', language_name: 'English', device: 'desktop', os: 'windows', depth: 10 }])
      }).finally(() => clearTimeout(timer));
      const d = await r.json();
      const items = d.tasks?.[0]?.result?.[0]?.items || [];
      const organic = items
        .filter(i => i.type === 'organic' && i.url && i.title)
        .filter(i => !excludeDomain || !i.url.toLowerCase().includes(excludeDomain.toLowerCase()))
        // Prefer authoritative domains
        .map(i => ({
          url: i.url,
          title: i.title,
          snippet: i.description || '',
          domain: (() => { try { return new URL(i.url).hostname.replace('www.',''); } catch(e) { return ''; } })()
        }))
        .slice(0, 6);
      allResults.push(...organic);
    } catch(e) {}
  }
  // Deduplicate by domain, return top 10
  const seen = new Set();
  return allResults.filter(r => {
    if (seen.has(r.domain)) return false;
    seen.add(r.domain);
    return true;
  }).slice(0, 10);
}

// ── Token cost calculator ───────────────────────────────────────
const MODEL_PRICING = {
  'gpt-4o':             { input: 2.50,  output: 10.00 },
  'gpt-4o-mini':        { input: 0.15,  output: 0.60  },
  'claude-sonnet-4-5':  { input: 3.00,  output: 15.00 },
  'claude-haiku-4-5':   { input: 0.25,  output: 1.25  },
};
const AUD_RATE = 1.55; // approx USD→AUD
function calcCostAUD(model, inputTokens, outputTokens) {
  const p = MODEL_PRICING[model] || MODEL_PRICING['gpt-4o'];
  const usd = (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
  return usd * AUD_RATE;
}

// Robustly extract a JSON object from an LLM response.
// Handles common failure modes:
//   1. AI wraps the JSON in ```json ... ``` markdown code fence
//   2. AI prepends/appends explanatory prose around the JSON
//   3. Response is truncated (max_tokens hit) — best-effort recovery
// Returns { data, error }. On success: data is the parsed object, error is null.
// On failure: data is null and error is a human-readable message.
function parseAIJsonResponse(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return { data: null, error: 'empty response from AI' };
  }
  let text = rawText.trim();

  // Strip markdown code fence wrapper: ```json ... ``` or ``` ... ```
  // The fence may appear at start, end, or both.
  text = text.replace(/^```(?:json|JSON)?\s*\n?/, '').replace(/\n?```\s*$/, '');

  // Strategy 1: try to parse the cleaned text directly.
  try { return { data: JSON.parse(text), error: null }; }
  catch (e1) {
    // Strategy 2: greedy regex — first { to last }
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try { return { data: JSON.parse(m[0]), error: null }; }
      catch (e2) {
        return { data: null, error: 'JSON.parse failed after stripping fences and extracting braces: ' + e2.message };
      }
    }
    return { data: null, error: 'no JSON object found in response: ' + e1.message };
  }
}

// ── Snipe AI helper — Claude if key set, else OpenAI, with timeout ─
// Returns { text, model, inputTokens, outputTokens }
async function callSnipeAI({ system, user, maxTokens = 600, fast = false, timeoutMs: timeoutOverride }) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || CONFIG.anthropic?.apiKey;
  const OPENAI_KEY    = process.env.OPENAI_API_KEY    || CONFIG.openai?.apiKey;
  const timeoutMs     = timeoutOverride || (fast ? 20000 : 240000); // 4 min for full brief/draft/meta. Override to leave headroom under Vercel's 300s function cap when other steps (link prefilter, Phase 2 verify, post-audit) eat into the budget.

  const withTimeout = (fetchPromise) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    return fetchPromise(ctrl.signal).finally(() => clearTimeout(timer));
  };

  if (ANTHROPIC_KEY && !ANTHROPIC_KEY.includes('your_anthropic')) {
    const model = fast ? 'claude-haiku-4-5' : 'claude-sonnet-4-5';
    const d = await withTimeout(signal => fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal,
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] })
    }).then(r => r.json()));
    if (d.error) throw new Error(d.error.message);
    return { text: d.content?.[0]?.text || '', model, inputTokens: d.usage?.input_tokens || 0, outputTokens: d.usage?.output_tokens || 0 };
  } else if (OPENAI_KEY) {
    const model = fast ? 'gpt-4o-mini' : 'gpt-4o';
    const d = await withTimeout(signal => fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', signal,
      headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] })
    }).then(r => r.json()));
    if (d.error) throw new Error(d.error.message || JSON.stringify(d.error));
    return { text: d.choices?.[0]?.message?.content || '', model, inputTokens: d.usage?.prompt_tokens || 0, outputTokens: d.usage?.completion_tokens || 0 };
  } else {
    throw new Error('No AI API key configured. Add ANTHROPIC_API_KEY or OPENAI_API_KEY to .env');
  }
}

// GET /api/snipe/scrape — quick page title scrape only (no AI)
app.get('/api/snipe/scrape', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });
  const page = await scrapePageContent(url);
  res.json({ title: page.h1 || page.title || '', metaDesc: page.metaDesc });
});

// POST /api/snipe/titles — scrape H1 + generate 3 title options (fast)
// Accepts optional originalTitle to skip re-scraping
app.post('/api/snipe/titles', async (req, res) => {
  const { url, originalTitle: providedTitle } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });

  // Only scrape if title not already provided
  let originalTitle = providedTitle || '';
  let pageMetaDesc = '';
  if (!originalTitle) {
    const page = await scrapePageContent(url);
    originalTitle = page.h1 || page.title || new URL(url).hostname;
    pageMetaDesc = page.metaDesc;
  }

  try {
    const brand = req.config.brand;
    const result = await callSnipeAI({
      fast: true,
      maxTokens: 400,
      system: `You are an SEO content strategist for ${brand.name} (${brand.domain}). Generate 3 alternative article titles. Return ONLY a JSON array of 3 strings. No other text.`,
      user: `Competitor article title: "${originalTitle}"\nCompetitor URL: ${url}\n\nGenerate 3 ${brand.name} article titles on this same topic. Each should:\n- Include the primary keyword naturally\n- Be compelling and unique from each other\n- Include ${new Date().getFullYear()} where natural\n\nReturn JSON array only: ["Title 1", "Title 2", "Title 3"]`
    });
    const match = result.text.match(/\[[\s\S]*?\]/);
    const titles = match ? JSON.parse(match[0]) : [originalTitle];
    res.json({ titles, originalTitle });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/snipe/generate — generate Brief+Draft+Meta for a sniped URL (SSE streaming)
app.post('/api/snipe/generate', async (req, res) => {
  const { url, itemId, title: chosenTitle } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });

  const brand = req.config.brand;
  const skillFile = path.join(__dirname, req.config.snipeSkillFile);
  const sitemapUrls = req.config.sitemap.urls;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Tell upstream proxies (Vercel, Nginx) NOT to buffer so SSE events reach
  // the browser as they're written rather than after the function returns.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const send = (d) => { res.write(`data: ${JSON.stringify(d)}\n\n`); };

  // Load skill prompt
  let skillPrompt = '';
  try { skillPrompt = fs.readFileSync(skillFile, 'utf8'); } catch(e) { skillPrompt = `You are a content strategist for ${brand.name}. Generate Brief, Draft, and Meta as JSON.`; }

  // Scrape competitor page (8-second hard timeout)
  send({ type: 'progress', stage: 'scraping', message: 'Analysing competitor page...' });
  const page = await scrapePageContent(url);

  send({ type: 'progress', stage: 'generating', message: 'Researching links & sources...' });

  // Title hierarchy: user-chosen > scraped H1 > page title > URL slug
  let slug = '';
  try { slug = new URL(url).pathname.split('/').filter(Boolean).pop()?.replace(/[-_]/g,' ')?.replace(/\.[^.]+$/,'') || ''; } catch(e) {}
  const competitorTitle = page.h1 || page.title || slug || url;
  const brandedTitle = chosenTitle || competitorTitle;

  // Fetch tenant sitemaps and find relevant internal links
  const sitemapResults = await Promise.all(sitemapUrls.map(u => fetchSitemapUrls(u)));
  const allInternalUrls = sitemapResults.flat();
  const scoredInternal = scoreUrlRelevance(allInternalUrls, competitorTitle);
  // Take top 20 scored — no tenant-specific "key pages" allow-list anymore;
  // relevance scoring + the sitemap itself are enough.
  const topInternalCandidates = scoredInternal.slice(0, 20).map(u => u.url);

  // Search for external authoritative sources
  const externalSources = await searchExternalSourcesForSnipe(competitorTitle, brand.domain);

  send({ type: 'progress', stage: 'generating', message: 'Writing Brief, Draft & Meta...' });

  try {
    const internalLinksBlock = topInternalCandidates.length
      ? topInternalCandidates.map(u => `- ${u}`).join('\n')
      : `- https://${brand.domain}/`;
    const externalLinksBlock = externalSources.length
      ? externalSources.map(s => `- [${s.title}](${s.url})${s.snippet ? '\n  Snippet: ' + s.snippet.slice(0, 120) : ''}`).join('\n')
      : '(Use your knowledge to cite 5-8 authoritative sources: industry reports, government stats, research firms — with real URLs as Markdown hyperlinks)';

    const userPrompt = `You are sniping this competitor article for ${brand.name}:

**Competitor URL:** ${url}
**Competitor Title / Topic:** ${competitorTitle}
**${brand.name} Article Title (use this as the H1):** ${brandedTitle}
**Competitor Meta Description:** ${page.metaDesc || 'Not available'}

**Competitor Article Content (first 6000 chars):**
${page.text ? page.text.slice(0, 6000) : 'Could not scrape — use the URL slug and topic to infer the content.'}

---

## ${brand.name} Internal Links (choose 5–8 most relevant for this article):
${internalLinksBlock}

## Authoritative External Sources to Cite (use 5–8 of these):
${externalLinksBlock}

---

CRITICAL REQUIREMENTS:
1. **Real names only:** Identify the actual software products/tools reviewed in the competitor article from the scraped content above. Use their real names — never write "Competitor 1" or placeholder text. Every H3 heading must use the real product name.
2. **Word count:** The Draft section MUST contain at least 1,800 words. Write every section fully — do not truncate, abbreviate, or summarise early. Cover every competitor tool with a full H3 section.
3. **Structure:** Mirror the competitor article exactly — same number of tool sections, same format per tool (Key Features + Best For + Tradeoffs & Risks). ${brand.name} listed first.
4. **Links:** Embed 5–8 internal links AND 5–8 external citations as Markdown hyperlinks [anchor text](url) inline in the draft prose.

Return ONLY valid JSON with keys "brief", "draft", "meta". No text before or after the JSON.`;

    // Send SSE comments every 5s while Claude generates so Vercel's edge
    // proxy doesn't drop the connection during the silent gap. The browser
    // ignores `:` comment lines per SSE spec, so this is a no-op for the UI.
    const heartbeat = setInterval(() => { try { res.write(': keepalive\n\n'); } catch(_) {} }, 5000);
    let aiResult;
    try {
      aiResult = await callSnipeAI({ system: skillPrompt, user: userPrompt, maxTokens: 16000 });
    } finally {
      clearInterval(heartbeat);
    }
    // Extract JSON from response (robust — handles code-fence wrapping)
    const parsed = parseAIJsonResponse(aiResult.text);
    let result = parsed.data || { brief: '', draft: '', meta: '' };
    if (parsed.error) {
      console.error('Snipe JSON parse failed:', parsed.error);
      console.error('First 400 chars:', aiResult.text.slice(0, 400));
      console.error('Last 200 chars:', aiResult.text.slice(-200));
      // Surface a useful error in the Brief tab so the user can see what
      // went wrong instead of a silent blank state.
      result.brief = `⚠ AI response could not be parsed as JSON.\n\n**Error:** ${parsed.error}\n\n**Raw response (first 2000 chars):**\n\n${aiResult.text.slice(0, 2000)}`;
    }

    // Calculate cost
    const costAUD = calcCostAUD(aiResult.model, aiResult.inputTokens, aiResult.outputTokens);
    const costStr = `$${costAUD.toFixed(4)} AUD`;
    const costMeta = { model: aiResult.model, inputTokens: aiResult.inputTokens, outputTokens: aiResult.outputTokens, costAUD: parseFloat(costAUD.toFixed(4)) };

    // Save to content item if itemId provided
    if (itemId) {
      try {
        const existing = await db.getContentItem(itemId);
        if (existing) {
          await db.updateContentItem(itemId, {
            snipe: { brief: result.brief, draft: result.draft, meta: result.meta, generatedAt: new Date().toISOString(), sniped: url },
            title: existing.title || brandedTitle,
            cost:  costMeta
          });
        }
      } catch(e) { console.error('snipe save:', e.message); }
    }

    // Emit staged events for progress bar with small delays for visual effect
    send({ type: 'stage', stage: 'brief' });
    await new Promise(r => setTimeout(r, 400));
    send({ type: 'stage', stage: 'draft' });
    await new Promise(r => setTimeout(r, 400));
    send({ type: 'stage', stage: 'meta' });
    await new Promise(r => setTimeout(r, 200));
    send({ type: 'complete', brief: result.brief, draft: result.draft, meta: result.meta, costAUD: parseFloat(costAUD.toFixed(4)), costStr, model: aiResult.model });
    res.end();
  } catch(e) {
    send({ type: 'error', error: e.message });
    res.end();
  }
});

// ============================================================
// Revamp — Phase 1-3 review + Mode 1/Mode 2 draft for an existing article
// (IR-only by tenant config, but the route is registered globally and
//  gated by req.config.revampSkillFile + contentFeatures.includes('revamp'))
// ============================================================

// Richer scrape than scrapePageContent — preserves up to 30K chars of body
// text AND extracts every external <a href> with anchor text + a short
// context window. Used by Revamp for Phase 2 citation verification.
async function scrapePageWithLinks(url) {
  const empty = { title: '', h1: '', metaDesc: '', text: '', html: '', externalLinks: [] };
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    const hardTimer = setTimeout(() => finish(empty), 12000);
    try {
      let cleanUrl = url, articleHost = '';
      try { const u = new URL(url); u.hash = ''; cleanUrl = u.toString(); articleHost = u.hostname.replace(/^www\./, ''); } catch(e) {}
      const mod = cleanUrl.startsWith('https') ? require('https') : require('http');
      const req = mod.get(cleanUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, timeout: 10000 }, (r) => {
        let data = '';
        r.on('data', c => { data += c; if (data.length > 600000) req.destroy(); });
        r.on('end', () => {
          clearTimeout(hardTimer);
          const titleMatch = data.match(/<title[^>]*>([^<]{1,300})<\/title>/i);
          const title = titleMatch ? titleMatch[1].trim().replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/&quot;/g,'"') : '';
          const h1Match = data.match(/<h1[^>]*>([\s\S]{1,500}?)<\/h1>/i);
          const h1 = h1Match ? h1Match[1].replace(/<[^>]+>/g,'').trim() : '';
          const metaMatch = data.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,500})["']/i)
                         || data.match(/<meta[^>]+content=["']([^"']{1,500})["'][^>]+name=["']description["']/i);
          const metaDesc = metaMatch ? metaMatch[1].trim() : '';
          // Strip scripts/styles but keep anchor structure for link extraction
          const clean = data.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<nav[\s\S]*?<\/nav>/gi,'').replace(/<footer[\s\S]*?<\/footer>/gi,'').replace(/<header[\s\S]*?<\/header>/gi,'');
          // Extract every <a href> with anchor text
          const links = [];
          const seen = new Set();
          const aRe = /<a\s+[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]{1,300}?)<\/a>/gi;
          let m;
          while ((m = aRe.exec(clean)) !== null) {
            let href = m[1].trim();
            // Resolve relative URLs
            try { href = new URL(href, cleanUrl).toString(); } catch(e) { continue; }
            const anchor = m[2].replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim();
            if (!anchor || anchor.length < 2) continue;
            let host = '';
            try { host = new URL(href).hostname.replace(/^www\./, ''); } catch(e) { continue; }
            if (host === articleHost) continue; // internal link, skip
            // Skip common navigation/social/asset links
            if (/(twitter\.com\/intent|facebook\.com\/sharer|linkedin\.com\/share|mailto:|tel:|\.(jpg|png|svg|gif|webp|css|js)$)/i.test(href)) continue;
            const key = host + '|' + href.split('?')[0].split('#')[0];
            if (seen.has(key)) continue;
            seen.add(key);
            // Capture ~120 chars of context around the link
            const idx = m.index;
            const before = clean.slice(Math.max(0, idx - 120), idx).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(-120);
            const after  = clean.slice(idx + m[0].length, idx + m[0].length + 120).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0, 120);
            links.push({ url: href, anchor, context: `${before} [LINK: ${anchor}] ${after}`.trim().slice(0, 280) });
          }
          const text = clean.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 30000);
          finish({ title, h1, metaDesc, text, html: '', externalLinks: links });
        });
      });
      req.on('error', () => { clearTimeout(hardTimer); finish(empty); });
      req.on('timeout', () => { req.destroy(); });
    } catch(e) { clearTimeout(hardTimer); finish(empty); }
  });
}

// Fetch a single external URL and return verification metadata:
//   { url, status: 'live' | 'http_error' | 'timeout' | 'error', httpStatus, title, snippet }
// 8-second hard timeout; truncates body to 8KB so verification stays fast.
async function verifyExternalLink(linkUrl) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    const timer = setTimeout(() => finish({ url: linkUrl, status: 'timeout' }), 8000);
    try {
      const mod = linkUrl.startsWith('https') ? require('https') : require('http');
      const req = mod.get(linkUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, timeout: 6000 }, (r) => {
        // Follow one redirect
        if ([301, 302, 307, 308].includes(r.statusCode) && r.headers.location) {
          clearTimeout(timer);
          let next = r.headers.location;
          try { next = new URL(next, linkUrl).toString(); } catch(e) {}
          r.destroy();
          return verifyExternalLink(next).then(v => resolve({ ...v, originalUrl: linkUrl }));
        }
        if (r.statusCode >= 400) {
          clearTimeout(timer);
          r.destroy();
          return finish({ url: linkUrl, status: 'http_error', httpStatus: r.statusCode });
        }
        let data = '';
        r.on('data', c => { data += c; if (data.length > 8192) req.destroy(); });
        r.on('end', () => {
          clearTimeout(timer);
          const titleMatch = data.match(/<title[^>]*>([^<]{1,300})<\/title>/i);
          const title = titleMatch ? titleMatch[1].trim() : '';
          const snippet = data.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s{2,}/g,' ').trim().slice(0, 600);
          finish({ url: linkUrl, status: 'live', httpStatus: r.statusCode, title, snippet });
        });
      });
      req.on('error', () => { clearTimeout(timer); finish({ url: linkUrl, status: 'error' }); });
      req.on('timeout', () => { req.destroy(); });
    } catch(e) { clearTimeout(timer); finish({ url: linkUrl, status: 'error' }); }
  });
}

// Run a list of verifyExternalLink calls with a concurrency cap.
async function verifyAllLinks(links, concurrency = 5) {
  const results = new Array(links.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, links.length) }, async () => {
    while (cursor < links.length) {
      const i = cursor++;
      const v = await verifyExternalLink(links[i].url);
      results[i] = { ...links[i], verification: v };
    }
  });
  await Promise.all(workers);
  return results;
}

// Lightweight HEAD-check for a single URL — used to pre-filter the sitemap
// so we never hand a 404'd internal URL to the AI.
async function quickHeadCheck(urlStr, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const t = setTimeout(() => finish(false), timeoutMs);
    try {
      const mod = urlStr.startsWith('https') ? require('https') : require('http');
      const u = new URL(urlStr);
      const req = mod.request({
        method: 'HEAD',
        host: u.hostname,
        port: u.port || (urlStr.startsWith('https') ? 443 : 80),
        path: u.pathname + (u.search || ''),
        headers: { 'User-Agent': 'Mozilla/5.0 (revamp-linkcheck)' },
        timeout: timeoutMs - 500
      }, (r) => {
        clearTimeout(t);
        // Follow one redirect manually
        if ([301, 302, 307, 308].includes(r.statusCode) && r.headers.location) {
          let next = r.headers.location;
          try { next = new URL(next, urlStr).toString(); } catch(e) {}
          r.destroy();
          return quickHeadCheck(next, Math.max(1000, timeoutMs - 1000)).then(finish);
        }
        finish(r.statusCode >= 200 && r.statusCode < 400);
        r.destroy();
      });
      req.on('error', () => { clearTimeout(t); finish(false); });
      req.on('timeout', () => { req.destroy(); });
      req.end();
    } catch (e) { clearTimeout(t); finish(false); }
  });
}

// Prefilter a sitemap URL list with HEAD checks. Returns only URLs that
// return 2xx/3xx. Caps the input to keep wall-clock under control.
async function prefilterSitemap(urls, { cap = 60, concurrency = 12, timeoutMs = 4000 } = {}) {
  const slice = urls.slice(0, cap);
  const live = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, slice.length) }, async () => {
    while (cursor < slice.length) {
      const i = cursor++;
      const ok = await quickHeadCheck(slice[i], timeoutMs);
      if (ok) live.push(slice[i]);
    }
  });
  await Promise.all(workers);
  return live;
}

// Extract every Markdown hyperlink from the generated draft.
// Returns: [{ anchor, url, internal }]
function extractMarkdownLinks(md, internalDomain) {
  if (!md) return [];
  const out = [];
  const re = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let m;
  while ((m = re.exec(md)) !== null) {
    let host = '';
    try { host = new URL(m[2]).hostname.replace(/^www\./, ''); } catch(e) { continue; }
    out.push({ anchor: m[1], url: m[2], internal: host === internalDomain });
  }
  return out;
}

// Normalise a URL for sitemap comparison (strip trailing slash + scheme + www).
function normaliseForSitemap(u) {
  try {
    const x = new URL(u);
    return (x.hostname.replace(/^www\./,'') + x.pathname).replace(/\/$/, '').toLowerCase();
  } catch(e) { return u.toLowerCase(); }
}

// POST /api/revamp/generate
// Body: { url, articleType: 'bof'|'mof'|'general', competitor, mode: 1|2, itemId? }
// SSE stream: 'progress' events + 'complete' with { feedback, draft, meta }
app.post('/api/revamp/generate', async (req, res) => {
  const { url, articleType = 'general', competitor = '', mode = 1, itemId } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  if (!req.config.revampSkillFile) return res.status(400).json({ error: 'Revamp is not enabled for this tenant' });
  if (!(req.config.contentFeatures || []).includes('revamp')) return res.status(400).json({ error: 'Revamp is not enabled for this tenant' });

  const brand = req.config.brand;
  const skillFile = path.join(__dirname, req.config.revampSkillFile);
  const sitemapUrls = req.config.sitemap.urls;
  const modeNum = parseInt(mode) === 2 ? 2 : 1;
  const typeLabel = articleType === 'bof' ? 'BOF (Best alternatives to ' + (competitor || 'competitor') + ')'
                  : articleType === 'mof' ? 'MOF (' + brand.name + ' vs ' + (competitor || 'competitor') + ')'
                  : 'General comparison / roundup';

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const send = (d) => { res.write(`data: ${JSON.stringify(d)}\n\n`); };

  let skillPrompt = '';
  try { skillPrompt = fs.readFileSync(skillFile, 'utf8'); }
  catch(e) { send({ type: 'error', error: 'Could not load revamp skill file: ' + e.message }); return res.end(); }

  send({ type: 'progress', stage: 'scraping', message: 'Fetching the article...' });
  const page = await scrapePageWithLinks(url);
  if (!page.text || page.text.length < 300) {
    send({ type: 'error', error: 'Could not scrape article body — page may be JS-rendered or blocked.' });
    return res.end();
  }

  send({ type: 'progress', stage: 'sitemap', message: 'Fetching sitemap...' });
  const sitemapResults = await Promise.all(sitemapUrls.map(u => fetchSitemapUrls(u)));
  const rawSitemapUrls = sitemapResults.flat();

  // Pre-flight: HEAD-check sitemap URLs so the AI never sees a 404'd
  // internal link. Caps at 50 URLs / concurrency 15 / 3.5s timeout
  // = ~14s wall-clock worst case (fits Vercel's 300s budget).
  send({ type: 'progress', stage: 'sitemap', message: `Validating ${Math.min(50, rawSitemapUrls.length)} sitemap URLs...` });
  const allInternalUrls = await prefilterSitemap(rawSitemapUrls, { cap: 50, concurrency: 15, timeoutMs: 3500 });
  const droppedSitemap = Math.min(50, rawSitemapUrls.length) - allInternalUrls.length;

  // Cap at 10 links so Phase 2 verification fits within Vercel's 300s budget
  // (scrape 12s + sitemap 10s + prefilter 14s + verify 10 links @ 5 ≈ 12s
  //  + external search 10s + AI 220s + post-audit 4s ≈ 282s)
  const linksToVerify = page.externalLinks.slice(0, 10);
  const skipped = page.externalLinks.length - linksToVerify.length;
  send({ type: 'progress', stage: 'verifying', message: `Verifying ${linksToVerify.length} external citations${skipped ? ` (${skipped} more not verified — article had ${page.externalLinks.length} links)` : ''}...`, totalLinks: linksToVerify.length });
  const verifiedLinks = await verifyAllLinks(linksToVerify, 5);

  // Build citation verification table for the AI prompt
  const verificationRows = verifiedLinks.map(v => {
    const status = v.verification?.status || 'unknown';
    const httpCode = v.verification?.httpStatus ? ` (HTTP ${v.verification.httpStatus})` : '';
    const sourceTitle = v.verification?.title || '';
    return `| ${v.anchor} | ${v.url} | ${sourceTitle} | ${status}${httpCode} | ${v.context.slice(0, 200)} |`;
  }).join('\n');

  const liveLinks = verifiedLinks.filter(v => v.verification?.status === 'live').length;
  const deadLinks = verifiedLinks.length - liveLinks;

  send({ type: 'progress', stage: 'searching', message: 'Finding fresh authoritative source candidates...' });
  // Topic for external source search = article title or H1
  const topic = page.h1 || page.title || competitor || 'B2B revenue operations';
  const externalCandidates = await searchExternalSourcesForSnipe(topic, brand.domain).catch(() => []);

  send({ type: 'progress', stage: 'generating', message: 'Reviewing + revising article (this can take 2-4 minutes)...' });

  // Build the user prompt with all gathered data
  const internalLinksBlock = allInternalUrls.length
    ? allInternalUrls.slice(0, 80).map(u => `- ${u}`).join('\n')
    : `- https://${brand.domain}/`;

  const externalCandidatesBlock = externalCandidates.length
    ? externalCandidates.slice(0, 12).map(s => `- [${s.title}](${s.url}) — ${s.snippet ? s.snippet.slice(0, 150) : ''}`).join('\n')
    : '(Use your knowledge to suggest authoritative sources: HubSpot, Salesforce, LinkedIn B2B Institute, Gong, Drift, 6sense, Salesloft, Outreach, Pipedrive, Demand Gen Report, HBR. Max 1 from McKinsey/Forrester/Gartner combined. No G2 links.)';

  const userPrompt = `You are revamping this existing ${brand.name} article.

**Article URL:** ${url}
**Article Type:** ${typeLabel}
**Competitor:** ${competitor || 'N/A (general comparison)'}
**Selected Mode:** ${modeNum === 1 ? 'Mode 1 — Full GEO Restructure' : 'Mode 2 — Best Practices Update (preserve existing structure)'}

**Current H1:** ${page.h1 || page.title || '(none detected)'}
**Current Meta Description:** ${page.metaDesc || '(none detected)'}

**Current Article Body (scraped, ${page.text.length} chars):**
${page.text}

---

## Phase 2 — Citation Verification Table

${verifiedLinks.length} external links were extracted from the article. ${liveLinks} verified live, ${deadLinks} unverified/dead. Each row was HTTP-fetched.

| Anchor Text | URL | Source Page Title | Status | Context in Article |
|---|---|---|---|---|
${verificationRows || '| (no external links found in article) | | | | |'}

**Action rule:** Sources with status \`http_error\`, \`timeout\`, or \`error\` are UNVERIFIED and MUST be dropped from the revised draft. Cite confirmed sources only, or replace with fresh sources from the candidate list below.

---

## ${brand.name} Sitemap (use ONLY these URLs for internal links — never invent slugs)

${internalLinksBlock}

---

## Authoritative External Source Candidates (use to replace dropped Unverified citations)

${externalCandidatesBlock}

---

## Required Output

Return ONLY valid JSON with keys "feedback", "draft", "meta". No text before or after the JSON.

- **feedback**: full Phase 1-3 review following the FEEDBACK section template in your system prompt. Include the citation verification table verbatim.
- **draft**: revised article. Apply ${modeNum === 1 ? 'Mode 1 (full GEO Restructure)' : 'Mode 2 (Best Practices Update — preserve existing structure)'} per your system prompt's mandatory checks.
- **meta**: meta description (≤160 chars, CTR-optimised) + internal links used + external citations used + any Unverified sources dropped.

CRITICAL:
1. Sources with status not equal to \`live\` are DROPPED from the draft.
2. Internal links come ONLY from the sitemap list above.
3. ${brand.name} listed first in any comparison table, with "Revenue Operations Studio" structural label.
4. No em-dashes / hedging / no-fly vocabulary / G2 links / ™ symbols anywhere.
5. Mode ${modeNum} mandatory checks from your system prompt apply.`;

  const heartbeat = setInterval(() => { try { res.write(': keepalive\n\n'); } catch(_) {} }, 5000);
  let aiResult;
  try {
    aiResult = await callSnipeAI({ system: skillPrompt, user: userPrompt, maxTokens: 16000, timeoutMs: 220000 });
  } catch(e) {
    clearInterval(heartbeat);
    send({ type: 'error', error: 'AI call failed: ' + e.message });
    return res.end();
  } finally {
    clearInterval(heartbeat);
  }

  const parsedRevamp = parseAIJsonResponse(aiResult.text);
  let result = parsedRevamp.data || { feedback: '', draft: '', meta: '' };
  if (parsedRevamp.error) {
    console.error('Revamp JSON parse failed:', parsedRevamp.error);
    console.error('First 400 chars:', aiResult.text.slice(0, 400));
    console.error('Last 200 chars:', aiResult.text.slice(-200));
    result.feedback = `⚠ AI response could not be parsed as JSON.\n\n**Error:** ${parsedRevamp.error}\n\n**Raw response (first 2000 chars):**\n\n${aiResult.text.slice(0, 2000)}`;
  }

  // ── Post-generation link audit ────────────────────────────────
  // Extract every Markdown link in the produced draft and validate them.
  // Internal links must appear in the (already-prefiltered) sitemap.
  // External links are checked for liveness with the same quickHeadCheck.
  // Audit table is appended to feedback so the user can see exactly what
  // the AI produced.
  const internalDomain = brand.domain.replace(/^www\./,'').toLowerCase();
  const sitemapSet = new Set(allInternalUrls.map(normaliseForSitemap));
  const draftLinks = extractMarkdownLinks(result.draft || '', internalDomain);
  const internalLinks = draftLinks.filter(l => l.internal);
  const externalLinks = draftLinks.filter(l => !l.internal);

  // Internal: check vs sitemap (cheap, no HTTP)
  const internalAudit = internalLinks.map(l => ({
    ...l,
    ok: sitemapSet.has(normaliseForSitemap(l.url)),
    note: sitemapSet.has(normaliseForSitemap(l.url)) ? 'in sitemap' : 'NOT in verified sitemap'
  }));

  // External: HEAD-check each in parallel (cap 8 for time budget)
  send({ type: 'progress', stage: 'auditing', message: `Auditing ${internalLinks.length} internal + ${externalLinks.length} external links in the draft...` });
  const extToCheck = externalLinks.slice(0, 8);
  const extResults = await Promise.all(extToCheck.map(async (l) => {
    const ok = await quickHeadCheck(l.url, 3500);
    return { ...l, ok, note: ok ? 'live' : 'DEAD / blocked' };
  }));
  const externalAudit = [
    ...extResults,
    ...externalLinks.slice(8).map(l => ({ ...l, ok: null, note: 'not audited (over cap)' }))
  ];

  const minInternal = 3, minExternal = 5;
  const internalLiveCount = internalAudit.filter(l => l.ok).length;
  const externalLiveCount = externalAudit.filter(l => l.ok).length;
  const internalDeadCount = internalAudit.length - internalLiveCount;
  const externalDeadCount = externalAudit.filter(l => l.ok === false).length;

  const auditLines = [];
  auditLines.push('');
  auditLines.push('---');
  auditLines.push('');
  auditLines.push('## Link Audit (auto-generated, post-AI)');
  auditLines.push('');
  auditLines.push(`**Internal:** ${internalLiveCount} verified / ${internalAudit.length} total (minimum ${minInternal}). ${internalDeadCount ? `**${internalDeadCount} not in sitemap — replace these.**` : '✓'}`);
  auditLines.push(`**External:** ${externalLiveCount} verified live / ${externalAudit.length} total (minimum ${minExternal}). ${externalDeadCount ? `**${externalDeadCount} dead — replace these.**` : '✓'}`);
  if (internalLiveCount < minInternal) auditLines.push(`> **Below internal-link minimum (${minInternal}).** Add ${minInternal - internalLiveCount} more from the sitemap.`);
  if (externalLiveCount < minExternal) auditLines.push(`> **Below external-citation minimum (${minExternal}).** Add ${minExternal - externalLiveCount} more authoritative sources.`);
  auditLines.push('');
  if (internalAudit.length) {
    auditLines.push('### Internal Links in Draft');
    auditLines.push('| Anchor | URL | Status |');
    auditLines.push('|---|---|---|');
    internalAudit.forEach(l => auditLines.push(`| ${l.anchor.slice(0,60)} | ${l.url} | ${l.ok ? '✅ ' + l.note : '❌ ' + l.note} |`));
    auditLines.push('');
  }
  if (externalAudit.length) {
    auditLines.push('### External Links in Draft');
    auditLines.push('| Anchor | URL | Status |');
    auditLines.push('|---|---|---|');
    externalAudit.forEach(l => auditLines.push(`| ${l.anchor.slice(0,60)} | ${l.url} | ${l.ok === true ? '✅ ' + l.note : l.ok === false ? '❌ ' + l.note : '⚠ ' + l.note} |`));
    auditLines.push('');
  }
  result.feedback = (result.feedback || '') + auditLines.join('\n');

  const costAUD = calcCostAUD(aiResult.model, aiResult.inputTokens, aiResult.outputTokens);
  const costStr = `$${costAUD.toFixed(4)} AUD`;
  const costMeta = { model: aiResult.model, inputTokens: aiResult.inputTokens, outputTokens: aiResult.outputTokens, costAUD: parseFloat(costAUD.toFixed(4)) };

  // Save: store revamp output in the existing snipe JSONB column so the
  // drawer continues to work. snipeType='revamp' tells the UI to label
  // the first tab "Feedback" instead of "Brief".
  if (itemId) {
    try {
      const existing = await db.getContentItem(itemId);
      if (existing) {
        await db.updateContentItem(itemId, {
          snipeType: 'revamp',
          snipe: {
            brief: result.feedback,
            draft: result.draft,
            meta: result.meta,
            generatedAt: new Date().toISOString(),
            sniped: url,
            mode: modeNum,
            articleType,
            competitor
          },
          title: existing.title || page.h1 || page.title || url,
          cost: costMeta
        });
      }
    } catch(e) { console.error('revamp save:', e.message); }
  }

  send({ type: 'stage', stage: 'feedback' });
  await new Promise(r => setTimeout(r, 300));
  send({ type: 'stage', stage: 'draft' });
  await new Promise(r => setTimeout(r, 300));
  send({ type: 'stage', stage: 'meta' });
  await new Promise(r => setTimeout(r, 200));
  send({ type: 'complete', feedback: result.feedback, draft: result.draft, meta: result.meta, costAUD: parseFloat(costAUD.toFixed(4)), costStr, model: aiResult.model, verifiedLive: liveLinks, verifiedDead: deadLinks });
  res.end();
});

// PATCH /api/content-items/:id — update a content item
app.patch('/api/content-items/:id', async (req, res) => {
  try {
    const updated = await db.updateContentItem(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/content-items/:id — remove a content item
app.delete('/api/content-items/:id', async (req, res) => {
  try {
    const ok = await db.deleteContentItem(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/content-items/:id/export — generate and download a .docx
app.get('/api/content-items/:id/export', async (req, res) => {
  const item = await db.getContentItem(req.params.id).catch(() => null);
  if (!item) return res.status(404).json({ error: 'Not found' });

  const { Document, Packer, Paragraph, TextRun, HeadingLevel, PageBreak, Table, TableRow, TableCell, WidthType, BorderStyle, AlignmentType, UnderlineType } = require('docx');

  // ── Markdown parser → docx paragraphs ──────────────────────────
  function parseInline(text) {
    // Returns array of TextRun objects for a line of text
    const runs = [];
    // Pattern: **bold**, *italic*, [anchor](url)
    const re = /(\*\*(.+?)\*\*|\*(.+?)\*|\[([^\]]+)\]\(([^)]+)\))/g;
    let last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) runs.push(new TextRun({ text: text.slice(last, m.index) }));
      if (m[2]) runs.push(new TextRun({ text: m[2], bold: true }));
      else if (m[3]) runs.push(new TextRun({ text: m[3], italics: true }));
      else if (m[4]) runs.push(new TextRun({ text: m[4], style: 'Hyperlink', underline: { type: UnderlineType.SINGLE }, color: '1155CC' }));
      last = m.index + m[0].length;
    }
    if (last < text.length) runs.push(new TextRun({ text: text.slice(last) }));
    return runs.length ? runs : [new TextRun({ text })];
  }

  function mdToDocx(md) {
    if (!md) return [new Paragraph({ text: '' })];
    const lines = md.split('\n');
    const paras = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // Table detection
      if (line.trim().startsWith('|')) {
        const tableLines = [];
        while (i < lines.length && lines[i].trim().startsWith('|')) {
          tableLines.push(lines[i]);
          i++;
        }
        // Filter separator rows
        const rows = tableLines.filter(l => !l.match(/^\s*\|[\s\-|:]+\|\s*$/));
        if (rows.length) {
          const tableRows = rows.map((row, ri) => {
            const cells = row.split('|').filter((_, ci) => ci > 0 && ci < row.split('|').length - 1);
            return new TableRow({
              children: cells.map(cell => new TableCell({
                children: [new Paragraph({ children: parseInline(cell.trim()), alignment: AlignmentType.LEFT })],
                shading: ri === 0 ? { fill: '0F172A' } : undefined,
              })),
            });
          });
          paras.push(new Table({
            rows: tableRows,
            width: { size: 100, type: WidthType.PERCENTAGE },
          }));
        }
        continue;
      }

      // Headings
      if (line.startsWith('# ')) {
        paras.push(new Paragraph({ text: line.slice(2).trim(), heading: HeadingLevel.HEADING_1, spacing: { before: 400, after: 200 } }));
      } else if (line.startsWith('## ')) {
        paras.push(new Paragraph({ text: line.slice(3).trim(), heading: HeadingLevel.HEADING_2, spacing: { before: 300, after: 150 } }));
      } else if (line.startsWith('### ')) {
        paras.push(new Paragraph({ text: line.slice(4).trim(), heading: HeadingLevel.HEADING_3, spacing: { before: 200, after: 100 } }));
      } else if (line.startsWith('#### ')) {
        paras.push(new Paragraph({ text: line.slice(5).trim(), heading: HeadingLevel.HEADING_4, spacing: { before: 160, after: 80 } }));
      // Bullet list
      } else if (line.match(/^[-*] /)) {
        paras.push(new Paragraph({ children: parseInline(line.slice(2).trim()), bullet: { level: 0 }, spacing: { after: 60 } }));
      } else if (line.match(/^\d+\. /)) {
        paras.push(new Paragraph({ children: parseInline(line.replace(/^\d+\. /, '').trim()), numbering: { reference: 'default-numbering', level: 0 }, spacing: { after: 60 } }));
      // Horizontal rule
      } else if (line.trim() === '---') {
        paras.push(new Paragraph({ text: '', border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'E2E8F0' } }, spacing: { before: 200, after: 200 } }));
      // Bold line (standalone **text**)
      } else if (line.trim().startsWith('**') && line.trim().endsWith('**') && line.trim().length > 4) {
        const inner = line.trim().slice(2, -2);
        paras.push(new Paragraph({ children: [new TextRun({ text: inner, bold: true })], spacing: { after: 100 } }));
      // Empty line
      } else if (line.trim() === '') {
        paras.push(new Paragraph({ text: '', spacing: { after: 100 } }));
      // Normal paragraph
      } else {
        paras.push(new Paragraph({ children: parseInline(line.trim()), spacing: { after: 120 } }));
      }
      i++;
    }
    return paras;
  }

  // ── Build sections ──────────────────────────────────────────────
  const title = item.title || 'Snipe Export';
  const brief = item.snipe?.brief || '';
  const draft = item.snipe?.draft || '';
  const meta  = item.snipe?.meta  || '';

  const briefParas = [
    new Paragraph({ children: [new TextRun({ text: 'Brief', bold: true, size: 56, color: '0F172A' })], heading: HeadingLevel.HEADING_1, spacing: { after: 300 } }),
    ...mdToDocx(brief),
  ];

  const draftParas = [
    new Paragraph({ children: [new PageBreak()] }),
    new Paragraph({ children: [new TextRun({ text: 'Draft', bold: true, size: 56, color: '0F172A' })], heading: HeadingLevel.HEADING_1, spacing: { after: 300 } }),
    ...mdToDocx(draft),
  ];

  const metaParas = [
    new Paragraph({ children: [new PageBreak()] }),
    new Paragraph({ children: [new TextRun({ text: 'Meta', bold: true, size: 56, color: '0F172A' })], heading: HeadingLevel.HEADING_1, spacing: { after: 300 } }),
    ...mdToDocx(meta),
  ];

  const doc = new Document({
    numbering: {
      config: [{
        reference: 'default-numbering',
        levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.START }],
      }],
    },
    sections: [{
      children: [...briefParas, ...draftParas, ...metaParas],
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  const filename = `${title.replace(/[^a-z0-9]/gi, '_').slice(0, 60)}.docx`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.send(buffer);
});

// Start
// ============================================================
// detectGSCSite(tenant) runs once per process per tenant. On Vercel each
// cold container will fire it; locally it runs at boot below. Lazy per-
// tenant — the GSC middleware also triggers detection on first request if
// boot hydration was skipped.
for (const t of KNOWN_TENANTS) {
  detectGSCSite(t).catch(e => console.warn(`GSC [${t}] detect:`, e.message));
}

// Only bind a port when this file is executed directly (i.e. `node server.js`
// locally). When imported as a module (e.g. by `api/index.js` on Vercel) the
// platform handles request routing — calling app.listen would crash the
// serverless function with EADDRINUSE on warm invocations.
if (require.main === module) {
  const PORT = process.env.PORT || 4016;
  app.listen(PORT, async () => {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  🚀  GEO Dashboard  |  v3.1  |  tenants: ' + KNOWN_TENANTS.join(', '));
    console.log(`  📡  http://localhost:${PORT}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    const { exec } = require('child_process');
    exec(`start http://localhost:${PORT}`);
  });
}

module.exports = app;
