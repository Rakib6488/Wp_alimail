/**
 * Support Bridge v4.0  -  Alimail (SMTP / IMAP)  <->  Apps Script portal
 *
 *  - Durable queue in ./data   : no mail event is lost if internet / Apps Script / the PC is down
 *  - Auto reconnect            : IMAP reconnects automatically, instant mail with IDLE-style 'exists' events
 *  - Catch-up                  : mails received while the PC was off are imported on start
 *  - Duplicate protection      : mail Message-ID checked here and again inside Apps Script
 *  - ngrok URL auto-sync       : BRIDGE_URL in Apps Script is updated by itself
 *  - Optional failover         : two PCs, only one active at a time (lease in Apps Script)
 *
 * Settings: config.json (see config.example.json) or environment variables.
 *   ENABLE_TEST=1  enables the /test diagnostic route (off by default, never in production)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const express = require('express');
const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

// Local .env (optional). Real environment variables win.
try {
  const envFile = path.join(__dirname, '.env');
  if (fs.existsSync(envFile)) {
    fs.readFileSync(envFile, 'utf8').split(/\r?\n/).forEach(line => {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || m[1].startsWith('#')) return;
      let value = m[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = value;
    });
  }
} catch (e) { console.warn('Could not load .env:', e.message); }

const VERSION = '4.0.0';
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const LOGS = path.join(ROOT, 'logs');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(LOGS, { recursive: true });

/* ---------------------------------------------------------------- config */
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, '')); }
catch (e) { if (fs.existsSync(path.join(ROOT, 'config.json'))) console.error('config.json is not valid JSON:', e.message); }
const PORT = Number(process.env.PORT || cfg.PORT || 3000);
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL || cfg.APPS_SCRIPT_URL;
const API_KEY = process.env.API_KEY || cfg.API_KEY;
const PUBLIC_URL = process.env.PUBLIC_URL || cfg.PUBLIC_URL || '';
const NGROK_API = process.env.NGROK_API || cfg.NGROK_API || 'http://127.0.0.1:4040/api/tunnels';
const NO_MAIL = process.env.NO_MAIL === '1';
const FAILOVER_ENABLED = String(process.env.FAILOVER_ENABLED !== undefined ? process.env.FAILOVER_ENABLED : (cfg.FAILOVER_ENABLED !== undefined ? cfg.FAILOVER_ENABLED : 'false')).toLowerCase() === 'true';
const PC_ID = String(process.env.PC_ID || cfg.PC_ID || '').trim().toUpperCase();
const LEASE_SECONDS = Math.max(20, Math.min(300, Number(process.env.LEASE_SECONDS || cfg.LEASE_SECONDS || 45)));
const HEARTBEAT_SECONDS = Math.max(5, Math.min(Math.floor(LEASE_SECONDS / 2), Number(process.env.HEARTBEAT_SECONDS || cfg.HEARTBEAT_SECONDS || 12)));
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || cfg.PRODUCTION === true;
const ENABLE_TEST = !IS_PRODUCTION && (process.env.ENABLE_TEST === '1' || cfg.ENABLE_TEST === true);
const ALLOWED_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*(googleusercontent\.com|script\.google\.com)$/i;

