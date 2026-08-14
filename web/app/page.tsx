'use client';

import { useEffect, useRef, useState } from 'react';

const WORKER_URL = process.env.NEXT_PUBLIC_WORKER_URL ?? 'http://localhost:3001';
const WORKER_WS_URL = WORKER_URL.replace(/^http/, 'ws') + '/ws';

type RunStatus = 'idle' | 'running' | 'done' | 'error';
type ReleaseAsset = { name: string; url: string };
type LogLine = { time: string; type: 'step' | 'info' | 'warn' | 'progress'; message: string };

type ServerMessage =
  | ({ channel: 'log' } & LogLine)
  | { channel: 'frame'; data: string }
  | { channel: 'status'; status: RunStatus; assets: ReleaseAsset[]; error: string | null };

const STATUS_LABEL: Record<RunStatus, string> = {
  idle: 'Idle',
  running: 'Running',
  done: 'Done',
  error: 'Error',
};

export default function Home() {
  const [status, setStatus] = useState<RunStatus>('idle');
  const [assets, setAssets] = useState<ReleaseAsset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ws = new WebSocket(WORKER_WS_URL);

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data) as ServerMessage;
      if (message.channel === 'log') {
        if (message.type === 'progress') return; // too noisy for the UI log, terminal-only
        setLogs((prev) => [...prev.slice(-199), message]);
      } else if (message.channel === 'frame') {
        setFrame(message.data);
      } else if (message.channel === 'status') {
        setStatus(message.status);
        setAssets(message.assets);
        setError(message.error);
        if (message.status === 'running') setLogs([]);
      }
    };

    return () => ws.close();
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logs]);

  async function startRun(): Promise<void> {
    setFrame(null);
    await fetch(`${WORKER_URL}/runs`, { method: 'POST' }).catch(() => undefined);
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="wordmark">
          ICE <strong>Report Scraper</strong>
        </div>
        <div className="status-pill" data-status={status}>
          <span className="status-dot" />
          {STATUS_LABEL[status]}
        </div>
      </header>

      {status === 'error' && error && <div style={{ margin: '1rem 1.5rem 0' }} className="error-banner">Run failed: {error}</div>}

      <main className="main">
        <div className="column">
          <div className="scope">
            <span className="scope-corner tl" />
            <span className="scope-corner tr" />
            <span className="scope-corner bl" />
            <span className="scope-corner br" />
            {frame ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`data:image/jpeg;base64,${frame}`} alt="Live view of the automated browser session" />
            ) : (
              <p className="scope-empty">
                {status === 'running' ? 'Connecting to the browser feed…' : 'No live feed yet. Start a run to watch it work.'}
              </p>
            )}
          </div>

          <div className="controls">
            <button className="btn" onClick={startRun} disabled={status === 'running'}>
              {status === 'running' ? 'Running…' : 'Start scrape'}
            </button>
            <span className="hint">Downloads UBL-UK Power Baseload Future reports and uploads them to a GitHub release.</span>
          </div>
        </div>

        <div className="column">
          <div className="panel">
            <div className="panel-header">Log</div>
            <div className="log" ref={logRef}>
              {logs.length === 0 && <p className="scope-empty">Nothing yet.</p>}
              {logs.map((line, i) => (
                <div key={i} className="log-line" data-kind={line.type}>
                  <time>{line.time}</time>
                  {line.message}
                </div>
              ))}
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">Results</div>
            {assets.length === 0 ? (
              <p className="results-empty">{status === 'done' ? 'Run completed with no files.' : 'Files appear here once a run finishes.'}</p>
            ) : (
              <ul className="results-list">
                {assets.map((asset) => (
                  <li key={asset.name}>
                    <a href={asset.url} target="_blank" rel="noreferrer">
                      {asset.name}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
