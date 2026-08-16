import { launchBrowser } from '../src/browser.js';
import { makeCursor } from '../src/cursor.js';
import { log } from '../src/log.js';
import {
  acceptCookieBanner,
  acceptDisclaimerModal,
  passBotChallenge,
  acceptGatedForm,
  selectReportAndGetSubmitButton,
  downloadAllReports,
} from '../src/flow.js';
import { osClickElement } from '../src/osClick.js';
import { config } from '../src/config.js';

async function main(): Promise<void> {
  const { browser, page } = await launchBrowser();
  const cursor = makeCursor(page, !config.headless);

  try {
    log.step(`navigating to ${config.targetUrl}`);
    await page.goto(config.targetUrl, { waitUntil: 'networkidle2', timeout: config.timeouts.navigationMs });

    await acceptCookieBanner(page, cursor);
    await acceptDisclaimerModal(page, cursor);
    await passBotChallenge(page, cursor);
    await acceptGatedForm(page, cursor);

    const submitButton = await selectReportAndGetSubmitButton(page);

    log.step('clicking Submit with a real OS-level click (nut-js)');
    await osClickElement(page, browser, submitButton);
    log.info('[submit] real click dispatched');

    await new Promise((r) => setTimeout(r, 3000));
    const tableCount = await page.evaluate(() => document.querySelectorAll('table').length);
    log.info(`[submit] tables found after real click: ${tableCount}`);

    const saved = await downloadAllReports(page, cursor);
    log.step(`done - ${saved.length} file(s) saved`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
