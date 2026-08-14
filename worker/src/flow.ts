import fs from 'node:fs';
import path from 'node:path';
import type { Page, ElementHandle } from 'puppeteer';
import type { GhostCursor } from 'ghost-cursor';
import { config } from './config.js';
import { humanClick, idleWander, sleep } from './cursor.js';
import { log } from './log.js';

async function clickCenter(page: Page, cursor: GhostCursor, el: ElementHandle): Promise<void> {
  // boundingBox() is viewport-relative - rows below the fold (the download
  // table can run to 7+ rows) get a box outside the visible area unless
  // scrolled into view first. behavior MUST be 'instant': the default
  // follows the page's CSS (this site sets scroll-behavior: smooth), which
  // animates over ~300-500ms - reading boundingBox() right after scrolling
  // then catches the row mid-animation and computes a stale coordinate that
  // belongs to whatever row ends up there once the animation finishes.
  await el.evaluate((node) => node.scrollIntoView({ block: 'center', behavior: 'instant' })).catch(() => undefined);
  const box = await el.boundingBox();
  if (!box) throw new Error('element has no bounding box (not visible)');
  await humanClick(cursor, page, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
}

// ::-p-text() substring-matches ANY element's combined text, including prose
// paragraphs that merely mention the phrase - this instead matches only real
// buttons/links whose own trimmed text equals it exactly
async function findButtonByExactText(page: Page, text: string, timeoutMs: number): Promise<ElementHandle | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await findVisibleButtonNow(page, text);
    if (found) return found;
    log.progress(`waiting for button "${text}"... (${Math.round((deadline - Date.now()) / 1000)}s left)`);
    await sleep(300);
  }
  log.endProgress();
  return null;
}

// single-shot, no polling: used to check whether a modal is still up right
// now, not to wait for one to appear. boundingBox() null means detached or
// display:none/hidden - a stale handle from a dismissed modal reads as gone.
async function findVisibleButtonNow(page: Page, text: string): Promise<ElementHandle | null> {
  const candidates = await page.$$('button, a');
  for (const el of candidates) {
    const elText = await el.evaluate((node) => node.textContent?.trim()).catch(() => null);
    if (elText !== text) continue;
    const box = await el.boundingBox().catch(() => null);
    if (box) return el;
  }
  return null;
}

// polls instead of a blind fixed sleep - returns as soon as the button is
// actually gone rather than always paying the full settle time
async function waitUntilGone(page: Page, buttonText: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!(await findVisibleButtonNow(page, buttonText))) return true;
    await sleep(100);
  } while (Date.now() < deadline);
  return !(await findVisibleButtonNow(page, buttonText));
}

// the site re-renders this same disclaimer/"I Accept" modal at more than one
// point (before the captcha, after it, and again once the report table
// loads) - clicking once and moving on isn't reliable, this clicks then
// confirms the modal is actually gone before returning, and retries if not
async function dismissModalUntilGone(
  page: Page,
  cursor: GhostCursor,
  buttonText: string,
  label: string,
  maxAttempts = 4,
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const button = await findVisibleButtonNow(page, buttonText);
    if (!button) return true;

    await clickCenter(page, cursor, button);
    if (await waitUntilGone(page, buttonText, 2000)) return true;
    log.warn(`[${label}] modal still present after click, retrying (attempt ${attempt}/${maxAttempts})`);
  }
  return !(await findVisibleButtonNow(page, buttonText));
}

export async function acceptCookieBanner(page: Page, cursor: GhostCursor): Promise<void> {
  log.step('cookie banner');
  const button = await page.$('#onetrust-accept-btn-handler').catch(() => null);
  if (!button) {
    log.info('[cookies] no OneTrust banner found, continuing');
    return;
  }
  await clickCenter(page, cursor, button);
  log.info('[cookies] accepted');
}

export async function acceptDisclaimerModal(page: Page, cursor: GhostCursor): Promise<void> {
  log.step('disclaimer modal');
  // the disclaimer modal's "I Accept" is the only match at this point - the
  // second one (gated behind the captcha) doesn't exist in the DOM yet
  const button = await findButtonByExactText(page, config.acceptButtonText, config.timeouts.challengeMs);

  if (!button) {
    log.warn('[disclaimer] no modal accept button appeared, continuing');
    return;
  }

  const cleared = await dismissModalUntilGone(page, cursor, config.acceptButtonText, 'disclaimer');
  if (!cleared) {
    log.warn('[disclaimer] modal still present after retries, continuing anyway');
    return;
  }
  log.info('[disclaimer] accepted and confirmed gone');
}

// solved via the 2captcha-backed plugin registered in browser.ts: it finds
// the sitekey, gets a solved token from the provider, and injects it -
// no click, no image challenge, works headless
export async function passBotChallenge(page: Page, cursor: GhostCursor): Promise<void> {
  log.step('reCAPTCHA');
  await idleWander(cursor, page);

  log.info(`[challenge] requesting solve from provider ${config.recaptcha.provider.id} (can take 10-30s)...`);
  const startedAt = Date.now();
  const { captchas, solutions, error } = await page.solveRecaptchas();
  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);

  if (captchas.length === 0) {
    log.info(`[challenge] no reCAPTCHA found, continuing (${elapsedSec}s)`);
    return;
  }
  if (error) {
    throw new Error(`[challenge] solver error after ${elapsedSec}s: ${error}`);
  }

  log.info(`[challenge] solved ${solutions.length} captcha(s) in ${elapsedSec}s`);
}