/* ---------------------------------------------------------------- utils */
const sleep = ms => new Promise(r => setTimeout(r, ms));
try { const f = path.join(LOGS, 'bridge.log'); if (fs.existsSync(f) && fs.statSync(f).size > 5e6) fs.renameSync(f, path.join(LOGS, 'bridge.old.log')); } catch (e) {}
function log(...a) {
  const line = new Date().toISOString().replace('T', ' ').slice(0, 19) + '  ' + a.join(' ');
  console.log(line);
  try { fs.appendFileSync(path.join(LOGS, 'bridge.log'), line + '\n'); } catch (e) {}
}
function loadJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } }
function saveJson(f, v) {
  const t = f + '.tmp';
  fs.writeFileSync(t, JSON.stringify(v));
  try { fs.renameSync(t, f); }
  catch (e) { fs.copyFileSync(t, f); try { fs.unlinkSync(t); } catch (x) {} }
}
function safeEq(a, b) {
  const x = Buffer.from(String(a == null ? '' : a)), y = Buffer.from(String(b == null ? '' : b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function errorText(e) {
  if (e && e.message) return String(e.message);
  if (typeof e === 'string') return e;
  try { return JSON.stringify(e); } catch (x) { return String(e || 'unknown error'); }
}
process.on('uncaughtException', e => log('UNCAUGHT', e && e.stack || e));
process.on('unhandledRejection', e => log('UNHANDLED', e && e.stack || e));

function configProblems_() {
  const bad = [];
  if (!APPS_SCRIPT_URL || /XXXX|paste/i.test(APPS_SCRIPT_URL)) bad.push('APPS_SCRIPT_URL is empty or still the example value. Use the Web app URL from Apps Script (Deploy > Manage deployments).');
  else if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(APPS_SCRIPT_URL)) bad.push('APPS_SCRIPT_URL must look like https://script.google.com/macros/s/.../exec (the Web app URL, not the editor URL).');
  if (!API_KEY || API_KEY.length < 20 || /paste/i.test(API_KEY)) bad.push('API_KEY is empty, too short, or still the example value. Copy it from Apps Script > Project Settings > Script properties.');
  if (!(PORT >= 1 && PORT <= 65535)) bad.push('PORT must be a number from 1 to 65535.');
  if (FAILOVER_ENABLED && !/^[A-Z0-9][A-Z0-9_-]{1,31}$/.test(PC_ID)) bad.push('FAILOVER_ENABLED requires a unique PC_ID such as PC-1, PC-2.');
  if (FAILOVER_ENABLED && LEASE_SECONDS <= HEARTBEAT_SECONDS) bad.push('LEASE_SECONDS must be greater than HEARTBEAT_SECONDS.');
  return bad;
}
const CONFIG_PROBLEMS = configProblems_();
if (CONFIG_PROBLEMS.length) {
  log('config.json needs ' + CONFIG_PROBLEMS.length + ' fix(es) before the bridge can start:');
  CONFIG_PROBLEMS.forEach(x => log('  - ' + x));
  process.exit(2);
}

/* ---------------------------------------------------------------- state */
const MEDIA = path.join(DATA, 'media');
fs.mkdirSync(MEDIA, { recursive: true });
const FILE_MAX = 10 * 1024 * 1024;
const QFILE = path.join(DATA, 'queue.json');
const FFILE = path.join(DATA, 'failed.json');
const SFILE = path.join(DATA, 'seen.json');
const STFILE = path.join(DATA, 'state.json');
const MFILE = path.join(DATA, 'sent-mail.json');
const IFILE = path.join(DATA, 'inline_seen.json');
let queue = loadJson(QFILE, []);
let seen = new Set(loadJson(SFILE, []));
let state = loadJson(STFILE, {});
const stats = { delivered: 0, started: Date.now() };

const RT_KEY = crypto.createHash('sha256').update(API_KEY + ':rt').digest('hex').slice(0, 24);
const rtClients = new Set();
function emit(t) {
  const d = 'data: ' + JSON.stringify({ t, at: Date.now() }) + '\n\n';
  rtClients.forEach(r => { try { r.write(d); } catch (e) { rtClients.delete(r); } });
}
function saveState(p) { Object.assign(state, p); saveJson(STFILE, state); }
let seenTimer = null;
function markSeen(id) {
  seen.add(id);
  if (seen.size > 8000) seen = new Set([...seen].slice(-6000));
  clearTimeout(seenTimer);
  seenTimer = setTimeout(() => saveJson(SFILE, [...seen]), 1000);
}

/* ---------------------------------------------------------------- Apps Script */
async function callScript(payload, timeoutMs = 45000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(APPS_SCRIPT_URL, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ apiKey: API_KEY, ...payload }), redirect: 'follow', signal: ctl.signal
    });
    const txt = await res.text();
    let j;
    try { j = JSON.parse(txt); } catch (e) {
      const preview = String(txt || '').replace(/\s+/g, ' ').slice(0, 180);
      const looksHtml = /^\s*(<!doctype html|<html|<head)/i.test(txt);
      throw new Error('Apps Script did not return JSON (HTTP ' + res.status +
        ', content-type ' + (res.headers.get('content-type') || 'unknown') +
        ', final-url ' + res.url + (looksHtml ? ', response is HTML' : '') +
        '). Deploy the latest Code.gs as Web app, execute as yourself, with access "Anyone". Response: ' + preview);
    }
    if (j.ok === false) { const e = new Error(j.error || 'rejected'); e.app = !/bad key/.test(j.error || ''); throw e; }
    return j;
  } finally { clearTimeout(t); }
}

/* ---------------------------------------------------------------- attachments */
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'application/pdf': '.pdf' };
function saveMedia(name, mime, buf) {
  mime = String(mime || 'application/octet-stream').split(';')[0].trim().toLowerCase();
  if (!name) name = 'file_' + Date.now() + (EXT[mime] || '');
  const p = path.join(MEDIA, crypto.randomUUID() + '.bin');
  fs.writeFileSync(p, buf);
  return { name: String(name).slice(0, 120), mime, size: buf.length, path: p };
}
// Queue items keep only a path; base64 is read right before the upload.
function inflate(payload) {
  if (!payload.files || !payload.files.length) return payload;
  const files = [];
  let lost = 0;
  for (const f of payload.files) {
    try { files.push({ name: f.name, mime: f.mime, data: fs.readFileSync(f.path).toString('base64') }); }
    catch (e) { lost++; log('attachment missing on disk, skipping:', f.name, '-', e.code || e.message); }
  }
  const out = Object.assign({}, payload, { files });
  if (lost) out.body = (out.body ? out.body + '\n\n' : '') + '[' + lost + ' attachment(s) could not be loaded by the bridge]';
  if (!files.length) delete out.files;
  return out;
}
function dropMedia(payload) { (payload.files || []).forEach(f => { try { fs.unlinkSync(f.path); } catch (e) {} }); }

/* ---------------------------------------------------------------- durable delivery queue */
function enqueue(payload, extId) {
  if (extId) { if (seen.has(extId)) return false; markSeen(extId); payload.extId = extId; }
  queue.push({ id: crypto.randomUUID(), payload, tries: 0, next: 0 });
  saveJson(QFILE, queue);
  pump();
  return true;
}
let pumping = false;
let portalOutdated = false;
async function pump() {
  if (FAILOVER_ENABLED && !bridgeLease.active) return;
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) {
      const now = Date.now();
      const item = queue.find(q => q.next <= now);
      if (!item) {
        const soonest = Math.min(...queue.map(q => q.next));
        await sleep(Math.min(Math.max(soonest - now, 100), 3000));
        continue;
      }
      try {
        await callScript(inflate(item.payload), 60000);
        const i = queue.indexOf(item); if (i >= 0) queue.splice(i, 1);
        saveJson(QFILE, queue); stats.delivered++; dropMedia(item.payload);
        if (item.payload.action === 'incoming') { emit('msg'); queueDesktopAlert(item.payload); }
      } catch (e) {
        item.tries++;
        if (/unknown action/.test(e.message || '')) {
          item.next = Date.now() + 60000;
          saveJson(QFILE, queue);
          if (!portalOutdated) { portalOutdated = true; log('PORTAL OUTDATED: ' + e.message + ' - messages are held in queue until the new Code.gs is deployed'); }
          continue;
        }
        if (e.app && item.tries >= 8) {
          const i = queue.indexOf(item); if (i >= 0) queue.splice(i, 1);
          saveJson(QFILE, queue);
          const f = loadJson(FFILE, []); f.push({ at: new Date().toISOString(), error: e.message, payload: item.payload }); saveJson(FFILE, f.slice(-200));
          log('PARKED message after 8 rejections:', e.message, '(see data/failed.json)');
          continue;
        }
        const backoff = Math.min(60000, 1000 * Math.pow(2, Math.min(item.tries, 6)));
        const until = Date.now() + backoff;
        if (e.app) item.next = until;
        else queue.forEach(q => { q.next = Math.max(q.next, until); });
        saveJson(QFILE, queue);
        log('delivery to portal failed (try ' + item.tries + '): ' + e.message + ' - retry in ' + Math.round(backoff / 1000) + 's');
      }
    }
  } finally { pumping = false; }
}
setInterval(() => { if (queue.length) pump(); }, 5000);

