import fs from 'node:fs';
import path from 'node:path';
import type { Browser, Page, ElementHandle } from 'puppeteer';
import type { GhostCursor } from 'ghost-cursor';
import { config } from './config.js';
import { humanClick, idleWander, sleep } from './cursor.js';
import { log } from './log.js';
import { osClickElement } from './osClick.js';

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

// a locator re-queries the live DOM each call instead of handing back a
// handle that can go stale across a click/re-render - returns the element
// only while it's actually visible (boundingBox() null otherwise)
type Locator = () => Promise<ElementHandle | null>;

function locateBySelector(page: Page, selector: string): Locator {
  return async () => {
    const el = await page.$(selector).catch(() => null);
    if (!el) return null;
    const box = await el.boundingBox().catch(() => null);
    return box ? el : null;
  };
}

// polls instead of a blind fixed sleep - returns as soon as the element is
// actually gone rather than always paying the full settle time
async function waitUntilGone(locate: Locator, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!(await locate())) return true;
    await sleep(100);
  } while (Date.now() < deadline);
  return !(await locate());
}

// several of this site's overlays (cookie banner, and the disclaimer/"I
// Accept" modal at three separate points) re-render or re-appear rather than
// staying dismissed - clicking once and moving on isn't reliable, this
// clicks then confirms the element is actually gone before returning, and
// retries if not
async function dismissUntilGone(
  page: Page,
  cursor: GhostCursor,
  locate: Locator,
  label: string,
  maxAttempts = 4,
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const el = await locate();
    if (!el) return true;

    await clickCenter(page, cursor, el);
    if (await waitUntilGone(locate, 2000)) return true;
    log.warn(`[${label}] still present after click, retrying (attempt ${attempt}/${maxAttempts})`);
  }
  return !(await locate());
}

export async function acceptCookieBanner(page: Page, cursor: GhostCursor): Promise<void> {
  log.step('cookie banner');
  const locate = locateBySelector(page, '#onetrust-accept-btn-handler');
  const button = await locate();
  if (!button) {
    log.info('[cookies] no OneTrust banner found, continuing');
    return;
  }

  const cleared = await dismissUntilGone(page, cursor, locate, 'cookies');
  if (!cleared) {
    log.warn('[cookies] banner still present after retries, continuing anyway');
    return;
  }
  log.info('[cookies] accepted and confirmed gone');
}

// ---- generic overlay detection & dismissal ----
// this site reuses the same "I Accept" label at three separate gates
// (disclaimer, gated-post-captcha form, and a recheck before download) -
// matching by text across the whole page can't tell which one is actually
// showing, which is how the wrong-modal misclick happened. Scoping the
// button search to the frontmost overlay's own container fixes that: no
// matter which of the three points fires, or whether one re-renders, the
// same detect-container -> click-its-button -> confirm-gone loop handles it.

// heuristic for "the modal currently blocking the page": a visible,
// fixed/absolute-positioned element that either declares itself a dialog
// (role="dialog"/aria-modal="true", which wins outright) or is large enough
// to plausibly be a full-page overlay (>=15% of the viewport) - among
// non-dialog candidates the highest CSS z-index wins
async function findFrontmostOverlay(page: Page): Promise<ElementHandle | null> {
  const handle = await page.evaluateHandle(() => {
    const viewportArea = window.innerWidth * window.innerHeight;
    let best: Element | null = null;
    let bestScore = -Infinity;
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const style = getComputedStyle(el);
      if (style.position !== 'fixed' && style.position !== 'absolute') continue;
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
      const isDialog = el.getAttribute('role') === 'dialog' || el.getAttribute('aria-modal') === 'true';
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (!isDialog && rect.width * rect.height < viewportArea * 0.15) continue;
      const z = Number(style.zIndex) || 0;
      const score = isDialog ? 1_000_000 + z : z;
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    return best;
  });
  const el = handle.asElement();
  if (!el) {
    await handle.dispose();
    return null;
  }
  return el as ElementHandle;
}

