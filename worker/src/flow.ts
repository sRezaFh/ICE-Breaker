import fs from 'node:fs';
import path from 'node:path';
import type { Page, ElementHandle } from 'puppeteer';
import type { GhostCursor } from 'ghost-cursor';
import { config } from './config.js';
import { humanClick, idleWander, sleep } from './cursor.js';
import { log } from './log.js';

async function clickCenter(page: Page, cursor: GhostCursor, el: ElementHandle): Promise<void> {
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
    const candidates = await page.$$('button, a');
    for (const el of candidates) {
      const elText = await el.evaluate((node) => node.textContent?.trim()).catch(() => null);
      if (elText === text) return el;
    }
    log.progress(`waiting for button "${text}"... (${Math.round((deadline - Date.now()) / 1000)}s left)`);
    await sleep(300);
  }
  log.endProgress();
  return null;
}

export async function acceptCookieBanner(page: Page, cursor: GhostCursor): Promise<void> {
  log.step('cookie banner');
  const button = await page.$('#onetrust-accept-btn-handler').catch(() => null);
  if (!button) {
    log.info('[cookies] no OneTrust banner found, continuing');
    return;
  }
  await clickCenter(page, cursor, button);
  await sleep(300);
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
  await clickCenter(page, cursor, button);
  await sleep(300);
  log.info('[disclaimer] accepted');
}

// solved via the 2captcha-backed plugin registered in browser.ts: it finds
// the sitekey, gets a solved token from the provider, and injects it -
// no click, no image challenge, works headless
export async function passBotChallenge(page: Page, cursor: GhostCursor): Promise<void> {
  log.step('reCAPTCHA');
  await idleWander(cursor, page);

  log.info('[challenge] requesting solve from provider (can take 10-30s)...');
  const { captchas, solutions, error } = await page.solveRecaptchas();

  if (captchas.length === 0) {
    log.info('[challenge] no reCAPTCHA found, continuing');
    return;
  }
  if (error) {
    throw new Error(`[challenge] solver error: ${error}`);
  }

  log.info(`[challenge] solved ${solutions.length} captcha(s)`);
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
  log.info('[accept] gated form accepted');
}

export async function selectReportAndSubmit(page: Page, cursor: GhostCursor): Promise<void> {
  log.step('select report + submit');

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
  await nativeSelect.select(optionValue);
  log.info(`[select] chose "${config.dropdownOptionText}"`);

  const submitButton = await findButtonByExactText(page, config.submitButtonText, config.timeouts.tableMs);
  if (!submitButton) {
    throw new Error(`[select] submit button "${config.submitButtonText}" not found`);
  }

  const deadline = Date.now() + config.timeouts.tableMs;
  while (Date.now() < deadline) {
    const disabled = await submitButton.evaluate((el) => (el as HTMLButtonElement).disabled).catch(() => false);
    if (!disabled) break;
    log.progress(`waiting for "${config.submitButtonText}" to enable... (${Math.round((deadline - Date.now()) / 1000)}s left)`);
    await sleep(300);
  }
  log.endProgress();

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

export async function downloadAllReports(page: Page, cursor: GhostCursor): Promise<string[]> {
  log.step('download reports');
  clearDownloadDir(config.downloadDir);
  await page.waitForNetworkIdle({ timeout: config.timeouts.tableMs }).catch(() => undefined);

  const allLinksAndButtons = await page.$$('button, a');
  const downloadButtons: ElementHandle[] = [];
  for (const el of allLinksAndButtons) {
    const elText = await el.evaluate((node) => node.textContent?.trim()).catch(() => null);
    if (elText?.startsWith(config.downloadButtonText)) downloadButtons.push(el);
  }
  log.info(`[download] found ${downloadButtons.length} download button(s)`);

  const saved: string[] = [];

  for (const [index, button] of downloadButtons.entries()) {
    const box = await button.boundingBox();
    if (!box) continue;

    // occasionally a click doesn't register a download in time (page still
    // settling, etc) - one retry clears almost all of these cheaply
    let fileName: string | null = null;
    for (let attempt = 1; attempt <= 2 && !fileName; attempt++) {
      const before = snapshotDir(config.downloadDir);
      await humanClick(cursor, page, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
      fileName = await waitForNewStableFile(config.downloadDir, before, config.timeouts.downloadMs);
      if (!fileName && attempt === 1) {
        log.warn(`[download] (${index + 1}/${downloadButtons.length}) no file detected, retrying once`);
      }
    }

    if (fileName) {
      log.info(`[download] (${index + 1}/${downloadButtons.length}) saved ${fileName}`);
      saved.push(fileName);
    } else {
      log.warn(`[download] (${index + 1}/${downloadButtons.length}) no file detected after retry`);
    }
  }

  return saved;
}
