/**
 * Support Bridge v3.3  -  WhatsApp (QR login) + Alimail (SMTP / IMAP)  <->  Apps Script portal
 *
 *  - Durable queues in ./data  : no message is lost if internet / Apps Script / the PC is down
 *  - Auto reconnect            : WhatsApp (watchdog) and IMAP (instant mail with IDLE)
 *  - Catch-up                  : WhatsApp messages received while the PC was off are imported on start
 *  - Duplicate protection      : WhatsApp ids + mail Message-ID, also checked again inside Apps Script
 *  - ngrok URL auto-sync       : BRIDGE_URL in Apps Script is updated by itself
 *
 * Settings: config.json (see config.example.json) or environment variables.
 *   ENABLE_TEST=1  enables the /test diagnostic route (off by default)
 */
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const express = require('express');
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const VERSION = '3.3.0';
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
const NO_WA = process.env.NO_WA === '1';
const NO_MAIL = process.env.NO_MAIL === '1';
const ENABLE_TEST = process.env.ENABLE_TEST === '1' || cfg.ENABLE_TEST === true;
const TRACK_GROUPS = String(process.env.TRACK_GROUPS || cfg.TRACK_GROUPS || 'true') !== 'false';
const SKIP_WA_TYPES = new Set([
  'e2e_notification', 'notification_template', 'notification', 'gp2',
  'call_log', 'protocol', 'broadcast_notification'
]);
// Only the portal (Google Apps Script / Google-hosted pages) may call the bridge from a browser.
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
  catch (e) {                                            // Windows can refuse rename over an open file: copy instead
    fs.copyFileSync(t, f); try { fs.unlinkSync(t); } catch (x) {}
  }
}
function safeEq(a, b) {                                  // constant-time string compare
  const x = Buffer.from(String(a == null ? '' : a)), y = Buffer.from(String(b == null ? '' : b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function errorText(e) {
  if (e && e.message) return String(e.message);
  if (typeof e === 'string') return e;
  try { return JSON.stringify(e); } catch (x) { return String(e || 'unknown error'); }
}
function arrayOrEmpty(value) { return Array.isArray(value) ? value : []; }

process.on('uncaughtException', e => log('UNCAUGHT', e && e.stack || e));
process.on('unhandledRejection', e => log('UNHANDLED', e && e.stack || e));

if (!APPS_SCRIPT_URL || !API_KEY || /XXXX/.test(APPS_SCRIPT_URL) || /paste/i.test(API_KEY)) {
  log('config.json is not filled. Set APPS_SCRIPT_URL and API_KEY, then start again.');
  process.exit(2);
}

/* ---------------------------------------------------------------- state */
const MEDIA = path.join(DATA, 'media');
fs.mkdirSync(MEDIA, { recursive: true });
const FILE_MAX = 10 * 1024 * 1024;                       // same limit as the portal
const QFILE = path.join(DATA, 'queue.json');
const FFILE = path.join(DATA, 'failed.json');
const SFILE = path.join(DATA, 'seen.json');
const STFILE = path.join(DATA, 'state.json');
const GFILE = path.join(DATA, 'group_names.json');
let queue = loadJson(QFILE, []);
let seen = new Set(loadJson(SFILE, []));
let state = loadJson(STFILE, {});
let groupNames = loadJson(GFILE, {});
const stats = { delivered: 0, started: Date.now() };
const agentByMsg = new Map();
let whatsappSendInflight = 0;

// Realtime push key: derived from the API key, can only trigger a page refresh (no data is sent).
const RT_KEY = crypto.createHash('sha256').update(API_KEY + ':rt').digest('hex').slice(0, 24);
// Browser session for the QR page: random per process start, stored only in an HttpOnly cookie.
const SESSION_TOKEN = crypto.randomBytes(24).toString('hex');
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
        ', final-url ' + res.url +
        (looksHtml ? ', response is HTML' : '') +
        '). Deploy the latest Code.gs as Web app, execute as yourself, with access "Anyone". Response: ' + preview);
    }
    if (j.ok === false) { const e = new Error(j.error || 'rejected'); e.app = !/bad key/.test(j.error || ''); throw e; }
    return j;
  } finally { clearTimeout(t); }
}

/* ---------------------------------------------------------------- attachments (kept on disk until the portal has them) */
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'video/mp4': '.mp4', 'application/pdf': '.pdf' };
function saveMedia(name, mime, buf) {
  mime = String(mime || 'application/octet-stream').split(';')[0].trim().toLowerCase();
  if (!name) name = 'file_' + Date.now() + (EXT[mime] || '');
  const p = path.join(MEDIA, crypto.randomUUID() + '.bin');
  fs.writeFileSync(p, buf);
  return { name: String(name).slice(0, 120), mime, size: buf.length, path: p };
}
// Queue items keep only a path; the base64 is read right before the upload.
// A missing file on disk no longer blocks the queue: the message is sent without it, with a note.
function inflate(payload) {
  if (!payload.files || !payload.files.length) return payload;
  const files = [];
  let lost = 0;
  for (const f of payload.files) {
    try {
      files.push({ name: f.name, mime: f.mime, data: fs.readFileSync(f.path).toString('base64') });
    } catch (e) {
      lost++;
      log('attachment missing on disk, skipping:', f.name, '-', e.code || e.message);
    }
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
// Picks the first item that is ready (not the head), so one failing item never blocks the others.
// If the portal itself is unreachable (network error), every item backs off together to keep order.
async function pump() {
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
        await callScript(inflate(item.payload));
        const i = queue.indexOf(item); if (i >= 0) queue.splice(i, 1);
        saveJson(QFILE, queue); stats.delivered++; dropMedia(item.payload);
        if (item.payload.action === 'incoming') emit('msg');
      } catch (e) {
        item.tries++;
        if (e.app && item.tries >= 8) {                  // poison message: park it, never block the queue
          const i = queue.indexOf(item); if (i >= 0) queue.splice(i, 1);
          saveJson(QFILE, queue);
          const f = loadJson(FFILE, []); f.push({ at: new Date().toISOString(), error: e.message, payload: item.payload }); saveJson(FFILE, f.slice(-200));
          log('PARKED message after 8 rejections:', e.message, '(see data/failed.json)');
          continue;
        }
        const backoff = Math.min(60000, 1000 * Math.pow(2, Math.min(item.tries, 6)));
        const until = Date.now() + backoff;
        if (e.app) item.next = until;                    // only this message is bad: others keep flowing
        else queue.forEach(q => { q.next = Math.max(q.next, until); });   // portal/network down: pause all
        saveJson(QFILE, queue);
        log('delivery to portal failed (try ' + item.tries + '): ' + e.message + ' - retry in ' + Math.round(backoff / 1000) + 's');
      }
    }
  } finally { pumping = false; }
}
setInterval(() => { if (queue.length) pump(); }, 5000);

async function withRetry(fn, tries = 3, delay = 800) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; if (e.noRetry) break; await sleep(delay * (i + 1)); }
  }
  throw last;
}

/* ---------------------------------------------------------------- WhatsApp */
let wa = null, restarting = false, waBad = 0, lastRestartAt = 0;
let waState = { status: NO_WA ? 'disabled' : 'starting', qr: null, since: Date.now() };
const callObjects = new Map();

function clearWAChromeLocks() {
  const sessionDir = path.join(ROOT, 'wa_session');
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (['SingletonLock', 'SingletonCookie', 'SingletonSocket'].includes(entry.name)) {
        try { fs.unlinkSync(fullPath); } catch (e) {}
      }
    }
  }
  walk(sessionDir);
}

// whatsapp-web.js passes an internal MediaData `__x_id` to the outgoing Msg model. WhatsApp Web then
// treats it as the message id and fails with "Data passed to getter must include an id property".
// This applies the upstream workaround and logs whether it was applied, so a silent skip is visible.
function patchWhatsAppWebJs() {
  try {
    const injectedFile = path.join(ROOT, 'node_modules', 'whatsapp-web.js', 'src', 'util', 'Injected', 'Utils.js');
    if (!fs.existsSync(injectedFile)) { log('whatsapp-web.js not found at expected path - is the package installed?'); return; }
    const source = fs.readFileSync(injectedFile, 'utf8');
    const marker = 'delete message.__x_id;';
    if (source.includes(marker)) {
      log('whatsapp-web.js outgoing-media ID workaround already present');
    } else {
      const objectEnd = /(\s*\.\.\.extraOptions,?\r?\n\s*\};)/;
      if (objectEnd.test(source)) {
        fs.writeFileSync(injectedFile, source.replace(objectEnd, match => match + '\n\n        // Prevent MediaData internals from replacing the Msg id.\n        ' + marker));
        log('Applied whatsapp-web.js outgoing-media ID workaround');
      } else {
        log('WARNING: could not find the Utils.js block to patch (library version differs). Pin whatsapp-web.js to 1.34.7 in package.json.');
      }
    }

    const messageFile = path.join(ROOT, 'node_modules', 'whatsapp-web.js', 'src', 'structures', 'Message.js');
    if (fs.existsSync(messageFile)) {
      const src2 = fs.readFileSync(messageFile, 'utf8');
      const marker2 = 'mimetype: msg.mimetype,';
      const needle = /(\s*)signal: new AbortController\(\)\.signal,/;
      if (!src2.includes(marker2) && needle.test(src2)) {
        fs.writeFileSync(messageFile, src2.replace(needle, (m, ws) => ws + marker2 + m));
        log('Applied whatsapp-web.js incoming-media MIME workaround');
      }
    }

    const clientFile = path.join(ROOT, 'node_modules', 'whatsapp-web.js', 'src', 'Client.js');
    if (fs.existsSync(clientFile)) {
      const clientSource = fs.readFileSync(clientFile, 'utf8');
      const socketNeedle = "            let state = window.require('WAWebSocketModel').Socket.state;";
      const socketPatch = `            let socketModel = window.require('WAWebSocketModel');
            for (let i = 0; i < 150 && !socketModel?.Socket; i++) {
                await new Promise(r => setTimeout(r, 200));
                socketModel = window.require('WAWebSocketModel');
            }
            if (!socketModel?.Socket) throw new Error('WhatsApp Web socket model was not ready');
            let state = socketModel.Socket.state;`;
      if (clientSource.includes(socketNeedle)) {
        fs.writeFileSync(clientFile, clientSource.replace(socketNeedle, socketPatch));
        log('Applied WhatsApp Web socket readiness workaround');
      } else if (!clientSource.includes('for (let i = 0; i < 150 && !socketModel?.Socket; i++)')) {
        log('WARNING: WhatsApp Web socket readiness patch target was not found');
      }
    }
  } catch (e) {
    log('Could not apply whatsapp-web.js workaround:', e.message);
  }
}

