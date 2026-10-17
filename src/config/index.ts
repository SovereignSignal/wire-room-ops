import dotenv from 'dotenv';

dotenv.config();

function normalizeAppUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return '';
  const withProtocol = (!trimmed.startsWith('http://') && !trimmed.startsWith('https://'))
    ? `https://${trimmed}`
    : trimmed;
  return withProtocol.replace(/\/+$/, '');
}

/**
 * Daily WireOps digest email. Unset sends, same as today.
 * Only the string "false" (any case, surrounding space ignored) turns it off.
 */
export function isDigestEmailEnabled(raw: string | undefined = process.env.DIGEST_EMAIL_ENABLED): boolean {
  if (raw == null || raw.trim() === '') return true;
  return raw.trim().toLowerCase() !== 'false';
}

/** Default-on flag: only "false" (any case, trimmed) disables it. */
export function isFlagEnabled(raw: string | undefined): boolean {
  if (raw == null || raw.trim() === '') return true;
  return raw.trim().toLowerCase() !== 'false';
}

/**
 * Comma-separated org patterns. Each entry is a case-insensitive regex, so a
 * plain name works too; an entry that is not a valid regex matches literally.
 */
export function parseOrgPatterns(raw: string | undefined): RegExp[] {
  return (raw || '').split(',').map(s => s.trim()).filter(Boolean).map(s => {
    try {
      return new RegExp(s, 'i');
    } catch {
      return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
  });
}

export const config = {
  database: {
    url: process.env.DATABASE_URL || '',
  },
  
  apis: {
    grok: {
      apiKey: process.env.GROK_API_KEY || '',
      baseUrl: 'https://api.x.ai/v1',
    },
    firecrawl: {
      apiKey: process.env.FIRECRAWL_API_KEY || '',
      baseUrl: 'https://api.firecrawl.dev/v1',
    },
    ollama: {
      apiKey: process.env.OLLAMA_API_KEY || '',
      baseUrl: 'https://ollama.com/api',
      // Env wins over api_providers.default_model for every summary call.
      defaultModel: process.env.OLLAMA_DEFAULT_MODEL || 'deepseek-v4.1-flash',
      fallbackModel: process.env.OLLAMA_FALLBACK_MODEL || 'glm-5.3-flash',
      // Wire-post models. Unset follows the summary primary so a deploy
      // without these variables keeps today's model.
      postGenModel: process.env.POST_GEN_MODEL || process.env.OLLAMA_DEFAULT_MODEL || 'deepseek-v4.1-flash',
      postVerifyModel: process.env.POST_VERIFY_MODEL || process.env.OLLAMA_DEFAULT_MODEL || 'deepseek-v4.1-flash',
    },
  },

  watchtower: {
    budgetMonthlyUsd: Number(process.env.WATCHTOWER_BUDGET_MONTHLY_USD || '20'),
    xListsEnabled: process.env.X_LISTS_ENABLED === 'true',
    xListsDryRun: process.env.X_LISTS_DRY_RUN !== 'false', // dry-run unless explicitly disabled
    xListIds: process.env.X_LIST_IDS || '',                // "crypto:123,ai:456,oss:789"
    registryWatchEnabled: process.env.REGISTRY_WATCH_ENABLED === 'true',
    registryWatchDryRun: process.env.REGISTRY_WATCH_DRY_RUN !== 'false',
    registryTiers: process.env.REGISTRY_WATCH_TIERS || '1',   // "1", "1,2", or "2"
    registryRssCap: Number(process.env.REGISTRY_WATCH_RSS_CAP || '60'),
    registryDiffCap: Number(process.env.REGISTRY_WATCH_DIFF_CAP || '80'),
    registryExtractCap: Number(process.env.REGISTRY_WATCH_EXTRACT_CAP || '10'),
  },

  startup: {
    // Default true. Set SCHEDULER_ENABLED=false on a secondary/rollback runtime
    // so only one process runs the scheduler and background loops.
    schedulerEnabled: isFlagEnabled(process.env.SCHEDULER_ENABLED),
    // Default true. Set TELEGRAM_INTAKE_WEBHOOK_REGISTER=false so this runtime
    // does not (re)point the Telegram intake webhook at itself on boot.
    telegramIntakeWebhookRegister: isFlagEnabled(process.env.TELEGRAM_INTAKE_WEBHOOK_REGISTER),
    // Explicit opt-in. Startup must not spend on LLM calls or rewrite queue
    // intelligence merely because a process was redeployed.
    llmRescoreEnabled: process.env.STARTUP_LLM_RESCORE_ENABLED === 'true',
  },
  
  email: {
    resendApiKey: process.env.RESEND_API_KEY || '',
    notificationEmail: process.env.NOTIFICATION_EMAIL || '',
    fromEmail: process.env.FROM_EMAIL || 'noreply@resend.sovereignsignal.com',
    // Live read so a skipped send follows the env var at send time.
    get digestEnabled() {
      return isDigestEmailEnabled();
    },
  },
  
  privy: {
    appId: process.env.PRIVY_APP_ID || '',
    appSecret: process.env.PRIVY_APP_SECRET || '',
  },

  auth: {
    tokenExpiryHours: 24,
  },
  
  app: {
    url: normalizeAppUrl(
      process.env.APP_URL
        || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : 'http://localhost:3000')
    ),
    port: parseInt(process.env.PORT || '3000', 10),
  },
  
  dateRange: {
    startDate: process.env.START_DATE,
    endDate: process.env.END_DATE,
  },


  forum: {
    discussWatchBaseUrl: process.env.DISCUSS_WATCH_API_URL || 'https://discuss-dot-watch-production.up.railway.app/api/v1',
    enabled: process.env.FORUM_SCAN_ENABLED === 'true',
    defaultLookbackDays: parseInt(process.env.FORUM_LOOKBACK_DAYS || '2', 10) || 2,
    // Pre-classified /api/v1/grants pull (lane v3). Default ON — it reduces
    // Grok judge spend; set FORUM_GRANTS_FEED_ENABLED=false to kill-switch.
    grantsFeedEnabled: process.env.FORUM_GRANTS_FEED_ENABLED !== 'false',
    grantsMinConfidence: parseInt(process.env.FORUM_GRANTS_MIN_CONFIDENCE || '60', 10) || 60,
    // Orgs never surfaced by the forum lane (matched against forum name, protocol and url).
    excludedOrgs: parseOrgPatterns(process.env.EXCLUDED_ORGS),
  },

  // Notion database ids the CRM jobs read. Empty means the job skips with a reason.
  notionDatabases: {
    contacts: process.env.CONTACTS_NOTION_DATABASE_ID || '',
    orgs: process.env.ORGS_NOTION_DATABASE_ID || '',
  },

  bdLeads: {
    // Link under the BD leads block of the daily digest email; omitted when unset.
    digestUrl: process.env.BD_LEADS_DIGEST_URL || '',
    // Operator profile the qualifier scores against. Falls back to
    // config/bd-profile.local.md (untracked), then a generic default.
    profile: process.env.BD_PROFILE || '',
  },

  crm: {
    // Org enrichment uses Grok Responses + web_search (same path as scans).
    // The grok provider's default_model may be a cheap chat model (glm-5.2);
    // enricher/contact-discovery pin a Grok search-capable model instead.
    // Contact discovery is a separate spend gate — it writes Needs Review
    // rows and should stay off until that queue is worked.
    enrichEnabled: process.env.CRM_ENRICH_ENABLED === 'true',
    contactDiscoveryEnabled: process.env.CRM_CONTACT_DISCOVERY_ENABLED === 'true',
  },

  cohort: {
    // In-process Notion cohort bridge (Cowork + Codex daily scans table →
    // source_runs heartbeat + queue). Default ON so a missed Stringer VM
    // window cannot stay silent; set COHORT_BRIDGE_ENABLED=false to disable.
    enabled: process.env.COHORT_BRIDGE_ENABLED !== 'false',
    // Required unless the enabled Notion integration carries cohort_database_id.
    databaseId: process.env.COHORT_NOTION_DATABASE_ID || '',
    token: process.env.COHORT_NOTION_TOKEN || process.env.NOTION_TOKEN || '',
  },

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
  },

  telegramIntake: {
    botToken: process.env.TELEGRAM_INTAKE_BOT_TOKEN || '',
    webhookSecret: process.env.TELEGRAM_INTAKE_WEBHOOK_SECRET || '',
    // Empty means nobody may submit; the adapter fails closed.
    allowedUserId: process.env.TELEGRAM_INTAKE_ALLOWED_USER_ID || '',
  },

  publicSnapshot: {
    // Outbound-only: we PUSH a narrow public projection to a store that serves
    // it anonymously. Nothing new listens on this app. Unset = publisher no-ops,
    // so this is safe to deploy before the target exists.
    pushUrl: process.env.SNAPSHOT_PUSH_URL || '',
    pushToken: process.env.SNAPSHOT_PUSH_TOKEN || '',
    telegramBase: process.env.SNAPSHOT_TELEGRAM_BASE || 'https://t.me/thegrantwire',
  },

};

export function validateConfig(): void {
  const required = [
    ['DATABASE_URL', config.database.url],
    ['NOTIFICATION_EMAIL', config.email.notificationEmail],
    ['PRIVY_APP_ID', config.privy.appId],
    ['PRIVY_APP_SECRET', config.privy.appSecret],
  ];

  const optional = [
    ['GROK_API_KEY', config.apis.grok.apiKey],
    ['FIRECRAWL_API_KEY', config.apis.firecrawl.apiKey],
    ['OLLAMA_API_KEY', config.apis.ollama.apiKey],
    ['RESEND_API_KEY', config.email.resendApiKey],
  ];

  const missing = required.filter(([, value]) => !value).map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  for (const [name, value] of optional) {
    if (!value) {
      console.warn(`[Startup] API key not set: ${name} — configure via Settings > API Providers`);
    }
  }
}