async function checkPortalVersion() {
  try {
    const r = await callScript({ action: 'ping' }, 15000);
    const have = Array.isArray(r.actions) ? r.actions : [];
    const missing = ['mailRead', 'mailUnseen'].filter(a => have.length && !have.includes(a));
    if (!r.version || r.version !== VERSION || missing.length) {
      portalOutdated = true;
      log('PORTAL OUTDATED: Apps Script version "' + (r.version || 'old') + '", bridge ' + VERSION + (missing.length ? ', missing actions: ' + missing.join(', ') : '') + '. Deploy the latest Code.gs: Deploy > Manage deployments > Edit > Version: New version > Deploy.');
    } else { if (portalOutdated) log('Portal version OK (' + r.version + ')'); portalOutdated = false; }
  } catch (e) { log('Portal version check failed:', e.message); }
}
setInterval(() => { checkPortalVersion(); }, 5 * 60000);

async function withRetry(fn, tries = 3, delay = 800) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; if (e.noRetry) break; await sleep(delay * (i + 1)); }
  }
  throw last;
}

/* ---------------------------------------------------------------- failover (lease) */
const bridgeLease = { active: !FAILOVER_ENABLED, token: '', expiresAt: 0, owner: PC_ID };
let leaseBusy = false, leaseTimer = null, servicesStarted = false;

async function stopServices(reason) {
  servicesStarted = false;
  log('Mail: stopping (' + reason + ')');
  imapGen++;
  if (imapClient) { try { imapClient.close(); } catch (e) {} imapClient = null; }
  if (extraClient) { try { extraClient.close(); } catch (e) {} extraClient = null; }
  mailState.connected = false; mailState.connecting = false;
}
async function startServices() {
  if (servicesStarted || (FAILOVER_ENABLED && !bridgeLease.active)) return;
  servicesStarted = true;
  if (!NO_MAIL) bootMail();
  syncUrl();
  if (queue.length) pump();
}
async function leaseRequest(mode) {
  return callScript({ action: 'bridgeLease', mode, pcId: PC_ID, token: bridgeLease.token, ttl: LEASE_SECONDS }, 15000);
}
async function leaseTick() {
  if (!FAILOVER_ENABLED || leaseBusy) return;
  leaseBusy = true;
  try {
    const r = await leaseRequest(bridgeLease.active ? 'renew' : 'acquire');
    if (r.acquired) {
      const wasActive = bridgeLease.active;
      bridgeLease.active = true; bridgeLease.token = String(r.token || bridgeLease.token); bridgeLease.expiresAt = Number(r.expiresAt) || 0;
      if (!wasActive) { log('Failover: lease acquired by ' + PC_ID); await startServices(); }
    } else if (bridgeLease.active && r.lost && bridgeLease.expiresAt && Date.now() >= bridgeLease.expiresAt) {
      bridgeLease.active = false; bridgeLease.token = ''; bridgeLease.expiresAt = Number(r.expiresAt) || 0;
      log('Failover: lease lost; entering standby' + (r.owner ? ' (active: ' + r.owner + ')' : ''));
      await stopServices('lease lost');
    }
  } catch (e) { log('Failover lease check failed:', e.message); }
  finally { leaseBusy = false; }
}
function startLeaseController() {
  if (!FAILOVER_ENABLED) return startServices();
  log('Failover enabled: ' + PC_ID + ', lease ' + LEASE_SECONDS + 's, heartbeat ' + HEARTBEAT_SECONDS + 's');
  leaseTick();
  leaseTimer = setInterval(leaseTick, HEARTBEAT_SECONDS * 1000);
}

/* ---------------------------------------------------------------- Mail (SMTP / IMAP) */
let mailCfg = null, transporter = null, imapGen = 0, imapClient = null, extraClient = null;
const mailState = { configured: false, connected: false, connecting: false, lastError: '' };