// Errors that mean the WhatsApp Web page/session is broken and needs a restart.
function isStaleSessionError(e) {
  return /execution context was destroyed|target closed|browser.*disconnected|session closed|protocol error|must include an id|is not a function|getter must include/i
    .test(String(e && e.message || e));
}
function requestRestart(reason) {
  // Cooldown: avoid restart loops if many sends fail in a row.
  if (Date.now() - lastRestartAt < 120000) return;
  lastRestartAt = Date.now();
  setTimeout(() => restartWA(reason), 1000);
}

async function initWhatsApp() {
  if (NO_WA) return;
  patchWhatsAppWebJs();
  clearWAChromeLocks();
  const { Client, LocalAuth } = require('whatsapp-web.js');
  const puppeteer = require('puppeteer');
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath();
  if (!executablePath) throw new Error('Puppeteer executable path could not be resolved');
  log('Using Puppeteer Chrome:', executablePath);
  waState = { status: 'starting', qr: null, since: Date.now() };
  wa = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(ROOT, 'wa_session') }),
    takeoverOnConflict: false,
    puppeteer: { executablePath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] }
  });
  const me = wa;
  wa.on('qr', async qr => { if (me !== wa) return; waState = { status: 'qr', qr: await QRCode.toDataURL(qr, { margin: 1, width: 300 }), since: Date.now() }; log('WhatsApp: scan the QR code (open the QR page)'); });
  wa.on('authenticated', () => { if (me === wa) { waState = { status: 'authenticated', qr: null, since: Date.now() }; log('WhatsApp: authenticated'); } });
  wa.on('auth_failure', m => { if (me === wa) { waState = { status: 'auth_failure', qr: null, since: Date.now() }; log('WhatsApp: auth failure', m); } });
  wa.on('ready', () => {
    if (me !== wa) return;
    waState = { status: 'ready', qr: null, since: Date.now() }; waBad = 0;
    log('WhatsApp: connected');
    const since = Math.floor(Date.now() / 1000) - 60 * 86400;
    const fullSync = async () => {
      try { await syncWhatsAppChats(); }
      catch (e) { log('WhatsApp chat sync failed:', errorText(e)); }
      try { await catchUp(since); }
      catch (e) { log('WhatsApp catch-up failed:', errorText(e)); }
      try { await syncWhatsAppChats(); }
      catch (e) { log('WhatsApp chat re-sync failed:', errorText(e)); }
    };
    fullSync().finally(() => saveState({ lastWaTs: Math.floor(Date.now() / 1000) }));
    refreshGroupNames().catch(e => log('WhatsApp group-name refresh failed:', e.message));
    setTimeout(() => refreshGroupNames().catch(e => log('WhatsApp group-name retry failed:', e.message)), 15000);
    setTimeout(() => refreshGroupNames().catch(e => log('WhatsApp group-name retry failed:', e.message)), 60000);
    // A two-month window on every reconnect imports history missed while the PC was down.
    setTimeout(() => {
      syncWhatsAppChats().catch(e => log('WhatsApp chat re-sync failed:', errorText(e)));
      catchUp(since).catch(e => log('WhatsApp catch-up retry failed:', errorText(e)));
    }, 30000);
  });
  wa.on('disconnected', r => { if (me === wa) { log('WhatsApp: disconnected (' + r + ')'); restartWA('disconnected: ' + r); } });
  wa.on('change_state', s => { if (me === wa && (s === 'CONFLICT' || s === 'UNLAUNCHED')) { log('WhatsApp state', s, '- resetting'); try { wa.resetState(); } catch (e) {} } });
  wa.on('message_create', msg => { handleWaMessage(msg).catch(e => log('wa message error:', e.message)); });
  wa.on('message_ack', (msg, ack) => {
    if (!msg || !msg.fromMe || !msg.to || !/@(c\.us|lid|g\.us)$/.test(msg.to)) return;
    enqueue({ action: 'waAck', messageId: msg.id && msg.id._serialized ? msg.id._serialized : '', chatId: msg.to, ack: Number(ack) || 0 });
  });
  wa.on('message_revoke_everyone', (after, before) => {
    const msg = before || after;
    if (!msg || !msg.id) return;
    const rawChatId = msg.fromMe ? msg.to : msg.from;
    const chatId = /@g\.us$/.test(String(rawChatId || '')) ? rawChatId : normalizeWaContact(rawChatId);
    if (!chatId || !/@(c\.us|lid|g\.us)$/.test(chatId)) return;
    enqueue({ action: 'waRevoke', messageId: msg.id._serialized || '', chatId });
  });
  const handleIncomingCall = call => {
    if (!call || !call.from || call.fromMe || !/@(c\.us|lid|g\.us)$/.test(call.from)) return;
    const id = String(call.id || '');
    if (!id || callObjects.has(id)) return;
    callObjects.set(id, call);
    setTimeout(() => callObjects.delete(id), 180000);
    const base = { action: 'waCall', callId: id, chatId: call.from, isVideo: !!call.isVideo, isGroup: !!call.isGroup, time: Number(call.timestamp) * 1000 || Date.now() };
    wa.getContactById(call.from).then(c => {
      enqueue(Object.assign(base, { name: String(c && (c.pushname || c.name || c.number) || '').trim() }));
    }).catch(() => enqueue(Object.assign(base, { name: '' })));
  };
  wa.on('incoming_call', handleIncomingCall);
  wa.on('call', handleIncomingCall);
  wa.initialize().catch(e => { if (me === wa) { waState = { status: 'error', qr: null, since: Date.now() }; log('WhatsApp init failed:', e && e.stack || e); } });
}

function killProcessTree(pid) {
  return new Promise(resolve => {
    if (!pid) return resolve();
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve());
    } else {
      try { process.kill(pid, 'SIGKILL'); } catch (e) {}
      resolve();
    }
  });
}

async function restartWA(reason) {
  if (restarting || NO_WA) return;
  restarting = true;
  log('WhatsApp: restarting (' + reason + ')');
  waState = { status: 'restarting', qr: null, since: Date.now() };
  const old = wa; wa = null;
  // A detached WhatsApp Web frame can make Client.destroy() hang while Chromium keeps the
  // LocalAuth profile locked. Capture the process first so initialize() does not fail later.
  const browser = old && old.pupBrowser;
  const browserPid = browser && typeof browser.process === 'function' && browser.process() && browser.process().pid;
  try { if (old) await Promise.race([old.destroy(), sleep(15000)]); } catch (e) {}
  try {
    if (browser && typeof browser.isConnected === 'function' && browser.isConnected()) await browser.close();
  } catch (e) {}
  await killProcessTree(browserPid);
  await sleep(4000);
  restarting = false;
  initWhatsApp().catch(e => { waState = { status: 'error', qr: null, since: Date.now() }; log('WhatsApp setup failed:', e.message); });
}
setInterval(() => { refreshGroupNames().catch(() => {}); }, 5 * 60 * 1000);

