import { createCursor, type GhostCursor } from 'ghost-cursor';
import type { Page, ElementHandle } from 'puppeteer';
import { log } from './log.js';

export function makeCursor(page: Page, visible: boolean): GhostCursor {
  // visible: true draws an actual on-page dot following the cursor
  // (ghost-cursor's installMouseHelper) - only meaningful in headed mode
  return createCursor(page, undefined, false, undefined, visible);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// catwalk: short meandering drifts from wherever the cursor already is,
// instead of teleporting to a far random point each time. Real hand motion
// wanders locally with the occasional bigger step, it doesn't jump corner to
// corner of the page before every click
export async function idleWander(cursor: GhostCursor, page: Page, steps = 3): Promise<void> {
  const viewport = page.viewport() ?? { width: 1280, height: 800 };
  let { x, y } = cursor.getLocation();

  for (let i = 0; i < steps; i++) {
    // mostly small drifts, occasionally a bigger meander
    const bigStep = Math.random() < 0.2;
    const range = bigStep ? 260 : 90;
    x = clamp(x + (Math.random() - 0.5) * range * 2, 0, viewport.width);
    y = clamp(y + (Math.random() - 0.5) * range * 2, 0, viewport.height);

    // ghost-cursor path steps scale with 25/moveSpeed, not moveSpeed itself -
    // default (unset) resolves to a random 0-1, i.e. an internal factor of
    // 25+ steps; 100 here drops that to ~6, well under default, so this is
    // actually faster rather than the inverted moveSpeed:3 that shipped
    // earlier (25/3 ≈ 8, above the default range - slower, not faster)
    await cursor.moveTo({ x, y }, { moveSpeed: 100 });
    await sleep(20 + Math.random() * 40);
  }
}

export async function humanClick(
  cursor: GhostCursor,
  page: Page,
  target: ElementHandle | { x: number; y: number },
): Promise<void> {
  const startedAt = Date.now();
  // a single short drift, not a multi-step meander - enough to avoid clicking
  // stone-cold from a long idle wait, without wandering all over the page
  // before every click
  await idleWander(cursor, page, 1);
  await sleep(20 + Math.random() * 40);

  // higher moveSpeed here (vs idleWander's 100) means fewer path steps for
  // the same distance, i.e. a straighter, quicker line to the actual target -
  // the meandering belongs to idleWander, not the approach itself
  const approachSpeed = 300;

  // ghost-cursor's click() only accepts an ElementHandle/selector (or nothing,
  // clicking at the current position) - raw coordinates need a moveTo first
  if ('x' in target && 'y' in target) {
    await cursor.moveTo(target, { moveSpeed: approachSpeed });
    await cursor.click();
  } else {
    await cursor.click(target, { moveSpeed: approachSpeed });
  }
  log.info(`[cursor] humanClick took ${Date.now() - startedAt}ms`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
