import { loadConfig } from "../src/config/config.js";
import { ProviderRegistry } from "../src/model/providers.js";
import { join } from "node:path";
const cfg = loadConfig(join(process.cwd(), "config.example.json"), (m) => console.log("[load]", m));
console.log("defaultModel:", cfg.defaultModel, "| providers:", cfg.providers.map(p => p.id).join(", "));
const reg = new ProviderRegistry(cfg.providers);
for (const id of ["zai/glm-4.6", "opencode/glm-5.1", "ollama/llama3.1", "claude-opus-4-8"]) {
  try { reg.resolve(id); console.log("resolve OK:", id); } catch (e) { console.log("resolve ERR:", id, String(e)); }
}
