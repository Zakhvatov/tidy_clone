import { defineConfig } from "vitest/config";

/**
 * Локальная конфигурация тестов воркера: изолирует `workers/api` от корневого
 * `vite.config.ts` PWA (React, jsdom, vitest.setup.ts) — здесь обычная Node-среда
 * и только unit-тесты воркера.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