// the overlay's primary action: a preferred-text match (checked in priority
// order) or, failing that, the lone visible interactive element - never
// guesses between multiple unlabeled candidates
async function findPrimaryButtonIn(container: ElementHandle, preferredTexts: string[]): Promise<ElementHandle | null> {
  const candidates = await container.$$('button, a, [role="button"]');
  const visible: { el: ElementHandle; text: string | null }[] = [];
  for (const el of candidates) {
    const box = await el.boundingBox().catch(() => null);
    if (!box) continue;
    const text = await el.evaluate((n) => n.textContent?.trim() || null).catch(() => null);
    visible.push({ el, text });
  }
  for (const wanted of preferredTexts) {
    const match = visible.find((c) => c.text === wanted);
    if (match) return match.el;
  }
  return visible.length === 1 ? visible[0].el : null;
}

async function anyOverlayVisible(page: Page): Promise<boolean> {
  const overlay = await findFrontmostOverlay(page);
  if (!overlay) return false;
  await overlay.dispose();
  return true;
}

// clicks the frontmost overlay's primary button, confirms it's actually
// gone, retries if it re-renders - returns false (not a throw) when there
// was nothing to dismiss, so callers can treat this as "already clear"
export async function dismissTopmostOverlay(
  page: Page,
  cursor: GhostCursor,
  preferredTexts: string[],
  label: string,
  maxAttempts = 4,
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const overlay = await findFrontmostOverlay(page);
    if (!overlay) return attempt > 1;

    const button = await findPrimaryButtonIn(overlay, preferredTexts);
    await overlay.dispose();
    if (!button) {
      log.warn(`[${label}] overlay detected but no actionable button found inside it`);
      return false;
    }

    await clickCenter(page, cursor, button);
    if (!(await waitForFalse(() => anyOverlayVisible(page), 2000))) {
      log.warn(`[${label}] overlay still present after click, retrying (attempt ${attempt}/${maxAttempts})`);
      continue;
    }
    return true;
  }
  return !(await anyOverlayVisible(page));
}

// same poll-until-false shape as waitUntilGone, generalized over a
// predicate instead of a single locator
async function waitForFalse(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!(await predicate())) return true;
    await sleep(100);
  } while (Date.now() < deadline);
  return !(await predicate());
}

export async function acceptDisclaimerModal(page: Page, cursor: GhostCursor): Promise<void> {
  log.step('disclaimer modal');
  const deadline = Date.now() + config.timeouts.challengeMs;
  while (!(await anyOverlayVisible(page)) && Date.now() < deadline) {
    log.progress(`waiting for disclaimer modal... (${Math.round((deadline - Date.now()) / 1000)}s left)`);
    await sleep(300);
  }
  log.endProgress();

  const cleared = await dismissTopmostOverlay(page, cursor, [config.acceptButtonText], 'disclaimer');
  if (!cleared) {
    log.warn('[disclaimer] no modal accept button appeared, continuing');
    return;
  }
  log.info('[disclaimer] accepted and confirmed gone');
}

// truncates rather than dropping the token entirely - length + prefix is
// enough to confirm a real solution came back without dumping a ~500-char
// single-use token (not a long-lived secret, but still no reason to log it
// in full) into the run log
function truncateToken(text: string | undefined): string {
  if (!text) return '(none)';
  return `${text.slice(0, 12)}... (${text.length} chars)`;
}

