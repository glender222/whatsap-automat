---
type: "query"
date: "2026-07-21T22:27:42.146334+00:00"
question: "Implementa únicamente un MVP estable y demostrable. Prioriza el recorrido: WhatsApp real → webhook → identificación de intención → selección real de agente → consulta de stock o creación de prepedido → respuesta por WhatsApp → actualización del frontend o handoff humano."
contributor: "graphify"
outcome: "useful"
source_nodes: ["config/index.ts", "dev-tunnel.ts", "metaWebhookRoutes.ts", "WhatsAppService", "MetaInboxStore", "AiRuntimeOrchestrator.ts", "AgentRouterService.ts", "AgentToolContext", "AgentRepositoryPg", "HandoffTicketRepositoryPg"]
---

# Q: Implementa únicamente un MVP estable y demostrable. Prioriza el recorrido: WhatsApp real → webhook → identificación de intención → selección real de agente → consulta de stock o creación de prepedido → respuesta por WhatsApp → actualización del frontend o handoff humano.

## Answer

Expanded from original query via graph vocab: [webhook, router, agent, provider, config, tunnel, meta, whatsapp, inbound, outbound, stock, handoff]. Implemented the P0 on the existing architecture: strict environment configuration, safe Cloudflare Quick Tunnel launcher, signed and tenant-aware Meta webhook with wamid deduplication, real AgentRouterService selection through AiRuntimeOrchestrator, OpenAI Responses provider behind the existing factory, safe tool and wamid tracing, persisted handoff gating and frontend configuration. Backend tests, build, typechecks and frontend build passed. Live Meta, OpenAI, PostgreSQL and Quick Tunnel end-to-end validation remains manual because no real local env or OpenAI key was available.

## Outcome

- Signal: useful

## Source Nodes

- config/index.ts
- dev-tunnel.ts
- metaWebhookRoutes.ts
- WhatsAppService
- MetaInboxStore
- AiRuntimeOrchestrator.ts
- AgentRouterService.ts
- AgentToolContext
- AgentRepositoryPg
- HandoffTicketRepositoryPg
- MetaCloudClient