import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

const PORT = Number(process.env.PORT || 10000);
const API_BASE = 'https://api.17track.net/track/v2.4';
const API_KEY = String(process.env.TRACK17_API_KEY || '').trim();
const CARRIER_CODE = Number(process.env.TRACK17_CARRIER_CODE || 3211); // Correos de Cuba
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'https://zona3brandon.us,https://www.zona3brandon.us')
  .split(',').map(value => value.trim()).filter(Boolean);
const DEBUG_TRACKING = process.env.DEBUG_TRACKING === '1';

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origen no permitido'));
  },
  methods: ['GET'],
  maxAge: 86400
}));
app.use(rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false }));

const STATUS_MAP = {
  NotFound: ['Sin información', 'Pendiente de registro'],
  InfoReceived: ['Información recibida', 'Recepción'],
  InTransit: ['En tránsito', 'En camino'],
  Expired: ['Envío demorado', 'En camino'],
  AvailableForPickup: ['Disponible para recoger', 'En entrega'],
  OutForDelivery: ['En reparto', 'En entrega'],
  DeliveryFailure: ['Intento de entrega', 'En entrega'],
  Delivered: ['Entregado', 'Entregado'],
  Exception: ['Incidencia en el envío', 'En proceso']
};

function clean(value = '') {
  return String(value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function createApiError(message, technicalCode, details = null, status = 502) {
  const error = new Error(message);
  error.technicalCode = technicalCode;
  error.details = details;
  error.status = status;
  return error;
}

async function post17Track(endpoint, body, timeoutMs = 35_000) {
  if (!API_KEY) {
    throw createApiError(
      'La clave de 17TRACK no está configurada en Render.',
      'TRACK17_KEY_MISSING',
      null,
      503
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${API_BASE}/${endpoint}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        '17token': API_KEY,
        'user-agent': 'Zona3B-Tracking/10.2'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const raw = await response.text();
    let payload;
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      throw createApiError('17TRACK devolvió una respuesta no válida.', 'TRACK17_INVALID_RESPONSE', {
        httpStatus: response.status,
        preview: raw.slice(0, 500)
      });
    }

    if (!response.ok || Number(payload?.code ?? 0) !== 0) {
      throw createApiError('17TRACK rechazó la consulta.', 'TRACK17_API_ERROR', {
        httpStatus: response.status,
        response: payload
      }, response.status === 401 || response.status === 403 ? 503 : 502);
    }
    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw createApiError('17TRACK tardó demasiado en responder.', 'TRACK17_TIMEOUT');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function rejectedError(payload) {
  const rejected = payload?.data?.rejected;
  if (!Array.isArray(rejected) || rejected.length === 0) return null;
  const first = rejected[0];
  return {
    code: Number(first?.error?.code || 0),
    message: clean(first?.error?.message || 'La consulta fue rechazada.'),
    carrier: first?.carrier || 0
  };
}

function acceptedItem(payload) {
  const accepted = payload?.data?.accepted;
  return Array.isArray(accepted) && accepted.length ? accepted[0] : null;
}

function eventTimestamp(event) {
  const candidate = event?.time_utc || event?.time_iso ||
    [event?.time_raw?.date, event?.time_raw?.time].filter(Boolean).join('T');
  const timestamp = Date.parse(candidate || '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function formatEvent(event, providerName = '') {
  const translated = event?.description_translation?.description;
  const description = clean(translated || event?.description || event?.stage || 'Movimiento del envío');
  const address = event?.address || {};
  const addressParts = [
    event?.location,
    address?.street,
    address?.city,
    address?.state,
    address?.country,
    address?.postal_code
  ].map(clean).filter(Boolean);

  return {
    status: description,
    date: event?.time_iso || event?.time_utc || clean([
      event?.time_raw?.date,
      event?.time_raw?.time
    ].filter(Boolean).join(' ')),
    location: [...new Set(addressParts)].join(' · '),
    provider: clean(providerName),
    stage: clean(event?.stage || ''),
    subStatus: clean(event?.sub_status || '')
  };
}

function normalizeTrack(item, code) {
  const info = item?.track_info || {};
  const latestStatus = info?.latest_status || {};
  const statusKey = clean(latestStatus?.status || 'NotFound');
  const [status, stage] = STATUS_MAP[statusKey] || [statusKey || 'En proceso', 'En proceso'];

  const providers = Array.isArray(info?.tracking?.providers) ? info.tracking.providers : [];
  const events = [];
  for (const providerEntry of providers) {
    const providerName = providerEntry?.provider?.name || providerEntry?.provider?.alias || '';
    const providerEvents = Array.isArray(providerEntry?.events) ? providerEntry.events : [];
    for (const event of providerEvents) {
      events.push({ ...formatEvent(event, providerName), _ts: eventTimestamp(event) });
    }
  }

  if (events.length === 0 && info?.latest_event) {
    events.push({ ...formatEvent(info.latest_event, providers[0]?.provider?.name || ''), _ts: eventTimestamp(info.latest_event) });
  }

  events.sort((a, b) => b._ts - a._ts);
  const uniqueEvents = [];
  const seen = new Set();
  for (const event of events) {
    const key = `${event.status}|${event.date}|${event.location}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { _ts, ...publicEvent } = event;
    uniqueEvents.push(publicEvent);
  }

  const origin = info?.shipping_info?.shipper_address || {};
  const destination = info?.shipping_info?.recipient_address || {};
  const carrier = providers[0]?.provider || {};
  const estimated = info?.time_metrics?.estimated_delivery_date || {};
  const latestDescription = clean(
    info?.latest_event?.description_translation?.description ||
    info?.latest_event?.description ||
    latestStatus?.sub_status_descr || ''
  );

  const summaryParts = [];
  if (carrier?.name) summaryParts.push(`Transportista: ${clean(carrier.name)}`);
  if (origin?.country) summaryParts.push(`Origen: ${clean(origin.country)}`);
  if (destination?.country) summaryParts.push(`Destino: ${clean(destination.country)}`);
  if (latestDescription) summaryParts.push(latestDescription);

  return {
    ok: true,
    trackingNumber: code,
    carrier: {
      code: item?.carrier || carrier?.key || null,
      name: clean(carrier?.name || carrier?.alias || 'Operador postal')
    },
    status,
    stage,
    mainStatus: statusKey,
    subStatus: clean(latestStatus?.sub_status || ''),
    summary: summaryParts.join(' · ') || 'Información suministrada por 17TRACK.',
    estimatedDelivery: {
      from: estimated?.from || null,
      to: estimated?.to || null,
      source: estimated?.source || null
    },
    events: uniqueEvents.slice(0, 50)
  };
}

function requestItem(code, year, includeCacheLevel = false) {
  const item = {
    number: code,
    origin_country: 'US',
    destination_country: 'CU',
    carrier: CARRIER_CODE,
    auto_detection: false,
    lang: 'es',
    tag: 'ZONA3B-CUBA'
  };
  if (includeCacheLevel) item.cacheLevel = 0;
  // El año se conserva para compatibilidad con la interfaz de Zona 3B.
  // 17TRACK no acepta un año aislado como parámetro de consulta.
  void year;
  return item;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function rejectionFromError(error) {
  return error?.details?.response?.data?.rejected?.[0]?.error || null;
}

function isAlreadyRegistered(rejection) {
  const code = Number(rejection?.code || 0);
  const message = clean(rejection?.message || '').toLowerCase();
  return code === -18019901 || message.includes('already registered') || message.includes('already exists');
}



async function removeWrongCarrierRegistrations(code) {
  // Un número UPU puede coincidir con varios operadores. Versiones anteriores
  // permitieron que 17TRACK lo registrara también como Cyprus Post. Consultamos
  // todas las inscripciones del número y eliminamos únicamente las que no sean
  // Correos de Cuba (3211).
  try {
    const lookup = await post17Track('gettrackinfo', [{ number: code }], 25_000);
    const accepted = Array.isArray(lookup?.data?.accepted) ? lookup.data.accepted : [];
    const wrong = accepted
      .map(item => Number(item?.carrier || item?.track_info?.tracking?.providers?.[0]?.provider?.key || 0))
      .filter(carrier => carrier && carrier !== CARRIER_CODE);

    if (wrong.length === 0) return [];

    const uniqueWrong = [...new Set(wrong)];
    const deletion = await post17Track(
      'deletetrack',
      uniqueWrong.map(carrier => ({ number: code, carrier })),
      25_000
    );

    const deleted = Array.isArray(deletion?.data?.accepted)
      ? deletion.data.accepted.map(item => Number(item?.carrier || 0)).filter(Boolean)
      : [];

    if (deleted.length) {
      console.log(JSON.stringify({ action: 'removed-wrong-carriers', code, deleted }));
    }
    return deleted;
  } catch (error) {
    // La limpieza no debe impedir que el cliente vea el rastreo correcto.
    console.warn(JSON.stringify({
      action: 'carrier-cleanup-skipped',
      code,
      technicalCode: error?.technicalCode || null,
      message: error?.message || String(error)
    }));
    return [];
  }
}

async function getTracking(code, year) {
  await removeWrongCarrierRegistrations(code);
  const queryItem = requestItem(code, year, true);

  // Correos de Cuba debe consultarse con el código de transportista 3211.
  // Intentamos primero una consulta en tiempo real para devolver datos de inmediato.
  try {
    const realtime = await post17Track('getRealTimeTrackInfo', [queryItem], 35_000);
    const realtimeItem = acceptedItem(realtime);
    if (realtimeItem) return normalizeTrack(realtimeItem, code);

    const realtimeRejected = rejectedError(realtime);
    if (realtimeRejected && ![-18019818, -18019909, -18019902].includes(realtimeRejected.code)) {
      throw createApiError(realtimeRejected.message, 'TRACK17_REJECTED', realtimeRejected, 422);
    }
  } catch (error) {
    // Algunos planes o transportistas no permiten consulta instantánea. En esos casos,
    // registramos el número y consultamos el resultado almacenado.
    const rejection = rejectionFromError(error);
    const recoverableCodes = new Set([-18019818, -18019815, -18019816, -18019909, -18019902, -18019912]);
    if (!recoverableCodes.has(Number(rejection?.code || 0)) && error?.technicalCode !== 'TRACK17_API_ERROR') {
      throw error;
    }
  }

  // Registrar explícitamente con Correos de Cuba (carrier 3211).
  try {
    const registration = await post17Track('register', [requestItem(code, year)]);
    const regRejected = rejectedError(registration);
    if (regRejected && !isAlreadyRegistered(regRejected)) {
      throw createApiError(regRejected.message, 'TRACK17_REGISTER_REJECTED', regRejected, 422);
    }
  } catch (error) {
    const rejection = rejectionFromError(error);
    if (!isAlreadyRegistered(rejection)) throw error;
  }

  // 17TRACK indica que el resultado puede tardar varios segundos después del registro.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) await sleep(4000);
    const stored = await post17Track('gettrackinfo', [requestItem(code, year)]);
    const storedItem = acceptedItem(stored);
    if (storedItem) {
      const normalized = normalizeTrack(storedItem, code);
      if (normalized.events.length > 0 || normalized.mainStatus !== 'NotFound') return normalized;
    }

    const rejection = rejectedError(stored);
    if (rejection && ![-18019909, -18019902].includes(rejection.code)) {
      throw createApiError(rejection.message, 'TRACK17_REJECTED', rejection, 422);
    }
  }

  return {
    ok: true,
    trackingNumber: code,
    status: 'Procesando rastreo',
    stage: 'Información recibida',
    mainStatus: 'InfoReceived',
    subStatus: '',
    summary: 'El número fue aceptado por 17TRACK. Los primeros movimientos pueden tardar unos minutos en aparecer.',
    carrier: { code: CARRIER_CODE, name: 'Correos de Cuba' },
    estimatedDelivery: { from: null, to: null, source: null },
    events: []
  };
}

app.get('/health', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({
    ok: true,
    service: 'zona3b-rastreo',
    version: '10.2.0',
    provider: '17TRACK',
    apiConfigured: Boolean(API_KEY)
  });
});

app.get('/api/quota', async (_req, res) => {
  try {
    const quota = await post17Track('getquota', []);
    res.set('Cache-Control', 'no-store').json({ ok: true, data: quota.data || quota });
  } catch (error) {
    res.status(error?.status || 502).json({
      ok: false,
      message: error?.message || 'No fue posible consultar la cuota.',
      technicalCode: error?.technicalCode || 'TRACK17_QUOTA_ERROR'
    });
  }
});

app.get('/api/track', async (req, res) => {
  const code = String(req.query.codigo || '').trim().toUpperCase();
  const year = String(req.query.anio || new Date().getFullYear()).trim();

  if (!/^[A-Z0-9-]{6,40}$/.test(code)) {
    return res.status(400).json({ ok: false, message: 'Número de rastreo inválido.', technicalCode: 'INVALID_TRACKING_NUMBER' });
  }
  if (!/^20\d{2}$/.test(year)) {
    return res.status(400).json({ ok: false, message: 'Año inválido.', technicalCode: 'INVALID_YEAR' });
  }

  try {
    const result = await getTracking(code, year);
    return res.set('Cache-Control', 'no-store').json({
      ...result,
      source: '17TRACK',
      checkedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error(JSON.stringify({
      time: new Date().toISOString(),
      code,
      year,
      technicalCode: error?.technicalCode,
      message: error?.message,
      details: error?.details || null
    }));

    return res.status(error?.status || 502).set('Cache-Control', 'no-store').json({
      ok: false,
      message: error?.message || 'No fue posible obtener el rastreo en este momento.',
      technicalCode: error?.technicalCode || 'TRACK17_UPSTREAM_ERROR',
      upstream: error?.details?.response?.data?.rejected?.[0]?.error || error?.details?.response || null,
      ...(DEBUG_TRACKING ? { debug: error?.details || null } : {})
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Zona 3B tracking server v10.2 listening on ${PORT}; 17TRACK configured=${Boolean(API_KEY)}`);
});
