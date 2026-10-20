import { fileURLToPath } from "node:url";
import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  label: "smoke",
  files: "out/test/smoke/**/*.test.js",
  version: "1.142.0",
  useInstallation: process.env.HTTP_STATUS_TEST_VSCODE ? { fromPath: process.env.HTTP_STATUS_TEST_VSCODE } : undefined,
  extensionDevelopmentPath: fileURLToPath(new URL(".", import.meta.url)),
  workspaceFolder: fileURLToPath(new URL("./test/fixtures/workspace", import.meta.url)),
  mocha: { timeout: 30000 },
});
