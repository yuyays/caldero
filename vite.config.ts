import { recommended as effectRecommended } from "@effect/tsgo/oxlint-presets";
import { defineConfig } from "vite-plus";

// Local agent tooling is not project source.
const agentDirectories = [
  ".agent/**",
  ".agents/**",
  ".claude/**",
  ".codex/**",
  ".cursor/**",
  ".gemini/**",
  ".opencode/**",
];

const testFiles = ["**/*.test.*", "**/*.spec.*"];

export default defineConfig({
  lint: {
    options: {
      typeAware: true,
      reportUnusedDisableDirectives: "error",
    },
    categories: {
      correctness: "error",
      suspicious: "error",
      perf: "warn",
    },
    // `effecttsgo` needs the integrations patched by the root `prepare` script.
    plugins: ["react", "jsx-a11y", "typescript", "import", "vitest", "effecttsgo"],
    jsPlugins: [
      "./tools/oxlint/index.js",
      "./tools/oxlint/anti-slop/index.ts",
      "./tools/oxlint/anti-slop/effect/index.ts",
    ],
    rules: {
      ...effectRecommended.rules,
      "effecttsgo/catch-all-tag-dispatch-to-catch-tag": "error",
      "effecttsgo/catch-if-tag-to-catch-tag": "error",
      "effecttsgo/schema-struct-with-tag": "error",
      // Service methods stay functions so each call gets its own Effect.fn span.
      "effecttsgo/lazy-effect": "off",
      // Branding every Schema class adds ceremony without a real use case.
      "effecttsgo/schema-class-missing-brand": "off",
      "react/exhaustive-deps": "warn",
      "react/rules-of-hooks": "error",
      "react/react-in-jsx-scope": "off",
      "react/purity": "error",
      "react/refs": "error",
      "react/set-state-in-effect": "error",
      "react/static-components": "error",
      "react/no-unstable-nested-components": "error",
      // The rest of the React Compiler's Rules-of-React checks.
      "react/capitalized-calls": "error",
      "react/exhaustive-effect-dependencies": "error",
      "react/globals": "error",
      "react/hooks": "error",
      "react/immutability": "error",
      "react/memo-dependencies": "error",
      "react/no-array-index-key": "error",
      "react/preserve-manual-memoization": "error",
      "react/set-state-in-render": "error",
      "react/unsupported-syntax": "error",
      "typescript/consistent-type-imports": "error",
      "typescript/no-base-to-string": "warn",
      "typescript/no-floating-promises": "warn",
      "typescript/no-misused-spread": "warn",
      "typescript/no-unsafe-type-assertion": "error",
      "oxc/no-accumulating-spread": "error",
      "import/no-unassigned-import": "off",
      "vitest/no-conditional-expect": "off",
      "vitest/no-standalone-expect": [
        "error",
        { additionalTestBlockFunctions: ["it.effect", "it.live"] },
      ],
      "vitest/require-to-throw-message": "off",
      "no-await-in-loop": "off",
      "require-yield": "off",
      "anti-slop/no-chained-type-assertions": "error",
      "anti-slop/no-module-mocking": "error",
      "anti-slop/no-reduce-accumulator-copy": "error",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop-effect/no-manual-effect-error-tag": "error",
      "anti-slop-effect/no-manual-tagged-construction": "error",
      "caldero/schema-compile-scope": "error",
      "caldero/suppression-reason": "error",
    },
    overrides: [
      {
        files: ["apps/agent/src/**/*.ts", "apps/web/src/**", "packages/domain/src/**/*.ts"],
        rules: { "caldero/runtime-boundary": "error" },
      },
      {
        // Entry points, CLI runtimes and the web adapters that hand Effects to a framework.
        files: [
          // Pi Durable calls the session host's tasks as Promises.
          "apps/agent/src/session-host.ts",
          "apps/agent/src/SessionDO.ts",
          // Node entrypoints own the process's single Effect runtime.
          "apps/agent/src/local-cli.ts",
          "apps/agent/src/local-status-cli.ts",
          "apps/web/src/lib/inbox.ts",
          ...testFiles,
        ],
        rules: { "caldero/runtime-boundary": "off" },
      },
      {
        // Cloudflare and runtime-selection entry points compose scoped services.
        files: [
          "apps/agent/src/SessionDO.ts",
          "apps/agent/src/worker.ts",
          "apps/agent/src/agent-settings.ts",
        ],
        rules: { "effecttsgo/strict-effect-provide": "off" },
      },
      {
        // Application tests run Effects through @effect/vitest, which provides TestClock.
        files: ["apps/agent/src/**"],
        rules: { "caldero/test-runtime": "error" },
      },
      {
        // Tooling tests under tools/ and the generator measure real processes.
        files: ["apps/**", "packages/contracts/**", "packages/domain/**"],
        rules: {
          "caldero/no-wall-clock-in-tests": "error",
          "caldero/no-timer-waits-in-tests": "error",
        },
      },
      {
        // Domain workflows, contracts and inbound adapters parse input at their boundary
        // instead of passing it on.
        files: [
          "packages/contracts/src/**/*.ts",
          "packages/domain/src/**/*.ts",
          "apps/agent/src/inbox-http.ts",
          "apps/agent/src/github-app.ts",
        ],
        rules: {
          "anti-slop/no-unknown-parameters": "error",
          "anti-slop/no-unknown-returns": "error",
          "anti-slop/no-unsafe-dictionary-type": "error",
        },
      },
      {
        files: ["apps/**", "packages/**"],
        rules: { "caldero/workspace-imports": "error" },
      },
      {
        // The browser client module is the frontend's Effect entry point.
        files: ["apps/web/src/lib/api-client.ts", "apps/web/src/lib/inbox.ts"],
        rules: { "effecttsgo/strict-effect-provide": "off" },
      },
      {
        files: testFiles,
        rules: {
          // Tests assert encoded wire values, which carry literal tags.
          "anti-slop-effect/no-manual-tagged-construction": "off",
          // Test cases provide their own layers and run once.
          "effecttsgo/effect-fn-opportunity": "off",
          "effecttsgo/strict-effect-provide": "off",
          "caldero/schema-compile-scope": "off",
        },
      },
    ],
    ignorePatterns: [
      ...agentDirectories,
      "**/dist/**",
      "**/node_modules/**",
      "apps/web/src/routeTree.gen.ts",
      "tools/oxlint/anti-slop/**",
    ],
  },
  fmt: {
    ignorePatterns: [
      ...agentDirectories,
      "apps/web/src/routeTree.gen.ts",
      "tools/oxlint/anti-slop/**",
    ],
  },
});
