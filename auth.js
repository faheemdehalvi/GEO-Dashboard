// Supabase Auth middleware. Verifies the JWT on every protected /api/* call
// using the publishable key (safe for verification). On success, attaches
// req.user = { id, email, ... }. On failure, returns 401 JSON.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  process.env.SUPABASE_ANON_KEY; // legacy name still accepted

const AUTH_ENABLED = !!(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY);

let _verifier = null;
if (AUTH_ENABLED) {
  _verifier = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  console.log('🔐 Auth: Supabase (Google + email/password)');
} else {
  console.warn('🔐 Auth: DISABLED (SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY missing) — all routes open');
}

async function requireAuth(req, res, next) {
  if (!AUTH_ENABLED) return next(); // fail-open when not configured (dev)
  try {
    const header = req.headers.authorization || '';
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'Missing Authorization header' });
    const { data, error } = await _verifier.auth.getUser(m[1]);
    if (error || !data?.user) return res.status(401).json({ error: 'Invalid or expired session' });
    req.user = data.user;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Auth check failed: ' + e.message });
  }
}

module.exports = { requireAuth, AUTH_ENABLED };
