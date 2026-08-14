import { EventEmitter } from 'node:events';

export type LogEvent = { type: 'step' | 'info' | 'warn' | 'progress'; message: string; time: string };

// server.ts subscribes to broadcast lines to connected frontends - CLI runs
// just never attach a listener, the emitter is inert overhead otherwise
export const logEvents = new EventEmitter();

function timestamp(): string {
  return new Date().toISOString().slice(11, 19);
}

function emit(type: LogEvent['type'], message: string): void {
  logEvents.emit('line', { type, message, time: timestamp() } satisfies LogEvent);
}

// marks a phase/page transition - always its own line, so a developer
// scanning the log can see exactly which step the run reached
function step(message: string): void {
  process.stdout.write(`\n[${timestamp()}] === ${message} ===\n`);
  emit('step', message);
}

function info(message: string): void {
  console.log(`[${timestamp()}] ${message}`);
  emit('info', message);
}

function warn(message: string): void {
  console.warn(`[${timestamp()}] WARN: ${message}`);
  emit('warn', message);
}

// for polling loops: overwrites the same terminal line (\r, no newline) so a
// 60s poll doesn't write 60+ lines into whatever's capturing this log
function progress(message: string): void {
  process.stdout.write(`\r[${timestamp()}] ${message}`.padEnd(120));
  emit('progress', message);
}

// call once after a progress() loop ends (success or timeout) to move off
// that line before the next step()/info() call
function endProgress(): void {
  process.stdout.write('\n');
}

export const log = { step, info, warn, progress, endProgress };
