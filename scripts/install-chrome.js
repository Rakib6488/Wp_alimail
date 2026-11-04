'use strict';

const { install, Browser, BrowserPlatform } = require('@puppeteer/browsers');
const { PUPPETEER_REVISIONS } = require('puppeteer-core/internal/revisions.js');

(async () => {
  process.on('unhandledRejection', error => {
    console.error('Unhandled Chrome install error:', error && error.stack || error);
    process.exit(1);
  });
  const cacheDir = process.env.PUPPETEER_CACHE_DIR;
  if (!cacheDir) throw new Error('PUPPETEER_CACHE_DIR is required');
  console.log('Installing Chrome', PUPPETEER_REVISIONS.chrome, 'into', cacheDir);
  const result = await install({
    browser: Browser.CHROME,
    buildId: PUPPETEER_REVISIONS.chrome,
    platform: BrowserPlatform.LINUX,
    cacheDir,
    downloadProgressCallback: (downloadedBytes, totalBytes) => {
      if (totalBytes) console.log(`Chrome download: ${downloadedBytes}/${totalBytes}`);
    },
  });
  console.log('Chrome installed:', result.executablePath);
})().catch(error => {
  console.error('Chrome install failed:', error && error.stack || error);
  process.exit(1);
});
