// Tenant resolution — maps a tenant slug ("kyn" | "ir") to a fully-resolved
// config object built from prefixed env vars with sensible fallbacks.
//
// Lookup order for each value:
//   1. <TENANT>_<KEY>     e.g. IR_GA4_PROPERTY_ID
//   2. <KEY>              bare env var (Kynection-era / legacy)
//   3. hard-coded default (per-tenant where it matters)
//
// This means existing Kynection deploys keep working with no `KYN_` prefix
// set — every bare env var still resolves. IR overrides only need IR_*
// variants for things that differ.

const KNOWN_TENANTS = ['kyn', 'ir'];
const DEFAULT_TENANT = 'kyn';

function resolveTenant(raw) {
  const t = (raw || '').toString().toLowerCase().trim();
  return KNOWN_TENANTS.includes(t) ? t : DEFAULT_TENANT;
}

function envFor(tenant, key) {
  const prefixed = process.env[`${tenant.toUpperCase()}_${key}`];
  if (prefixed !== undefined && prefixed !== '') return prefixed;
  return process.env[key];
}

// Hard-coded per-tenant fallbacks for things that always differ between
// Kynection and IR even when env vars aren't set yet. Only used if both
// the prefixed env var AND the bare env var are missing.
const TENANT_DEFAULTS = {
  kyn: {
    BRAND_NAME: 'Kynection',
    BRAND_DOMAIN: 'kynection.com.au',
    GA4_PROPERTY_ID: '386242225',
    SEMRUSH_DOMAIN: 'kynection.com.au',
    SITEMAP_URLS: 'https://www.kynection.com.au/post-sitemap.xml,https://www.kynection.com.au/page-sitemap.xml',
    SNIPE_SKILL_FILE: 'snipe-skill.md',
    ENABLED_SECTIONS: 'overview,web,gsc,semrush,youtube,mqls,deals,aeo,prompts,content',
    DASHBOARD_TITLE: 'Kynection Analytics Dashboard'
  },
  ir: {
    BRAND_NAME: 'Intelligent Resourcing',
    BRAND_DOMAIN: 'intelligentresourcing.co',
    GA4_PROPERTY_ID: '533739502',
    SEMRUSH_DOMAIN: 'intelligentresourcing.co',
    SITEMAP_URLS: 'https://intelligentresourcing.co/sitemap.xml',
    SNIPE_SKILL_FILE: 'snipe-skill-ir.md',
    // IR omits semrush + mqls + deals — focus on web/GSC/YouTube + AEO + Content
    ENABLED_SECTIONS: 'overview,web,gsc,youtube,aeo,prompts,content',
    DASHBOARD_TITLE: 'Intelligent Resourcing Analytics'
  }
};

function envOrDefault(tenant, key) {
  const v = envFor(tenant, key);
  if (v !== undefined && v !== '') return v;
  return (TENANT_DEFAULTS[tenant] || TENANT_DEFAULTS[DEFAULT_TENANT])[key];
}

function buildConfig(tenant) {
  tenant = resolveTenant(tenant);
  return {
    tenant,
    brand: {
      name:   envOrDefault(tenant, 'BRAND_NAME'),
      domain: envOrDefault(tenant, 'BRAND_DOMAIN')
    },
    google: {
      clientId:     envFor(tenant, 'GOOGLE_CLIENT_ID'),
      clientSecret: envFor(tenant, 'GOOGLE_CLIENT_SECRET'),
      refreshToken: envFor(tenant, 'GOOGLE_REFRESH_TOKEN')
    },
    youtube: {
      clientId:     envFor(tenant, 'YOUTUBE_CLIENT_ID')     || envFor(tenant, 'GOOGLE_CLIENT_ID'),
      clientSecret: envFor(tenant, 'YOUTUBE_CLIENT_SECRET') || envFor(tenant, 'GOOGLE_CLIENT_SECRET'),
      refreshToken: envFor(tenant, 'YOUTUBE_REFRESH_TOKEN')
    },
    ga4: { propertyId: envOrDefault(tenant, 'GA4_PROPERTY_ID') },
    gsc: { siteUrl: null }, // populated lazily by detectGSCSite per-tenant
    semrush: {
      apiKey:   envFor(tenant, 'SEMRUSH_API_KEY'),
      domain:   envOrDefault(tenant, 'SEMRUSH_DOMAIN'),
      database: envFor(tenant, 'SEMRUSH_DATABASE') || 'au'
    },
    hubspot: { accessToken: envFor(tenant, 'HUBSPOT_ACCESS_TOKEN') },
    gemini:  { apiKey: envFor(tenant, 'GEMINI_API_KEY') },
    openai:  { apiKey: envFor(tenant, 'OPENAI_API_KEY') },
    sitemap: {
      urls: envOrDefault(tenant, 'SITEMAP_URLS').split(',').map(s => s.trim()).filter(Boolean)
    },
    snipeSkillFile:  envOrDefault(tenant, 'SNIPE_SKILL_FILE'),
    enabledSections: envOrDefault(tenant, 'ENABLED_SECTIONS').split(',').map(s => s.trim()).filter(Boolean),
    title:           envOrDefault(tenant, 'DASHBOARD_TITLE'),
    supabaseUrl:     envFor(tenant, 'SUPABASE_URL'),
    supabaseServiceKey: envFor(tenant, 'SUPABASE_SERVICE_ROLE_KEY')
  };
}

// Express middleware — populates req.tenant + req.config on every /api/*
// request from the x-tenant header (defaults to 'kyn').
function tenantMiddleware(req, res, next) {
  req.tenant = resolveTenant(req.headers['x-tenant']);
  req.config = buildConfig(req.tenant);
  next();
}

module.exports = {
  KNOWN_TENANTS,
  DEFAULT_TENANT,
  resolveTenant,
  buildConfig,
  tenantMiddleware
};
