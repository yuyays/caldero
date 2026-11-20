import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    // These tests spawn real processes and open SQLite files. The 5s default is fine
    // on a laptop and too tight on a loaded CI runner, where a single run has timed out.
    testTimeout: 30_000,
  },
});
