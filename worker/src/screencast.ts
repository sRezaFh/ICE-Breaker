import type { Page } from 'puppeteer';

export type FrameHandler = (base64Jpeg: string) => void;

// CDP screencast captures whatever's actually rendered, including the
// ghost-cursor visible-mouse-helper overlay, works the same headless or not
export async function startScreencast(page: Page, onFrame: FrameHandler): Promise<() => Promise<void>> {
  const client = await page.createCDPSession();

  client.on('Page.screencastFrame', (frame) => {
    onFrame(frame.data);
    client.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined);
  });

  await client.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 60,
    maxWidth: 1280,
    maxHeight: 800,
    everyNthFrame: 1,
  });

  return async () => {
    await client.send('Page.stopScreencast').catch(() => undefined);
    await client.detach().catch(() => undefined);
  };
}
