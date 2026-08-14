import fs from 'node:fs';
import { launchBrowser } from '../src/browser.js';
import { makeCursor } from '../src/cursor.js';
import { config } from '../src/config.js';
import {
  acceptCookieBanner,
  acceptDisclaimerModal,
  passBotChallenge,
  acceptGatedForm,
} from '../src/flow.js';

async function main(): Promise<void> {
  const { browser, page } = await launchBrowser();
  const cursor = makeCursor(page, !config.headless);
  await page.goto(config.targetUrl, { waitUntil: 'networkidle2', timeout: 30_000 });
  await new Promise((r) => setTimeout(r, 1000));

  await acceptCookieBanner(page, cursor);
  await page.screenshot({ path: 'debug/step1-cookies.png' });

  await acceptDisclaimerModal(page, cursor);
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: 'debug/step2-disclaimer.png' });

  await passBotChallenge(page, cursor);
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: 'debug/step3-captcha.png' });

  await acceptGatedForm(page, cursor);
  await new Promise((r) => setTimeout(r, 2000));
  await page.screenshot({ path: 'debug/step4-gated.png' });

  await page.screenshot({ path: 'debug/screenshot.png', fullPage: true });
  const html = await page.content();
  fs.writeFileSync('debug/page.html', html);

  // raw string, not a transpiled function - keeps esbuild's __name helper
  // injection (tsx's keepNames) out of code that runs in the page context
  const info = (await page.evaluate(`
    (function () {
      function describe(el) {
        return {
          tag: el.tagName,
          id: el.id,
          className: el.className,
          text: (el.textContent || '').trim().slice(0, 60),
          outerHTMLStart: el.outerHTML.slice(0, 300),
        };
      }
      return {
        selects: Array.from(document.querySelectorAll('select')).map(describe),
        comboboxLike: Array.from(document.querySelectorAll('[role="listbox"], [role="combobox"], [class*="dropdown"], [class*="select"]')).slice(0, 15).map(describe),
        submitButtons: Array.from(document.querySelectorAll('button, input[type="submit"], a')).filter(function (el) { return /submit/i.test(el.textContent || '') || (el.value && /submit/i.test(el.value)); }).map(describe),
        downloadButtons: Array.from(document.querySelectorAll('button, a')).filter(function (el) { return /download/i.test(el.textContent || ''); }).slice(0, 10).map(describe),
        tables: Array.from(document.querySelectorAll('table')).map(describe),
        bodyTextSample: (document.body.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 2000),
      };
    })()
  `)) as unknown;
  fs.writeFileSync('debug/info.json', JSON.stringify(info, null, 2));

  console.log('saved debug/screenshot.png, debug/page.html, debug/info.json');
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
