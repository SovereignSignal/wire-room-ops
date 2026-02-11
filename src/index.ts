console.log('[Startup] Loading modules...');

let validateConfig: any;
let startServer: any;

try {
  console.log('[Startup] Loading config...');
  const configModule = require('./config');
  validateConfig = configModule.validateConfig;
  console.log('[Startup] Config module loaded');
} catch (error) {
  console.error('[Startup] Failed to load config:', error);
  process.exit(1);
}

try {
  console.log('[Startup] Loading server...');
  const serverModule = require('./server');
  startServer = serverModule.startServer;
  console.log('[Startup] Server module loaded');
} catch (error) {
  console.error('[Startup] Failed to load server:', error);
  process.exit(1);
}

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
