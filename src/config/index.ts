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

export const config = {
  database: {
    url: process.env.DATABASE_URL || '',
  },
  
  apis: {
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY || '',
    },
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
      defaultModel: process.env.OLLAMA_DEFAULT_MODEL || 'gpt-oss:120b',
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

  summarize: {
    provider: (process.env.SUMMARIZE_PROVIDER || 'auto') as 'auto' | 'ollama' | 'grok',
  },

  startup: {
    // Explicit opt-in. Startup must not spend on LLM calls or rewrite queue
    // intelligence merely because a process was redeployed.
    llmRescoreEnabled: process.env.STARTUP_LLM_RESCORE_ENABLED === 'true',
  },
  
  email: {
    resendApiKey: process.env.RESEND_API_KEY || '',
    notificationEmail: process.env.NOTIFICATION_EMAIL || '',
    fromEmail: process.env.FROM_EMAIL || 'noreply@resend.sovereignsignal.com',
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
    databaseId: process.env.COHORT_NOTION_DATABASE_ID || '366000c0d590805ba2abdd2957ee86a7',
    token: process.env.COHORT_NOTION_TOKEN || process.env.NOTION_TOKEN || '',
  },

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
  },

  telegramIntake: {
    botToken: process.env.TELEGRAM_INTAKE_BOT_TOKEN || '',
    webhookSecret: process.env.TELEGRAM_INTAKE_WEBHOOK_SECRET || '',
    allowedUserId: process.env.TELEGRAM_INTAKE_ALLOWED_USER_ID || '394395765',
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
    ['ANTHROPIC_API_KEY', config.apis.anthropic.apiKey],
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