async function loadMailConfig() {
  const r = await callScript({ action: 'config' });
  mailCfg = r.config;
  if (!mailCfg.SMTP_PASS || /APP_PASSWORD_HERE/.test(mailCfg.SMTP_PASS)) throw new Error('SMTP_PASS / IMAP_PASS are not set in Script Properties');
  const host = process.env.SMTP_HOST || mailCfg.SMTP_HOST;
  const configuredPort = Number(process.env.SMTP_PORT || mailCfg.SMTP_PORT);
  const port = configuredPort === 465 ? 587 : configuredPort;
  if (transporter) { try { transporter.close(); } catch (e) {} }
  transporter = nodemailer.createTransport({
    host, port, secure: port === 465, pool: true, maxConnections: 3, maxMessages: 100,
    auth: { user: mailCfg.SMTP_USER, pass: mailCfg.SMTP_PASS },
    connectionTimeout: 20000, greetingTimeout: 15000, socketTimeout: 40000
  });
  mailState.configured = true;
  log('Mail config loaded for', mailCfg.SMTP_USER, 'SMTP', host + ':' + port);
}
// Fixed footer images. The portal puts <img src="cid:..."> in the mail; the image is attached inline here.
const FOOTER_IMAGES = [
  { cid: 'palmpay-logo', file: 'assets/palmpay-logo.png' },
  { cid: 'hello-banner', file: 'assets/hello-banner.jpg' }
];
function inlineImages_(html) {
  return FOOTER_IMAGES
    .filter(i => String(html || '').indexOf('cid:' + i.cid) >= 0 && fs.existsSync(path.join(__dirname, i.file)))
    .map(i => ({ filename: path.basename(i.file), path: path.join(__dirname, i.file), cid: i.cid }));
}
// Only retry when the connection failed BEFORE the mail was handed over (avoids duplicate mails).
const SMTP_SAFE_RETRY = new Set(['ECONNECTION', 'ECONNREFUSED', 'ENOTFOUND', 'EDNS', 'EAI_AGAIN']);
async function sendMail(m) {
  if (!transporter) await loadMailConfig();
  const files = (m.files || []).map(f => ({ filename: f.name, content: Buffer.from(f.data, 'base64'), contentType: f.mime }));
  await withRetry(async () => {
    try {
      const ref = /^<[^<>\s]{3,300}>$/.test(String(m.inReplyTo || '')) ? String(m.inReplyTo) : '';
      const cc = (Array.isArray(m.cc) ? m.cc : []).map(x => String(x).trim()).filter(x => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(x)).slice(0, 10);
      await transporter.sendMail(Object.assign({ from: mailCfg.SMTP_USER, to: m.to, subject: m.subject, text: m.text, html: m.html, cc: cc.length ? cc : undefined,
        attachments: inlineImages_(m.html).concat(files) }, ref ? { inReplyTo: ref, references: ref } : {}));
    } catch (e) {
      if (!SMTP_SAFE_RETRY.has(e && e.code)) e.noRetry = true;
      throw e;
    }
  }, 3, 1500);
}
const HTML_ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', bull: '•', middot: '·', euro: '€', pound: '£', yen: '¥', laquo: '«', raquo: '»', times: '×', deg: '°' };
function htmlDecode_(s) {
  return String(s).replace(/&#x([0-9a-f]+);/gi, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return ''; } })
    .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(Number(d)); } catch (e) { return ''; } })
    .replace(/&([a-z]+);/gi, (m, n) => Object.prototype.hasOwnProperty.call(HTML_ENT, n.toLowerCase()) ? HTML_ENT[n.toLowerCase()] : m);
}
function htmlToText_(html) {
  let h = String(html || '');
  h = h.replace(/<!--[\s\S]*?-->/g, '').replace(/<(head|style|script|title|noscript)\b[\s\S]*?<\/\1>/gi, '');
  h = h.replace(/<(div|span|p|td|table)\b[^>]*(?:display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all)[^>]*>[\s\S]*?<\/\1>/gi, '');
  h = h.replace(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, inner) => {
    const t = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t || /^(mailto:|tel:|#|javascript:)/i.test(href)) return inner;
    const same = t.replace(/^https?:\/\//i, '').replace(/\/$/, '') === href.replace(/^https?:\/\//i, '').replace(/\/$/, '');
    return same ? t : t + ' (' + htmlDecode_(href) + ')';
  });
  h = h.replace(/<img\b[^>]*?alt\s*=\s*["']([^"']{2,80})["'][^>]*>/gi, ' [$1] ');
  h = h.replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|ul|ol|blockquote|section|article|header|footer|pre)>/gi, '\n')
    .replace(/<(p|div|h[1-6]|blockquote|pre)\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ').replace(/<hr\b[^>]*>/gi, '\n--------\n')
    .replace(/<\/tr>/gi, '\n').replace(/<\/t[dh]>\s*<t[dh]\b[^>]*>/gi, '  |  ')
    .replace(/<\/?(span|font|strong|b|em|i|u|small|sub|sup|mark|abbr)\b[^>]*>/gi, '')
    .replace(/<\/?(table|thead|tbody|tfoot|tr|td|th|li|ul|ol|center)\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '');
  h = htmlDecode_(h).replace(/\r/g, '').replace(/[ ​‌‍﻿]/g, ' ');
  const lines = h.split('\n').map(l => l.replace(/[ \t]+/g, ' ').replace(/^( ?\| ?)+|( ?\| ?)+$/g, '').trim()).map(l => /^[|\s-]*$/.test(l) && !/^-{4,}$/.test(l) ? '' : l);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
function mailText(p) {
  let t = (p.text || '').trim();
  const html = p.html ? String(p.html) : '';
  const placeholder = t.length < 300 && /(enable html|does not support html|html (e-?mail|version)|view (this )?(e-?mail|message) (in|on) (your )?(web )?browser)/i.test(t);
  if (html && (!t || placeholder || (t.length < 40 && html.length > 400))) {
    const conv = htmlToText_(html);
    if (conv) t = conv;
  }
  return (t || '(empty)').slice(0, 45000);
}
let procMail = false, procAgain = false, mailHistoryRunning = false;
const mailDone = new Set();
const mailUidId = new Map();
const selfSeen = new Map();
const mailKey = (client, uid) => String(client && client.mailbox && client.mailbox.uidValidity || 0) + ':' + uid;
const inlineSeen = new Set(loadJson(IFILE, []));
function ownMailAddrs() {
  const raw = process.env.MAIL_ALIASES || cfg.MAIL_ALIASES || [];
  const set = new Set((Array.isArray(raw) ? raw : String(raw).split(',')).map(x => String(x).trim().toLowerCase()).filter(Boolean));
  [mailCfg && mailCfg.IMAP_USER, mailCfg && mailCfg.SMTP_USER].forEach(x => { if (x) set.add(String(x).toLowerCase()); });
  return set;
}
const addrList = f => ((f && f.value) || []).map(a => String(a.address || '').toLowerCase()).filter(a => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)).slice(0, 20);
const mailFails = new Map();
async function handleMailUid(client, uid, options) {
  options = options || {};
  const m = await client.fetchOne(uid, { source: true, flags: true }, { uid: true });
  if (!m || !m.source) throw new Error('IMAP message source unavailable (UID ' + uid + ')');
  const p = await simpleParser(m.source);
  if (options.sinceTs && p.date && p.date.getTime() < Number(options.sinceTs) * 1000) return;
  const addr = p.from && p.from.value && p.from.value[0];
  const from = ((addr && addr.address) || 'unknown').toLowerCase();
  const ownSet = ownMailAddrs();
  const toL = addrList(p.to), ccL = addrList(p.cc);
  const toAddr = (p.to && p.to.value || []).find(a => a && a.address && !ownSet.has(String(a.address).toLowerCase())) || (p.to && p.to.value && p.to.value[0]);
  const outgoing = options.outgoing || ownSet.has(from);
  const files = [], skipped = [];
  for (const a of (p.attachments || [])) {
    const buf = a.content, n = a.filename || '';
    if (!buf || !buf.length) continue;
    if ((a.related || a.contentDisposition === 'inline') && buf.length < 100 * 1024) {
      if (buf.length < 1024) continue;
      const h = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
      if (inlineSeen.has(h)) continue;
      inlineSeen.add(h);
      if (inlineSeen.size > 800) inlineSeen.delete(inlineSeen.values().next().value);
      saveJson(IFILE, [...inlineSeen]);
    }
    if (buf.length > FILE_MAX) { skipped.push((n || 'attachment') + ' (' + (buf.length / 1048576).toFixed(1) + ' MB)'); continue; }
    files.push(saveMedia(n, a.contentType, buf));
  }
  let body = mailText(p);
  if (files.length && body === '(empty)') body = '';
  if (skipped.length) body += '\n\n[attachment too large for the portal (max ' + Math.round(FILE_MAX / 1048576) + ' MB), open it in Alimail: ' + skipped.join(', ') + ']';
  const recipient = toAddr && toAddr.address ? String(toAddr.address).toLowerCase() : '';
  const payload = {
    action: 'incoming', channel: 'mail',
    from: outgoing ? recipient : from,
    name: outgoing ? '' : ((addr && addr.name) || ''),
    fromMe: outgoing, mailTo: toL, mailCc: ccL,
    seen: !outgoing && !!(m.flags && m.flags.has && m.flags.has('\\Seen')),
    subject: p.subject || '(no subject)', body,
    time: p.date ? p.date.getTime() : Date.now()
  };
  if (files.length) payload.files = files;
  const messageId = String(p.messageId || '').trim().replace(/^<|>$/g, '');
  const fallbackSeed = [options.folder || 'INBOX', String(uid), from, recipient, p.subject || '', p.date ? String(p.date.getTime()) : ''].join('|');
  const extId = messageId
    ? ('mail:' + messageId.toLowerCase())
    : ('mail:uid:' + String(options.folder || 'INBOX').toLowerCase() + ':' + uid + ':' + crypto.createHash('sha1').update(fallbackSeed).digest('hex').slice(0, 16));
  if (messageId && !outgoing && (options.folder || 'INBOX') === 'INBOX') { mailUidId.set(mailKey(client, uid), messageId.toLowerCase()); if (mailUidId.size > 6000) mailUidId.delete(mailUidId.values().next().value); }
  if (!enqueue(payload, extId)) dropMedia(payload);
}
async function processMail(client) {
  if (mailHistoryRunning) { procAgain = true; return; }
  if (procMail) { procAgain = true; return; }
  procMail = true;
  try {
    do {
      procAgain = false;
      const found = await client.search({ seen: false }, { uid: true });
      const uids = Array.isArray(found) ? found : [];
      for (const uid of uids) {
        const mk = mailKey(client, uid);
        if (mailDone.has(mk)) continue;
        try { await handleMailUid(client, uid, { folder: 'INBOX' }); mailFails.delete(uid); mailDone.add(mk); if (mailDone.size > 5000) mailDone.delete(mailDone.values().next().value); }
        catch (e) {
          const n = (mailFails.get(uid) || 0) + 1; mailFails.set(uid, n);
          log('mail uid ' + uid + ' failed (' + n + '/3):', e.message);
          if (n >= 3) log('mail uid ' + uid + ' kept unread; retrying on the next sync');
        }
      }
    } while (procAgain);
  } finally { procMail = false; }
}
let mailHistoryOk = false;
const mailReadBuf = new Set();
let mailReadTimer = null;
async function reportUnseen(client) {
  const found = await client.search({ seen: false, answered: false }, { uid: true });
  const uids = (Array.isArray(found) ? found : []).slice().sort((a, b) => a - b);
  const take = uids.slice(-300);
  const items = [];
  if (take.length) {
    for await (const m of client.fetch(take.join(','), { envelope: true, internalDate: true }, { uid: true })) {
      const id = m.envelope && m.envelope.messageId;
      if (id) items.push({ id: String(id).replace(/^<|>$/g, '').toLowerCase(), t: m.internalDate ? new Date(m.internalDate).getTime() : 0 });
    }
  }
  const dated = items.map(i => i.t).filter(Boolean);
  const cut = uids.length > take.length && dated.length ? Math.min(...dated) : 0;
  log('Alimail unread report: ' + items.length + ' unread' + (uids.length > take.length ? ' (newest 300 of ' + uids.length + ')' : ''));
  enqueue({ action: 'mailUnseen', ids: items.map(i => i.id), cut: cut });
}
async function markMailSeenImap(ids) {
  const client = imapClient;
  if (!client || !client.usable || !mailState.connected) throw new Error('Mail connection is not ready');
  if (mailHistoryRunning) throw new Error('Mail is syncing, try again in a moment');
  const lock = await client.getMailboxLock('INBOX');
  try {
    const uids = [];
    for (const raw of ids.slice(0, 50)) {
      const id = String(raw || '').trim().replace(/^<|>$/g, '');
      if (!id) continue;
      const found = await client.search({ header: { 'message-id': id } }, { uid: true });
      if (Array.isArray(found) && found.length) { uids.push(...found); selfSeen.set(id.toLowerCase(), Date.now()); }
    }
    if (uids.length) await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
    return uids.length;
  } finally { lock.release(); }
}
setInterval(() => { const t = Date.now() - 120000; selfSeen.forEach((v, k) => { if (v < t) selfSeen.delete(k); }); }, 60000);
function mailSince() {
  return Number(state.lastMailTs) || Math.floor(Date.now() / 1000);
}
setInterval(() => { if (mailHistoryOk && mailState.connected) saveState({ lastMailTs: Math.floor(Date.now() / 1000) }); }, 60000);

