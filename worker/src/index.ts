import { runScrape } from './runScrape.js';

runScrape().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