// phone digits -> the exact WhatsApp id that sent to us (c.us or lid). Used for replies, because the
// phone lookup (getNumberId) can return nothing for some contacts even though they can receive messages.
const knownWaId = new Map();
function normalizeWaContact(raw) {
  let value = String(raw || '').trim().replace(/^wa:/i, '');
  if (value.endsWith('@g.us')) return value.toLowerCase();
  value = value.replace(/@(s\.whatsapp\.net|c\.us|lid)$/i, '').replace(/^.*:/, '');
  value = value.replace(/[^\d]/g, '');
  return value;
}
function cleanWaPhone(raw, source) {
  const serialized = String(source || raw || '').toLowerCase();
  if (serialized.includes('@lid')) return '';
  return normalizeWaContact(raw || source);
}
// Real phone number of a WhatsApp id. New WhatsApp hides the number behind an "@lid" id; this asks WhatsApp for the real one.
// Returns '' when WhatsApp does not tell (then the lid digits are used, as before).
const phoneCache = new Map();
async function phoneOf(wid) {
  wid = String(wid || '');
  if (!/@lid$/i.test(wid)) return normalizeWaContact(wid);
  if (phoneCache.has(wid)) return phoneCache.get(wid);
  const lidDigits = normalizeWaContact(wid);
  const ok = v => { const d = normalizeWaContact(v); return d && d !== lidDigits ? d : ''; };
  let out = '';
  try {
    if (wa && typeof wa.getContactLidAndPhone === 'function') {
      const r = await wa.getContactLidAndPhone([wid]);
      const row = Array.isArray(r) ? r[0] : r;
      out = ok(row && (row.pn || row.phone));
    }
  } catch (e) {}
  if (!out) { try { const c = await wa.getContactById(wid); out = ok(c && c.number); } catch (e) {} }
  if (!out && wa && wa.pupPage) {
    try {
      const v = await wa.pupPage.evaluate(id => {
        try {
          const w = window.require('WAWebWidFactory').createWid(id);
          const c = window.require('WAWebContactCollection').ContactCollection.get(w);
          const pn = c && (c.phoneNumber || (c.__x_phoneNumber));
          return pn ? (pn._serialized || String(pn)) : '';
        } catch (e) { return ''; }
      }, wid);
      out = ok(v);
    } catch (e) {}
  }
  if (out) phoneCache.set(wid, out);
  return out;
}
// Name exactly like WhatsApp shows it: only a name SAVED in the phone's address book. Unsaved contacts show their number.
function savedName(c) {
  if (!c) return '';
  const nm = String(c.name || '').trim(), push = String(c.pushname || '').trim();
  if (c.isMyContact || (nm && nm !== push)) return String(c.name || c.shortName || '').trim();
  return '';
}
async function resolveSender(msg) {
  let from = normalizeWaContact(msg.from);
  const push0 = String(msg._data && (msg._data.notifyName || msg._data.senderName) || '').trim();
  let name = '', push = push0;
  let hasNumber = false;
  const lidFrom = /@lid$/i.test(String(msg.from || ''));
  try {
    const c = await msg.getContact();
    name = savedName(c);
    push = String(c.pushname || push0 || '').trim();
    const n = c.number ? normalizeWaContact(c.number) : '';
    if (n && !(lidFrom && n === normalizeWaContact(msg.from))) { from = n; hasNumber = true; }
    else if (c.id && c.id._serialized) from = normalizeWaContact(c.id._serialized);
  } catch (e) {}
  if (!hasNumber && lidFrom) { const p = await phoneOf(msg.from); if (p) from = p; else if (!name) name = push; }   // real number unknown: the public name is better than a fake number
  return { from, name };
}
async function resolveGroupName(msg, groupIdOverride) {
  const metaSubject = msg._data && msg._data.groupMetadata && (msg._data.groupMetadata.subject || msg._data.groupMetadata.name);
  let name = String(msg._data && (msg._data.chatName || msg._data.groupName || metaSubject || (msg._data.chat && (msg._data.chat.name || msg._data.chat.formattedTitle || msg._data.chat.subject))) || '').trim();
  if (name && !/^whatsapp group$/i.test(name)) return name;
  const groupId = String(groupIdOverride || msg.from || '');
  if (groupNames[groupId]) return groupNames[groupId];
  const chats = [];
  try { chats.push(await msg.getChat()); } catch (e) {}
  try { if (wa && groupId) chats.push(await wa.getChatById(groupId)); } catch (e) {}
  for (const chat of chats) {
    name = String(chat && (chat.name || chat.formattedTitle || (chat.groupMetadata && chat.groupMetadata.subject) || '') || '').trim();
    if (name && !/^whatsapp group$/i.test(name)) {
      if (chat && chat.id && chat.id._serialized && chat.id._serialized.endsWith('@g.us')) {
        groupNames[chat.id._serialized] = name;
        saveJson(GFILE, groupNames);
      }
      return name;
    }
  }
  // Query only the current group record from WhatsApp Web's store.
  try {
    if (wa && wa.pupPage && groupId && groupId.endsWith('@g.us')) {
      name = String(await wa.pupPage.evaluate(async groupId => {
        const collections = window.require && window.require('WAWebCollections');
        const store = window.Store || (window.WWebJS && window.WWebJS.store) || collections;
        if (!store) return '';
        const chat = store.Chat && store.Chat.get && store.Chat.get(groupId);
        if (!chat) return '';
        const meta = chat.groupMetadata || (store.GroupMetadata && store.GroupMetadata.get && store.GroupMetadata.get(groupId));
        return chat.name || chat.formattedTitle || chat.subject || (meta && (meta.subject || meta.name)) || '';
      }, groupId) || '').trim();
      if (name && !/^whatsapp group$/i.test(name)) {
        groupNames[groupId] = name;
        saveJson(GFILE, groupNames);
        return name;
      }
    }
  } catch (e) {}
  // The full chat list still contains the visible group name on some WhatsApp Web builds.
  try {
    if (wa && groupId && typeof wa.getChats === 'function') {
      const all = arrayOrEmpty(await wa.getChats());
      const found = all.find(chat => {
        const id = chat && chat.id;
        return id && (id._serialized === groupId || id.user + '@' + id.server === groupId);
      });
      name = String(found && (found.name || found.formattedTitle || (found.groupMetadata && found.groupMetadata.subject) || '') || '').trim();
      if (name && !/^whatsapp group$/i.test(name)) {
        groupNames[groupId] = name;
        saveJson(GFILE, groupNames);
        return name;
      }
    }
  } catch (e) {}
  return '';
}

async function refreshGroupNames() {
  if (!wa || waState.status !== 'ready') return;
  try {
    let changed = false;
    if (wa.pupPage) {
      const rows = await wa.pupPage.evaluate(async () => {
        const collections = window.require && window.require('WAWebCollections');
        const store = window.Store || (window.WWebJS && window.WWebJS.store) || collections;
        if (!store || !store.Chat) return [];
        let models = [];
        try {
          if (store.Chat.getModelsArray) models = store.Chat.getModelsArray();
          else if (store.Chat.models) models = store.Chat.models;
        } catch (e) {}
        return (Array.isArray(models) ? models : []).filter(chat => chat && chat.id && String(chat.id._serialized || '').endsWith('@g.us')).map(chat => ({
          id: String(chat.id._serialized || ''),
          name: String(chat.name || chat.formattedTitle || chat.subject || '').trim()
        }));
      });
      for (const row of rows) {
        const name = String(row.name || '').trim();
        if (name && !/^whatsapp group$/i.test(name) && groupNames[row.id] !== name) {
          groupNames[row.id] = name;
          changed = true;
        }
      }
    }
    if (changed) saveJson(GFILE, groupNames);
    for (const [contact, name] of Object.entries(groupNames)) {
      if (contact.endsWith('@g.us') && String(name).trim() && !/^whatsapp group$/i.test(name)) {
        callScript({ action: 'syncGroupName', chatId: contact, name }, 20000).catch(() => {});
      }
    }
  } catch (e) {
    log('WhatsApp group-name refresh failed:', e.message);
  }
}