// solved via the 2captcha-backed plugin registered in browser.ts: it finds
// the sitekey, gets a solved token from the provider, and injects it -
// no click, no image challenge, works headless. every call out to that
// provider, and everything it hands back, gets logged - this is the one
// step in the pipeline that spends real API credits and can fail in ways
// (wrong sitekey, provider timeout, balance exhausted) invisible from the
// page alone
export async function passBotChallenge(page: Page, cursor: GhostCursor): Promise<void> {
  log.step('reCAPTCHA');
  await idleWander(cursor, page);

  log.info(`[challenge] requesting solve from provider ${config.recaptcha.provider.id} (can take 10-30s)...`);
  const startedAt = Date.now();

  // page.solveRecaptchas() has no timeout of its own - observed it hang
  // silently for 10+ minutes once with zero output, indistinguishable from a
  // dead process without this. A heartbeat during the wait plus a hard
  // ceiling turns a silent hang into a loud, timely failure.
  const heartbeat = setInterval(() => {
    log.progress(`[challenge] still waiting on provider ${config.recaptcha.provider.id}... (${Math.round((Date.now() - startedAt) / 1000)}s elapsed)`);
  }, 5000);

  let result: Awaited<ReturnType<Page['solveRecaptchas']>>;
  try {
    result = await Promise.race([
      page.solveRecaptchas(),
      sleep(config.timeouts.captchaSolveMs).then((): never => {
        throw new Error(
          `[challenge] provider ${config.recaptcha.provider.id} did not respond within ${config.timeouts.captchaSolveMs}ms - aborting rather than hanging indefinitely`,
        );
      }),
    ]);
  } finally {
    clearInterval(heartbeat);
    log.endProgress();
  }

  const { captchas, solutions, solved, error } = result;
  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);

  if (captchas.length === 0) {
    log.info(`[challenge] no reCAPTCHA found, continuing (${elapsedSec}s)`);
    return;
  }

  for (const c of captchas) {
    log.info(
      `[challenge] found ${c._vendor ?? 'unknown'} captcha` +
        `${c.isEnterprise ? ' (enterprise)' : ''}${c.isInvisible ? ' (invisible)' : ''} ` +
        `sitekey=${c.sitekey ?? '(none)'} id=${c.id ?? '(none)'}`,
    );
  }

  for (const s of solutions) {
    if (s.error) {
      log.warn(`[challenge] provider ${s.provider ?? config.recaptcha.provider.id} returned an error for id=${s.id ?? '(none)'}: ${s.error}`);
      continue;
    }
    log.info(
      `[challenge] provider ${s.provider ?? config.recaptcha.provider.id} id=${s.id ?? '(none)'} ` +
        `providerCaptchaId=${s.providerCaptchaId ?? '(none)'} hasSolution=${s.hasSolution ?? false} ` +
        `duration=${s.duration ?? '?'}ms token=${truncateToken(s.text)}`,
    );
  }

  for (const sv of solved) {
    if (sv.error) {
      log.warn(`[challenge] failed to enter solution for id=${sv.id ?? '(none)'}: ${sv.error}`);
      continue;
    }
    log.info(
      `[challenge] entered solution for id=${sv.id ?? '(none)'} isSolved=${sv.isSolved ?? false} ` +
        `responseElement=${sv.responseElement ?? false} responseCallback=${sv.responseCallback ?? false}`,
    );
  }

  if (error) {
    throw new Error(`[challenge] solver error after ${elapsedSec}s: ${error}`);
  }

  log.info(`[challenge] solved ${solutions.length} captcha(s) in ${elapsedSec}s`);
}

