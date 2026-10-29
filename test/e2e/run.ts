// Runs one Drive script with an environment cleaned of the variables an enclosing OpenCode session
// or its front end sets. Drive spreads `process.env` into the isolated server, so a variable such as
// OPENCODE_CONFIG from an enclosing session would load that session's real configuration (plugins,
// tools, permissions) into the "isolated" instance.
import { join } from "node:path";

const [script] = Bun.argv.slice(2);
if (script === undefined) {
  console.error("usage: bun test/e2e/run.ts <drive-script.ts>");
  process.exit(2);
}

const kept = (name: string) =>
  name.startsWith("OPENCODE_DRIVE") || !/^(OPENCODE|OPENCHAMBER)/.test(name);
const env: Record<string, string> = {};
for (const [name, value] of Object.entries(process.env))
  if (value !== undefined && kept(name)) env[name] = value;
env.E2E_REPO_ROOT = process.cwd();

const drive = Bun.spawn(
  [
    join(process.cwd(), "node_modules", ".bin", "opencode-drive"),
    "run",
    script,
  ],
  {
    env,
    stdio: ["inherit", "inherit", "inherit"],
  },
);
process.exit(await drive.exited);
