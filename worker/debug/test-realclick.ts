import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer';

// Windows blocks background processes from stealing foreground focus
// (SetForegroundWindow silently no-ops) unless the caller recently sent
// real input - CDP's Page.bringToFront() doesn't count. The classic
// workaround: nudge Alt right before the call, which Windows treats as
// "user just interacted" and relaxes the lock for that one call.
function forceForegroundByPid(pid: number): void {
  const script = `
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type @"
      using System;
      using System.Runtime.InteropServices;
      public class Win32 {
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
      }
"@
    $targetPid = ${pid}
    $found = [IntPtr]::Zero
    $callback = {
      param($hWnd, $lParam)
      $procId = 0
      [void][Win32]::GetWindowThreadProcessId($hWnd, [ref]$procId)
      if ($procId -eq $targetPid -and [Win32]::IsWindowVisible($hWnd)) {
        $script:found = $hWnd
        return $false
      }
      return $true
    }
    [Win32]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
    if ($found -ne [IntPtr]::Zero) {
      [System.Windows.Forms.SendKeys]::SendWait('%')
      Start-Sleep -Milliseconds 100
      [Win32]::SetForegroundWindow($found) | Out-Null
      Start-Sleep -Milliseconds 200
      $fg = [Win32]::GetForegroundWindow()
      $fgPid = 0
      [void][Win32]::GetWindowThreadProcessId($fg, [ref]$fgPid)
      $ok = ($fgPid -eq $targetPid)
      Write-Output "focus succeeded=$ok"
    } else {
      Write-Output "no visible window found for pid $targetPid"
    }
  `;
  const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf-8',
  });
  console.log(`[calibrate] ${result.trim()}`);
}

// zero captcha, zero disclaimer, one always-enabled button - isolates the
// question "does an OS-level click even register on the right element" from
// every ICE-specific confounder (disabled state, layout ghosts, gating)
const TEST_PAGE =
  'data:text/html,' +
  encodeURIComponent(
    '<html><body style="margin:0">' +
      '<div style="height:400px;background:#eee"></div>' +
      '<button id="target" style="width:200px;height:60px;font-size:20px" onclick="document.title=\'CLICKED\'">Click me</button>' +
      '</body></html>',
  );

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// same catwalk shape as cursor.ts's idleWander: short meandering drifts from
// wherever the cursor already is, then a final approach to the real target -
// a real hand doesn't teleport straight to the click point either
async function catwalkTo(
  mouseMod: typeof import('@nut-tree-fork/nut-js').mouse,
  PointCtor: typeof import('@nut-tree-fork/nut-js').Point,
  straightToFn: typeof import('@nut-tree-fork/nut-js').straightTo,
  screenMod: typeof import('@nut-tree-fork/nut-js').screen,
  targetX: number,
  targetY: number,
): Promise<void> {
  const screenWidth = await screenMod.width();
  const screenHeight = await screenMod.height();
  const start = await mouseMod.getPosition();
  let x = start.x;
  let y = start.y;

  const steps = 1 + Math.floor(Math.random() * 2);
  for (let i = 0; i < steps; i++) {
    const bigStep = Math.random() < 0.2;
    const range = bigStep ? 260 : 90;
    x = clamp(x + (Math.random() - 0.5) * range * 2, 0, screenWidth);
    y = clamp(y + (Math.random() - 0.5) * range * 2, 0, screenHeight);
    await mouseMod.move(straightToFn(new PointCtor(x, y)));
    await sleep(80 + Math.random() * 180);
  }
  await mouseMod.move(straightToFn(new PointCtor(targetX, targetY)));
}

async function main(): Promise<void> {
  const { mouse, straightTo, Point, screen } = await import('@nut-tree-fork/nut-js');

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: ['--window-position=0,0', '--window-size=1000,800'],
  });
  try {
    const page = (await browser.pages())[0] ?? (await browser.newPage());
    await page.goto(TEST_PAGE);
    await new Promise((r) => setTimeout(r, 500));

    const target = await page.$('#target');
    if (!target) {
      const content = await page.content();
      console.log('[calibrate] #target not found, page content:', content.slice(0, 500));
      return;
    }

    const pid = browser.process()?.pid;
    if (pid) forceForegroundByPid(pid);
    await new Promise((r) => setTimeout(r, 300));

    const box = await target.boundingBox();
    if (!box) throw new Error('no bounding box for #target');

    const windowMetrics = await page.evaluate(() => ({
      screenX: window.screenX,
      screenY: window.screenY,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    }));
    console.log('[calibrate] window metrics', windowMetrics);
    console.log('[calibrate] button viewport box', box);

    const chromeInsetX = (windowMetrics.outerWidth - windowMetrics.innerWidth) / 2;
    const chromeInsetY = windowMetrics.outerHeight - windowMetrics.innerHeight;
    const targetX = windowMetrics.screenX + chromeInsetX + box.x + box.width / 2;
    const targetY = windowMetrics.screenY + chromeInsetY + box.y + box.height / 2;
    console.log(`[calibrate] computed OS screen target: (${targetX}, ${targetY})`);

    await catwalkTo(mouse, Point, straightTo, screen, targetX, targetY);
    await new Promise((r) => setTimeout(r, 300));
    await mouse.leftClick();
    await new Promise((r) => setTimeout(r, 500));

    const title = await page.title();
    if (title === 'CLICKED') {
      console.log('[calibrate] SUCCESS - real OS click registered on the button');
    } else {
      console.log(`[calibrate] FAILED - title is "${title}", click did not land`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
