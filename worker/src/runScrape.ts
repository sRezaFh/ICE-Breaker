import { config } from './config.js';
import { launchBrowser } from './browser.js';
import { log } from './log.js';
import { startScreencast, type FrameHandler } from './screencast.js';
import { passGate, selectContract, submitAndCountReports, downloadAllReports } from './flow.js';

export type RunResult = { saved: string[] };

// @spec worker/SPEC.md#runscrape
export async function runScrape(onFrame?: FrameHandler): Promise<RunResult> {
  const { browser, page } = await launchBrowser();
  const stopScreencast = onFrame ? await startScreencast(page, onFrame) : null;

  const runStartedAt = Date.now();
  try {
    await log.timed(`navigate to ${config.targetUrl}`, () =>
      page.goto(config.targetUrl, { waitUntil: 'domcontentloaded', timeout: config.timeouts.navigationMs }),
    );

    await log.timed('gate', () => passGate(page));
    await log.timed('select contract', () => selectContract(page));
    const total = await log.timed('submit', () => submitAndCountReports(page, browser));
    const saved = await log.timed('download reports', () => downloadAllReports(page, total));

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
