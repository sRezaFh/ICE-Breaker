---
title: Worker scrape flow
type: spec
module: worker
updated: 2026-10-08
status: active
---

## Purpose

The worker downloads every report PDF for one contract from the ICE Report Center, unattended.
It owns the browser session, the page flow, the captcha provider call and the download capture.
It does not own what happens to the files afterwards: `server.ts` uploads them through
`github.ts`, and the web frontend only displays the run.

Read [ICE-Breaker](../README.md) first for how to run and deploy it.

## Methods

### runScrape

- In: an optional frame handler, passed only by the server, that receives screencast frames.
- Out: `{ saved }`, the file names written to `config.downloadDir` in table order.
- Errors: rethrows any step failure after logging which step and how far into the run.
- Notes: navigation waits for `domcontentloaded` only. The gate loop reacts to the page as it
  fills in, so waiting for the network to go idle buys nothing and cost about 28 seconds.

### passGate

- In: the page, already navigated to `config.targetUrl`.
- Out: resolves once a visible `<select>` is on the page.
- Errors: throws when the picker has not appeared within `timeouts.gateMs`, or when the captcha
  provider fails.

### selectContract

- In: the page with the picker showing.
- Out: resolves once `config.dropdownOptionText` is selected and has stayed selected.
- Errors: throws when the option is missing or the page resets the selection five times.

### submitAndCountReports

- In: the page and the browser (the browser is needed only for the OS click fallback).
- Out: the number of download buttons found, `0` when the table never appeared.
- Errors: throws when no enabled Submit button exists.

### downloadAllReports

- In: the page and the count from `submitAndCountReports`.
- Out: saved file names, or the debug dump file names when the count is `0`.
- Errors: none thrown per file. A failed row is logged and skipped.

## Logic

### Gate loop

The site puts up to four things between the landing page and the picker: a cookie banner, a
disclaimer modal, an inline captcha, and an inline "I Accept" that works only after the captcha.
Any of them can be absent (a warm browser profile skips the modal) and the modal can come back.

`passGate` therefore does not run fixed steps. It polls one page side state check every
`config.pollMs` and does whatever that check says: click the marked element, solve the captcha
(once), or return because the picker is visible. Nothing waits for an element that may never
come. The previous fixed sequence spent a full 60 seconds waiting for a modal that was not there.

After a click it waits, up to `timeouts.settleMs`, for the clicked element to lose its box before
polling again, so a fading modal is not clicked twice.

### Gate state script

`GATE_STATE_SCRIPT` runs in the page and returns `{ picker, click, captcha }`. It is a string, not
a function, because the TypeScript runner wraps named inner functions in a helper that does not
exist in the page.

- An accept button is "gated" when the captcha widget sits within three ancestors of it. A gated
  button is offered for clicking only once the captcha response field holds a token. Until then
  the script reports `captcha: true`.
- Any other accept button is the disclaimer. It is offered only when it is the topmost element at
  its own centre, which is what tells the modal's button from the inline one underneath it.
- The element to click is tagged with the `data-ice-click` attribute, and the caller clicks that.
  The tag is cleared at the start of every check.

### Captcha solve

The provider plugin registered in `browser.ts` finds the site key, fetches a token and injects it.
The call has no timeout of its own, so it is raced against `timeouts.captchaSolveMs` with a
heartbeat line every five seconds. Every captcha found, every provider answer and every injection
result is logged, because this is the one step that spends API credit and fails invisibly.

### Contract selection

The page refetches its criteria after mount and resets the picker when the old value is not in the
new set. One `select()` races that reset and can submit an empty contract with no error. The
selection is re-asserted until it survives a 600 ms settle.

### Submit click

Submit is clicked directly first. Earlier testing found the site ignoring a synthetic click here,
which is why `osClick.ts` exists. A direct click has since been seen to work, so it is tried
first and costs nothing when it does. If no download button appears within
`timeouts.directSubmitMs`, the click is repeated as a real OS level click. The log line says which
path produced the table, and that line is the evidence for removing the fallback and the virtual
display from the image.

### Download buttons

The results table is rendered inside an iframe, so every frame is scanned. Buttons are found by
walking table rows, which gives a stable top to bottom order. They are looked up again by index
before every click, because a click can re-render the table and stale handles lose their box.

### Download events

Downloads are captured from the browser's own events rather than by watching the folder.
`Browser.setDownloadBehavior` with `eventsEnabled` makes the browser report
`downloadWillBegin` (file name) and `downloadProgress` (completed or canceled). `nextDownload` is
armed before the click and resolves with the file name, with an HTTP status when the download
request itself failed, or with `null` on cancel or timeout.

### Download loop

The folder is emptied first: the browser renames a repeat download to `name (1).pdf`, which would
break the file names the server uploads. A `409` means two clicks landed too close together, so it
backs off two seconds and retries once. Any other failure status ends that row at once.

### Empty table dump

When no download button ever appears, every frame's HTML and a full page screenshot are written to
the download folder. They ride the normal upload path, which is the only way to see what the
browser saw inside the deployed container.

## Data flow

- CLI: `index.ts` -> `runScrape` -> `flow.ts` -> `downloads/`
- Server: `POST /runs` -> `runScrape` -> `downloads/` -> `github.ts` -> release assets -> web
- Live view: page -> `screencast.ts` -> WebSocket `frame` channel -> web
- Log: `log.ts` -> stdout and WebSocket `log` channel -> web

## Dependencies

- `config.ts`: target URL, button texts, timeouts, paths.
- `browser.ts`: launches the browser with the stealth and captcha provider plugins.
- `osClick.ts`: the OS level click used only as the Submit fallback.
- `log.ts`: step, info, warn and progress lines, also broadcast by the server.
- `puppeteer`, `puppeteer-extra`, `puppeteer-extra-plugin-stealth`,
  `puppeteer-extra-plugin-recaptcha`, `@nut-tree-fork/nut-js`.

## Related

- [ICE-Breaker](../README.md): how to run and deploy the worker and the web frontend.