// WhatsApp Web sometimes fails to resolve media when only the serialized id is passed to Msg.get().
// This runtime fallback tries the full id, reconstructed WIDs, and the message collection.
async function downloadWaMediaRaw(msg) {
  if (!wa || !wa.pupPage || !msg || !msg.id) return null;
  return wa.pupPage.evaluate(async (msgId) => {
    const collections = window.require && window.require('WAWebCollections');
    const factory = window.require && window.require('WAWebWidFactory');
    if (!collections || !collections.Msg) throw new Error('WhatsApp message store unavailable');
    const found = [];
    const add = x => { if (x && !found.includes(x)) found.push(x); };
    const serialized = msgId._serialized || String(msgId);
    const widText = value => {
      if (typeof value === 'string') return value;
      if (!value) return '';
      return value._serialized || (value.user && value.server ? value.user + '@' + value.server : '');
    };
    const candidates = [];
    const addCandidate = value => { if (value && !candidates.includes(value)) candidates.push(value); };
    addCandidate(msgId);
    addCandidate(serialized);
    if (msgId.id) addCandidate(msgId.id);
    const key = Object.assign({}, msgId);
    if (factory) {
      const remote = widText(key.remote);
      const participant = widText(key.participant);
      if (remote) key.remote = factory.createWid(remote);
      if (participant) key.participant = factory.createWid(participant);
    }
    addCandidate(key);
    for (const candidate of candidates) {
      try { add(collections.Msg.get(candidate)); } catch (e) {}
      try {
        const r = await collections.Msg.getMessagesById([candidate]);
        add(r && r.messages && r.messages[0]);
      } catch (e) {}
      if (found.length) break;
    }
    if (!found.length) {
      const models = collections.Msg.getModelsArray ? collections.Msg.getModelsArray() : (collections.Msg.models || collections.Msg._models || []);
      for (const m of (Array.isArray(models) ? models : [])) {
        if (m && (m.id && (m.id._serialized === serialized || m.id.id === msgId.id))) { add(m); break; }
      }
    }
    const model = found[0];
    if (!model || !model.mediaData) throw new Error('WhatsApp media message was not found');
    const manager = window.require('WAWebDownloadManager').downloadManager;
    const download = async () => manager.downloadAndMaybeDecrypt({
      directPath: model.directPath, encFilehash: model.encFilehash, filehash: model.filehash,
      mediaKey: model.mediaKey, mediaKeyTimestamp: model.mediaKeyTimestamp, type: model.type,
      mimetype: model.mimetype,
      signal: new AbortController().signal,
      downloadQpl: { addAnnotations() { return this; }, addPoint() { return this; } }
    });
    let decrypted;
    try {
      if (!model.directPath) throw new Error('WhatsApp media has no directPath');
      decrypted = await download();
    } catch (directError) {
      if (model.mediaData.mediaStage === 'REUPLOADING' || String(model.mediaData.mediaStage || '').includes('ERROR')) return null;
      await model.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });
      if (model.mediaData.mediaStage === 'REUPLOADING' || String(model.mediaData.mediaStage || '').includes('ERROR')) return null;
      decrypted = await download();
    }
    return {
      data: await window.WWebJS.arrayBufferToBase64Async(decrypted),
      mimetype: model.mimetype, filename: model.filename, filesize: model.size
    };
  }, msg.id);
}
function cleanMedia(md, msg) {
  const data = String(md.data).replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
  if (!data) throw new Error('WhatsApp returned empty media data');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('WhatsApp returned invalid base64 media');
  if (Math.floor(data.length * 3 / 4) > FILE_MAX) throw new Error('WhatsApp media exceeds 10 MB');
  return Object.assign({}, md, {
    data,
    mimetype: String(md.mimetype || msg._data && msg._data.mimetype || 'application/octet-stream').split(';')[0].trim(),
    filename: String(md.filename || msg._data && msg._data.filename || '').trim() ||
      ('whatsapp-' + Date.now() + (String(msg.type || '').toLowerCase() === 'image' ? '.jpg' : ''))
  });
}
async function downloadWaMedia(msg) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0 && typeof msg.reload === 'function') { try { await msg.reload(); } catch (e) {} }
      const media = await msg.downloadMedia();
      if (media && media.data) return cleanMedia(media, msg);
      throw new Error('WhatsApp returned empty media');
    } catch (e) {
      last = e;
      try {
        const raw = await downloadWaMediaRaw(msg);
        if (raw && raw.data) return cleanMedia(raw, msg);
      } catch (fallbackError) { last = fallbackError; }
      if (attempt < 2) await sleep(1000 * (attempt + 1));
    }
  }
  // WhatsApp Web can expose a stale message object after reconnect; reload it once.
  try {
    const id = msg.id && msg.id._serialized;
    if (wa && id && typeof wa.getMessageById === 'function') {
      const fresh = await wa.getMessageById(id);
      if (fresh) {
        const media = await fresh.downloadMedia();
        if (media && media.data) return cleanMedia(media, msg);
      }
    }
  } catch (e) { last = e; }
  throw last || new Error('Could not download WhatsApp media');
}
async function handleWaMessage(msg) {
  if (!msg || msg.isStatus) return;
  const msgType = String(msg.type || msg._data && msg._data.type || '').toLowerCase();
  const msgSubtype = String(msg._data && msg._data.subtype || '').toLowerCase();
  const msgBodyHint = String(msg.body || msg._data && msg._data.body || '').trim().toLowerCase();
  if (SKIP_WA_TYPES.has(msgType) || /notification|e2e|protocol|gp2/.test(msgType + ' ' + msgSubtype) ||
      /^(?:\[)?(?:e2e_notification|notification_template|notification)(?:\]|\b)/.test(msgBodyHint) ||
      /e2e notification received|encryption notification/.test(msgBodyHint)) return;
  const chatId = msg.fromMe ? msg.to : msg.from;
  if (!chatId || !/@(c\.us|lid|g\.us)$/.test(chatId)) return;
  if (/@(broadcast|newsletter)$/.test(chatId) || chatId === 'status@broadcast') return;
  const isGroup = /@g\.us$/.test(chatId);
  if (isGroup && !TRACK_GROUPS) return;
  const extId = msg.id && msg.id._serialized ? 'wa:' + msg.id._serialized : null;
  if (extId && seen.has(extId)) return;
  let outgoingAgent = '';
  let outgoingAgentName = '';
  if (msg.fromMe && extId) {
    // message_create can fire before sendWhatsApp() has recorded which agent sent it: wait briefly.
    const wid = extId.replace(/^wa:/, '');
    let known = agentByMsg.get(wid);
    for (let i = 0; !known && whatsappSendInflight > 0 && i < 20; i++) { await sleep(100); known = agentByMsg.get(wid); }
    if (known) { outgoingAgent = known.agent || ''; outgoingAgentName = known.agentName || ''; }
  }
  let s, groupName = '';
  if (isGroup) {
    s = { from: chatId, name: msg.fromMe ? 'Phone (WhatsApp)' : '' };
    const rawAuthor = String(msg.author || '').trim();
    const authorSource = rawAuthor.toLowerCase();
    if (!msg.fromMe) {
      s.name = String(msg._data && (msg._data.notifyName || msg._data.senderName) || '').trim();
      if (!s.name && msg.authorName) s.name = String(msg.authorName).trim();
      if (!s.name && rawAuthor) {
        try { const contact = await msg.getContact(); s.name = String(contact.pushname || contact.name || contact.number || '').trim(); } catch (e) {}
      }
      s.number = authorSource.includes('@lid') ? '' : cleanWaPhone(rawAuthor, authorSource);
      if (!s.number && rawAuthor && !rawAuthor.includes('@lid')) s.number = rawAuthor.split('@')[0];
    } else {
      s.number = '';
    }
    groupName = await resolveGroupName(msg, chatId);
  } else {
    s = await resolveSender(msg);
    if (msg.fromMe) { const p = /@lid$/i.test(chatId) ? await phoneOf(chatId) : ''; s = { from: p || chatId, name: 'Phone (WhatsApp)' }; }
    // remember which exact WhatsApp id to answer to (for fromMe the customer is msg.to, never our own id)
    const sendId = msg.fromMe ? msg.to : msg.from;
    for (const d of [String(s.from).replace(/\D/g, ''), String(sendId || '').replace(/\D/g, '')]) if (d && sendId) knownWaId.set(d, sendId);
  }
  let body = (msg.body && String(msg.body).trim()) ? String(msg.body) : '';
  const files = [];
  if (msg.hasMedia) {
    try {
      const md = await downloadWaMedia(msg);
      if (md && md.data) {
        const buf = Buffer.from(md.data, 'base64');
        if (buf.length > FILE_MAX) body = (body ? body + '\n' : '') + '[file too large to show: ' + (md.filename || msg.type) + ']';
        else files.push(saveMedia(md.filename, md.mimetype, buf));
      }
    } catch (e) {
      log('media download failed:', String(e && (e.stack || e.message) || e));
      body = body || '[' + (msg.type || 'media') + ' received - could not download]';
    }
  } else if (!body) body = '[' + (msg.type || 'message') + ' received]';
  let payloadQuotedId = '';
  if (msg.hasQuotedMsg) {
    try {
      const quoted = await msg.getQuotedMessage();
      if (quoted && quoted.id && quoted.id._serialized) payloadQuotedId = quoted.id._serialized;
    } catch (e) {}
  }
  const payload = { action: 'incoming', channel: 'whatsapp', from: s.from, name: s.name, fromMe: !!msg.fromMe, body,
    messageId: extId ? extId.replace(/^wa:/, '') : '', quotedId: payloadQuotedId, time: Number(msg.timestamp) * 1000 || Date.now() };
  if (msg.fromMe) Object.assign(payload, { agent: outgoingAgent, agentName: outgoingAgentName });
  if (isGroup) Object.assign(payload, { group: true, groupName: groupName || 'WhatsApp group', senderName: s.name, senderNumber: s.number });
  if (files.length) payload.files = files;
  if (enqueue(payload, extId)) {
    if (msg.timestamp) state.lastWaTs = Math.max(state.lastWaTs || 0, msg.timestamp);
  } else {
    dropMedia(payload);                                  // duplicate: do not leave an orphan file on disk
  }
}
async function syncWhatsAppChats() {
  if (!wa || waState.status !== 'ready') return { ok: false };
  let libraryChats;
  try {
    libraryChats = await withRetry(() => wa.getChats(), 4, 1500);
    if (!Array.isArray(libraryChats)) throw new Error('WhatsApp getChats returned a non-array result');
  } catch (e) {
    log('WhatsApp store/getChats unavailable, using raw chat-store fallback:', errorText(e));
    if (!wa.pupPage) throw new Error('WhatsApp chat store unavailable');
    try {
      libraryChats = await wa.pupPage.evaluate(() => {
        const collections = window.require && window.require('WAWebCollections');
        if (!collections || !collections.Chat) return [];
        const models = collections.Chat.getModelsArray ? collections.Chat.getModelsArray() :
          (collections.Chat.models || collections.Chat._models || []);
        return (Array.isArray(models) ? models : []).map(chat => {
          const data = chat && chat.__x || chat && chat._models || chat && chat._data || chat;
          const id = chat && chat.id && (typeof chat.id === 'string' ? chat.id : chat.id._serialized || '');
          return {
            id: typeof id === 'string' ? { _serialized: id, server: id.split('@')[1] || '', user: id.split('@')[0] || '' } : chat.id,
            name: String(chat && (chat.name || chat.formattedTitle || chat.contact && chat.contact.name) || '').trim(),
            unreadCount: Number(chat && (chat.unreadCount || 0)) || 0,
            timestamp: Number(chat && (chat.timestamp || chat.t || 0)) || 0,
            _data: data || {}
          };
        });
      });
    } catch (fallbackError) {
      throw new Error('WhatsApp raw chat-store fallback failed: ' + errorText(fallbackError));
    }
  }
  if (!Array.isArray(libraryChats)) libraryChats = [];
  const chats = [];
  for (const c of libraryChats) {
    const serialized = String(c.id && c.id._serialized || '');
    if (!/@(c\.us|lid|g\.us)$/.test(serialized)) continue;
    if (/@(broadcast|newsletter)$/.test(serialized) || serialized === 'status@broadcast') continue;
    const isGroup = serialized.endsWith('@g.us');
    if (isGroup && !TRACK_GROUPS) continue;
    let name = '', window_push = '';
    let phone = serialized.split('@')[0];
    if (!isGroup) {
      try {
        const contact = await c.getContact();
        name = savedName(contact);
        window_push = String(contact && contact.pushname || '').trim();
        phone = String(contact && contact.number || c.id && c.id.user || phone).trim();
        phone = normalizeWaContact(phone);
      } catch (e) {}
      if (String(c.id && c.id.server || '').toLowerCase() === 'lid') {
        const real = await phoneOf(serialized);          // real number instead of the hidden lid id
        if (real) phone = real;
        else { phone = normalizeWaContact(serialized); if (!name) name = window_push; }
      }
      if (!phone) phone = normalizeWaContact(serialized);
      if (!phone) phone = serialized.split('@')[0];
    } else {
      name = String(c.name || c.formattedTitle || '').trim();
      if (!name || /^whatsapp group$/i.test(name)) name = await resolveGroupName({ _data: c._data }, serialized);
    }
    chats.push({
      id: isGroup ? serialized : normalizeWaContact(phone || serialized),
      name: name || (isGroup ? 'WhatsApp group' : ''),
      phone,
      unread: Number(c.unreadCount) || 0,
      isGroup,
      timestamp: Number(c.timestamp || c.t || 0) * 1000 || Date.now()
    });
  }
  const result = await callScript({ action: 'syncWhatsAppChats', chats }, 120000);
  log('WhatsApp chat sync:', chats.length, 'chat(s),', result && result.upserted || 0, 'updated');
  return result;
}

