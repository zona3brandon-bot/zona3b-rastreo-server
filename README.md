# Zona 3B Tracking Server v10.3

Backend para la página de seguimiento de Zona 3B Brandon usando la API oficial de 17TRACK.

## Corrección crítica

- **Correos de Cuba:** carrier `3201`
- **Cyprus Post:** carrier `3211`

Esta versión corrige automáticamente registros antiguos creados con Cyprus Post mediante el endpoint oficial `changecarrier`, y después consulta siempre con Correos de Cuba.

## Variable requerida

`TRACK17_API_KEY`

## Endpoints

- `GET /health`
- `GET /api/quota`
- `GET /api/track?codigo=CM872184101ZB&anio=2026`
