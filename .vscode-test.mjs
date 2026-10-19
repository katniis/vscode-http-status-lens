import { fileURLToPath } from "node:url";
import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  label: "smoke",
  files: "out/test/smoke/**/*.test.js",
  version: "1.142.0",
  extensionDevelopmentPath: fileURLToPath(new URL(".", import.meta.url)),
  mocha: { timeout: 30000 },
});