async function catchUp(since) {
  try {
    let chats = [];
    try {
      const libraryChats = await withRetry(() => wa.getChats(), 4, 1200);
      if (!Array.isArray(libraryChats)) throw new Error('WhatsApp getChats returned a non-array result');
      chats = libraryChats
        .filter(c => c.id && (['c.us', 'lid'].includes(c.id.server) || (TRACK_GROUPS && c.id.server === 'g.us')))
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    } catch (e) {
      try {
        const ids = await wa.pupPage.evaluate(() => {
          const collections = window.require && window.require('WAWebCollections');
          if (!collections || !collections.Chat) return [];
          const models = collections.Chat.getModelsArray ? collections.Chat.getModelsArray() :
            (collections.Chat.models || collections.Chat._models || []);
          return (Array.isArray(models) ? models : []).map(chat => chat && chat.id && (chat.id._serialized || String(chat.id))).filter(Boolean);
        });
        for (const id of ids) {
          if (!/@(c\.us|lid|g\.us)$/.test(id)) continue;
          if (!TRACK_GROUPS && id.endsWith('@g.us')) continue;
          try { chats.push(await wa.getChatById(id)); } catch (fallbackChatError) {}
        }
      } catch (fallbackError) {}
    }
    let n = 0;
    for (const c of chats) {
      let msgs;
      try { msgs = await withRetry(() => c.fetchMessages({ limit: 1000 }), 2, 800); }
      catch (e) { log('WhatsApp catch-up skipped chat', String(c.id && c.id._serialized || c.id || 'unknown'), ':', errorText(e)); continue; }
      for (const m of msgs) {
        if (m.timestamp < since) continue;               // duplicates are filtered by "seen"
        const before = queue.length;
        await handleWaMessage(m);
        if (queue.length > before) n++;
      }
    }
    log('WhatsApp catch-up: ' + n + ' missed message(s) queued');
  } catch (e) { log('WhatsApp catch-up failed:', errorText(e)); }
}

async function resolveWaTarget(to) {
  let target = String(to || '').trim();
  if (!target) throw new Error('WhatsApp recipient is empty');
  if (target.includes('@')) return target;
  const digits = target.replace(/\D/g, '');
  if (!digits) throw new Error('WhatsApp recipient is empty');
  if (knownWaId.has(digits)) return knownWaId.get(digits);   // this contact wrote to us before
  let resolved = '';
  try {
    const id = await wa.getNumberId(digits);
    if (id) resolved = id._serialized;
  } catch (e) {}
  if (!resolved) {
    // Some builds return no NumberId for an existing chat. Try the normal c.us chat before rejecting.
    try {
      const chat = await wa.getChatById(digits + '@c.us');
      if (chat) resolved = digits + '@c.us';
    } catch (e) {}
  }
  if (!resolved) { const e = new Error('This number is not on WhatsApp'); e.noRetry = true; throw e; }
  return resolved;
}

// Runs one direct WhatsApp Web send inside the page. Returns {ok, id} or {ok:false, reason}.
async function directSend(target, body, quotedId, mentionIds) {
  return wa.pupPage.evaluate(async (chatId, text, quoteId, mentions) => {
    let stage = 'pre';
    try {
      if (!window.WWebJS || !window.require) return { ok: false, stage, reason: 'WhatsApp chat resolver unavailable' };
      const factory = window.require('WAWebWidFactory');
      const collections = window.require('WAWebCollections');
      const wid = factory.createWid(chatId);
      let chat = collections.Chat.get(wid);
      if (!chat) chat = await window.WWebJS.getChat(chatId, { getAsModel: false });
      if (!chat) return { ok: false, stage, reason: 'chat not loaded' };
      const options = { linkPreview: true };
      if (quoteId) options.quotedMessageId = quoteId;
      if (mentions && mentions.length) options.mentionedJidList = mentions;
      stage = 'send';
      const msg = await window.WWebJS.sendMessage(chat, text, options);
      let id = ''; try { id = msg && msg.id && msg.id._serialized ? msg.id._serialized : ''; } catch (e) {}
      return { ok: true, id };
    } catch (e) {
      return { ok: false, stage, reason: e && e.message ? e.message : String(e) };
    }
  }, target, body, quotedId || '', (mentionIds || []).map(String));
}

// Runs one direct WhatsApp Web media send. Returns {ok, id} or {ok:false, reason}.
async function directSendMedia(target, f, caption, asDoc, quotedId, mentionIds) {
  return wa.pupPage.evaluate(async (chatId, mediaInfo, text, sendMediaAsDocument, quoteId, mentions) => {
    let stage = 'pre';
    try {
      if (!window.WWebJS || !window.WWebJS.sendMessage || !window.require) {
        return { ok: false, stage, reason: 'WhatsApp Web media sender unavailable' };
      }
      const factory = window.require('WAWebWidFactory');
      const collections = window.require('WAWebCollections');
      const wid = factory.createWid(chatId);
      let chat = collections.Chat.get(wid);
      if (!chat) chat = await window.WWebJS.getChat(chatId, { getAsModel: false });
      if (!chat) return { ok: false, stage, reason: 'chat not loaded' };
      stage = 'send';
      const msg = await window.WWebJS.sendMessage(chat, undefined, {
        media: mediaInfo,
        caption: text || '',
        sendMediaAsDocument: !!sendMediaAsDocument,
        linkPreview: false,
        ...(quoteId ? { quotedMessageId: quoteId } : {}),
        ...(mentions && mentions.length ? { mentionedJidList: mentions } : {})
      });
      let id = ''; try { id = msg && msg.id && msg.id._serialized ? msg.id._serialized : ''; } catch (e) {}
      return { ok: true, id };
    } catch (e) {
      return { ok: false, stage, reason: e && e.message ? e.message : String(e) };
    }
  }, target, { data: f.data, mimetype: f.mime, filename: f.name }, caption || '', asDoc, quotedId || '', (mentionIds || []).map(String));
}

function rememberOutgoing(id, agent, agentName) {
  if (!id) return;
  agentByMsg.set(id, { agent: agent || '', agentName: agentName || '' });
  setTimeout(() => agentByMsg.delete(id), 180000);
}

