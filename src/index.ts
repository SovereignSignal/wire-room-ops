import { validateConfig, config } from './config';
import { startServer } from './server';

async function main() {
  console.log('[Startup] Starting Wire Room Ops...');

  // Production safety: refuse to start without Privy auth credentials
  if (process.env.NODE_ENV === 'production' && !process.env.PRIVY_APP_ID) {
    console.error('[Startup] FATAL: PRIVY_APP_ID is not set in production. Refusing to start without auth.');
    process.exit(1);
  }

  try {
    validateConfig();
    console.log('[Startup] Configuration validated');
    console.log(`[Startup] APP_URL: ${config.app.url}`);
  } catch (error) {
    console.error('[Startup] Configuration error:', error);
    process.exit(1);
  }

  try {
    console.log('[Startup] Starting server...');
    await startServer();
    console.log('[Startup] Server started successfully');
  } catch (error) {
    console.error('[Startup] Server startup error:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('[Startup] Fatal error:', error);
  process.exit(1);
});
