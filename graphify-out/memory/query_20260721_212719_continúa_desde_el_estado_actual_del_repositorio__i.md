---
type: "query"
date: "2026-07-21T21:27:19.898238+00:00"
question: "Continúa desde el estado actual del repositorio. Inspecciona y normaliza la integración entre Meta Developers, WhatsApp Cloud API, webhook, Cloudflare Tunnel y variables de entorno, sin modificar código; entrega arquitectura, flujo, problemas, riesgos, propuesta, plan por archivo y criterios OpenAI Build Week."
contributor: "graphify"
outcome: "useful"
source_nodes: ["metaWebhookRoutes.ts", "WhatsAppService", "MetaCloudClient", "AiRuntimeOrchestrator", "dev-tunnel.ts", "http.ts"]
---

# Q: Continúa desde el estado actual del repositorio. Inspecciona y normaliza la integración entre Meta Developers, WhatsApp Cloud API, webhook, Cloudflare Tunnel y variables de entorno, sin modificar código; entrega arquitectura, flujo, problemas, riesgos, propuesta, plan por archivo y criterios OpenAI Build Week.

## Answer

Expanded from original query via vocab: [whatsapp, webhook, meta, cloudflare, tunnel, agent, message, config, env, callback, verify, inbound]. El flujo actual es Meta y Cloudflare hacia metaWebhookRoutes, WhatsAppService, MetaInboxStore y PostgreSQL, luego AiRuntimeOrchestrator y tools, salida por MetaCloudClient y eventos al frontend. Hallazgos: no existen env examples, dev:tunnel inicia backend si falta y siempre el tunel, la URL se extrae de trycloudflare y se concatena con el path fijo; token de verificacion y URL se duplican en archivos versionados; firma POST es opcional; ACK espera IA y outbound; tenant desconocido cae al default; el router multiagente no se usa y se fija gestion_web; Quick Tunnel publica todo el backend. Propuesta: fuente global env para secretos de la Meta App, credenciales por empresa cifradas en DB con env solo bootstrap, callback constante, salida runtime ignorada, firma obligatoria, ingesta durable con ACK rapido, tenant estricto, JWT y sockets por empresa, cablear router existente, proveedor OpenAI explicito, pruebas y documentacion reproducible.

## Outcome

- Signal: useful

## Source Nodes

- metaWebhookRoutes.ts
- WhatsAppService
- MetaCloudClient
- AiRuntimeOrchestrator
- dev-tunnel.ts
- http.ts