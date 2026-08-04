# Zona 3B Tracking Server v9.0

Servidor Node.js + Playwright para consultar el rastreador público de Correos de Cuba.

## Actualización

Esta versión mejora la localización del formulario, captura respuestas XHR/fetch, reintenta la consulta y registra diagnósticos detallados en los Logs de Render.

## Archivos que se reemplazan en GitHub

- `src/server.js`
- `package.json`

También puede subirse todo el contenido de esta carpeta reemplazando el repositorio actual.

## Pruebas

- `GET /health`
- `GET /api/track?codigo=CM872184101ZB&anio=2026`

## Diagnóstico temporal

Si aún falla, agregue en Render la variable `DEBUG_TRACKING=1`, despliegue de nuevo y abra el endpoint de prueba. La respuesta incluirá datos técnicos para identificar cambios del sitio externo. Después elimine o cambie la variable a `0`.