// A browser-side send can throw after WhatsApp has already created the message.
// Confirm the message in WhatsApp's own store before attempting the fallback,
// otherwise a retry can create a duplicate reply.
async function confirmSent(target, sinceMs, matcher) {
  const exclude = [...agentByMsg.keys()];
  for (let i = 0; i < 3; i++) {
    await sleep(1500);
    try {
      const id = await wa.pupPage.evaluate(async (chatId, since, text, media, skipIds) => {
        const M = window.require('WAWebCollections').Msg;
        const models = M.getModelsArray ? M.getModelsArray() : (M.models || M._models || []);
        const hits = (Array.isArray(models) ? models : []).filter(m => {
          try {
            const mid = m.id;
            if (!mid || !mid.fromMe) return false;
            const remote = String(mid.remote && mid.remote._serialized || mid.remote || '');
            if (remote !== chatId || Number(m.t) * 1000 < since || skipIds.includes(mid._serialized)) return false;
            return media ? !!m.type && m.type !== 'chat' : m.type === 'chat' && String(m.body || '') === text;
          } catch (e) { return false; }
        }).sort((a, b) => Number(b.t) - Number(a.t));
        return hits[0] && hits[0].id ? hits[0].id._serialized : '';
      }, target, sinceMs - 5000, matcher.text || '', !!matcher.media, exclude);
      if (id) return { checked: true, found: true, id };
    } catch (e) { return { checked: false, found: false, id: '' }; }
  }
  return { checked: true, found: false, id: '' };
}

async function guardedSend(label, target, sinceMs, matcher, runDirect, runFallback) {
  let ambiguous = false;
  try {
    const d = await runDirect();
    if (d && d.ok) return d.id || '';
    ambiguous = !!(d && d.stage === 'send');
    log('direct ' + label + ' send failed (' + (ambiguous ? 'after send started' : 'before send') + '):', d && d.reason);
  } catch (e) {
    ambiguous = true;
    log('direct ' + label + ' send threw:', errorText(e));
  }
  if (ambiguous) {
    const v = await confirmSent(target, sinceMs, matcher);
    if (v.found) { log('WhatsApp ' + label + ' was actually delivered - fallback skipped'); return v.id; }
    if (!v.checked) { const e = new Error('WhatsApp delivery could not be confirmed; check the chat before retrying.'); e.noRetry = true; throw e; }
  }
  try { return await runFallback(); }
  catch (e) {
    const v = await confirmSent(target, sinceMs, matcher);
    if (v.found) { log('WhatsApp ' + label + ' delivered despite fallback error'); return v.id; }
    throw e;
  }
}

async function sendWhatsApp(to, body, files, agent, agentName, quotedId, mentions) {
  if (!wa || waState.status !== 'ready') { const e = new Error('WhatsApp is not connected. Open the QR page and scan.'); e.noRetry = true; throw e; }
  const target0 = await resolveWaTarget(to);
  files = files || [];
  // Warm the chat before sending: WhatsApp Web can have a contact indexed but its Chat model not loaded.
  let target = target0;
  try {
    const warmed = await withRetry(() => wa.getChatById(target0), 2, 700);
    if (warmed && warmed.id && warmed.id._serialized) target = warmed.id._serialized;
  } catch (e) { log('WhatsApp chat warm-up skipped:', errorText(e)); }

  whatsappSendInflight++;
  try {
    if (!files.length) {
      const startedAt = Date.now();
      let id;
      try {
        id = await guardedSend('text', target, startedAt, { text: body, media: false },
          () => directSend(target, body, quotedId, mentions),
          async () => {
          const opts = { linkPreview: true };
          if (quotedId) opts.quotedMessageId = quotedId;
          if (mentions && mentions.length) opts.mentions = mentions.map(String).filter(Boolean);
          const sent = await wa.sendMessage(target, body, opts);
          return sent && sent.id && sent.id._serialized || '';
        });
      } catch (e) {
        if (isStaleSessionError(e)) {
          requestRestart('text send failure: ' + errorText(e));
          throw new Error('WhatsApp session became stale; it is restarting. Please retry in a moment.');
        }
        throw e;
      }
      rememberOutgoing(id, agent, agentName);
      return { id: id || '', extId: id || '' };
    }

    let firstSentId = '';
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const asDoc = !/^(image|video|audio)\//.test(f.mime);
      const caption = i === 0 ? body : '';
      const quote = i === 0 ? quotedId : '';
      const mentionList = i === 0 ? mentions : [];
      const startedAt = Date.now();
      let id;
      try {
        id = await guardedSend('media ' + f.name, target, startedAt, { text: caption, media: true },
          () => directSendMedia(target, f, caption, asDoc, quote, mentionList),
          async () => {
          const { MessageMedia } = require('whatsapp-web.js');
          const mm = new MessageMedia(f.mime, f.data, f.name);
          const opts = { sendMediaAsDocument: asDoc };
          if (caption && caption.trim()) opts.caption = caption;
          if (quote) opts.quotedMessageId = quote;
          if (mentionList && mentionList.length) opts.mentions = mentionList.map(String).filter(Boolean);
          const sent = await wa.sendMessage(target, mm, opts);
          return sent && sent.id && sent.id._serialized || '';
        });
      } catch (e) {
        log('media send error for', f.name, ':', errorText(e));
        if (isStaleSessionError(e)) {
          requestRestart('media send failure: ' + errorText(e));
          throw new Error('WhatsApp session became stale; it is restarting. Please retry in a moment.');
        }
        throw e;
      }
      rememberOutgoing(id, agent, agentName);
      if (!firstSentId && id) firstSentId = id;
    }
    return { id: firstSentId, extId: firstSentId };
  } finally {
    whatsappSendInflight--;
  }
}

// Prevent double-clicks and browser retries from sending the same WhatsApp
// payload twice while the first request is still in flight.
const sendCache = new Map();
function sendSignature(b) {
  const h = crypto.createHash('sha1');
  h.update(JSON.stringify([b.to, b.body || '', b.quotedId || '', b.mentions || []]));
  (b.files || []).forEach(f => {
    h.update(String(f.name || '') + ':' + String(f.mime || '') + ':');
    h.update(String(f.data || ''));
  });
  return h.digest('hex');
}
function dedupeSend(key, ttl, fn) {
  const now = Date.now(), hit = sendCache.get(key);
  if (hit && (hit.pending || now - hit.at < ttl)) {
    log('duplicate WhatsApp send suppressed');
    return hit.promise;
  }
  const entry = { pending: true, at: now, promise: null };
  entry.promise = fn().then(
    result => { entry.pending = false; entry.at = Date.now(); return result; },
    error => { sendCache.delete(key); throw error; }
  );
  sendCache.set(key, entry);
  return entry.promise;
}
setInterval(() => {
  const now = Date.now();
  sendCache.forEach((v, k) => { if (!v.pending && now - v.at > 60000) sendCache.delete(k); });
}, 30000);

// Watchdog: detect a frozen browser / dead session and recover without human help.
setInterval(async () => {
  if (NO_WA || restarting) return;
  const age = Date.now() - waState.since;
  if (waState.status === 'ready' && wa) {
    try {
      const st = await Promise.race([wa.getState(), sleep(20000).then(() => 'TIMEOUT')]);
      if (st === 'CONNECTED') { waBad = 0; saveState({ lastWaTs: Math.floor(Date.now() / 1000) }); }
      else if (++waBad >= 3) restartWA('state ' + st);
    } catch (e) { if (++waBad >= 3) restartWA('state check failed: ' + e.message); }
  } else if (['starting', 'authenticated', 'disconnected', 'auth_failure', 'error'].includes(waState.status) && age > 180000) {
    restartWA('stuck in ' + waState.status);
  }
}, 30000);

/* ---------------------------------------------------------------- Mail */
let mailCfg = null, transporter = null, imapGen = 0, imapClient = null;
const mailState = { configured: false, connected: false, lastError: '' };

