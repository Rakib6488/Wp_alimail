'use strict';

const { install, Browser, BrowserPlatform } = require('@puppeteer/browsers');
const { PUPPETEER_REVISIONS } = require('puppeteer-core/internal/revisions.js');

const cacheDir = process.env.PUPPETEER_CACHE_DIR;
if (!cacheDir) throw new Error('PUPPETEER_CACHE_DIR is required');

install({
  browser: Browser.CHROME,
  buildId: PUPPETEER_REVISIONS.chrome,
  platform: BrowserPlatform.LINUX,
  cacheDir,
}).then(result => {
  console.log('Chrome installed:', result.executablePath);
}).catch(error => {
  console.error('Chrome install failed:', error);
  process.exitCode = 1;
});
