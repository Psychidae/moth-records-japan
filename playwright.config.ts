import { defineConfig } from '@playwright/test';
export default defineConfig({
 testDir:'tests/e2e',outputDir:'test-results',workers:1,
 use:{baseURL:'http://127.0.0.1:4321',browserName:'chromium'},
 webServer:{command:'node scripts/serve-public-local.mjs',url:'http://127.0.0.1:4321',reuseExistingServer:false},
});
