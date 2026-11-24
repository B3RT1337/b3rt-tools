import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import ytDlp from 'yt-dlp-exec';
import {
  createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const TMP = join(__dirname, 'tmp');
const PUBLIC_DIR = join(__dirname, 'public');
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 2);
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS || 5 * 60 * 1000);
const MAX_FILESIZE = process.env.MAX_FILESIZE || '200M';
// Your download server (where yt-dlp + ffmpeg run). Edit this if the IP/port changes.
const HOME_SERVER = 'http://217.174.153.234:3000';
// Render sets RENDER=true automatically. On Render this app only serves the
// page and forwards /api/download to HOME_SERVER; everywhere else it runs yt-dlp itself.
const BACKEND_URL = process.env.RENDER ? HOME_SERVER : '';

// Start with a clean temp dir
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const app = express();
app.set('trust proxy', 1); // needed behind Render/Fly/etc. so rate limiting sees real IPs
app.use(cors({ origin: process.env.CORS_ORIGIN || true, exposedHeaders: ['Content-Disposition'] }));
app.use(express.json({ limit: '10kb' }));

// Allow-list hosts per kind
const ALLOWED_HOSTS = {
  mp3: ['youtube.com', 'youtu.be', 'soundcloud.com', 'facebook.com', 'fb.watch', 'tiktok.com'],
  mp4: ['youtube.com', 'youtu.be'],
  fb:  ['facebook.com', 'fb.watch'],
  tt:  ['tiktok.com']
};

function hostAllowed(kind, hostname) {
  return ALLOWED_HOSTS[kind].some(h => hostname === h || hostname.endsWith('.' + h));
}

function removeJobFiles(id) {
  try {
    for (const f of readdirSync(TMP)) {
      if (f.startsWith(id)) rmSync(join(TMP, f), { force: true });
    }
  } catch { /* ignore */ }
}

// Sweep leftovers older than 15 minutes
setInterval(() => {
  try {
    const cutoff = Date.now() - 15 * 60 * 1000;
    for (const f of readdirSync(TMP)) {
      const p = join(TMP, f);
      if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true });
    }
  } catch { /* ignore */ }
}, 10 * 60 * 1000).unref();

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: Number(process.env.RATE_LIMIT || 15),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a few minutes and try again.' }
});

let active = 0;

app.get('/health', (_req, res) => res.json({ ok: true, active }));

app.post('/api/download', limiter, async (req, res) => {
  const { url, kind } = req.body || {};

  // --- validation ---
  if (typeof kind !== 'string' || !Object.hasOwn(ALLOWED_HOSTS, kind)) {
    return res.status(400).json({ error: 'Invalid type' });
  }
  if (typeof url !== 'string' || url.length > 2048) {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
  if (!/^https?:$/.test(parsed.protocol)) {
    return res.status(400).json({ error: 'Only http/https allowed' });
  }
  if (!hostAllowed(kind, parsed.hostname)) {
    return res.status(400).json({ error: `Host not allowed for ${kind}` });
  }
  // --- proxy mode (Render -> your server) ---
  if (BACKEND_URL) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), JOB_TIMEOUT_MS + 30000);
    res.on('close', () => { clearTimeout(timer); ctrl.abort(); });
    try {
      const r = await fetch(`${BACKEND_URL}/api/download`, {
        method: 'POST',
        // pass the visitor's IP so the home server's rate limit is per visitor, not per Render
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': req.ip },
        body: JSON.stringify({ url, kind }),
        signal: ctrl.signal
      });
      res.status(r.status);
      for (const h of ['content-type', 'content-length', 'content-disposition']) {
        const v = r.headers.get(h);
        if (v) res.setHeader(h, v);
      }
      if (!r.body) return res.end();
      Readable.fromWeb(r.body).on('error', () => res.destroy()).pipe(res);
    } catch (err) {
      console.error('proxy failed:', err.message);
      if (!res.headersSent) res.status(502).json({ error: 'Could not reach the download server.' });
      else res.destroy();
    }
    return;
  }

  // --- direct mode (this machine runs yt-dlp) ---
  if (active >= MAX_CONCURRENT) {
    return res.status(503).json({ error: 'Server is busy. Please try again in a moment.' });
  }

  active++;
  let slotHeld = true;
  const freeSlot = () => { if (slotHeld) { slotHeld = false; active--; } };

  const id = randomUUID();
  const isAudio = kind === 'mp3';
  const ext = isAudio ? 'mp3' : 'mp4';
  const mime = isAudio ? 'audio/mpeg' : 'video/mp4';

  // Always clean up once the response is finished or the client disconnects
  res.on('close', () => removeJobFiles(id));

  const flags = {
    output: join(TMP, `${id}.%(ext)s`),
    noPlaylist: true,
    maxFilesize: MAX_FILESIZE,
    noWarnings: true,
    ...(isAudio
      ? { format: 'bestaudio/best', extractAudio: true, audioFormat: 'mp3', audioQuality: 0 }
      : { format: 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best', mergeOutputFormat: 'mp4' })
  };

  try {
    await ytDlp(url, flags, { timeout: JOB_TIMEOUT_MS });
  } catch (err) {
    freeSlot();
    removeJobFiles(id);
    const detail = String(err?.stderr || err?.message || '');
    console.error('yt-dlp failed:', detail.slice(0, 500));

    let msg = 'Could not download this link. It may be private, unavailable, over the size limit, or blocked by the source site.';
    if (/sign in to confirm|not a bot/i.test(detail)) {
      msg = 'YouTube is blocking this server (bot check). Try again later or run the backend from a home connection.';
    } else if (/larger than max-filesize|File is larger/i.test(detail)) {
      msg = `File is larger than the ${MAX_FILESIZE} limit.`;
    } else if (/ffmpeg|ffprobe/i.test(detail) && /not found|No such file/i.test(detail)) {
      msg = 'Server is missing ffmpeg.';
    }
    if (!res.headersSent) res.status(500).json({ error: msg });
    return;
  }

  freeSlot();

  if (res.destroyed) { removeJobFiles(id); return; } // client left while we were working

  try {
    // Prefer the expected extension; fall back to any finished file for this job
    let file = `${id}.${ext}`;
    if (!existsSync(join(TMP, file))) {
      file = readdirSync(TMP).find(f => f.startsWith(id) && !/\.(part|ytdl|temp)$/i.test(f));
    }
    if (!file) throw new Error('No output file produced');

    const filePath = join(TMP, file);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', statSync(filePath).size);
    res.setHeader('Content-Disposition', `attachment; filename="b3rt-${kind}-${id.slice(0, 8)}.${ext}"`);

    const stream = createReadStream(filePath);
    stream.on('error', err => { console.error(err); res.destroy(); });
    stream.pipe(res);
  } catch (err) {
    console.error(err);
    removeJobFiles(id);
    if (!res.headersSent) res.status(500).json({ error: 'Download failed' });
  }
});

// Serve the front-end from ./public
app.use(express.static(PUBLIC_DIR));

app.listen(PORT, () => console.log(`Backend on http://localhost:${PORT}`));
