# ICE-Breaker

Automated downloader for ICE Report Center reports (UBL-UK Power Baseload Future), with a web frontend to trigger runs and watch them live.

## Structure

- `worker/`: Puppeteer scraper (stealth + 2Captcha-solved reCAPTCHA + ghost-cursor human-like mouse movement) and a small Express/WebSocket server (`server.ts`) that exposes it over HTTP: start a run, stream live log lines and a JPEG screencast of the browser (including the visible mouse cursor), and upload results to a GitHub Release when done.
- `web/`: Next.js frontend, a Start button, a live view of the browser session, a log panel, and a results list linking to the uploaded files.
- `render.yaml`: deploy config for the worker (Render, free web service tier).

## Running locally

**Worker** (needs its own `.env`, copy from `worker/.env.example`):

```
cd worker
npm install
npm run dev          # one-off CLI scrape, saves to worker/downloads/
npm run server:dev   # runs the HTTP/WebSocket server instead, for use with web/
```

Required: `TWOCAPTCHA_API_KEY` (2captcha.com account). `GITHUB_TOKEN`/`GITHUB_OWNER`/`GITHUB_REPO` are only needed for `server:dev`'s upload-to-release step.

**Web** (needs its own `.env.local`, copy from `web/.env.example`):

```
cd web
npm install
npm run dev
```

Set `NEXT_PUBLIC_WORKER_URL` to wherever the worker is running (`http://localhost:3001` locally).

## Deploying

1. Push this repo to GitHub.
2. Deploy `worker/` to Render using `render.yaml`. Set `TWOCAPTCHA_API_KEY`, `GITHUB_TOKEN` (a PAT with `contents:write` on this repo, or wherever you want releases uploaded), `GITHUB_OWNER`, `GITHUB_REPO` as env vars there.
3. Deploy `web/` to Vercel. Set `NEXT_PUBLIC_WORKER_URL` to the Render worker's public URL.
