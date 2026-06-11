import { main } from "./config-cli.js";

// Entry point for `npm run config -- <args>`. Kept separate from config-cli.ts so
// that module (runConfigCli) can be imported in tests without executing.
main(process.argv.slice(2));
