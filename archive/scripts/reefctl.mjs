#!/usr/bin/env node

// reefctl - minimal stdio MCP client for Reef, with convenience commands.
//
// Convenience usage:
//   reefctl info
//   reefctl status [job-1]
//   reefctl spawn <agent> <task...> [--cwd /path] [--mode headless|headful]
//   reefctl output <jobId> [--since ISO]
//   reefctl send <jobId> <message...>
//   reefctl kill <jobId>
//
// Low-level usage:
//   reefctl tool reef:spawn --args '{"agent":"opencode","task":"ping"}'

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const serverPath = fileURLToPath(new URL('../dist/index.js', import.meta.url));

function usage(code = 1) {
  console.error(`reefctl\n\nConvenience:\n  reefctl info\n  reefctl status [job-1]\n  reefctl spawn <agent> <task...> [--cwd <path>] [--mode headless|headful]\n  reefctl output <jobId> [--since <ISO>]\n  reefctl send <jobId> <message...>\n  reefctl kill <jobId>\n\nLow-level:\n  reefctl tool <reef:toolName> [--args '<json>'] [--cwd <path>]\n\nExamples:\n  reefctl spawn opencode ping --cwd /home/marcuss/Projects/lobstar-builds/reef\n  reefctl send job-1 "What did I say in my previous message?"\n`);
  process.exit(code);
}

function takeFlag(argv, name) {
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  const val = argv[idx + 1];
  argv.splice(idx, 2);
  return val;
}

function sendJson(stream, msg) {
  stream.write(`${JSON.stringify(msg)}\n`);
}

async function readNextJson(rl, timeoutMs = 5000) {
  return await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for response')), timeoutMs);
    const onLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const parsed = JSON.parse(trimmed);
        cleanup();
        resolve(parsed);
      } catch {
        // ignore non-JSON lines
      }
    };
    const cleanup = () => {
      clearTimeout(t);
      rl.off('line', onLine);
    };
    rl.on('line', onLine);
  });
}

async function callTool({ toolName, toolArgs, cwd }) {
  const proc = spawn(process.execPath, [serverPath], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d.toString()));

  const rl = createInterface({ input: proc.stdout });

  // MCP init
  sendJson(proc.stdin, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'reefctl', version: '0.0.0' }
    }
  });

  const initResp = await readNextJson(rl);
  if (initResp?.error) {
    throw new Error(`initialize error: ${JSON.stringify(initResp.error)}\n${stderr}`);
  }

  // required notification
  sendJson(proc.stdin, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

  // tool call
  sendJson(proc.stdin, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: toolName, arguments: toolArgs }
  });

  const resp = await readNextJson(rl, 20000);
  if (resp?.error) {
    throw new Error(`tool error: ${JSON.stringify(resp.error)}\n${stderr}`);
  }

  const structured = resp?.result?.structuredContent;

  proc.kill();
  rl.close();

  return structured ?? resp?.result ?? null;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv.shift();
  if (!cmd) usage(1);

  // Global flags for convenience commands
  const cwd = takeFlag(argv, '--cwd') ?? projectRoot;

  if (cmd === 'tool') {
    const toolName = argv.shift();
    if (!toolName) usage(1);
    const argsJson = takeFlag(argv, '--args') ?? '{}';
    let toolArgs;
    try {
      toolArgs = JSON.parse(argsJson);
    } catch (e) {
      console.error('Invalid --args JSON:', e?.message ?? e);
      process.exit(2);
    }
    const out = await callTool({ toolName, toolArgs, cwd });
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (cmd === 'info') {
    const out = await callTool({ toolName: 'reef:info', toolArgs: {}, cwd });
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (cmd === 'status') {
    const agentId = argv[0];
    const out = await callTool({
      toolName: 'reef:status',
      toolArgs: agentId ? { agentId } : {},
      cwd
    });
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (cmd === 'spawn') {
    const agent = argv.shift();
    if (!agent) usage(1);
    const mode = takeFlag(argv, '--mode') ?? 'headless';
    const task = argv.join(' ').trim();
    if (!task) usage(1);
    const out = await callTool({
      toolName: 'reef:spawn',
      toolArgs: { agent, task, cwd, mode },
      cwd
    });
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (cmd === 'output') {
    const agentId = argv.shift();
    if (!agentId) usage(1);
    const since = takeFlag(argv, '--since');
    const out = await callTool({
      toolName: 'reef:output',
      toolArgs: since ? { agentId, since } : { agentId },
      cwd
    });
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (cmd === 'send') {
    const agentId = argv.shift();
    if (!agentId) usage(1);
    const message = argv.join(' ').trim();
    if (!message) usage(1);
    const out = await callTool({
      toolName: 'reef:send',
      toolArgs: { agentId, message },
      cwd
    });
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (cmd === 'kill') {
    const agentId = argv.shift();
    if (!agentId) usage(1);
    const out = await callTool({
      toolName: 'reef:kill',
      toolArgs: { agentId },
      cwd
    });
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  usage(1);
}

main().catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(1);
});
