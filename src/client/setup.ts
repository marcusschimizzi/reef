import { createInterface, type Interface } from "node:readline";
import { join } from "node:path";
import { reefHome } from "../core/paths.js";
import { openSecretStore } from "../secrets/store.js";
import { CATALOG, type CatalogEntry } from "../model/catalog.js";
import type { ModelOverride, ProviderKind } from "../model/providers.js";
import {
  applyConfigEdit,
  readRawConfig,
  writeRawConfig,
  type ConfigEdit,
} from "../config/config.js";

// `reef setup` — a guided first-run flow so a user never has to wrangle env
// vars. Pick a provider from the catalog (or custom), confirm the endpoint and a
// model, enter the API key with HIDDEN input, and reef stores the key in the
// secret store (OS keyring, or a 0600 file) and writes the provider to config.
// Env vars still work as a fallback for CI/headless.
//
// One readline interface drives the whole flow — creating a fresh interface per
// prompt drops piped/sequential input. A `muted` flag hides API-key entry.

const KINDS: ProviderKind[] = ["anthropic", "openai", "openai-compatible"];

/** A line prompt and a hidden (no-echo) prompt, over one shared readline. */
interface Prompter {
  ask(query: string, def?: string): Promise<string>;
  askHidden(query: string): Promise<string>;
}

function makePrompter(): { prompter: Prompter; close: () => void } {
  // terminal mode only on a real TTY — with piped/non-TTY stdin it mangles input
  // (and there's no local echo to hide anyway).
  const tty = Boolean(process.stdin.isTTY);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: tty });
  let muted = false;
  // Replace readline's writer so we can suppress echo during hidden entry; when
  // not muted this mirrors the default (write to stdout). Typed narrowly (no any).
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s) => {
    if (!muted) process.stdout.write(s);
  };
  // A line queue fed by a persistent listener — robust to piped input arriving
  // all at once (rl.question would drop the buffered lines between prompts).
  const queue: string[] = [];
  let waiter: ((line: string) => void) | null = null;
  rl.on("line", (line) => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(line);
    } else {
      queue.push(line);
    }
  });
  const nextLine = (): Promise<string> =>
    queue.length ? Promise.resolve(queue.shift() as string) : new Promise((r) => (waiter = r));
  return {
    close: () => rl.close(),
    prompter: {
      async ask(query, def) {
        process.stdout.write(def ? `${query} [${def}]: ` : `${query}: `);
        const a = (await nextLine()).trim();
        return a || def || "";
      },
      async askHidden(query) {
        process.stdout.write(`${query}: `);
        muted = true;
        const a = await nextLine();
        muted = false;
        process.stdout.write("\n");
        return a.trim();
      },
    },
  };
}

interface ProviderResult {
  id: string;
  kind: ProviderKind;
  baseURL?: string;
  auth?: "bearer" | "x-api-key";
  apiKeyEnv?: string;
  overrides?: ModelOverride[];
  model: string;
  key?: string;
}

async function main(): Promise<void> {
  const configPath = process.env.REEF_CONFIG_FILE || join(reefHome(), "config.json");
  const secrets = openSecretStore(reefHome(), (m) => console.log(m));
  const { prompter, close } = makePrompter();

  try {
    console.log("\nreef setup — add a model provider\n");
    CATALOG.forEach((e, i) => console.log(`  ${String(i + 1).padStart(2)}. ${e.label}`));
    console.log("   c. custom (enter the details by hand)\n");

    const pick = (await prompter.ask("Choose a provider (number or 'c')")).toLowerCase();
    const chosen = pick === "c" ? undefined : CATALOG[Number(pick) - 1];
    if (pick !== "c" && !chosen) {
      console.log("No such option — run `npm run setup` again.");
      return;
    }

    const provider = chosen ? await fromCatalog(prompter, chosen) : await fromScratch(prompter);
    if (!provider) return;

    if (provider.key) {
      secrets.set(provider.id, provider.key);
      console.log(`✓ key stored in the ${secrets.backend}`);
    }

    const raw = readRawConfig(configPath) ?? {};
    const edit: ConfigEdit = {
      op: "provider-set",
      provider: {
        id: provider.id,
        kind: provider.kind,
        baseURL: provider.baseURL,
        apiKeyEnv: provider.apiKeyEnv,
        auth: provider.auth,
        overrides: provider.overrides,
      },
    };
    let next: Record<string, unknown>;
    try {
      next = applyConfigEdit(raw, edit);
    } catch (err) {
      console.log(`✗ couldn't write provider config: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const modelId = `${provider.id}/${provider.model}`;
    if ((await prompter.ask(`Make ${modelId} the default model? (y/N)`)).toLowerCase().startsWith("y")) {
      next = applyConfigEdit(next, { op: "set", key: "defaultModel", value: modelId });
      console.log(`✓ default model set to ${modelId}`);
    }

    writeRawConfig(configPath, next);
    console.log(`\n✓ provider "${provider.id}" configured. Use it as ${modelId}.`);
    console.log("Restart the daemon (npm run daemon) to apply.\n");
  } finally {
    close();
  }
}

async function fromCatalog(p: Prompter, e: CatalogEntry): Promise<ProviderResult> {
  const baseURL = e.baseURL ? await p.ask("Base URL", e.baseURL) : undefined;
  const model = await p.ask("Model", e.sampleModels[0]);
  const key = e.needsKey ? await p.askHidden(`API key for ${e.label}`) : undefined;
  return {
    id: e.id,
    kind: e.kind,
    baseURL,
    auth: e.auth,
    apiKeyEnv: e.apiKeyEnv,
    overrides: e.overrides,
    model,
    key: key || undefined,
  };
}

async function fromScratch(p: Prompter): Promise<ProviderResult | undefined> {
  const id = await p.ask("Provider id (used as the model prefix, e.g. myllm)");
  if (!id) return undefined;
  const kind = (await p.ask(`Kind (${KINDS.join(" / ")})`, "openai-compatible")) as ProviderKind;
  if (!KINDS.includes(kind)) {
    console.log(`Unknown kind "${kind}".`);
    return undefined;
  }
  const baseURL =
    kind === "openai-compatible" || kind === "anthropic" ? await p.ask("Base URL") : undefined;
  const auth =
    kind === "anthropic"
      ? ((await p.ask("Auth (x-api-key / bearer)", "x-api-key")) as "bearer" | "x-api-key")
      : undefined;
  const model = await p.ask("Model");
  const key = await p.askHidden("API key (leave blank if none)");
  return { id, kind, baseURL: baseURL || undefined, auth, model, key: key || undefined };
}

void main();