async function loadMailConfig() {
  const r = await callScript({ action: 'config' });
  mailCfg = r.config;
  if (!mailCfg.SMTP_PASS || /APP_PASSWORD_HERE/.test(mailCfg.SMTP_PASS)) throw new Error('SMTP_PASS / IMAP_PASS are not set in Script Properties');
  const port = Number(mailCfg.SMTP_PORT);
  if (transporter) { try { transporter.close(); } catch (e) {} }
  transporter = nodemailer.createTransport({
    host: mailCfg.SMTP_HOST, port, secure: port === 465, pool: true, maxConnections: 3, maxMessages: 100,
    auth: { user: mailCfg.SMTP_USER, pass: mailCfg.SMTP_PASS },
    connectionTimeout: 20000, greetingTimeout: 15000, socketTimeout: 40000
  });
  mailState.configured = true;
  log('Mail config loaded for', mailCfg.SMTP_USER);
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
// Only retry when the connection failed BEFORE the mail was handed over. After a timeout the mail may
// already be delivered, and a retry would send a duplicate.
const SMTP_SAFE_RETRY = new Set(['ECONNECTION', 'ECONNREFUSED', 'ENOTFOUND', 'EDNS', 'EAI_AGAIN']);
async function sendMail(m) {
  if (!transporter) await loadMailConfig();
  const files = (m.files || []).map(f => ({ filename: f.name, content: Buffer.from(f.data, 'base64'), contentType: f.mime }));
  await withRetry(async () => {
    try {
      await transporter.sendMail({ from: mailCfg.SMTP_USER, to: m.to, subject: m.subject, text: m.text, html: m.html,
        attachments: inlineImages_(m.html).concat(files) });
    } catch (e) {
      if (!SMTP_SAFE_RETRY.has(e && e.code)) e.noRetry = true;
      throw e;
    }
  }, 3, 1500);
}
function mailText(p) {
  let t = (p.text || '').trim();
  if (!t && p.html) {
    t = String(p.html).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();   // &amp; last
  }
  return (t || '(empty)').slice(0, 20000);
}
let procMail = false, procAgain = false, mailHistoryRunning = false;
const mailFails = new Map();                              // uid -> failure count
async function handleMailUid(client, uid, options) {
  options = options || {};
  const m = await client.fetchOne(uid, { source: true }, { uid: true });
  if (!m || !m.source) throw new Error('IMAP message source unavailable (UID ' + uid + ')');
  const p = await simpleParser(m.source);
  const addr = p.from && p.from.value && p.from.value[0];
  const from = ((addr && addr.address) || 'unknown').toLowerCase();
  const own = String(mailCfg.IMAP_USER).toLowerCase();
  const toAddr = p.to && p.to.value && p.to.value[0];
  const outgoing = options.outgoing || from === own;
  const files = [], skipped = [];
  for (const a of (p.attachments || [])) {
    const buf = a.content, n = a.filename || '';
    if (!buf || !buf.length) continue;
    if ((a.related || a.contentDisposition === 'inline') && buf.length < 30 * 1024) continue;   // signature logos, tracking pixels
    if (buf.length > FILE_MAX) { skipped.push(n || 'attachment'); continue; }
    files.push(saveMedia(n, a.contentType, buf));
  }
  let body = mailText(p);
  if (files.length && body === '(empty)') body = '';
  if (skipped.length) body += '\n\n[attachment too large to show: ' + skipped.join(', ') + ']';
  const recipient = toAddr && toAddr.address ? String(toAddr.address).toLowerCase() : '';
  const payload = {
    action: 'incoming', channel: 'mail',
    from: outgoing ? recipient : from,
    name: outgoing ? '' : ((addr && addr.name) || ''),
    fromMe: outgoing,
    subject: p.subject || '(no subject)', body,
    time: p.date ? p.date.getTime() : Date.now()
  };
  if (files.length) payload.files = files;
  const messageId = String(p.messageId || '').trim().replace(/^<|>$/g, '');
  const fallbackSeed = [options.folder || 'INBOX', String(uid), from, recipient, p.subject || '', p.date ? String(p.date.getTime()) : ''].join('|');
  const extId = messageId
    ? ('mail:' + messageId.toLowerCase())
    : ('mail:uid:' + String(options.folder || 'INBOX').toLowerCase() + ':' + uid + ':' + crypto.createHash('sha1').update(fallbackSeed).digest('hex').slice(0, 16));
  if (!enqueue(payload, extId)) dropMedia(payload);
  // Incoming mail is not marked read here. The portal controls read/unread state.
}
async function processMail(client) {
  if (mailHistoryRunning) { procAgain = true; return; }    // history sync is switching mailboxes
  if (procMail) { procAgain = true; return; }              // a new mail arrived mid-run: go again right after
  procMail = true;
  try {
    do {
      procAgain = false;
      const found = await client.search({ seen: false }, { uid: true });
      const uids = Array.isArray(found) ? found : [];
      for (const uid of uids) {
        try { await handleMailUid(client, uid, { folder: 'INBOX' }); mailFails.delete(uid); }
        catch (e) {
          const n = (mailFails.get(uid) || 0) + 1; mailFails.set(uid, n);
          log('mail uid ' + uid + ' failed (' + n + '/3):', e.message);
          if (n >= 3) log('mail uid ' + uid + ' kept unread; retrying on the next sync');
        }
      }
    } while (procAgain);
  } finally { procMail = false; }
}
async function syncMailHistory(client) {
  if (mailHistoryRunning) return;
  mailHistoryRunning = true;
  const since = new Date(Date.now() - 60 * 86400000);
  let total = 0;
  let folders = [];
  try { folders = await client.list(); } catch (e) { folders = []; }
  const folderNames = folders.map(f => String(f.path || f.name || '')).filter(Boolean);
  if (!folderNames.some(name => /^INBOX$/i.test(name))) folderNames.unshift('INBOX');
  // Import every useful folder (Primary/Promotions/All Mail on some accounts); dedup by Message-ID.
  const skip = /(^|[\\/])(trash|deleted|junk|spam|drafts?)($|[\\/])/i;
  const uniqueFolders = [...new Set(folderNames)].filter(name => !skip.test(name));
  for (const folder of uniqueFolders) {
    const isSent = /(^|[\\/])(sent|sent items|sent mail)($|[\\/])/i.test(folder);
    try {
      await client.mailboxOpen(folder);
      const found = await client.search({ since }, { uid: true });
      const uids = Array.isArray(found) ? found : [];
      for (const uid of uids) {
        try { await handleMailUid(client, uid, { outgoing: isSent, folder }); total++; }
        catch (e) { log('mail history uid ' + folder + ' failed:', e.message); }
      }
    } catch (e) { log('mail history folder ' + folder + ' failed:', e.message); }
  }
  try { await client.mailboxOpen('INBOX'); }
  finally {
    mailHistoryRunning = false;
    log('Mail history sync: two-month window, ' + uniqueFolders.length + ' folder(s), ' + total + ' message(s) queued/checked');
  }
}
async function startImap() {
  if (NO_MAIL) return;
  const gen = ++imapGen;
  if (imapClient) { try { imapClient.close(); } catch (e) {} imapClient = null; }   // stop the previous loop's connection
  let backoff = 2000;
  while (gen === imapGen) {
    const client = new ImapFlow({ host: mailCfg.IMAP_HOST, port: Number(mailCfg.IMAP_PORT), secure: true,
      auth: { user: mailCfg.IMAP_USER, pass: mailCfg.IMAP_PASS }, logger: false });
    imapClient = client;
    let closed; const closedP = new Promise(r => { closed = r; });
    client.on('close', () => closed());
    client.on('error', e => { mailState.lastError = e.message; });
    let timer = null;
    try {
      await client.connect();
      if (gen !== imapGen) { try { client.close(); } catch (e) {} break; }
      await client.mailboxOpen('INBOX');
      mailState.connected = true; mailState.lastError = ''; backoff = 2000;
      log('Mail: connected to inbox (instant delivery on)');
      client.on('exists', () => processMail(client).catch(e => log('mail error:', e.message)));
      await syncMailHistory(client);
      await processMail(client);
      timer = setInterval(() => { if (client.usable) processMail(client).catch(e => log('mail error:', e.message)); }, 60000);   // safety net
      await closedP;
    } catch (e) { if (gen === imapGen) mailState.lastError = e.message; log('Mail (IMAP) error:', e.message); }
    if (timer) clearInterval(timer);
    if (gen === imapGen) mailState.connected = false;
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
  // Only Google-hosted portal origins may call the bridge from a browser. No wildcard.
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
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
// API calls: header key only. The QR page: HttpOnly session cookie set after a key check.
function guard(req, res, next) {
  if (safeEq(req.headers['x-api-key'], API_KEY) || safeEq(parseCookies(req).sb_sess, SESSION_TOKEN)) return next();
  res.status(401).json({ ok: false, error: 'unauthorized' });
}

app.get('/', (req, res) => res.send('Support bridge ' + VERSION + ' is running'));

// Realtime stream: EventSource cannot send headers, so it uses a key derived from the API key.
// It only carries "something changed" pings, never message content.
app.get('/events', (req, res) => {
  if (!safeEq(req.query.k, RT_KEY)) return res.status(401).end();
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n: connected\n\n');
  rtClients.add(res);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 20000);
  req.on('close', () => { clearInterval(hb); rtClients.delete(res); });
});

// Opening /qr?key=... once sets a session cookie and redirects, so the key is not kept in the URL.
app.get('/qr', (req, res, next) => {
  if (safeEq(req.query.key, API_KEY)) {
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', 'sb_sess=' + SESSION_TOKEN + '; Path=/; HttpOnly; SameSite=Strict' + secure);
    return res.redirect(302, '/qr');
  }
  next();
}, guard, (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WhatsApp login</title></head>
    <body style="font-family:Segoe UI,Arial,sans-serif;text-align:center;padding:40px;color:#111b21">
      <div id="content"><h3>Checking WhatsApp connection...</h3></div>
      <p style="color:#667781;font-size:13px">Queue waiting: <span id="queue">0</span></p>
      <script>
      let timer=null,lastQr='';
      function setText(id,t){document.getElementById(id).textContent=t}
      async function refreshQr(){
        try{
          const r=await fetch('/qr-status',{cache:'no-store',credentials:'same-origin',headers:{'ngrok-skip-browser-warning':'1'}});
          if(r.status===401){document.getElementById('content').innerHTML='<h3>Session expired</h3><p>Open the QR link from the portal again.</p>';if(timer){clearInterval(timer);timer=null}return}
          if(!r.ok)throw new Error('HTTP '+r.status);
          const d=await r.json();setText('queue',d.queue||0);
          if(d.status==='ready'){
            document.getElementById('content').innerHTML='<h2 style="color:#16a34a">WhatsApp is connected</h2><p>You can close this page.</p>';
            if(timer){clearInterval(timer);timer=null}return;
          }
          if(d.status==='qr'&&d.qr&&d.qr!==lastQr){
            lastQr=d.qr;
            const img=document.createElement('img');img.src=d.qr;img.width=300;img.height=300;img.alt='WhatsApp QR code';
            const p=document.createElement('p');p.innerHTML='Scan with WhatsApp: <b>Linked devices</b>, then <b>Link a device</b>';
            const c=document.getElementById('content');c.innerHTML='';c.appendChild(img);c.appendChild(p);
          }else if(d.status==='qr'&&d.qr){/* QR unchanged */}
          else{
            const h=document.createElement('h3');h.textContent='Status: '+String(d.status);
            const p=document.createElement('p');p.textContent='Please wait while WhatsApp restores the connection.';
            const c=document.getElementById('content');c.innerHTML='';c.appendChild(h);c.appendChild(p);
          }
        }catch(e){document.getElementById('content').innerHTML='<h3>Connection temporarily unavailable</h3><p>Keep this page open; it will retry automatically.</p>'}
      }
      refreshQr();timer=setInterval(refreshQr,5000);
      </script></body></html>`);
});
app.get('/qr-status', guard, (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.json({ ok: true, status: waState.status, qr: waState.qr || null, queue: queue.length });
});
app.get('/status', guard, (req, res) => res.json({
  version: VERSION, whatsapp: waState.status, mail: mailState.connected, mailConfigured: mailState.configured, mailError: mailState.lastError,
  queue: queue.length, delivered: stats.delivered, live: rtClients.size, uptimeMin: Math.round((Date.now() - stats.started) / 60000)
}));
// Diagnostic route: pushes a fake message through the pipeline. Off unless ENABLE_TEST=1.
if (ENABLE_TEST) {
  app.get('/test', guard, (req, res) => {
    const payload = { action: 'incoming', channel: 'whatsapp', from: '8800000000000', name: 'Bridge Test', body: 'Test message from the bridge (' + new Date().toLocaleTimeString() + ')' };
    if (req.query.group) Object.assign(payload, { from: '1203630@g.us', group: true, groupName: 'Support Group', senderName: 'Rahim', senderNumber: '8801711000000' });
    if (req.query.file) payload.files = [saveMedia('test.txt', 'text/plain', Buffer.from('hello attachment'))];
    enqueue(payload);
    res.json({ ok: true, note: 'queued - it should appear in the Agent Portal within seconds' });
  });
}
const groupMemberCache = new Map();
const withTimeoutP = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
// One group member as WhatsApp shows it: saved name, real phone number (never the hidden lid digits) and the public name.
async function describeMember(id) {
  let name = '', push = '', phone = '';
  try {
    const c = await withTimeoutP(wa.getContactById(id), 4000);
    name = savedName(c);
    push = String(c && (c.pushname || c.verifiedName) || '').trim();
    if (!/@lid$/i.test(id)) phone = normalizeWaContact(c && c.number || id);
  } catch (e) { if (!/@lid$/i.test(id)) phone = normalizeWaContact(id); }
  if (/@lid$/i.test(id)) { try { phone = await withTimeoutP(phoneOf(id), 4000); } catch (e) { phone = ''; } }
  return { id, name, push, phone };
}
app.post('/group-members', guard, async (req, res) => {
  try {
    const groupId = String(req.body.to || req.body.groupId || '');
    if (!wa || waState.status !== 'ready') return res.status(503).json({ ok: false, error: 'WhatsApp is not connected' });
    if (!groupId.endsWith('@g.us')) return res.status(400).json({ ok: false, error: 'Invalid WhatsApp group ID' });
    const membersById = new Map();
    const cached = groupMemberCache.get(groupId);
    if (cached && !req.body.fresh && Date.now() - cached.t < 10 * 60 * 1000) return res.json({ ok: true, members: cached.members, cached: true });
    const ids = [];

    try {
      const chat = await wa.getChatById(groupId);
      if (chat && Array.isArray(chat.participants)) {
        for (const participant of chat.participants) {
          const wid = participant && (participant.id || participant.wid || participant);
          let id = '';
          if (typeof wid === 'string') id = wid;
          else if (wid && wid._serialized) id = String(wid._serialized);
          else if (wid && wid.user && wid.server) id = wid.user + '@' + wid.server;
          if (!id || !/@(?:c\.us|lid)$/.test(id)) continue;

          ids.push(id);
        }
      }
    } catch (e) {
      log('WhatsApp public group-member lookup failed:', e.message);
    }
    // describe all members in parallel (batches of 12, 4 s limit each) instead of one by one: big groups used to take so long that the portal gave up
    for (let i = 0; i < ids.length; i += 12) {
      const part = await Promise.all(ids.slice(i, i + 12).map(describeMember));
      part.forEach(m => membersById.set(m.id, m));
    }

    // Fallback: read the group metadata directly from WhatsApp Web when the library model is empty.
    if (!membersById.size && wa.pupPage) {
      const browserMembers = await wa.pupPage.evaluate(async chatId => {
        const req = window.require && window.require.bind(window);
        const WidFactory = req && req('WAWebWidFactory');
        const collections = req && req('WAWebCollections');
        const store = window.Store || (window.WWebJS && window.WWebJS.store) || collections;
        if (!store || !store.Chat) return [];
        let chat = null;
        try {
          if (WidFactory && WidFactory.createWid) chat = store.Chat.get(WidFactory.createWid(chatId));
          if (!chat) chat = store.Chat.get(chatId);
          if (!chat && store.Chat.find) chat = await store.Chat.find(chatId);
        } catch (e) {}
        if (!chat) {
          try {
            const models = store.Chat.getModelsArray ? store.Chat.getModelsArray() : (store.Chat.models || store.Chat._models || []);
            chat = (Array.isArray(models) ? models : []).find(c => String(c && c.id && (c.id._serialized || c.id) || '') === chatId);
          } catch (e) {}
        }
        if (!chat) return [];
        let raw = [];
        try {
          const metadata = chat.groupMetadata || chat.groupMetadataModel || chat;
          raw = metadata.participants || (metadata.participantList && metadata.participantList.getModelsArray && metadata.participantList.getModelsArray()) || [];
          if (raw.getModelsArray) raw = raw.getModelsArray();
          else if (raw.models) raw = raw.models;
          else if (!Array.isArray(raw)) raw = [];
        } catch (e) {}
        return raw.map(p => {
          const wid = p.id || p.wid || p;
          const id = String(wid._serialized || (wid.user && wid.server ? wid.user + '@' + wid.server : '') || p.user || p).trim();
          if (!id || !/@(?:c\.us|lid)$/.test(id)) return null;
          let name = '';
          try {
            const contact = store.Contact && store.Contact.get(wid);
            name = String(contact && (contact.pushname || contact.name || contact.formattedName || contact.verifiedName) || '').trim();
          } catch (e) {}
          return { id, name, push: '', phone: /@c\.us$/.test(id) ? id.replace(/@.*$/, '') : '' };
        }).filter(Boolean);
      }, groupId);

      for (const member of browserMembers || []) {
        if (member && member.id) membersById.set(member.id, member);
      }
    }

    const members = [...membersById.values()];
    if (members.length) groupMemberCache.set(groupId, { t: Date.now(), members });
    log('WhatsApp group members for', groupId, ':', members.length);
    res.json({ ok: true, members });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.post('/send-whatsapp', guard, async (req, res) => {
  try {
    const result = await dedupeSend(sendSignature(req.body || {}), 8000, () =>
      sendWhatsApp(req.body.to, req.body.body, req.body.files, req.body.agent, req.body.agentName, req.body.quotedId, req.body.mentions));
    res.json({ ok: true, id: result && result.id ? result.id : '' });
    emit('sent');
  } catch (e) {
    log('send-whatsapp failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.post('/call/reject', guard, async (req, res) => {
  try {
    const callId = String(req.body.callId || '');
    const call = callObjects.get(callId);
    if (!call) return res.status(404).json({ ok: false, error: 'Call not found or already ended' });
    await call.reject();
    callObjects.delete(callId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/logout', guard, async (req, res) => {
  try { if (wa) await Promise.race([wa.logout(), sleep(10000)]); } catch (e) {}
  if (!restarting) restartWA('logout requested');
  res.json({ ok: true });
});
app.post('/send-mail', guard, async (req, res) => {
  const to = String(req.body && req.body.to || '').trim();
  if (!to || !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(to)) return res.status(400).json({ ok: false, error: 'Invalid recipient address' });
  try { await sendMail(req.body); res.json({ ok: true }); emit('sent'); }
  catch (e) { log('send-mail failed:', e.message); res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/reload-config', guard, async (req, res) => {
  try { await loadMailConfig(); startImap(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/relink', guard, async (req, res) => {        // force a fresh QR (log out the linked phone)
  try { if (wa) { await Promise.race([wa.logout(), sleep(10000)]); } } catch (e) {}
  restartWA('relink requested');
  res.json({ ok: true });
});

const server = app.listen(PORT, () => {
  log('Support bridge ' + VERSION + ' listening on port ' + PORT + ' (queued: ' + queue.length + ')');
  initWhatsApp();
  bootMail();
  syncUrl();
  if (queue.length) pump();
});
server.on('error', e => {
  if (e.code === 'EADDRINUSE') { log('Port ' + PORT + ' is already in use - the bridge is probably already running.'); process.exit(3); }
  log('Server error:', e.message); process.exit(1);
});
function shutdown() {
  try { saveJson(QFILE, queue); saveJson(SFILE, [...seen]); saveJson(STFILE, state); } catch (e) {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
