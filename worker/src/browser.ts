import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { addExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as RecaptchaPluginModule from 'puppeteer-extra-plugin-recaptcha';

// same CJS/NodeNext default-export interop gap as puppeteer-extra itself -
// the .d.ts is accurate, TS just can't resolve the synthetic default here
const createRecaptchaPlugin = RecaptchaPluginModule.default as unknown as (opts: {
  provider: { id: string; token: string };
  visualFeedback?: boolean;
}) => import('puppeteer-extra-plugin-recaptcha').PuppeteerExtraPluginRecaptcha;
import type { Browser, Page } from 'puppeteer';
import { config } from './config.js';

const puppeteerExtra = addExtra(puppeteer as never);
puppeteerExtra.use(StealthPlugin());
puppeteerExtra.use(
  createRecaptchaPlugin({
    provider: config.recaptcha.provider,
    visualFeedback: true,
  }) as never,
);

export async function launchBrowser(): Promise<{ browser: Browser; page: Page }> {
  fs.mkdirSync(config.downloadDir, { recursive: true });

  const browser = (await puppeteerExtra.launch({
    headless: config.headless,
    defaultViewport: null,
    userDataDir: config.userDataDir,
    args: ['--start-maximized'],
  })) as Browser;

  const page = await browser.newPage();

  const cdp = await page.createCDPSession();
  await cdp.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: config.downloadDir,
  });

  return { browser, page };
}
