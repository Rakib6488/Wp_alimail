'use strict';

const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');
const { install, Browser, BrowserPlatform } = require('@puppeteer/browsers');

(async () => {
  process.on('unhandledRejection', error => {
    console.error('Unhandled Chrome install error:', error && error.stack || error);
    process.exit(1);
  });
  const cacheDir = process.env.PUPPETEER_CACHE_DIR || path.join(__dirname, '..', '.cache', 'puppeteer');
  const buildId = puppeteer.PUPPETEER_REVISIONS.chrome;
  console.log('Installing Puppeteer Chrome', buildId, 'for Puppeteer', require('puppeteer/package.json').version, 'into', cacheDir);
  const result = await install({
    browser: Browser.CHROME,
    buildId,
    platform: BrowserPlatform.LINUX,
    cacheDir,
    downloadProgressCallback: (downloadedBytes, totalBytes) => {
      if (totalBytes) console.log(`Chrome download: ${downloadedBytes}/${totalBytes}`);
    },
  });
  const executablePath = result.executablePath;
  if (!executablePath || !fs.existsSync(executablePath)) {
    throw new Error(`Chrome installer completed but executable is missing: ${executablePath || '(empty path)'}`);
  }
  console.log('Chrome installed:', executablePath);
})().catch(error => {
  console.error('Chrome install failed:', error && error.stack || error);
  process.exit(1);
});
