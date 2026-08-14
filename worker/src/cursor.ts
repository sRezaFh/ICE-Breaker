import { createCursor, type GhostCursor } from 'ghost-cursor';
import type { Page, ElementHandle } from 'puppeteer';

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

    // moveSpeed > 1 shortens ghost-cursor's per-move path/timing - default is
    // a random 0.5-1.0, this trades a little realism for wall-clock time
    await cursor.moveTo({ x, y }, { moveSpeed: 3 });
    await sleep(20 + Math.random() * 40);
  }
}

export async function humanClick(
  cursor: GhostCursor,
  page: Page,
  target: ElementHandle | { x: number; y: number },
): Promise<void> {
  // every click drifts a bit first, not just the captcha step - ghost-cursor
  // already curves each move, but a click right after a long idle wait with
  // zero prior motion is its own tell
  await idleWander(cursor, page, 1 + Math.floor(Math.random() * 2));
  await sleep(20 + Math.random() * 40);

  // ghost-cursor's click() only accepts an ElementHandle/selector (or nothing,
  // clicking at the current position) - raw coordinates need a moveTo first
  if ('x' in target && 'y' in target) {
    await cursor.moveTo(target, { moveSpeed: 3 });
    await cursor.click();
  } else {
    await cursor.click(target, { moveSpeed: 3 });
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