export async function acceptGatedForm(page: Page, cursor: GhostCursor): Promise<void> {
  log.step('gated accept button');
  const button = await findButtonByExactText(page, config.acceptButtonText, config.timeouts.challengeMs);

  if (!button) {
    log.warn('[accept] no gated accept button found, continuing');
    return;
  }

  const deadline = Date.now() + config.timeouts.challengeMs;
  while (Date.now() < deadline) {
    const disabled = await button.evaluate((el) => (el as HTMLButtonElement).disabled).catch(() => false);
    if (!disabled) break;
    log.progress(`waiting for gated "${config.acceptButtonText}" to enable... (${Math.round((deadline - Date.now()) / 1000)}s left)`);
    await sleep(500);
  }
  log.endProgress();

  await clickCenter(page, cursor, button);
  const cleared = await waitUntilGone(page, config.acceptButtonText, 2000);
  if (!cleared) {
    log.warn('[accept] gated modal still present after click, retrying');
    await dismissModalUntilGone(page, cursor, config.acceptButtonText, 'accept');
  }
  log.info('[accept] gated form accepted');
}

// re-render of the same disclaimer modal shows up again once the report
// table loads - a stale download click can land on this overlay instead of
// the button underneath, so re-check right before downloading rather than
// trusting the accepts earlier in the flow to have been the last word
export async function ensureDisclaimerCleared(page: Page, cursor: GhostCursor): Promise<void> {
  const stillUp = await findVisibleButtonNow(page, config.acceptButtonText);
  if (!stillUp) return;

  log.step('disclaimer recheck');
  log.warn('[disclaimer] modal reappeared before download, dismissing again');
  const cleared = await dismissModalUntilGone(page, cursor, config.acceptButtonText, 'disclaimer-recheck');
  if (!cleared) {
    throw new Error('[disclaimer] modal still blocking the page after retries - aborting before download');
  }
  log.info('[disclaimer] confirmed gone, proceeding to download');
}

// split out from selectReportAndSubmit so callers can swap in a different
// click mechanism for just the Submit button (e.g. a real OS-level click)
// without duplicating the contract-selection/race-guard logic
export async function selectReportAndGetSubmitButton(page: Page): Promise<ElementHandle> {
  log.step('select report');

  const nativeSelect = await page
    .waitForSelector('select', { timeout: config.timeouts.tableMs })
    .catch(() => null);
  if (!nativeSelect) {
    throw new Error('[select] no <select> found on the report picker page');
  }

  const optionValue = await nativeSelect.evaluate((el, text) => {
    const select = el as HTMLSelectElement;
    const opt = Array.from(select.options).find((o) => o.textContent?.trim() === text);
    return opt?.value ?? null;
  }, config.dropdownOptionText);

  if (optionValue === null) {
    throw new Error(`[select] option "${config.dropdownOptionText}" not found - check config.dropdownOptionText`);
  }

  // the report center refetches "criteria" asynchronously after mount and
  // resets exchangeCodeAndContract to its default when the previous value
  // isn't in the new criteria set - selecting once and moving on races that
  // reset, leaving the form submitted with an empty contract (no request,
  // no error, just silence). Re-assert the selection until it survives a
  // settle window instead of trusting a single select() call.
  for (let attempt = 1; attempt <= 5; attempt++) {
    await nativeSelect.select(optionValue);
    await sleep(600);
    const currentValue = await nativeSelect.evaluate((el) => (el as HTMLSelectElement).value);
    if (currentValue === optionValue) break;
    log.info(`[select] contract reset to "${currentValue}" after selecting, re-selecting (attempt ${attempt})`);
    if (attempt === 5) {
      throw new Error('[select] contract selection kept getting reset by the criteria refetch - giving up');
    }
  }
  log.info(`[select] chose "${config.dropdownOptionText}"`);

  const submitButton = await findButtonByExactText(page, config.submitButtonText, config.timeouts.tableMs);
  if (!submitButton) {
    throw new Error(`[select] submit button "${config.submitButtonText}" not found`);
  }

  // belt-and-suspenders: re-verify right before the click too, in case the
  // reset fires on a slightly longer delay than the settle window above
  const valueAtClickTime = await nativeSelect.evaluate((el) => (el as HTMLSelectElement).value);
  if (valueAtClickTime !== optionValue) {
    await nativeSelect.select(optionValue);
    await sleep(600);
  }

  const deadline = Date.now() + config.timeouts.tableMs;
  while (Date.now() < deadline) {
    const disabled = await submitButton.evaluate((el) => (el as HTMLButtonElement).disabled).catch(() => false);
    if (!disabled) break;
    log.progress(`waiting for "${config.submitButtonText}" to enable... (${Math.round((deadline - Date.now()) / 1000)}s left)`);
    await sleep(300);
  }
  log.endProgress();

  return submitButton;
}