// Sent items / other folders are polled every 2 min on a SECOND connection.
const SKIP_FOLDERS = /(^|[\\/])(trash|deleted|junk|spam|drafts?)($|[\\/])/i;
let extraFolders = [], extraFoldersAt = 0, extraBusy = false;
async function pollExtraFolders() {
  if (NO_MAIL || extraBusy || !mailState.connected || !mailHistoryOk || mailHistoryRunning || !mailCfg) return;
  extraBusy = true;
  try {
    if (!extraClient || !extraClient.usable) {
      if (extraClient) { try { extraClient.close(); } catch (e) {} }
      extraClient = new ImapFlow({ host: mailCfg.IMAP_HOST, port: Number(mailCfg.IMAP_PORT), secure: true, auth: { user: mailCfg.IMAP_USER, pass: mailCfg.IMAP_PASS }, logger: false });
      extraClient.on('error', () => {});
      await extraClient.connect();
    }
    const c2 = extraClient;
    if (!extraFolders.length || Date.now() - extraFoldersAt > 30 * 60000) {
      const l = await c2.list();
      extraFolders = l.map(f => String(f.path || f.name || '')).filter(n => n && !/^INBOX$/i.test(n) && !SKIP_FOLDERS.test(n));
      extraFoldersAt = Date.now();
    }
    const marks = state.mailFolderUid || {};
    let n = 0;
    for (const folder of extraFolders) {
      const isSent = /(^|[\\/])(sent|sent items|sent mail)($|[\\/])/i.test(folder);
      const mb = await c2.mailboxOpen(folder, { readOnly: true });
      const top = Number(mb.uidNext) - 1, rec = marks[folder];
      if (!rec || rec.v !== String(mb.uidValidity)) { marks[folder] = { v: String(mb.uidValidity), last: top }; continue; }
      if (top <= rec.last) continue;
      const found = await c2.search({ uid: (rec.last + 1) + ':*' }, { uid: true });
      const uids = (Array.isArray(found) ? found : []).filter(u => u > rec.last).sort((a, b) => a - b);
      for (const uid of uids) {
        try { await handleMailUid(c2, uid, { outgoing: isSent, folder }); rec.last = uid; n++; }
        catch (e) { log('mail ' + folder + ' uid ' + uid + ' failed:', e.message); break; }
      }
    }
    state.mailFolderUid = marks; saveState({ mailFolderUid: marks });
    if (n) log('Mail: ' + n + ' new mail(s) from other folders (Sent etc.)');
  } catch (e) { log('Mail extra-folder poll failed:', e.message); try { extraClient && extraClient.close(); } catch (x) {} extraClient = null; }
  finally { extraBusy = false; }
}
setInterval(() => { pollExtraFolders().catch(() => {}); }, 120000);

