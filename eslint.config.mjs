import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "out/**", "node_modules/**", "test/fixtures/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.mjs"],
    rules: {
      "no-undef": "off"
    }
  }
);
