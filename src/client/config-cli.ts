import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { applyConfigEdit, type ConfigEdit, type ScalarKey } from "../config/config.js";

// `reef config` — a small CLI over .reef/config.json. Reads/edits the raw file
// (preserving unknown keys) and validates every change through the config schema
// before writing, so the CLI can never leave the daemon with a config it would
// reject. Edits take effect on the next daemon start. Secrets never pass through
// here: a provider names the env var its key comes from (--api-key-env), never a
// literal key. Pure dispatch (runConfigCli) takes injected IO so it's testable.

export interface ConfigIo {
  /** The raw config object on disk, or undefined if the file doesn't exist. */
  read(): Record<string, unknown> | undefined;
  write(raw: Record<string, unknown>): void;
  out(line: string): void;
  /** Where edits land (shown in confirmations). */
  path: string;
}

const SCALAR_KEYS: ScalarKey[] = ["defaultModel", "policyFile"];

const USAGE = [
  "reef config — view and edit .reef/config.json",
  "",
  "  show                                 print the whole config",
  "  get <key>                            print one value (defaultModel | policyFile)",
  "  set <key> <value>                    set a scalar value",
  "  unset <key>                          remove a scalar value",
  "  provider list                        list configured providers",
  "  provider add <id> <kind> [opts]      add/replace a provider",
  "       kind: anthropic | openai | openai-compatible",
  "       --base-url <url>                API base URL (required for openai-compatible)",
  "       --api-key-env <VAR>             env var the API key is read from (never the key)",
  "  provider rm <id>                     remove a provider",
  "",
  "Edits apply on the next daemon restart.",
].join("\n");

/** Run one CLI invocation against injected IO. Returns a process exit code. */
export function runConfigCli(args: string[], io: ConfigIo): number {
  const [command, ...rest] = args;
  const raw = io.read() ?? {};

  try {
    switch (command) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        io.out(USAGE);
        return 0;

      case "show":
        io.out(JSON.stringify(raw, null, 2));
        return 0;

      case "get": {
        const key = rest[0];
        if (!key) return fail(io, "get needs a key");
        io.out(formatValue(raw[key]));
        return 0;
      }

      case "set": {
        const [key, value] = rest;
        if (!isScalarKey(key)) return fail(io, `set: unknown key "${key ?? ""}" (${SCALAR_KEYS.join(" | ")})`);
        if (value === undefined) return fail(io, "set needs a value");
        return commit(io, raw, { op: "set", key, value });
      }

      case "unset": {
        const key = rest[0];
        if (!isScalarKey(key)) return fail(io, `unset: unknown key "${key ?? ""}" (${SCALAR_KEYS.join(" | ")})`);
        return commit(io, raw, { op: "unset", key });
      }

      case "provider":
        return provider(rest, io, raw);

      default:
        return fail(io, `unknown command "${command}"\n\n${USAGE}`);
    }
  } catch (err) {
    return fail(io, `invalid edit — not written: ${describeError(err)}`);
  }
}

/** A readable one-line reason from a zod (or other) error. */
function describeError(err: unknown): string {
  const issues = (err as { issues?: Array<{ path: Array<string | number>; message: string }> })?.issues;
  if (Array.isArray(issues)) {
    return issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
  }
  return err instanceof Error ? err.message : String(err);
}

function provider(args: string[], io: ConfigIo, raw: Record<string, unknown>): number {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list": {
      const list = Array.isArray(raw.providers) ? (raw.providers as Array<Record<string, unknown>>) : [];
      io.out(list.length ? JSON.stringify(list, null, 2) : "(no custom providers; built-ins: anthropic, openai, ollama, openrouter)");
      return 0;
    }
    case "add": {
      const [id, kind] = rest;
      if (!id || !kind) return fail(io, "provider add needs <id> <kind>");
      const baseURL = flag(rest, "--base-url");
      const apiKeyEnv = flag(rest, "--api-key-env");
      return commit(io, raw, { op: "provider-set", provider: { id, kind, baseURL, apiKeyEnv } });
    }
    case "rm": {
      const id = rest[0];
      if (!id) return fail(io, "provider rm needs an <id>");
      return commit(io, raw, { op: "provider-rm", id });
    }
    default:
      return fail(io, `unknown provider command "${sub ?? ""}" (list | add | rm)`);
  }
}

function commit(io: ConfigIo, raw: Record<string, unknown>, edit: ConfigEdit): number {
  const next = applyConfigEdit(raw, edit); // validates; throws on invalid
  io.write(next);
  io.out(`wrote ${io.path} — restart the daemon to apply`);
  return 0;
}

function fail(io: ConfigIo, message: string): number {
  io.out(message);
  return 1;
}

function isScalarKey(key: string | undefined): key is ScalarKey {
  return key !== undefined && (SCALAR_KEYS as string[]).includes(key);
}

/** Read `--flag value` from an argv tail; undefined if absent. */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function formatValue(value: unknown): string {
  if (value === undefined) return "(unset)";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Entry point — wires runConfigCli to the real config file. */
export function main(argv: string[]): void {
  const path = process.env.REEF_CONFIG_FILE || join(resolve(".reef"), "config.json");
  const io: ConfigIo = {
    path,
    read: () => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : undefined),
    write: (raw) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
    },
    out: (line) => process.stdout.write(`${line}\n`),
  };
  process.exitCode = runConfigCli(argv, io);
}
