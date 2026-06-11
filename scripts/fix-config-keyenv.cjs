const fs = require("fs");
const path = require("os").homedir() + "/.reef/config.json";
const cfg = JSON.parse(fs.readFileSync(path, "utf8"));
const correct = { zai: "ZAI_API_KEY", "zai-coding": "ZAI_API_KEY", opencode: "OPENCODE_API_KEY", "opencode-anthropic": "OPENCODE_API_KEY" };
let fixed = 0;
for (const p of cfg.providers || []) {
  if (correct[p.id] && p.apiKeyEnv !== correct[p.id]) { p.apiKeyEnv = correct[p.id]; fixed++; }
}
fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
console.log(`reset apiKeyEnv on ${fixed} provider(s) to env var names (no secret printed)`);
