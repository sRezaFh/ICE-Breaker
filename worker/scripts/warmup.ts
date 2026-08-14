import { launchBrowser } from '../src/browser.js';

// run once (npm run warmup): log into a Google account by hand in the window
// that opens, then just close it - the persistent profile keeps the session
async function main(): Promise<void> {
  const { browser, page } = await launchBrowser();
  await page.goto('https://accounts.google.com', { waitUntil: 'networkidle2' });

  console.log('Log into a Google account in the opened window, then close the browser to finish.');
  await new Promise<void>((resolve) => browser.on('disconnected', () => resolve()));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
