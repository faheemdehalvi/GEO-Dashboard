// Supabase Auth middleware. Verifies the JWT on every protected /api/* call
// using the publishable key (safe for verification). On success, attaches
// req.user = { id, email, ... }. On failure, returns 401 JSON.
//
// Optional domain whitelist: if ALLOWED_EMAIL_DOMAINS is set (comma-separated
// list e.g. "intelligentresourcing.co,kynection.com"), users whose email
// doesn't match one of those domains get 403. Leaves verified-but-not-allowed
// Supabase user records intact so an admin can audit them later.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  process.env.SUPABASE_ANON_KEY; // legacy name still accepted

const AUTH_ENABLED = !!(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY);

const ALLOWED_DOMAINS = (process.env.ALLOWED_EMAIL_DOMAINS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

let _verifier = null;
if (AUTH_ENABLED) {
  _verifier = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const domainNote = ALLOWED_DOMAINS.length
    ? ` — restricted to: ${ALLOWED_DOMAINS.join(', ')}`
    : ' — no domain restriction (set ALLOWED_EMAIL_DOMAINS to limit access)';
  console.log('🔐 Auth: Supabase (Google + email/password)' + domainNote);
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

    // Domain whitelist enforcement — only kicks in if ALLOWED_EMAIL_DOMAINS
    // is set. We use 403 (forbidden) not 401 (unauthenticated) because the
    // user IS authenticated; their identity just isn't permitted here. The
    // frontend handles 403 by signing them out and explaining why.
    if (ALLOWED_DOMAINS.length) {
      const email = (data.user.email || '').toLowerCase();
      const domain = email.split('@')[1] || '';
      if (!ALLOWED_DOMAINS.includes(domain)) {
        return res.status(403).json({
          error: 'access_denied',
          message: `Access is restricted. The email "${email}" is not in the allowed domain list. Contact your administrator if this is unexpected.`
        });
      }
    }

    req.user = data.user;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Auth check failed: ' + e.message });
  }
}

module.exports = { requireAuth, AUTH_ENABLED };
