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
      orgsDbId: process.env.NOTION_ORGS_DB_ID || '301000c0-d590-819f-9619-000bac2ea702',
      oppsDbId: process.env.NOTION_OPPS_DB_ID || '301000c0-d590-81fc-9828-000bb5409ede',
      crmPageId: process.env.NOTION_CRM_PAGE_ID || '301000c0d5908049b313f8170819ece3',
    },
  },
  
  email: {
    resendApiKey: process.env.RESEND_API_KEY || '',
    notificationEmail: process.env.NOTIFICATION_EMAIL || '',
    fromEmail: process.env.FROM_EMAIL || 'noreply@cryptograntwire.com',
  },
  
  auth: {
    magicLinkSecret: process.env.MAGIC_LINK_SECRET || 'change-me-in-production',
    tokenExpiryHours: 24,
  },
  
  app: {
    url: process.env.APP_URL || 'http://localhost:3000',
    port: parseInt(process.env.PORT || '3000', 10),
  },
  
  dateRange: {
    startDate: process.env.START_DATE,
    endDate: process.env.END_DATE,
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
  ];
  
  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}
