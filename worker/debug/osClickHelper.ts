import { execFileSync } from 'node:child_process';
import type { Page } from 'puppeteer';
import type { Browser as PuppeteerBrowser } from 'puppeteer';

// Windows blocks background processes from stealing foreground focus
// (SetForegroundWindow silently no-ops) unless the caller recently sent
// real input - CDP's Page.bringToFront() doesn't count. The classic
// workaround: nudge Alt right before the call, which Windows treats as
// "user just interacted" and relaxes the lock for that one call.
export function forceForegroundByPid(pid: number): boolean {
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
      Write-Output "$($fgPid -eq $targetPid)"
    } else {
      Write-Output "false"
    }
  `;
  const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf-8',
  });
  return result.trim() === 'True';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function catwalkTo(targetX: number, targetY: number): Promise<void> {
  const { mouse, straightTo, Point, screen } = await import('@nut-tree-fork/nut-js');
  const screenWidth = await screen.width();
  const screenHeight = await screen.height();
  const start = await mouse.getPosition();
  let x = start.x;
  let y = start.y;

  const steps = 1 + Math.floor(Math.random() * 2);
  for (let i = 0; i < steps; i++) {
    const bigStep = Math.random() < 0.2;
    const range = bigStep ? 260 : 90;
    x = clamp(x + (Math.random() - 0.5) * range * 2, 0, screenWidth);
    y = clamp(y + (Math.random() - 0.5) * range * 2, 0, screenHeight);
    await mouse.move(straightTo(new Point(x, y)));
    await sleep(80 + Math.random() * 180);
  }
  await mouse.move(straightTo(new Point(targetX, targetY)));
}

// clicks an element with a genuine OS-level input event instead of CDP's
// Input.dispatchMouseEvent - see debug/test-realclick.ts for why this
// matters: ICE's Submit action appears to require it
export async function osClickElement(
  page: Page,
  browser: PuppeteerBrowser,
  el: { boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null> },
): Promise<void> {
  const { mouse } = await import('@nut-tree-fork/nut-js');

  await page.bringToFront();
  const pid = browser.process()?.pid;
  if (pid) {
    const focused = forceForegroundByPid(pid);
    if (!focused) throw new Error('[osClick] could not bring browser window to OS foreground');
  }
  await sleep(300);

  const box = await el.boundingBox();
  if (!box) throw new Error('[osClick] target element has no bounding box');

  const windowMetrics = await page.evaluate(() => ({
    screenX: window.screenX,
    screenY: window.screenY,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
  }));

  const chromeInsetX = (windowMetrics.outerWidth - windowMetrics.innerWidth) / 2;
  const chromeInsetY = windowMetrics.outerHeight - windowMetrics.innerHeight;
  const targetX = windowMetrics.screenX + chromeInsetX + box.x + box.width / 2;
  const targetY = windowMetrics.screenY + chromeInsetY + box.y + box.height / 2;

  await catwalkTo(targetX, targetY);
  await sleep(200 + Math.random() * 200);
  await mouse.leftClick();
}