async function syncMailHistory(client) {
  if (mailHistoryRunning) return;
  mailHistoryRunning = true;
  const startedAt = Math.floor(Date.now() / 1000), sinceTs = mailSince();
  const since = new Date(sinceTs * 1000);
  log('Mail downtime catch-up window: since ' + since.toLocaleString() + (state.lastMailTs ? ' (last online checkpoint)' : ' (first start: no history)'));
  let total = 0, failed = 0;
  let folders = [];
  try { folders = await client.list(); } catch (e) { folders = []; }
  const folderNames = folders.map(f => String(f.path || f.name || '')).filter(Boolean);
  if (!folderNames.some(name => /^INBOX$/i.test(name))) folderNames.unshift('INBOX');
  const skip = /(^|[\\/])(trash|deleted|junk|spam|drafts?)($|[\\/])/i;
  const uniqueFolders = [...new Set(folderNames)].filter(name => !skip.test(name));
  for (const folder of uniqueFolders) {
    const isSent = /(^|[\\/])(sent|sent items|sent mail)($|[\\/])/i.test(folder);
    try {
      await client.mailboxOpen(folder);
      if (!/^INBOX$/i.test(folder) && client.mailbox) {
        const marks = state.mailFolderUid || (state.mailFolderUid = {});
        marks[folder] = { v: String(client.mailbox.uidValidity), last: Number(client.mailbox.uidNext) - 1 };
      }
      const found = await client.search({ since }, { uid: true });
      const uids = Array.isArray(found) ? found : [];
      for (const uid of uids) {
        try { await handleMailUid(client, uid, { outgoing: isSent, folder, sinceTs: sinceTs }); total++; }
        catch (e) { failed++; log('mail history uid ' + folder + ' failed:', e.message); }
      }
    } catch (e) { failed++; log('mail history folder ' + folder + ' failed:', e.message); }
  }
  try { await client.mailboxOpen('INBOX'); }
  finally {
    mailHistoryRunning = false;
    if (!failed) { mailHistoryOk = true; saveState({ lastMailTs: startedAt, mailFolderUid: state.mailFolderUid || {} }); }
    log('Mail history sync: since last seen, ' + uniqueFolders.length + ' folder(s), ' + total + ' message(s) queued/checked');
  }
}
async function startImap() {
  if (NO_MAIL) return;
  const gen = ++imapGen;
  mailState.connecting = true;
  if (imapClient) { try { imapClient.close(); } catch (e) {} imapClient = null; }
  let backoff = 2000;
  while (gen === imapGen) {
    const client = new ImapFlow({ host: mailCfg.IMAP_HOST, port: Number(mailCfg.IMAP_PORT), secure: true,
      auth: { user: mailCfg.IMAP_USER, pass: mailCfg.IMAP_PASS }, logger: false });
    imapClient = client;
    let closed; const closedP = new Promise(r => { closed = r; });
    client.on('close', () => closed());
    client.on('error', e => { mailState.lastError = e.message; });
    let timer = null, unseenTimer = null;
    try {
      await client.connect();
      if (gen !== imapGen) { try { client.close(); } catch (e) {} break; }
      await client.mailboxOpen('INBOX');
      mailState.connected = true; mailState.connecting = false; mailState.lastError = ''; backoff = 2000;
      log('Mail: connected to inbox (instant delivery on)');
      client.on('exists', () => processMail(client).catch(e => log('mail error:', e.message)));
      // read in Alimail webmail / phone app -> read in the portal (batched, 4 s)
      client.on('flags', async ev => {
        try {
          if (!ev || (ev.path && !/^INBOX$/i.test(ev.path)) || !ev.flags || !ev.flags.has || !ev.flags.has('\\Seen')) return;
          let uid = ev.uid;
          if (!uid && ev.seq) { try { const r = await client.fetchOne(ev.seq, { uid: true }); uid = r && r.uid; } catch (e) {} }
          const id = uid && mailUidId.get(mailKey(client, uid));
          if (!id) return;
          if (selfSeen.has(id)) { selfSeen.delete(id); return; }
          mailReadBuf.add(id);
          if (!mailReadTimer) mailReadTimer = setTimeout(() => { mailReadTimer = null; const ids = [...mailReadBuf]; mailReadBuf.clear(); if (ids.length) enqueue({ action: 'mailRead', ids }); }, 4000);
        } catch (e) { /* best effort */ }
      });
      await syncMailHistory(client);
      await processMail(client);
      timer = setInterval(() => { if (client.usable) processMail(client).catch(e => log('mail error:', e.message)); }, 60000);
      unseenTimer = setInterval(() => { if (client.usable) reportUnseen(client).catch(e => log('mail unseen report failed:', e.message)); }, 60000);
      await closedP;
    } catch (e) { if (gen === imapGen) mailState.lastError = e.message; log('Mail (IMAP) error:', e.message); }
    if (timer) clearInterval(timer);
    if (unseenTimer) clearInterval(unseenTimer);
    if (gen === imapGen) { mailState.connected = false; mailState.connecting = true; }
    try { client.close(); } catch (e) {}
    if (gen !== imapGen) break;
    log('Mail: reconnecting in ' + Math.round(backoff / 1000) + 's');
    await sleep(backoff); backoff = Math.min(backoff * 2, 60000);
  }
}
async function bootMail() {
  if (NO_MAIL) return;
  for (;;) {
    try { await loadMailConfig(); break; }
    catch (e) { mailState.lastError = e.message; log('Mail setup failed:', e.message, '- retrying in 30s'); await sleep(30000); }
  }
  startImap();
}

