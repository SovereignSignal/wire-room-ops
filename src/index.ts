import { validateConfig } from './config';
import { startServer } from './server';

async function main() {
  console.log('Starting Crypto Grant Wire Summarizer...');

  try {
    validateConfig();
    console.log('Configuration validated');
  } catch (error) {
    console.error('Configuration error:', error);
    process.exit(1);
  }

  try {
    await startServer();
  } catch (error) {
    console.error('Server startup error:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
