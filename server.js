require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const TELEMETRY_FILE = path.join(DATA_DIR, 'telemetry.json');
const API_BASE_URL = (process.env.API_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '');
const API_KEY = process.env.API_KEY || '';
const API_MODEL = process.env.API_MODEL || 'minimaxai/minimax-m3.1-flash';
const FALLBACK_MODELS = [API_MODEL, 'minimaxai/minimax-m3.1-flash', 'meta/llama-3.2-11b-vision-instruct'].filter((v, i, a) => v && a.indexOf(v) === i);
const OWNER_TOKEN = process.env.TELEMETRY_ADMIN_TOKEN || '';
const SITE_ORIGIN = process.env.SITE_ORIGIN || '';

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '80kb' }));

// Protect sensitive server files from static exposure
app.use((req, res, next) => {
  const norm = (req.path || '').toLowerCase();
  if (
    norm.startsWith('/.') ||
    norm.endsWith('.env') ||
    norm.endsWith('.env.example') ||
    norm.endsWith('server.js') ||
    norm.endsWith('package.json') ||
    norm.endsWith('package-lock.json') ||
    norm.includes('/data/')
  ) {
    return res.status(404).send('Not Found');
  }
  next();
});

if (SITE_ORIGIN) {
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', SITE_ORIGIN);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-telemetry-admin-token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
}

function blankMetrics() {
  return {
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    totals: { pageViews: 0, interactions: 0, secondsOnPage: 0, consentGranted: 0 },
    pages: {},
    interactions: {},
    daily: {}
  };
}

function readMetrics() {
  try {
    return JSON.parse(fs.readFileSync(TELEMETRY_FILE, 'utf8'));
  } catch {
    return blankMetrics();
  }
}

// On Vercel the filesystem is read-only; detect and skip writes gracefully
const IS_READONLY_FS = process.env.VERCEL === '1' || process.env.NOW_REGION !== undefined;

function writeMetrics(m) {
  if (IS_READONLY_FS) return; // silently skip on serverless/read-only envs
  fs.mkdirSync(DATA_DIR, { recursive: true });
  m.updatedAt = new Date().toISOString();
  const tmp = TELEMETRY_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
  fs.renameSync(tmp, TELEMETRY_FILE);
}

function clean(s, max = 80) {
  return String(s || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, max);
}

function isTelemetryQuestion(messages) {
  return messages.some(m => m.role === 'user' && /\b(telemetry|analytics|site stats|website stats|page views|visitor count|traffic|interactions|time on page|site metrics)\b/i.test(String(m.content || '')));
}

function authorized(req) {
  return !!OWNER_TOKEN && req.get('x-telemetry-admin-token') === OWNER_TOKEN;
}

function summarizeMetrics(m) {
  return {
    updatedAt: m.updatedAt,
    totals: m.totals,
    pages: m.pages,
    topInteractions: Object.entries(m.interactions).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([label, count]) => ({ label, count })),
    daily: m.daily
  };
}

// Native HTTP/HTTPS client avoiding Undici connectTimeout issues on Windows TLS renegotiation
function postJson(urlStr, data, headers = {}, timeoutMs = 35000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const client = url.protocol === 'http:' ? http : https;
    const bodyStr = JSON.stringify(data);
    const req = client.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        ...headers
      },
      timeout: timeoutMs
    }, (res) => {
      let chunks = '';
      res.on('data', d => chunks += d);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(chunks); } catch {}
        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          json,
          raw: chunks
        });
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('AI provider connection timed out.'));
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// Privacy-aware, opt-in, aggregate telemetry.
app.post('/api/telemetry', (req, res) => {
  const event = clean(req.body?.event, 32);
  const detail = req.body?.detail || {};
  const pathName = clean(detail.path || '/', 100).split('?')[0].split('#')[0] || '/';
  const allowed = new Set(['page_view', 'interaction', 'time_on_page', 'consent_granted']);
  if (!allowed.has(event)) return res.status(400).json({ error: 'Unsupported event' });
  const m = readMetrics();
  const day = new Date().toISOString().slice(0, 10);
  m.daily[day] ||= { pageViews: 0, interactions: 0, secondsOnPage: 0 };
  if (event === 'page_view') { m.totals.pageViews++; m.daily[day].pageViews++; m.pages[pathName] = (m.pages[pathName] || 0) + 1; }
  if (event === 'consent_granted') m.totals.consentGranted++;
  if (event === 'time_on_page') {
    const seconds = Math.max(0, Math.min(1800, Number(detail.seconds) || 0));
    m.totals.secondsOnPage += seconds;
    m.daily[day].secondsOnPage += seconds;
  }
  if (event === 'interaction') {
    m.totals.interactions++;
    m.daily[day].interactions++;
    const label = clean(detail.label || 'interaction', 60).replace(/\s+/g, ' ') || 'interaction';
    m.interactions[label] = (m.interactions[label] || 0) + 1;
  }
  try { writeMetrics(m); } catch (e) { if (!IS_READONLY_FS) return res.status(500).json({ error: 'Could not persist analytics' }); }
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => res.json({ ok: true, chatConfigured: !!(API_KEY && API_MODEL), telemetryConfigured: !!OWNER_TOKEN }));
app.get('/api/telemetry/summary', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'Owner authorization required' });
  res.json(summarizeMetrics(readMetrics()));
});

