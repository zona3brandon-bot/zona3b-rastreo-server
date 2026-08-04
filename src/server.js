import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { chromium } from 'playwright';

const PORT = Number(process.env.PORT || 10000);
const TRACKING_URL = process.env.TRACKING_URL || 'https://www.correos.cu/rastreador-de-envios/';
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'https://zona3brandon.us,https://www.zona3brandon.us')
  .split(',').map(v => v.trim()).filter(Boolean);
const DEBUG_TRACKING = process.env.DEBUG_TRACKING === '1';

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
      args: [
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process'
      ]
    }).catch(err => { browserPromise = null; throw err; });
  }
  return browserPromise;
}

function clean(value = '') {
  return String(value)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

const statusPattern = /^(FACTURADO|CLASIFICADO|SALIDA(?: DE)? ADUANA|ENTREGADO A ADUANA|RECEPCIONADO|RECIBIDO|EN CAMINO|EN ENTREGA|ENTREGADO|DESPACHADO|ARRIBO|ADUANA|LLEGADA A LA OCI|IMPOSICI[ÓO]N|INTENTO ENTREGA|EN TR[ÁA]NSITO|DEVUELTO)$/i;
const datePattern = /(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},\s+\d{4}(?:\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)?|\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/i;
const resultMarkers = /PA[IÍ]S ORIGEN|FACTURADO|CLASIFICADO|RECEPCIONADO|ENTREGADO A ADUANA|SALIDA(?: DE)? ADUANA|LLEGADA A LA OCI|IMPOSICI[ÓO]N|INTENTO ENTREGA/i;
const emptyMarkers = /NO (?:SE )?(?:ENCUENTRA|EXISTE)|SIN INFORMACI[ÓO]N|NO HAY INFORMACI[ÓO]N|NO SE ENCONTRARON RESULTADOS|NO EST[ÁA] REGISTRADO/i;

function parseText(raw) {
  const text = clean(raw);
  const lines = text.split('\n').map(clean).filter(Boolean);
  const events = [];

  for (let i = 0; i < lines.length; i++) {
    const lineWithoutDate = clean(lines[i].replace(datePattern, ''));
    if (!statusPattern.test(lineWithoutDate)) continue;

    const nearby = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 6));
    const joined = nearby.join(' · ');
    const date = (joined.match(datePattern) || [])[0] || '';
    const locationParts = nearby.filter(v => /^(En:|Hacia:|Peso:)/i.test(v));
    const location = locationParts.join(' · ');
    const status = lineWithoutDate.toUpperCase();

    if (!events.some(e => e.status === status && e.date === date && e.location === location)) {
      events.push({ status, date, location });
    }
  }

  let stage = 'En proceso';
  let status = 'Información localizada';
  if (/\bENTREGADO\b/i.test(text) && !/ENTREGADO A ADUANA/i.test(text)) {
    stage = 'Entregado'; status = 'Envío entregado';
  } else if (/INTENTO ENTREGA|EN ENTREGA/i.test(text)) {
    stage = 'En entrega'; status = 'En proceso de entrega';
  } else if (/EN CAMINO|FACTURADO|DESPACHADO|SALIDA(?: DE)? ADUANA|EN TR[ÁA]NSITO/i.test(text)) {
    stage = 'En camino'; status = 'Envío en camino';
  } else if (/RECEPCIONADO|RECIBIDO|CLASIFICADO|ENTREGADO A ADUANA/i.test(text)) {
    stage = 'Recepción'; status = 'Envío recibido';
  }

  const country = (text.match(/Pa[ií]s Origen:\s*([^\n]+)/i) || [])[1];
  return {
    ok: events.length > 0,
    status,
    stage,
    summary: country ? `País de origen: ${clean(country)}` : 'Movimientos informados por el operador postal.',
    events: events.slice(0, 30)
  };
}

