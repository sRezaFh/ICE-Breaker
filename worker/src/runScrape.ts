import { config } from './config.js';
import { launchBrowser } from './browser.js';
import { makeCursor } from './cursor.js';
import { log } from './log.js';
import { startScreencast, type FrameHandler } from './screencast.js';
import {
  acceptCookieBanner,
  acceptDisclaimerModal,
  passBotChallenge,
  acceptGatedForm,
  selectReportAndSubmit,
  ensureDisclaimerCleared,
  downloadAllReports,
} from './flow.js';

export type RunResult = { saved: string[] };

// shared by the CLI entrypoint (index.ts) and the worker server - onFrame is
// only passed by the server, so a plain CLI run never pays for the screencast
export async function runScrape(onFrame?: FrameHandler): Promise<RunResult> {
  const { browser, page } = await launchBrowser();
  const cursor = makeCursor(page, !config.headless || onFrame !== undefined);

  const stopScreencast = onFrame ? await startScreencast(page, onFrame) : null;

  const runStartedAt = Date.now();
  try {
    await log.timed(`navigate to ${config.targetUrl}`, () =>
      page.goto(config.targetUrl, { waitUntil: 'networkidle2', timeout: config.timeouts.navigationMs }),
    );

    await log.timed('cookie banner', () => acceptCookieBanner(page, cursor));
    await log.timed('disclaimer modal', () => acceptDisclaimerModal(page, cursor));
    await log.timed('reCAPTCHA', () => passBotChallenge(page, cursor));
    await log.timed('gated accept', () => acceptGatedForm(page, cursor));
    await log.timed('select + submit', () => selectReportAndSubmit(page, browser, cursor));
    await log.timed('disclaimer recheck', () => ensureDisclaimerCleared(page, cursor));
    const saved = await log.timed('download reports', () => downloadAllReports(page, cursor));

    log.step(`done - ${saved.length} file(s) saved to ${config.downloadDir} (${Date.now() - runStartedAt}ms total)`);
    return { saved };
  } catch (err) {
    log.step(`FAILED at the point above - ${(err as Error).message} (${Date.now() - runStartedAt}ms in)`);
    throw err;
  } finally {
    if (stopScreencast) await stopScreencast();
    await browser.close();
  }
}
