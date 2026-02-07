// @ts-check
import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for KDHT browser stability tests.
 * Tests run against imeyouwe.com recursive portal server.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // Run tests sequentially for network stability testing
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1, // Single worker for controlled testing
  reporter: [
    ['html', { open: 'never' }],
    ['list']
  ],
  
  // Longer timeouts for WebRTC connection tests
  timeout: 120000, // 2 minutes per test
  expect: {
    timeout: 30000
  },

  use: {
    // Base URL for the recursive portal server
    // Default to imeyouwe.com, can be overridden with KDHT_BASE_URL env var
    baseURL: process.env.KDHT_BASE_URL || 'https://imeyouwe.com',
    
    // Collect trace on failure for debugging
    trace: 'on-first-retry',
    
    // Video recording for debugging connection issues
    video: 'on-first-retry',
    
    // Screenshot on failure
    screenshot: 'only-on-failure',
    
    // Browser context options
    contextOptions: {
      // Permissions for WebRTC
      permissions: ['microphone', 'camera'],
    },
  },

  projects: [
    {
      name: 'chromium',
      use: { 
        ...devices['Desktop Chrome'],
        // Chrome-specific flags for WebRTC
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            // Increase connection limits
            '--max-active-webgl-contexts=100',
          ]
        }
      },
    },
    // Firefox has different WebRTC behavior
    {
      name: 'firefox',
      use: { 
        ...devices['Desktop Firefox'],
        launchOptions: {
          firefoxUserPrefs: {
            'media.navigator.permission.disabled': true,
            'media.navigator.streams.fake': true,
          }
        }
      },
    },
  ],
});
