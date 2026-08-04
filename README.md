# Zona 3B Tracking Server v10.2

Backend Node.js para la API oficial de 17TRACK.

## Corrección principal

- Fuerza el transportista **Correos de Cuba (código 3211)**.
- Intenta consulta en tiempo real.
- Si no está disponible, registra la guía y consulta los datos almacenados.
- Devuelve el error real de 17TRACK en el campo `upstream` para facilitar diagnósticos.

## Variable requerida en Render

`TRACK17_API_KEY`

Opcional: `TRACK17_CARRIER_CODE=3211`


## Corrección v10.2

- Fuerza siempre Correos de Cuba (`carrier: 3211`, `auto_detection: false`).
- Detecta y elimina inscripciones duplicadas del mismo número con transportistas incorrectos.
- Conserva únicamente la inscripción oficial de Correos de Cuba.
