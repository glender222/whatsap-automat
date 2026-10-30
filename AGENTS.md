# Instrucciones del workspace

Este workspace contiene dos aplicaciones relacionadas:

- Frontend_py_whatsaapweb
- WhatsaapWeb-JS

## Uso del grafo

- Antes de realizar búsquedas amplias en el repositorio, consultar:
  - graphify-out/graph.json
  - graphify-out/GRAPH_REPORT.md
- Usar Graphify para identificar símbolos, dependencias, rutas y posibles
  efectos de un cambio antes de abrir numerosos archivos.
- Para cambios transversales, trazar el flujo completo entre frontend,
  endpoints, rutas, servicios, repositorios y base de datos.
- No reconstruir el grafo completo después de cada cambio.
- Después de cambios arquitectónicos o modificaciones importantes,
  actualizar Graphify incrementalmente.
- No modificar manualmente graphify-out/graph.json.
- Antes de modificar una subcarpeta, leer su AGENTS.md correspondiente.

## Forma de trabajo

1. Analizar el impacto del cambio.
2. Presentar los archivos relevantes.
3. Implementar el cambio mínimo necesario.
4. Ejecutar las pruebas existentes.
5. Revisar el diff.
6. Actualizar el grafo cuando el cambio afecte la arquitectura.