/* ---------------------------------------------------------------- desktop alerts (Windows) */
let alertBatch = [], alertTimer = null;
function alertEnabled() { return process.env.DESKTOP_ALERTS !== undefined ? process.env.DESKTOP_ALERTS !== 'false' : cfg.DESKTOP_ALERTS !== false; }
function showDesktopNotice(title, body) {
  if (process.platform !== 'win32') return;
  const q = s => String(s || '').replace(/[\r\n]+/g, ' ').replace(/'/g, "''").slice(0, 200);
  const ps = "Add-Type -AssemblyName System.Windows.Forms;Add-Type -AssemblyName System.Drawing;" +
    "$n=New-Object System.Windows.Forms.NotifyIcon;$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;" +
    "$n.ShowBalloonTip(7000,'" + q(title) + "','" + q(body) + "',[System.Windows.Forms.ToolTipIcon]::Info);" +
    "Start-Sleep -Seconds 9;$n.Dispose()";
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps], { windowsHide: true }, err => {
    if (err) log('desktop alert failed:', err.message);
  });
}
function queueDesktopAlert(p) {
  if (!alertEnabled() || !p || p.fromMe || p.seen) return;
  alertBatch.push(p);
  if (!alertTimer) alertTimer = setTimeout(flushDesktopAlerts, 4000);
}
function flushDesktopAlerts() {
  alertTimer = null;
  const b = alertBatch.splice(0);
  if (!b.length) return;
  const who = p => p.name || p.from || 'Customer';
  if (b.length === 1) {
    const p = b[0];
    showDesktopNotice('Alimail: ' + who(p), p.subject || String(p.body || '').replace(/\s+/g, ' ').slice(0, 140));
  } else {
    showDesktopNotice('Alimail: ' + b.length + ' new mails', b.slice(0, 3).map(who).join(', ') + (b.length > 3 ? ' and ' + (b.length - 3) + ' more' : ''));
  }
}

