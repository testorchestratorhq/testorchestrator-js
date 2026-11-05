import { defineConfig } from '@playwright/test'

// The e2e project: Playwright's own json reporter and ours run on the same test run, so the server's
// playwright-json mapping and this reporter's to-results-json can be compared result by result.
export default defineConfig({
  testDir: './tests',
  retries: 1,
  reporter: [
    ['list'],
    ['json', { outputFile: 'playwright-report.json' }],
    [
      '@testorchestrator/playwright-reporter',
      {
        attachments: process.env.TO_ATTACHMENTS ?? 'names',
        runName: process.env.TO_RUN_NAME ?? 'e2e · Playwright reporter',
      },
    ],
  ],
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
  ],
})
