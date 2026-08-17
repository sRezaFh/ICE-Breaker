import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const recaptchaApiKey = process.env.TWOCAPTCHA_API_KEY;
if (!recaptchaApiKey) {
  throw new Error('TWOCAPTCHA_API_KEY is not set - copy .env.example to .env and fill it in');
}

export const config = {
  targetUrl: 'https://www.ice.com/report/10',
  downloadDir: path.resolve(__dirname, '..', 'downloads'),

  // helps within a single long-lived process (repeated CLI runs, or the
  // worker server between requests while its instance stays warm) - reset
  // whenever the host's disk is ephemeral (e.g. a Render instance redeploy)
  userDataDir: path.resolve(__dirname, '..', 'chrome-profile'),

  recaptcha: {
    provider: { id: '2captcha' as const, token: recaptchaApiKey },
  },

  // only needed by server.ts's upload-to-release step, not the plain CLI run
  github: {
    token: process.env.GITHUB_TOKEN,
    owner: process.env.GITHUB_OWNER,
    repo: process.env.GITHUB_REPO,
  },

  port: Number(process.env.PORT) || 3001,

  // single source of truth for the headless viewport, the wander-clamp
  // fallback in cursor.ts, and the screencast capture size - these were
  // three separately hardcoded copies (900/800/800) before this
  viewport: { width: 1280, height: 900 },

  // dropdown option text to select once the report form is visible
  dropdownOptionText: 'UBL-UK Power Baseload Future (Gregorian)',

  acceptButtonText: 'I Accept',
  submitButtonText: 'Submit',
  downloadButtonText: 'Download',

  // headed locally by default (handy to watch it work) - the deployed worker
  // sets HEADLESS=true since Render has no display; the visible mouse-helper
  // overlay still renders into the CDP screencast frames either way
  headless: process.env.HEADLESS === 'true',

  timeouts: {
    navigationMs: 30_000,
    challengeMs: 60_000,
    tableMs: 20_000,
    downloadMs: 30_000,
    // the 2captcha provider call itself has no built-in bound and can hang
    // silently well past its usual 10-30s (observed once at 10+ minutes with
    // zero progress output) - this caps it so a stuck provider fails loudly
    // instead of hanging the whole run
    captchaSolveMs: 120_000,
  },
} as const;
