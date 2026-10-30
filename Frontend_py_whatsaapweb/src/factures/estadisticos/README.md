# Modulo de reportes

## Estado

El dashboard consume datos reales del backend. No usa fallback mock.

## Funcionalidades

- Metricas generales por rango de fechas.
- Filtro opcional por etiqueta.
- Distribucion por etiqueta y tipo de mensaje.
- Chats con mayor actividad.
- Actividad diaria.
- Heatmap de mensajes entrantes por dia y hora.
- Vista previa de pedidos y servicios registrados.
- Exportacion operativa CSV y Excel compatible.

## Endpoints

- `GET /api/reports/metrics`
- `GET /api/reports/stats`
- `GET /api/reports/operations`
- `GET /api/reports/operations/export?format=csv|xls`
- `GET /api/reports/heatmap`
- `GET /api/reports/chat/:chatId/history`

Los endpoints requieren JWT y rol `ADMIN`.

## Archivos principales

- `Reportes.tsx`: pantalla y filtros.
- `components/HeatmapGrid.tsx`: matriz dias x horas.
- `components/ExportSection.tsx`: vista previa y descargas.
- `hooks/useReports.ts`: carga coordinada de metricas y heatmap.
- `services/reportsService.ts`: cliente HTTP tipado.
