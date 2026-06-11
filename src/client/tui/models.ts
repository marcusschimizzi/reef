import { CATALOG, catalogEntry } from "../../model/catalog.js";
import type { SessionIndex } from "./sessionIndex.js";

// Builds the `/model` picker's option list, entirely client-side — no new daemon
// surface to enumerate models. The router knows provider *ids* but not which
// models each serves, so concrete model names are sourced from what reef already
// knows: the provider catalog (sampleModels + per-model `overrides`), the
// session's configured providers, models already in use, and the configured
// default — plus a free-text "Custom…" entry so an unlisted model is never
// blocked. (Live `/v1/models` querying per provider is a later upgrade.)

export interface ModelOption {
  /** The full `provider/model` id to select; "" marks the custom (free-text) entry. */
  id: string;
  label: string;
  custom?: boolean;
}

/** Built-in providers the router always knows (see model/providers.ts BUILTINS). */
const BUILTIN_PROVIDER_IDS = ["anthropic", "openai", "ollama", "openrouter"];

/** A bare model id resolves to Anthropic (parseModelId) — normalize so the bare
 *  default and its `anthropic/…` form don't show up as two separate rows. */
export function normalizeModelId(id: string): string {
  const t = id.trim();
  return t.includes("/") ? t : `anthropic/${t}`;
}

export function buildModelOptions(
  rawConfig: Record<string, unknown>,
  index: SessionIndex,
  current?: string,
): ModelOption[] {
  const ids = new Set<string>();
  const add = (id: unknown): void => {
    if (typeof id !== "string") return;
    if (id.trim()) ids.add(normalizeModelId(id));
  };
  // Every catalog-known model for a provider: its sample models + any per-model
  // protocol overrides (this is where minimax-m3, glm-4.6, kimi-k2.6, … come from).
  const addCatalogModels = (providerId: string): void => {
    const cat = catalogEntry(providerId);
    if (!cat) return;
    for (const m of cat.sampleModels) add(`${providerId}/${m}`);
    for (const ov of cat.overrides ?? []) for (const m of ov.models) add(`${providerId}/${m}`);
  };

  for (const id of BUILTIN_PROVIDER_IDS) addCatalogModels(id);

  const providers = Array.isArray(rawConfig.providers)
    ? (rawConfig.providers as Array<Record<string, unknown>>)
    : [];
  for (const p of providers) {
    const id = typeof p.id === "string" ? p.id : undefined;
    if (!id) continue;
    addCatalogModels(id);
    // honor any user-defined per-model overrides in the config too
    const ovs = Array.isArray(p.overrides) ? (p.overrides as Array<Record<string, unknown>>) : [];
    for (const ov of ovs) {
      const models = Array.isArray(ov.models) ? ov.models : [];
      for (const m of models) if (typeof m === "string") add(`${id}/${m}`);
    }
  }

  add(rawConfig.defaultModel); // the configured default
  for (const s of Object.values(index)) add(s.model); // models already in use
  add(current); // ensure the session's current model is always present

  const options: ModelOption[] = [...ids].sort().map((id) => ({ id, label: id }));
  options.push({ id: "", label: "Custom… (type a model id)", custom: true });
  return options;
}

// Re-exported so a test can assert the catalog is the source of the sample models.
export { CATALOG };
