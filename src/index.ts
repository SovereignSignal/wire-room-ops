import { validateConfig } from './config';
import { startServer } from './server';

console.log('Starting Crypto Grant Wire Summarizer...');

try {
  validateConfig();
  console.log('Configuration validated');
} catch (error) {
  console.error('Configuration error:', error);
  process.exit(1);
}

startServer();
