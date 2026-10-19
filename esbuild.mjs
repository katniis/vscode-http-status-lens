import esbuild from "esbuild";
import { rm } from "node:fs/promises";

await rm("dist/extension.js.map", { force: true });

await esbuild.build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  external: ["vscode"],
  outfile: "dist/extension.js"
});
