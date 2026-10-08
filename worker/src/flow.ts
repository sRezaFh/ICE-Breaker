// @spec worker/SPEC.md#logic
import fs from 'node:fs';
import path from 'node:path';
import type { Browser, CDPSession, ElementHandle, HTTPResponse, Page } from 'puppeteer';
import { config } from './config.js';
import { log } from './log.js';
import { osClickElement } from './osClick.js';

type GateState = { picker: boolean; click: string | null; captcha: boolean };

type DownloadOutcome = { fileName: string } | { status: number } | null;

const DOWNLOAD_URL = /\/marketdata\/api\/reports\/\d+\/download\//;

// @spec worker/SPEC.md#gate-state-script
const GATE_STATE_SCRIPT = `(() => {
  document.querySelectorAll('[data-ice-click]').forEach((el) => el.removeAttribute('data-ice-click'));

  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };

  const onTop = (el) => {
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const rect = el.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hit !== null && (hit === el || el.contains(hit));
  };

  const besideCaptcha = (el) => {
    let node = el.parentElement;
    for (let depth = 0; depth < 3 && node && node !== document.body; depth++, node = node.parentElement) {
      if (node.querySelector('iframe[src*="recaptcha"], .g-recaptcha')) return true;
    }
    return false;
  };

  const picker = Array.from(document.querySelectorAll('select')).some(visible);
  const solved = Array.from(document.querySelectorAll('textarea[name="g-recaptcha-response"]')).some(
    (field) => field.value.length > 0,
  );

  const cookies = document.querySelector('#onetrust-accept-btn-handler');
  if (cookies && visible(cookies)) {
    cookies.setAttribute('data-ice-click', 'cookie banner');
    return { picker, click: 'cookie banner', captcha: false };
  }

  const acceptText = ${JSON.stringify(config.acceptButtonText.toLowerCase())};
  let captcha = false;
  for (const el of document.querySelectorAll('button, a, [role="button"]')) {
    if ((el.textContent || '').trim().toLowerCase() !== acceptText || !visible(el)) continue;
    const gated = besideCaptcha(el);
    if (gated && !solved) {
      captcha = true;
      continue;
    }
    if (el.disabled || !onTop(el)) continue;
    const label = gated ? 'accept after captcha' : 'disclaimer accept';
    el.setAttribute('data-ice-click', label);
    return { picker, click: label, captcha: false };
  }
  return { picker, click: null, captcha };
})()`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function gateState(page: Page): Promise<GateState> {
  return (await page.evaluate(GATE_STATE_SCRIPT).catch(() => null)) as GateState | null ?? {
    picker: false,
    click: null,
    captcha: false,
  };
}

async function clickMarked(page: Page, label: string): Promise<void> {
  const el = await page.$('[data-ice-click]').catch(() => null);
  if (!el) return;
  try {
    await el.click();
  } catch (err) {
    log.warn(`[gate] could not click ${label}: ${(err as Error).message}`);
    return;
  }
  log.info(`[gate] clicked ${label}`);

  const deadline = Date.now() + config.timeouts.settleMs;
  while (Date.now() < deadline) {
    if (!(await el.boundingBox().catch(() => null))) return;
    await sleep(100);
  }
}

async function clearOverlays(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const state = await gateState(page);
    if (!state.click) return;
    await clickMarked(page, state.click);
  }
}

function truncateToken(text: string | undefined): string {
  if (!text) return '(none)';
  return `${text.slice(0, 12)}... (${text.length} chars)`;
}