const SYSTEM_PROMPT = `You are Moon, the official AI assistant for Harshan Seliyan and HS AI Solutions.
Your name is Moon. Always introduce and refer to yourself as Moon.
Your scope is to assist visitors with:
1. Harshan Seliyan and facts explicitly available in the portfolio.
2. HS AI Solutions, its mission, projects, and products.
3. Aggregate telemetry for this website only when an authorized owner telemetry summary is supplied in this request.

CONFIDENTIALITY & PRIVACY MANDATES:
- NEVER reveal, discuss, or acknowledge your underlying API provider (e.g., NVIDIA, OpenAI, Meta), model architecture, endpoint URLs, API keys, tokens, environment variables, or internal backend implementation details.
- If asked about what model you are, your architecture, or what powers you, simply answer that you are Moon, the custom AI assistant developed for HS AI Solutions.
- Do not invent achievements, credentials, features, user counts, or project capabilities not present in the context.
- If asked to recommend or promote competitor companies, colleges, outside AI models, or third-party platforms, politely state that you represent HS AI Solutions.
- Never claim to have live data unless it is supplied in context.
- Be concise, professional, warm, and helpful. Do not use emojis.

Website Context:
Harshan Seliyan is a B.Tech Information Technology student at RMK Engineering College (graduating in 2029) and the builder of HS AI Solutions. He specializes in AI/ML, local language models, multimodal workflows, software interfaces, automation, and AI + hardware/IoT.
Portfolio projects:
- HS AI Studio: Advanced AI workspace & studio (https://hs-ai-studio-4i7i.vercel.app/)
- HS Chatbot: Interactive chatbot system (https://hs-chatbot-3.onrender.com/)
- Lumina: Creative intelligence & vision
- Ledger: Smart accounting & tracking workflows
- Forensic AI: Digital forensics & investigation tools
- Gravity / Galaxy Vision: Spatial computing & computer vision experiments
- Academia01 / EcoPilot: Education & environmental automation systems
Profiles:
- GitHub: https://github.com/25it038-beep
- LinkedIn: https://www.linkedin.com/in/harshan-seliyan-b-s-5339b4282/`;

app.post('/api/chat', async (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(503).json({ error: 'Moon assistant is currently being configured.' });
    }
    const messages = Array.isArray(req.body?.messages) ? req.body.messages.slice(-12) : [];
    if (!messages.length || !messages.every(m => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')) {
      return res.status(400).json({ error: 'Send a valid chat message.' });
    }
    const sanitized = messages.map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
    let sys = SYSTEM_PROMPT;
    if (isTelemetryQuestion(sanitized)) {
      if (authorized(req)) {
        sys += '\n\nAUTHORIZED PRIVATE SITE TELEMETRY SUMMARY (aggregate only): ' + JSON.stringify(summarizeMetrics(readMetrics())) + '\nExplain these metrics accurately, identify that they are consent-based aggregate events, and do not infer unique visitors because no visitor IDs are stored.';
      } else {
        sys += '\n\nThe user is asking for private site analytics, but no valid owner token was supplied. Do not reveal telemetry numbers. Explain that private aggregate site analytics require owner authorization and invite them to use the Site Owner control in this assistant if they manage this website.';
      }
    }

    let lastError = null;
    let reply = null;

    // Try candidate models in order if one experiences unexpected provider latency
    for (const model of FALLBACK_MODELS) {
      try {
        const resp = await postJson(`${API_BASE_URL}/chat/completions`, {
          model,
          messages: [{ role: 'system', content: sys }, ...sanitized],
          temperature: 0.4,
          max_tokens: 700
        }, {
          'Authorization': `Bearer ${API_KEY}`
        }, 30000);

        if (resp.ok && resp.json?.choices?.[0]?.message?.content) {
          reply = resp.json.choices[0].message.content.trim();
          break;
        } else {
          lastError = `Model ${model} returned ${resp.status}`;
        }
      } catch (err) {
        lastError = err.message;
      }
    }

    if (!reply) {
      console.error('All AI models failed. Last error:', lastError);
      return res.status(502).json({ error: 'Moon is temporarily unable to process your request. Please try again.' });
    }

    res.json({ reply });
  } catch (e) {
    console.error('Chat request exception:', e.message);
    res.status(502).json({
      error: 'Moon is temporarily unable to connect. Please try again in a moment.'
    });
  }
});

app.use(express.static(ROOT, { index: 'index.html', extensions: ['html'] }));

// Explicit routes for Vercel serverless (express.static may not resolve __dirname correctly)
app.get('/google573851dad8cd2940.html', (req, res) => {
  res.sendFile(path.join(ROOT, 'google573851dad8cd2940.html'));
});

// Serve index.html for all unmatched routes (SPA / fallback)
app.get('*', (req, res) => {
  res.sendFile(path.join(ROOT, 'index.html'));
});

// Export for Vercel serverless; also listen for local dev
if (require.main === module) {
  app.listen(PORT, () => console.log(`HS AI Solutions portfolio with Moon running on port ${PORT}`));
}

module.exports = app;
