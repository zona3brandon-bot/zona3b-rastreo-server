# Zona 3B Tracking Server v10.0

Backend Node.js para consultar la API oficial de 17TRACK y entregar los movimientos a `zona3brandon.us`.

## Variable obligatoria en Render

- `TRACK17_API_KEY`: clave de seguridad completa de 17TRACK.

No publiques esta clave en GitHub ni dentro de la página web.

## Variable opcional

- `TRACK17_CARRIER_CODE`: código numérico del operador en 17TRACK. Déjala sin configurar para permitir detección automática.
- `ALLOWED_ORIGINS`: por defecto `https://zona3brandon.us,https://www.zona3brandon.us`.
- `DEBUG_TRACKING=1`: agrega detalles técnicos a los errores. Úsala solo temporalmente.

## Endpoints

- `GET /health`
- `GET /api/quota`
- `GET /api/track?codigo=CM872184101ZB&anio=2026`

## Verificación

1. Sube todos los archivos a la raíz de `zona3b-rastreo-server`.
2. Render desplegará el nuevo commit automáticamente.
3. Abre `/health` y confirma `"version":"10.0.0"` y `"apiConfigured":true`.
4. Abre `/api/quota` para verificar la clave y la cuota.
5. Prueba `/api/track`.

La primera consulta puede devolver `Sin información` si 17TRACK todavía no recibe movimientos del operador. El servidor utiliza primero `/gettrackinfo` y después `/getRealTimeTrackInfo` en modo estándar.