export async function selectReportAndSubmit(page: Page, cursor: GhostCursor): Promise<void> {
  const submitButton = await selectReportAndGetSubmitButton(page);
  await clickCenter(page, cursor, submitButton);
  log.info('[select] submitted');
}

function snapshotDir(dir: string): Set<string> {
  return new Set(fs.readdirSync(dir));
}

async function waitForNewStableFile(dir: string, before: Set<string>, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = fs.readdirSync(dir);
    const added = current.find((f) => !before.has(f) && !f.endsWith('.crdownload'));
    if (added) {
      const fullPath = path.join(dir, added);
      const size1 = fs.statSync(fullPath).size;
      await sleep(300);
      const size2 = fs.statSync(fullPath).size;
      if (size1 === size2) return added;
    }
    log.progress(`waiting for download... (${Math.round((deadline - Date.now()) / 1000)}s left)`);
    await sleep(300);
  }
  log.endProgress();
  return null;
}

// Chrome renames a same-name re-download to "file (1).pdf" rather than
// overwriting, which also breaks the new-file detection below (it never sees
// the exact expected name appear) - clearing first keeps runs idempotent
function clearDownloadDir(dir: string): void {
  for (const f of fs.readdirSync(dir)) {
    fs.unlinkSync(path.join(dir, f));
  }
}

// walks the actual results table row by row instead of scanning every
// button/link on the page by text - deterministic top-to-bottom order tied
// to real table structure, not an incidental match order
async function findDownloadButtons(page: Page): Promise<ElementHandle[]> {
  const table = await page.$('table');
  if (!table) return [];

  const rows = await table.$$('tbody tr');
  const downloadButtons: ElementHandle[] = [];
  for (const row of rows) {
    const button = await row.$('button, a');
    if (!button) continue;
    const elText = await button.evaluate((node) => node.textContent?.trim()).catch(() => null);
    if (elText?.startsWith(config.downloadButtonText)) downloadButtons.push(button);
  }
  return downloadButtons;
}

export async function downloadAllReports(page: Page, cursor: GhostCursor): Promise<string[]> {
  log.step('download reports');
  clearDownloadDir(config.downloadDir);
  await page.waitForNetworkIdle({ timeout: config.timeouts.tableMs }).catch(() => undefined);

  const total = (await findDownloadButtons(page)).length;
  log.info(`[download] found ${total} download button(s)`);

  const saved: string[] = [];

  for (let index = 0; index < total; index++) {
    // re-query by index every time instead of holding onto handles from the
    // initial scan - a click can trigger a table re-render (row order/count
    // unaffected, but the old DOM nodes go stale and boundingBox() on them
    // silently returns null further down the loop)
    const button = (await findDownloadButtons(page))[index];
    if (!button) {
      log.warn(`[download] (${index + 1}/${total}) button vanished from the table, skipping`);
      continue;
    }

    // occasionally a click doesn't register a download in time (page still
    // settling, etc) - one retry clears almost all of these cheaply
    let fileName: string | null = null;
    for (let attempt = 1; attempt <= 2 && !fileName; attempt++) {
      // boundingBox() is viewport-relative - rows below the fold (this table
      // can run to 7+ rows) need scrolling into view before it means
      // anything. behavior: 'instant' matters here too - see clickCenter's
      // comment above for why the default (CSS-driven smooth scroll) races
      // this immediate boundingBox() read.
      await button.evaluate((node) => node.scrollIntoView({ block: 'center', behavior: 'instant' })).catch(() => undefined);
      const box = await button.boundingBox();
      if (!box) break;

      const before = snapshotDir(config.downloadDir);
      // race the click's own response against the file-watch: a non-2xx
      // (e.g. 409 from clicking too fast back-to-back) means no file is ever
      // coming, so bail out instead of burning the full downloadMs timeout
      const responsePromise = page
        .waitForResponse((res) => /\/marketdata\/api\/reports\/\d+\/download\//.test(res.url()), {
          timeout: config.timeouts.downloadMs,
        })
        .catch(() => null);
      await humanClick(cursor, page, { x: box.x + box.width / 2, y: box.y + box.height / 2 });

      const response = await responsePromise;
      if (response && !response.ok()) {
        log.warn(`[download] (${index + 1}/${total}) server returned ${response.status()}, not waiting for a file`);
        break;
      }

      fileName = await waitForNewStableFile(config.downloadDir, before, config.timeouts.downloadMs);
      if (!fileName && attempt === 1) {
        log.warn(`[download] (${index + 1}/${total}) no file detected, retrying once`);
      }
    }

    if (fileName) {
      log.info(`[download] (${index + 1}/${total}) saved ${fileName}`);
      saved.push(fileName);
    } else {
      log.warn(`[download] (${index + 1}/${total}) no file detected after retry`);
    }
  }

  return saved;
}
