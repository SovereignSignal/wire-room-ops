import { validateConfig } from './config';
import { startServer } from './server';

async function main() {
  console.log('[Startup] Starting Crypto Grant Wire Summarizer...');

  try {
    validateConfig();
    console.log('[Startup] Configuration validated');
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