async function firstVisible(locator) {
  const count = await locator.count();
  for (let i = 0; i < count; i++) {
    const item = locator.nth(i);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return null;
}

async function locateForm(page) {
  const codeInput = await firstVisible(page.locator([
    'input[placeholder*="código" i]',
    'input[placeholder*="codigo" i]',
    'input[placeholder*="seguimiento" i]',
    'input[name*="codigo" i]',
    'input[id*="codigo" i]',
    'input[name*="tracking" i]'
  ].join(',')));

  const yearInput = await firstVisible(page.locator([
    'input[placeholder*="año" i]',
    'input[placeholder*="ano" i]',
    'input[name*="anno" i]',
    'input[name*="anio" i]',
    'input[name*="year" i]',
    'input[id*="anno" i]',
    'input[id*="anio" i]'
  ].join(',')));

  if (codeInput && yearInput) return { codeInput, yearInput };

  // Fallback: ubica el bloque que contiene el título del rastreador y usa sus campos visibles.
  const heading = page.getByText(/RASTREADOR DE ENV[IÍ]OS/i).first();
  if (await heading.count()) {
    const block = heading.locator('xpath=ancestor::*[self::form or self::section or self::div][.//input][1]');
    if (await block.count()) {
      const visible = block.locator('input:visible');
      const count = await visible.count();
      if (count >= 2) return { codeInput: visible.nth(count - 2), yearInput: visible.nth(count - 1) };
    }
  }

  const visibleInputs = page.locator('input:visible');
  const count = await visibleInputs.count();
  for (let i = 0; i < count - 1; i++) {
    const a = visibleInputs.nth(i);
    const b = visibleInputs.nth(i + 1);
    const ap = clean(await a.getAttribute('placeholder') || '');
    const bp = clean(await b.getAttribute('placeholder') || '');
    if (/c[oó]digo|seguimiento/i.test(ap) && /año|ano/i.test(bp)) return { codeInput: a, yearInput: b };
  }

  return { codeInput: null, yearInput: null };
}

async function findSearchButton(page, codeInput) {
  // Primero busca dentro del mismo formulario/contenedor que el campo de código.
  const form = codeInput.locator('xpath=ancestor::form[1]');
  if (await form.count()) {
    const btn = await firstVisible(form.locator('button, input[type="submit"], input[type="button"]'));
    if (btn) return btn;
  }

  const parentBlock = codeInput.locator('xpath=ancestor::*[self::section or self::div][.//*[self::button or @type="submit" or @type="button"]][1]');
  if (await parentBlock.count()) {
    const btn = await firstVisible(parentBlock.locator('button:has-text("Buscar"), input[value*="Buscar" i], button[type="submit"], input[type="submit"]'));
    if (btn) return btn;
  }

  return firstVisible(page.locator('button:has-text("Buscar"), input[value*="Buscar" i], button[type="submit"], input[type="submit"]'));
}

async function waitForResult(page, capturedBodies, timeoutMs = 45_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const bodyText = await page.locator('body').innerText().catch(() => '');
    if (resultMarkers.test(bodyText) || emptyMarkers.test(bodyText)) return bodyText;

    for (let i = capturedBodies.length - 1; i >= 0; i--) {
      const candidate = capturedBodies[i]?.body || '';
      if (resultMarkers.test(candidate) || emptyMarkers.test(candidate)) return candidate;
    }
    await page.waitForTimeout(750);
  }
  return '';
}

