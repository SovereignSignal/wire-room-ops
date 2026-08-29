import { validateConfig, config } from './config';
import { assertProductionAuthSafety } from './config/production-guards';
import { startServer } from './server';

async function main() {
  console.log('[Startup] Starting Wire Room Ops...');

  try {
    assertProductionAuthSafety();
  } catch (error) {
    console.error(`[Startup] FATAL: ${error instanceof Error ? error.message : error}`);
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
