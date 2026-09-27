import { runStartupUpdateCheck } from './update.js';

await runStartupUpdateCheck();
await import('./index.js');