/* ---------------------------------------------------------------- ngrok / public URL -> Apps Script */
let lastUrl = '';
async function syncUrl() {
  try {
    let url = PUBLIC_URL;
    if (!url) {
      const r = await fetch(NGROK_API, { signal: AbortSignal.timeout(3000) });
      const j = await r.json();
      const t = (j.tunnels || []).find(x => x.public_url && x.public_url.startsWith('https://'));
      if (!t) return;
      url = t.public_url;
    }
    if (url && url !== lastUrl) {
      await callScript({ action: 'setBridgeUrl', url }, 20000);
      lastUrl = url;
      log('BRIDGE_URL updated in Apps Script:', url);
    }
  } catch (e) { /* ngrok not running or portal unreachable: try again later */ }
}
setInterval(syncUrl, 20000);

/* ---------------------------------------------------------------- HTTP */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '40mb' }));
app.use((req, res, next) => {
  const origin = String(req.headers.origin || '');
  if (origin && ALLOWED_ORIGIN.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-api-key, ngrok-skip-browser-warning');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
function guard(req, res, next) {
  if (safeEq(req.headers['x-api-key'], API_KEY)) return next();
  res.status(401).json({ ok: false, error: 'unauthorized' });
}

app.get('/', (req, res) => res.send('Support bridge ' + VERSION + ' is running'));

// Realtime stream: only "something changed" pings, never mail content.
app.get('/events', (req, res) => {
  if (!safeEq(req.query.k, RT_KEY)) return res.status(401).end();
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n: connected\n\n');
  rtClients.add(res);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 20000);
  req.on('close', () => { clearInterval(hb); rtClients.delete(res); });
});

app.get('/status', guard, (req, res) => res.json({
  version: VERSION,
  mail: mailState.connected,
  mailStatus: mailState.connected ? 'connected' : (mailState.connecting ? 'connecting' : 'disconnected'),
  mailConfigured: mailState.configured,
  mailError: mailState.lastError,
  queue: queue.length, delivered: stats.delivered, live: rtClients.size,
  uptimeMin: Math.round((Date.now() - stats.started) / 60000),
  failover: FAILOVER_ENABLED ? { enabled: true, pcId: PC_ID, active: bridgeLease.active, expiresAt: bridgeLease.expiresAt } : { enabled: false }
}));

// Diagnostic: pushes a fake mail through the pipeline. Off unless ENABLE_TEST=1.
if (ENABLE_TEST) {
  log('WARNING: /test route is ON - it can inject fake mails. Turn ENABLE_TEST off for real use.');
  app.get('/test', guard, (req, res) => {
    const payload = { action: 'incoming', channel: 'mail', from: 'test@example.com', name: 'Bridge Test', subject: 'Bridge test', body: 'Test mail from the bridge (' + new Date().toLocaleTimeString() + ')', mailTo: [], mailCc: [] };
    if (req.query.file) payload.files = [saveMedia('test.txt', 'text/plain', Buffer.from('hello attachment'))];
    enqueue(payload);
    res.json({ ok: true, note: 'queued - it should appear in Alimail within seconds' });
  });
}

app.post('/send-mail', guard, async (req, res) => {
  const to = String(req.body && req.body.to || '').trim();
  if (!to || !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(to)) return res.status(400).json({ ok: false, error: 'Invalid recipient address' });
  const key = String(req.body.key || '').slice(0, 120);
  try {
    if (key) {
      const cut = Date.now() - 24 * 3600 * 1000;
      Object.keys(sentMail).forEach(k => { if (!(sentMail[k] >= cut)) delete sentMail[k]; });
      if (sentMail[key]) { log('duplicate mail suppressed'); return res.json({ ok: true, dup: true }); }
      await dedupeSend('mail:' + key, 24 * 3600 * 1000, async () => {
        await sendMail(req.body);
        sentMail[key] = Date.now(); saveJson(MFILE, sentMail);
      });
    } else await sendMail(req.body);
    res.json({ ok: true }); emit('sent');
  } catch (e) { log('send-mail failed:', e.message); res.status(500).json({ ok: false, error: e.message }); }
});
let sentMail = loadJson(MFILE, {});
const sendCache = new Map();
function dedupeSend(key, ttl, fn) {
  const now = Date.now(), hit = sendCache.get(key);
  if (hit && (hit.pending || now - hit.at < ttl)) { log('duplicate send suppressed'); return hit.promise; }
  const entry = { pending: true, at: now, promise: null, ttl: ttl };
  entry.promise = fn().then(
    result => { entry.pending = false; entry.at = Date.now(); return result; },
    error => { sendCache.delete(key); throw error; }
  );
  sendCache.set(key, entry);
  return entry.promise;
}
setInterval(() => {
  const now = Date.now();
  sendCache.forEach((v, k) => { if (!v.pending && now - v.at > Math.max(60000, v.ttl || 0)) sendCache.delete(k); });
}, 30000);

app.post('/mail-seen', guard, async (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
  try { const n = await markMailSeenImap(ids); res.json({ ok: true, marked: n }); }
  catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});
app.post('/reload-config', guard, async (req, res) => {
  try { await loadMailConfig(); startImap(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

const server = app.listen(PORT, () => {
  log('Support bridge ' + VERSION + ' listening on port ' + PORT + ' (queued: ' + queue.length + ')');
  setTimeout(() => checkPortalVersion(), 8000);
  startLeaseController();
});
server.on('error', e => {
  if (e.code === 'EADDRINUSE') { log('Port ' + PORT + ' is already in use - the bridge is probably already running.'); process.exit(3); }
  log('Server error:', e.message); process.exit(1);
});
async function shutdown() {
  try { saveJson(QFILE, queue); saveJson(SFILE, [...seen]); saveJson(STFILE, state); } catch (e) {}
  try { if (leaseTimer) clearInterval(leaseTimer); await stopServices('shutdown'); } catch (e) {}
  if (FAILOVER_ENABLED && bridgeLease.active) { try { await leaseRequest('release'); } catch (e) {} }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