// @spec worker/SPEC.md#captcha-solve
async function solveCaptcha(page: Page): Promise<void> {
  log.step('reCAPTCHA');
  const provider = config.recaptcha.provider.id;
  log.info(`[challenge] requesting solve from provider ${provider} (can take 10-30s)...`);
  const startedAt = Date.now();

  const heartbeat = setInterval(() => {
    log.progress(`[challenge] still waiting on provider ${provider}... (${Math.round((Date.now() - startedAt) / 1000)}s elapsed)`);
  }, 5000);

  let result: Awaited<ReturnType<Page['solveRecaptchas']>>;
  try {
    result = await Promise.race([
      page.solveRecaptchas(),
      sleep(config.timeouts.captchaSolveMs).then((): never => {
        throw new Error(
          `[challenge] provider ${provider} did not respond within ${config.timeouts.captchaSolveMs}ms - aborting rather than hanging indefinitely`,
        );
      }),
    ]);
  } finally {
    clearInterval(heartbeat);
    log.endProgress();
  }

  const { captchas, solutions, solved, error } = result;
  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);

  for (const c of captchas) {
    log.info(
      `[challenge] found ${c._vendor ?? 'unknown'} captcha` +
        `${c.isEnterprise ? ' (enterprise)' : ''}${c.isInvisible ? ' (invisible)' : ''} ` +
        `sitekey=${c.sitekey ?? '(none)'} id=${c.id ?? '(none)'}`,
    );
  }

  for (const s of solutions) {
    if (s.error) {
      log.warn(`[challenge] provider ${s.provider ?? provider} returned an error for id=${s.id ?? '(none)'}: ${s.error}`);
      continue;
    }
    log.info(
      `[challenge] provider ${s.provider ?? provider} id=${s.id ?? '(none)'} ` +
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
  if (captchas.length === 0) {
    throw new Error(`[challenge] gate is waiting on a captcha but the solver found none on the page (${elapsedSec}s)`);
  }

  log.info(`[challenge] solved ${solutions.length} captcha(s) in ${elapsedSec}s`);
}

// @spec worker/SPEC.md#gate-loop
export async function passGate(page: Page): Promise<void> {
  log.step('gate');
  const deadline = Date.now() + config.timeouts.gateMs;
  let solveRequested = false;

  while (Date.now() < deadline) {
    const state = await gateState(page);
    if (state.click) {
      await clickMarked(page, state.click);
      continue;
    }
    if (state.picker) {
      log.info('[gate] contract picker is showing');
      return;
    }
    if (state.captcha && !solveRequested) {
      solveRequested = true;
      await solveCaptcha(page);
      continue;
    }
    await sleep(config.pollMs);
  }
  throw new Error(`[gate] contract picker did not appear within ${config.timeouts.gateMs}ms`);
}

// @spec worker/SPEC.md#contract-selection
export async function selectContract(page: Page): Promise<void> {
  log.step('select contract');
  const picker = await page.waitForSelector('select', { visible: true, timeout: config.timeouts.tableMs }).catch(() => null);
  if (!picker) {
    throw new Error('[select] no <select> found on the report picker page');
  }

  const optionValue = await picker.evaluate((el, text) => {
    const select = el as HTMLSelectElement;
    const option = Array.from(select.options).find((o) => o.textContent?.trim() === text);
    return option?.value ?? null;
  }, config.dropdownOptionText);
  if (optionValue === null) {
    throw new Error(`[select] option "${config.dropdownOptionText}" not found - check config.dropdownOptionText`);
  }

  for (let attempt = 1; attempt <= 5; attempt++) {
    await picker.select(optionValue);
    await sleep(600);
    const currentValue = await picker.evaluate((el) => (el as HTMLSelectElement).value);
    if (currentValue === optionValue) {
      log.info(`[select] chose "${config.dropdownOptionText}"`);
      return;
    }
    log.info(`[select] contract reset to "${currentValue}" after selecting, re-selecting (attempt ${attempt})`);
  }
  throw new Error('[select] contract selection kept getting reset by the criteria refetch - giving up');
}

async function findEnabledButton(page: Page, text: string, timeoutMs: number): Promise<ElementHandle<Element> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const handle = await page.evaluateHandle((wanted) => {
      const match = Array.from(document.querySelectorAll('button, a')).find(
        (el) =>
          el.textContent?.trim() === wanted &&
          el.getBoundingClientRect().width > 0 &&
          !(el as HTMLButtonElement).disabled,
      );
      return match ?? null;
    }, text);
    const el = handle.asElement() as ElementHandle<Element> | null;
    if (el) return el;
    await handle.dispose();
    await sleep(config.pollMs);
  }
  return null;
}

// @spec worker/SPEC.md#download-buttons
async function findDownloadButtons(page: Page): Promise<ElementHandle[]> {
  const downloadButtons: ElementHandle[] = [];
  for (const frame of page.frames()) {
    const rows = await frame.$$('table tbody tr').catch(() => []);
    for (const row of rows) {
      const button = await row.$('button, a').catch(() => null);
      if (!button) continue;
      const elText = await button.evaluate((node) => node.textContent?.trim()).catch(() => null);
      if (elText?.startsWith(config.downloadButtonText)) downloadButtons.push(button);
    }
  }
  return downloadButtons;
}

async function waitForDownloadButtons(page: Page, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await clearOverlays(page);
    const total = (await findDownloadButtons(page)).length;
    if (total > 0) return total;
    await sleep(config.pollMs);
  }
  return 0;
}

// @spec worker/SPEC.md#submit-click
export async function submitAndCountReports(page: Page, browser: Browser): Promise<number> {
  log.step('submit');
  const submit = await findEnabledButton(page, config.submitButtonText, config.timeouts.tableMs);
  if (!submit) {
    throw new Error(`[submit] enabled "${config.submitButtonText}" button not found`);
  }

  await submit.click();
  log.info('[submit] clicked (direct click)');
  let total = await waitForDownloadButtons(page, config.timeouts.directSubmitMs);

  if (total === 0) {
    log.warn(`[submit] no report table ${config.timeouts.directSubmitMs}ms after a direct click, retrying with a real OS-level click`);
    const retry = (await findEnabledButton(page, config.submitButtonText, config.timeouts.tableMs)) ?? submit;
    await osClickElement(page, browser, retry);
    log.info('[submit] clicked (real OS-level click)');
    total = await waitForDownloadButtons(page, config.timeouts.tableMs);
  }

  log.info(`[submit] found ${total} download button(s)`);
  return total;
}

