import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { addExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as RecaptchaPluginModule from 'puppeteer-extra-plugin-recaptcha';
import type { Browser } from 'puppeteer';
import { config } from '../src/config.js';
import { makeCursor } from '../src/cursor.js';
import { log } from '../src/log.js';
import {
  acceptCookieBanner,
  acceptDisclaimerModal,
  passBotChallenge,
  acceptGatedForm,
  selectReportAndGetSubmitButton,
  ensureDisclaimerCleared,
  downloadAllReports,
} from '../src/flow.js';
import { osClickElement } from '../src/osClick.js';

// throwaway profile so cookies/localStorage from months of dev testing in
// worker/chrome-profile can't hide whether the disclaimer/gated modals
// actually appear - this is the ONLY thing that changes vs the real run
const freshProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ice-fresh-profile-'));

const createRecaptchaPlugin = RecaptchaPluginModule.default as unknown as (opts: {
  provider: { id: string; token: string };
  visualFeedback?: boolean;
}) => import('puppeteer-extra-plugin-recaptcha').PuppeteerExtraPluginRecaptcha;

const puppeteerExtra = addExtra(puppeteer as never);
puppeteerExtra.use(StealthPlugin());
puppeteerExtra.use(createRecaptchaPlugin({ provider: config.recaptcha.provider, visualFeedback: true }) as never);

async function shot(page: import('puppeteer').Page, name: string): Promise<void> {
  await page.screenshot({ path: `debug/fresh-${name}.png` }).catch(() => undefined);
}

async function main(): Promise<void> {
  fs.mkdirSync(config.downloadDir, { recursive: true });
  const browser = (await puppeteerExtra.launch({
    headless: false,
    defaultViewport: null,
    userDataDir: freshProfileDir,
    args: ['--start-maximized'],
  })) as Browser;
  const page = await browser.newPage();
  const cdp = await page.createCDPSession();
  await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: config.downloadDir });
  const cursor = makeCursor(page, true);

  try {
    log.step(`navigating to ${config.targetUrl} (fresh profile: ${freshProfileDir})`);
    await page.goto(config.targetUrl, { waitUntil: 'networkidle2', timeout: config.timeouts.navigationMs });
    await shot(page, '0-landed');

    await acceptCookieBanner(page, cursor);
    await shot(page, '1-cookies');

    await acceptDisclaimerModal(page, cursor);
    await shot(page, '2-disclaimer');

    await passBotChallenge(page, cursor);
    await shot(page, '3-captcha');

    await acceptGatedForm(page, cursor);
    await shot(page, '4-gated');

    const submitButton = await selectReportAndGetSubmitButton(page);
    await shot(page, '5-before-submit');
    await osClickElement(page, browser, submitButton);
    await new Promise((r) => setTimeout(r, 3000));
    await shot(page, '6-after-submit');

    await ensureDisclaimerCleared(page, cursor);
    await shot(page, '7-disclaimer-recheck');

    const saved = await downloadAllReports(page, cursor);
    log.step(`done - ${saved.length} file(s): ${saved.join(', ')}`);
  } finally {
    await browser.close();
    fs.rmSync(freshProfileDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
