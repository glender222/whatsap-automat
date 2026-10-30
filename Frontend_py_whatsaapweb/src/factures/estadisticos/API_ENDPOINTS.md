# API de reportes

Todas las rutas requieren `Authorization: Bearer <token>` y rol `ADMIN`.

## Filtros comunes

- `startDate`: fecha ISO `YYYY-MM-DD`.
- `endDate`: fecha ISO `YYYY-MM-DD`.
- `timezone`: zona IANA; por defecto `America/Lima`.
- `tagId`: etiqueta opcional.

El backend limita cada rango a 366 dias.

## Metricas

```http
GET /api/reports/metrics
GET /api/reports/stats
```

Devuelven metricas generales, actividad diaria, distribuciones y chats con mayor actividad.

## Reporte operativo

```http
GET /api/reports/operations
GET /api/reports/operations/export?format=csv
GET /api/reports/operations/export?format=xls
```

La consulta admite `status`, `actorUserId`, `limit` y `offset`. La exportacion incluye hasta 5000 filas.

## Mapa de calor

```http
GET /api/reports/heatmap
```

Devuelve una matriz normalizada de 7 dias x 24 horas para mensajes entrantes.

## Historial exportable

```http
GET /api/reports/chat/:chatId/history
```

Devuelve el historial real persistido en PostgreSQL para el chat solicitado.
