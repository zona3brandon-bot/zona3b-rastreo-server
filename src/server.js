import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { chromium } from 'playwright';

const PORT = Number(process.env.PORT || 10000);
const TRACKING_URL = process.env.TRACKING_URL || 'https://www.correos.cu/rastreador-de-envios/';
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'https://zona3brandon.us,https://www.zona3brandon.us')
  .split(',').map(v => v.trim()).filter(Boolean);

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('Origen no permitido'));
  },
  methods: ['GET'],
  maxAge: 86400
}));
app.use(rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false }));

let browserPromise;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-blink-features=AutomationControlled']
    }).catch(err => { browserPromise = null; throw err; });
  }
  return browserPromise;
}

function clean(value = '') {
  return String(value).replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

const statusPattern = /^(FACTURADO|CLASIFICADO|SALIDA ADUANA|ENTREGADO A ADUANA|RECEPCIONADO|RECIBIDO|EN CAMINO|EN ENTREGA|ENTREGADO|DESPACHADO|ARRIBO|ADUANA)$/i;
const datePattern = /(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s+\d{1,2},\s+\d{4}(?:\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)?|\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/i;

function parseText(raw) {
  const text = clean(raw);
  const lines = text.split('\n').map(clean).filter(Boolean);
  const events = [];

  for (let i = 0; i < lines.length; i++) {
    const possibleStatus = clean(lines[i].replace(datePattern, ''));
    if (!statusPattern.test(possibleStatus)) continue;
    const nearby = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 5));
    const joined = nearby.join(' · ');
    const date = (joined.match(datePattern) || [])[0] || '';
    const location = nearby.filter(v => /^(En:|Hacia:)/i.test(v)).join(' · ');
    if (!events.some(e => e.status === possibleStatus && e.date === date)) {
      events.push({ status: possibleStatus, date, location });
    }
  }

  let stage = 'En proceso';
  let status = 'Información localizada';
  if (/\bENTREGADO\b/i.test(text)) { stage = 'Entregado'; status = 'Envío entregado'; }
  else if (/EN ENTREGA/i.test(text)) { stage = 'En entrega'; status = 'En proceso de entrega'; }
  else if (/EN CAMINO|FACTURADO|DESPACHADO/i.test(text)) { stage = 'En camino'; status = 'Envío en camino'; }
  else if (/RECEPCIONADO|RECIBIDO|CLASIFICADO/i.test(text)) { stage = 'Recepción'; status = 'Envío recibido'; }

  const country = (text.match(/Pa[ií]s Origen:\s*([^\n]+)/i) || [])[1];
  return {
    ok: events.length > 0,
    status,
    stage,
    summary: country ? `País de origen: ${clean(country)}` : 'Movimientos informados por el operador postal.',
    events: events.slice(0, 25)
  };
}

async function locateTrackingInputs(page) {
  const inputs = page.locator('input:visible');
  const count = await inputs.count();
  let codeInput = null;
  let yearInput = null;

  for (let i = 0; i < count; i++) {
    const el = inputs.nth(i);
    const meta = `${await el.getAttribute('name') || ''} ${await el.getAttribute('id') || ''} ${await el.getAttribute('placeholder') || ''}`.toLowerCase();
    if (!codeInput && /(c[oó]digo|codigo|seguimiento|rastreo|tracking|env[ií]o)/i.test(meta)) codeInput = el;
    if (!yearInput && /(año|ano|year)/i.test(meta)) yearInput = el;
  }

  // El formulario oficial muestra código y año juntos; estos fallbacks evitan depender de nombres internos.
  if (!codeInput && count >= 1) codeInput = inputs.nth(0);
  if (!yearInput && count >= 2) yearInput = inputs.nth(1);
  return { codeInput, yearInput };
}

async function track(code, year) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    locale: 'es-ES',
    timezoneId: 'America/Havana',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 1100 },
    extraHTTPHeaders: { 'Accept-Language': 'es-ES,es;q=0.9' }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);

  try {
    await page.goto(TRACKING_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const { codeInput, yearInput } = await locateTrackingInputs(page);
    if (!codeInput || !yearInput) throw new Error('No se localizaron los campos del rastreador oficial.');

    await codeInput.fill(code);
    await yearInput.fill(String(year));

    const searchButton = page.getByRole('button', { name: /buscar/i }).first();
    if (await searchButton.count()) await searchButton.click();
    else {
      const submit = page.locator('input[type="submit"]:visible, button[type="submit"]:visible').first();
      if (!await submit.count()) throw new Error('No se encontró el botón Buscar.');
      await submit.click();
    }

    await page.waitForFunction(() => {
      const t = document.body?.innerText?.toUpperCase() || '';
      return ['FACTURADO','CLASIFICADO','RECEPCIONADO','ENTREGADO A ADUANA','SALIDA ADUANA'].some(s => t.includes(s))
        || /NO (SE )?(ENCUENTRA|EXISTE)|SIN INFORMACIÓN|SIN INFORMACION/.test(t);
    }, null, { timeout: 30_000 });

    const bodyText = await page.locator('body').innerText();
    const result = parseText(bodyText);
    if (!result.ok) {
      if (/NO (SE )?(ENCUENTRA|EXISTE)|SIN INFORMACIÓN|SIN INFORMACION/i.test(bodyText)) {
        return { ok: true, status: 'Sin información disponible', stage: 'Pendiente de registro', summary: 'El operador postal todavía no muestra movimientos para este código.', events: [] };
      }
      throw new Error('El rastreador respondió, pero no se pudieron interpretar los movimientos.');
    }
    return result;
  } finally {
    await context.close();
  }
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'zona3b-rastreo' }));

app.get('/api/track', async (req, res) => {
  const code = String(req.query.codigo || '').trim().toUpperCase();
  const year = String(req.query.anio || new Date().getFullYear()).trim();
  if (!/^[A-Z0-9-]{6,40}$/.test(code)) return res.status(400).json({ ok: false, message: 'Número de rastreo inválido.' });
  if (!/^20\d{2}$/.test(year)) return res.status(400).json({ ok: false, message: 'Año inválido.' });

  try {
    const result = await track(code, year);
    return res.set('Cache-Control', 'no-store').json(result);
  } catch (error) {
    console.error(new Date().toISOString(), code, error);
    return res.status(502).set('Cache-Control', 'no-store').json({
      ok: false,
      message: 'No fue posible obtener el rastreo en este momento. Intenta nuevamente en unos minutos.',
      technicalCode: 'UPSTREAM_TRACKING_ERROR'
    });
  }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Zona 3B tracking server listening on ${PORT}`));

process.on('SIGTERM', async () => {
  if (browserPromise) {
    try { const browser = await browserPromise; await browser.close(); } catch {}
  }
  process.exit(0);
});
