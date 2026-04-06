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
      baseUrl: process.env.OLLAMA_BASE_URL || 'https://ollama.com/api',
    },
  },

  summarize: {
    provider: (process.env.SUMMARIZE_PROVIDER || 'auto') as 'auto' | 'ollama' | 'grok',
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
  },

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
  },

  telegramIntake: {
    botToken: process.env.TELEGRAM_INTAKE_BOT_TOKEN || '',
    webhookSecret: process.env.TELEGRAM_INTAKE_WEBHOOK_SECRET || '',
    allowedUserId: process.env.TELEGRAM_INTAKE_ALLOWED_USER_ID || '394395765',
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
