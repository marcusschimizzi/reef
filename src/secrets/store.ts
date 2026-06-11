import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Entry } from "@napi-rs/keyring";

// Where reef keeps API keys — out of config files and env-var wrangling. Primary
// backend is the OS keyring (macOS Keychain / Windows Credential Manager /
// libsecret); when that's unavailable (headless/SSH/Linux without a secret
// service) it falls back to a 0600 JSON file in ~/.reef. Keyed by provider id.
// Sync throughout (the keyring bindings are synchronous), so the model router
// can resolve a key inline.

const SERVICE = "reef";

export interface SecretStore {
  /** Human label for the active backend ("keychain" | "file"). */
  readonly backend: string;
  get(id: string): string | undefined;
  set(id: string, secret: string): void;
  delete(id: string): void;
}

/** OS keyring backend (one keychain entry per provider id, service "reef"). */
class KeyringStore implements SecretStore {
  readonly backend = "keychain";
  get(id: string): string | undefined {
    return new Entry(SERVICE, id).getPassword() ?? undefined;
  }
  set(id: string, secret: string): void {
    new Entry(SERVICE, id).setPassword(secret);
  }
  delete(id: string): void {
    try {
      new Entry(SERVICE, id).deletePassword();
    } catch {
      // already absent — fine
    }
  }
}

/** 0600 JSON file fallback. Readable only by the user; not encrypted. */
export class FileStore implements SecretStore {
  readonly backend = "file";
  constructor(private readonly path: string) {}

  private read(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  }
  private write(obj: Record<string, string>): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.path, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
    chmodSync(this.path, 0o600); // enforce even if the file pre-existed
  }
  get(id: string): string | undefined {
    return this.read()[id];
  }
  set(id: string, secret: string): void {
    const obj = this.read();
    obj[id] = secret;
    this.write(obj);
  }
  delete(id: string): void {
    const obj = this.read();
    delete obj[id];
    this.write(obj);
  }
}

/**
 * Open the best available secret store: the OS keyring if a probe succeeds, else
 * the 0600 file in `home`. The probe (a no-op get) throws when no keyring backend
 * exists, which is the signal to fall back.
 */
export function openSecretStore(home: string, log: (m: string) => void = () => {}): SecretStore {
  try {
    new Entry(SERVICE, "__reef_probe__").getPassword(); // throws if no keyring backend
    return new KeyringStore();
  } catch {
    log(`OS keyring unavailable — storing secrets in ${join(home, "secrets.json")} (0600)`);
    return new FileStore(join(home, "secrets.json"));
  }
}