async function performAttempt(code, year, attempt) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    locale: 'es-ES',
    timezoneId: 'America/Havana',
    viewport: { width: 1440, height: 1100 },
    extraHTTPHeaders: {
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.7',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache'
    }
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['es-ES', 'es', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  });

  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const capturedBodies = [];
  const networkLog = [];

  page.on('response', async response => {
    const req = response.request();
    const type = req.resourceType();
    const ct = response.headers()['content-type'] || '';
    if (['xhr', 'fetch', 'document'].includes(type)) {
      networkLog.push({ method: req.method(), status: response.status(), type, url: response.url().slice(0, 300) });
      if (/text|html|json|javascript/i.test(ct)) {
        try {
          const body = await response.text();
          if (body && body.length < 2_000_000) capturedBodies.push({ url: response.url(), body });
        } catch {}
      }
    }
  });

  // Evita descargar recursos pesados; no bloquea scripts, XHR ni hojas de estilo.
  await page.route('**/*', route => {
    const type = route.request().resourceType();
    if (['image', 'media', 'font'].includes(type)) return route.abort();
    return route.continue();
  });

  try {
    const target = `${TRACKING_URL}${TRACKING_URL.includes('?') ? '&' : '?'}zona3b=${Date.now()}-${attempt}`;
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});

    const { codeInput, yearInput } = await locateForm(page);
    if (!codeInput || !yearInput) {
      const inputs = await page.locator('input:visible').evaluateAll(nodes => nodes.map(n => ({
        name: n.getAttribute('name'), id: n.id, placeholder: n.getAttribute('placeholder'), type: n.getAttribute('type')
      })));
      throw Object.assign(new Error('No se localizaron los campos del rastreador oficial.'), { diagnostics: { inputs, networkLog } });
    }

    await codeInput.scrollIntoViewIfNeeded();
    await codeInput.click({ clickCount: 3 });
    await codeInput.fill(code);
    await yearInput.click({ clickCount: 3 });
    await yearInput.fill(String(year));

    const button = await findSearchButton(page, codeInput);
    if (!button) throw Object.assign(new Error('No se encontró el botón Buscar.'), { diagnostics: { networkLog } });

    await Promise.all([
      button.click({ force: true }),
      page.waitForTimeout(500)
    ]);

    // Algunos formularios solo reaccionan bien al Enter.
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

    const resultText = await waitForResult(page, capturedBodies, 45_000);
    if (!resultText) {
      const bodyText = await page.locator('body').innerText().catch(() => '');
      throw Object.assign(new Error('El rastreador no produjo una respuesta reconocible.'), {
        diagnostics: {
          pageUrl: page.url(),
          bodyPreview: clean(bodyText).slice(0, 2500),
          networkLog: networkLog.slice(-30),
          capturedUrls: capturedBodies.map(x => x.url).slice(-20)
        }
      });
    }

    if (emptyMarkers.test(resultText) && !resultMarkers.test(resultText)) {
      return {
        ok: true,
        status: 'Sin información disponible',
        stage: 'Pendiente de registro',
        summary: 'El operador postal todavía no muestra movimientos para este código.',
        events: []
      };
    }

    const result = parseText(resultText);
    if (!result.ok) {
      throw Object.assign(new Error('Se recibió información, pero no se pudieron interpretar los movimientos.'), {
        diagnostics: { resultPreview: clean(resultText).slice(0, 3000), networkLog: networkLog.slice(-30) }
      });
    }
    return result;
  } finally {
    await context.close();
  }
}

async function track(code, year) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await performAttempt(code, year, attempt);
    } catch (error) {
      lastError = error;
      console.error(JSON.stringify({
        time: new Date().toISOString(), code, year, attempt,
        error: error?.message,
        diagnostics: error?.diagnostics || null
      }));
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }
  throw lastError;
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'zona3b-rastreo', version: '9.0.0' }));

app.get('/api/track', async (req, res) => {
  const code = String(req.query.codigo || '').trim().toUpperCase();
  const year = String(req.query.anio || new Date().getFullYear()).trim();
  if (!/^[A-Z0-9-]{6,40}$/.test(code)) return res.status(400).json({ ok: false, message: 'Número de rastreo inválido.' });
  if (!/^20\d{2}$/.test(year)) return res.status(400).json({ ok: false, message: 'Año inválido.' });

  try {
    const result = await track(code, year);
    return res.set('Cache-Control', 'no-store').json({ ...result, source: 'Correos de Cuba', checkedAt: new Date().toISOString() });
  } catch (error) {
    return res.status(502).set('Cache-Control', 'no-store').json({
      ok: false,
      message: 'No fue posible obtener el rastreo en este momento. Intenta nuevamente en unos minutos.',
      technicalCode: 'UPSTREAM_TRACKING_ERROR',
      ...(DEBUG_TRACKING ? { debug: { message: error?.message, diagnostics: error?.diagnostics || null } } : {})
    });
  }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Zona 3B tracking server v9.0 listening on ${PORT}`));

process.on('SIGTERM', async () => {
  if (browserPromise) {
    try { const browser = await browserPromise; await browser.close(); } catch {}
  }
  process.exit(0);
});
