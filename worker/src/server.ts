import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { WebSocketServer, type WebSocket } from 'ws';
import { config } from './config.js';
import { log, logEvents, type LogEvent } from './log.js';
import { runScrape } from './runScrape.js';
import { uploadToGitHubRelease } from './github.js';

type ReleaseAsset = { name: string; url: string };
type RunStatus = 'idle' | 'running' | 'done' | 'error';

let status: RunStatus = 'idle';
let assets: ReleaseAsset[] = [];
let errorMessage: string | null = null;

const clients = new Set<WebSocket>();

function broadcast(message: unknown): void {
  const payload = JSON.stringify(message);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

logEvents.on('line', (event: LogEvent) => broadcast({ channel: 'log', ...event }));

async function startRun(): Promise<void> {
  status = 'running';
  assets = [];
  errorMessage = null;
  broadcast({ channel: 'status', status, assets, error: null });

  try {
    const { saved } = await runScrape((frame) => broadcast({ channel: 'frame', data: frame }));

    if (config.github.token) {
      assets = await uploadToGitHubRelease(config.downloadDir, saved);
    } else {
      log.warn('[github] GITHUB_TOKEN not set, skipping upload - files stayed local to the worker only');
    }

    status = 'done';
    broadcast({ channel: 'status', status, assets, error: null });
  } catch (err) {
    status = 'error';
    errorMessage = (err as Error).message;
    broadcast({ channel: 'status', status, assets, error: errorMessage });
  }
}

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/runs/current', (_req, res) => {
  res.json({ status, assets, error: errorMessage });
});

app.post('/runs', (_req, res) => {
  if (status === 'running') {
    res.status(409).json({ error: 'a run is already in progress' });
    return;
  }
  void startRun();
  res.status(202).json({ started: true });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ channel: 'status', status, assets, error: errorMessage }));
  ws.on('close', () => clients.delete(ws));
});

server.listen(config.port, () => {
  console.log(`worker listening on :${config.port}`);
});
