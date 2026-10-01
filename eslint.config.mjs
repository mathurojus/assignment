import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",

    // Not application code.
    //
    // `.opencode/plugins/` is the agent capture hook required by the assignment.
    // It runs inside OpenCode's own runtime, not Next's, so it is outside this
    // project's dependency graph and its toolchain. Linting it under
    // `eslint-config-next` reports `no-explicit-any` on the plugin SDK's own
    // untyped boundaries, which is noise about a file that cannot be changed to
    // satisfy the rule.
    ".opencode/**",

    // Generated, not authored.
    "drizzle/**",
    "storage/**",
  ]),
]);

export default eslintConfig;