// @spec worker/SPEC.md#download-events
async function openDownloadChannel(page: Page): Promise<CDPSession> {
  const client = await page.browser().target().createCDPSession();
  await client.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: config.downloadDir,
    eventsEnabled: true,
  });
  return client;
}

// @spec worker/SPEC.md#download-events
function nextDownload(page: Page, client: CDPSession, timeoutMs: number): Promise<DownloadOutcome> {
  return new Promise((resolve) => {
    let guid: string | null = null;
    let fileName: string | null = null;

    const finish = (outcome: DownloadOutcome): void => {
      clearTimeout(timer);
      client.off('Browser.downloadWillBegin', onBegin);
      client.off('Browser.downloadProgress', onProgress);
      page.off('response', onResponse);
      resolve(outcome);
    };
    const onBegin = (event: { guid: string; suggestedFilename: string }): void => {
      if (guid) return;
      guid = event.guid;
      fileName = event.suggestedFilename;
    };
    const onProgress = (event: { guid: string; state: string }): void => {
      if (event.guid !== guid) return;
      if (event.state === 'completed' && fileName) finish({ fileName });
      if (event.state === 'canceled') finish(null);
    };
    const onResponse = (response: HTTPResponse): void => {
      if (DOWNLOAD_URL.test(response.url()) && !response.ok()) finish({ status: response.status() });
    };
    const timer = setTimeout(() => finish(null), timeoutMs);

    client.on('Browser.downloadWillBegin', onBegin);
    client.on('Browser.downloadProgress', onProgress);
    page.on('response', onResponse);
  });
}

function clearDownloadDir(dir: string): void {
  for (const f of fs.readdirSync(dir)) {
    fs.unlinkSync(path.join(dir, f));
  }
}

// @spec worker/SPEC.md#empty-table-dump
async function dumpPageState(page: Page, label: string): Promise<string[]> {
  const files: string[] = [];
  const frames = page.frames();
  for (let i = 0; i < frames.length; i++) {
    const html = await frames[i]
      .content()
      .catch((err) => `<!-- could not read frame content: ${(err as Error).message} -->`);
    const fileName = `debug-${label}-frame${i}.html`;
    fs.writeFileSync(path.join(config.downloadDir, fileName), html);
    files.push(fileName);
    log.warn(`[debug] frame ${i} url=${frames[i].url() || '(about:blank)'} -> ${fileName}`);
  }

  const screenshotName = `debug-${label}-screenshot.png`;
  await page
    .screenshot({ path: path.join(config.downloadDir, screenshotName) as `${string}.png`, fullPage: true })
    .catch((err) => log.warn(`[debug] screenshot failed: ${(err as Error).message}`));
  files.push(screenshotName);

  return files;
}

// @spec worker/SPEC.md#download-loop
export async function downloadAllReports(page: Page, total: number): Promise<string[]> {
  log.step('download reports');
  clearDownloadDir(config.downloadDir);

  if (total === 0) {
    log.warn('[download] no download buttons, dumping page state');
    return dumpPageState(page, 'empty');
  }

  const client = await openDownloadChannel(page);
  const saved: string[] = [];
  try {
    for (let index = 0; index < total; index++) {
      const position = `(${index + 1}/${total})`;
      let fileName: string | null = null;

      for (let attempt = 1; attempt <= 2 && !fileName; attempt++) {
        await clearOverlays(page);
        const button = (await findDownloadButtons(page))[index];
        if (!button) {
          log.warn(`[download] ${position} button is gone from the table`);
          await sleep(config.pollMs);
          continue;
        }

        const pending = nextDownload(page, client, config.timeouts.downloadMs);
        await button.click().catch((err) => log.warn(`[download] ${position} click failed: ${(err as Error).message}`));
        const outcome = await pending;

        if (outcome && 'fileName' in outcome) {
          fileName = outcome.fileName;
        } else if (outcome && outcome.status === 409 && attempt === 1) {
          log.warn(`[download] ${position} got 409 (conflict), backing off and retrying`);
          await sleep(2000);
        } else if (outcome) {
          log.warn(`[download] ${position} server returned ${outcome.status}, not waiting for a file`);
          break;
        } else {
          log.warn(`[download] ${position} no file arrived on attempt ${attempt}`);
        }
      }

      if (fileName) {
        log.info(`[download] ${position} saved ${fileName}`);
        saved.push(fileName);
      } else {
        log.warn(`[download] ${position} FAILED`);
      }
    }
  } finally {
    await client.detach().catch(() => undefined);
  }

  return saved;
}