// unlike the disclaimer and the pre-download recheck, this gate is NOT a
// floating overlay - confirmed via debug/fresh-*.png screenshots, it's
// plain inline page content (the recaptcha checkbox + "I Accept" sit
// directly in the page flow, no dialog box, no backdrop). Overlay-scoping
// this one finds nothing and hangs for the full timeout every time. A
// page-wide exact-text search is safe here specifically because by this
// point the disclaimer overlay is already confirmed gone (see
// acceptDisclaimerModal) - there's no second "I Accept" left to collide with.
export async function acceptGatedForm(page: Page, cursor: GhostCursor): Promise<void> {
  log.step('gated accept button');
  const deadline = Date.now() + config.timeouts.challengeMs;

  const button = await findButtonByExactText(page, config.acceptButtonText, config.timeouts.challengeMs);
  if (!button) {
    log.warn('[accept] no gated accept button found, continuing');
    return;
  }

  while (Date.now() < deadline) {
    const disabled = await button.evaluate((el) => (el as HTMLButtonElement).disabled).catch(() => false);
    if (!disabled) break;
    log.progress(`waiting for gated "${config.acceptButtonText}" to enable... (${Math.round((deadline - Date.now()) / 1000)}s left)`);
    await sleep(500);
  }
  log.endProgress();

  await clickCenter(page, cursor, button);
  const stillThere = async () => (await findVisibleButtonNow(page, config.acceptButtonText)) !== null;
  if (!(await waitForFalse(stillThere, 2000))) {
    log.warn('[accept] gated accept button still present after click, retrying');
    await dismissUntilGone(page, cursor, () => findVisibleButtonNow(page, config.acceptButtonText), 'accept');
  }
  log.info('[accept] gated form accepted');
}

// re-render of the same disclaimer modal shows up again once the report
// table loads - a stale download click can land on this overlay instead of
// the button underneath, so re-check right before downloading rather than
// trusting the accepts earlier in the flow to have been the last word
export async function ensureDisclaimerCleared(page: Page, cursor: GhostCursor): Promise<void> {
  if (!(await anyOverlayVisible(page))) return;

  log.step('disclaimer recheck');
  log.warn('[disclaimer] an overlay reappeared before download, dismissing again');
  const cleared = await dismissTopmostOverlay(page, cursor, [config.acceptButtonText], 'disclaimer-recheck');
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

// ICE gates report generation behind a check that distinguishes a genuine
// hardware mouse click from a CDP-simulated one, even within the same
// automated session that solved the captcha fine - every other click in
// this flow uses the CDP/ghost-cursor path fine, only this one needs the
// real-input path (see osClick.ts)
export async function selectReportAndSubmit(page: Page, browser: Browser, cursor: GhostCursor): Promise<void> {
  const submitButton = await selectReportAndGetSubmitButton(page);
  await osClickElement(page, browser, submitButton);
  log.info('[select] submitted (real OS-level click)');
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

  // an empty table has more than one possible cause (no reports left today,
  // a prior run's downloads exhausted a quota, the page rendered differently
  // than expected) - log enough of the actual page state to tell which,
  // instead of guessing blind on the next run
  if (total === 0) {
    const tableRowCount = await page.$$eval('table tbody tr', (rows) => rows.length).catch(() => -1);
    const bodyText = await page
      .$eval('body', (el) => el.innerText.replace(/\s+/g, ' ').trim().slice(0, 500))
      .catch(() => '(could not read body text)');
    log.warn(`[download] on ${page.url()}, table has ${tableRowCount} row(s) with no matching button - page text: "${bodyText}"`);
  }

  const saved: string[] = [];

  for (let index = 0; index < total; index++) {
    // re-query by index every time instead of holding onto handles from the
    // initial scan - a click can trigger a table re-render (row order/count
    // unaffected, but the old DOM nodes go stale and boundingBox() on them
    // silently returns null further down the loop)
    //
    // a row can also disappear briefly right after a neighboring row's click
    // (table reflow/re-render mid-flight) and reappear moments later - poll
    // for it instead of judging it gone from a single snapshot
    let button = (await findDownloadButtons(page))[index];
    if (!button) {
      const deadline = Date.now() + 3000;
      while (!button && Date.now() < deadline) {
        await sleep(300);
        button = (await findDownloadButtons(page))[index];
      }
    }
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
        // 409 means "conflict", not "never coming" - observed after clicking
        // back-to-back rows, and clears on its own after a short pause. Any
        // other status is a real failure (bad request, not found, etc), bail
        // immediately rather than burning the retry on something that can't
        // change.
        if (response.status() === 409 && attempt === 1) {
          log.warn(`[download] (${index + 1}/${total}) got 409 (conflict), backing off and retrying`);
          await sleep(2000);
          continue;
        }
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
