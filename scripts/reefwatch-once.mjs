#!/usr/bin/env node

// reefwatch-once.mjs
//
// Poll Reef for attention-worthy events (completed / needs_input) and DM Marcus.
// Designed to run from host cron with near-zero tokens (no LLM calls).
//
// Requires:
// - node
// - clawdbot CLI on PATH
// - reef built (dist/) and scripts/reefctl.mjs present
//
// State file: ~/.reef/reefwatch-state.json

import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';

const SLACK_TARGET = process.env.REEFWATCH_SLACK_TARGET ?? 'D0AB6F788KH';
const SLACK_CHANNEL = process.env.REEFWATCH_CHANNEL ?? 'slack';
const REEFCTL = process.env.REEFWATCH_REEFCTL ?? path.resolve('scripts/reefctl.mjs');
const REEF_CWD = process.env.REEFWATCH_REEF_CWD ?? process.cwd();

const STATE_DIR = path.join(os.homedir(), '.reef');
const STATE_PATH = path.join(STATE_DIR, 'reefwatch-state.json');

function sh(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (res.error) throw res.error;
  return res;
}

function reefctl(args) {
  const res = sh(process.execPath, [REEFCTL, ...args], { cwd: REEF_CWD });
  if (res.status !== 0) {
    throw new Error(`reefctl failed (${res.status}): ${res.stderr || res.stdout}`);
  }
  const out = (res.stdout || '').trim();
  if (!out) return null;
  return JSON.parse(out);
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { cursors: {} };
  }
}

async function saveState(state) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  const tmp = `${STATE_PATH}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, STATE_PATH);
}

function isAttentionStatus(status) {
  return status === 'awaiting_input' || status === 'completed' || status === 'error';
}

function summarizeEvent(e) {
  if (!e) return '';
  if (e.type === 'needs_input') {
    const q = e.payload?.question ?? '(question missing)';
    const opts = Array.isArray(e.payload?.options) ? `\nOptions: ${e.payload.options.join(', ')}` : '';
    return `needs_input: ${q}${opts}`;
  }
  if (e.type === 'error') {
    return `error: ${e.payload?.message ?? e.payload?.error ?? ''}`.trim();
  }
  if (e.type === 'completed') {
    return `completed: exitCode=${e.payload?.exitCode ?? 'unknown'}`;
  }
  if (e.type === 'text') {
    // OpenCode event: payload.part.text
    const t = e.payload?.part?.text;
    if (typeof t === 'string' && t.length) return `text: ${t.slice(0, 180)}`;
  }
  return `${e.type}`;
}

function sendSlack(message) {
  const res = sh('clawdbot', ['message', 'send', '--channel', SLACK_CHANNEL, '--target', SLACK_TARGET, '--message', message]);
  if (res.status !== 0) {
    throw new Error(`clawdbot message send failed (${res.status}): ${res.stderr || res.stdout}`);
  }
}

async function main() {
  const state = await loadState();
  state.cursors ??= {};

  const status = reefctl(['status', '--cwd', REEF_CWD]);
  const agents = status?.agents ?? [];

  const notifications = [];

  for (const job of agents) {
    const jobId = job.id;
    const agent = job.agent;
    const jobStatus = job.status;

    if (!jobId || !isAttentionStatus(jobStatus)) continue;

    const cursorKey = `${jobId}`;
    const since = state.cursors[cursorKey];

    // Pull new events since last cursor.
    const outArgs = ['output', jobId, '--cwd', REEF_CWD];
    if (since) outArgs.push('--since', since);
    const output = reefctl(outArgs);
    const events = output?.events ?? [];

    // Determine newest timestamp we've seen.
    const newestTs = events.reduce((acc, e) => {
      const ts = e?.timestamp;
      return typeof ts === 'string' && ts > acc ? ts : acc;
    }, since ?? '');

    // Bootstrap behavior: if we have never tracked this job before, set cursor and do not notify.
    if (!since) {
      if (newestTs) state.cursors[cursorKey] = newestTs;
      continue;
    }

    const attentionEvents = events.filter((e) => e?.type === 'needs_input' || e?.type === 'completed' || e?.type === 'error');
    if (attentionEvents.length > 0) {
      const last = attentionEvents[attentionEvents.length - 1];
      notifications.push({
        jobId,
        agent,
        status: jobStatus,
        summary: summarizeEvent(last)
      });
    }

    if (newestTs && newestTs !== since) state.cursors[cursorKey] = newestTs;
  }

  if (notifications.length > 0) {
    const lines = notifications.map((n) => `• ${n.jobId} (${n.agent}) status=${n.status} — ${n.summary}`);
    const msg = `Reef update:\n${lines.join('\n')}\n\n(Use reefctl output <jobId> to inspect full events.)`;
    sendSlack(msg);
  }

  await saveState(state);
}

main().catch((err) => {
  // Don't throw noisy errors into cron mail; just print.
  console.error(err?.stack ?? String(err));
  process.exit(1);
});
