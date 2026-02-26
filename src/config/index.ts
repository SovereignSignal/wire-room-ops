import dotenv from 'dotenv';

dotenv.config();

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
    notion: {
      apiKey: process.env.NOTION_API_KEY || '',
      orgsDbId: process.env.NOTION_ORGS_DB_ID || '',
      oppsDbId: process.env.NOTION_OPPS_DB_ID || '',
      crmPageId: process.env.NOTION_CRM_PAGE_ID || '',
      stagingOrgsDbId: process.env.NOTION_STAGING_ORGS_DB_ID || '',
    },
  },
  
  email: {
    resendApiKey: process.env.RESEND_API_KEY || '',
    notificationEmail: process.env.NOTIFICATION_EMAIL || '',
    fromEmail: process.env.FROM_EMAIL || 'noreply@thewireroom.xyz',
  },
  
  privy: {
    appId: process.env.PRIVY_APP_ID || '',
    appSecret: process.env.PRIVY_APP_SECRET || '',
  },

  auth: {
    tokenExpiryHours: 24,
  },
  
  app: {
    url: process.env.APP_URL
      || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : 'http://localhost:3000'),
    port: parseInt(process.env.PORT || '3000', 10),
  },
  
  dateRange: {
    startDate: process.env.START_DATE,
    endDate: process.env.END_DATE,
  },

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
    allowedUserIds: (process.env.TELEGRAM_ALLOWED_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
    defaultWire: process.env.TELEGRAM_DEFAULT_WIRE || 'crypto',
  },

  inboundEmail: {
    allowedSenders: (process.env.INBOUND_EMAIL_ALLOWED_SENDERS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    inboundAddress: process.env.INBOUND_EMAIL_ADDRESS || '',
    webhookSigningSecret: process.env.RESEND_WEBHOOK_SECRET || '',
  },

  forum: {
    discussWatchBaseUrl: process.env.DISCUSS_WATCH_API_URL || 'https://discuss-dot-watch-production.up.railway.app/api/v1',
    enabled: process.env.FORUM_SCAN_ENABLED === 'true',
  },

  distribution: {
    enabled: process.env.DISTRIBUTION_ENABLED === 'true',
    x: {
      crypto: {
        apiKey: process.env.X_CRYPTO_API_KEY || '',
        apiSecret: process.env.X_CRYPTO_API_SECRET || '',
        accessToken: process.env.X_CRYPTO_ACCESS_TOKEN || '',
        accessTokenSecret: process.env.X_CRYPTO_ACCESS_TOKEN_SECRET || '',
      },
      ai: {
        apiKey: process.env.X_AI_API_KEY || '',
        apiSecret: process.env.X_AI_API_SECRET || '',
        accessToken: process.env.X_AI_ACCESS_TOKEN || '',
        accessTokenSecret: process.env.X_AI_ACCESS_TOKEN_SECRET || '',
      },
      oss: {
        apiKey: process.env.X_OSS_API_KEY || '',
        apiSecret: process.env.X_OSS_API_SECRET || '',
        accessToken: process.env.X_OSS_ACCESS_TOKEN || '',
        accessTokenSecret: process.env.X_OSS_ACCESS_TOKEN_SECRET || '',
      },
    },
    telegramChannels: {
      crypto: process.env.TELEGRAM_CHANNEL_CRYPTO || '',
      ai: process.env.TELEGRAM_CHANNEL_AI || '',
      oss: process.env.TELEGRAM_CHANNEL_OSS || '',
    },
  },
};

export function validateConfig(): void {
  const required = [
    ['DATABASE_URL', config.database.url],
    ['ANTHROPIC_API_KEY', config.apis.anthropic.apiKey],
    ['GROK_API_KEY', config.apis.grok.apiKey],
    ['FIRECRAWL_API_KEY', config.apis.firecrawl.apiKey],
    ['RESEND_API_KEY', config.email.resendApiKey],
    ['NOTIFICATION_EMAIL', config.email.notificationEmail],
    ['PRIVY_APP_ID', config.privy.appId],
    ['PRIVY_APP_SECRET', config.privy.appSecret],
  ];
  
  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}
