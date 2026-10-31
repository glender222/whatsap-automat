# @whatsap-automat/contracts (PR-04)

Paquete central de contratos canónicos, esquemas de validación en tiempo de ejecución, adaptadores y fixtures sintéticos para **Whatsap-Automat v0.4**.

## Propósito y Arquitectura

Este paquete implementa la especificación de contratos establecida en el **Blueprint v0.4 (Sección 5)** siguiendo los principios de **Arquitectura Hexagonal (Puertos y Adaptadores)**:

1. **Desacoplamiento Total del Núcleo**: Los contratos canónicos (`ChannelEventV1`, `SendMessageCommandV1`, `AgentGraphVersionV1`, `ApprovalRequestV1`, `ConversationV1`, `ServerEventV1`) definen la frontera del dominio independiente de bases de datos o proveedores externos.
2. **Validación en Runtime**: Esquemas construidos con Zod garantizan la integridad de los datos en tiempo de ejecución (`safeParse`), devolviendo detalles estructurados de error (`invalidParams`).
3. **Vocabulario Canónico de Errores**: Normalización de errores mediante el estándar **RFC 7807 / RFC 9457 (`ProblemDetailsV1`)** y códigos de error unificados (`UNAUTHORIZED`, `POLICY_DENIED`, `APPROVAL_REQUIRED`, `NOT_FOUND`, `CONFLICT`, `VALIDATION_ERROR`, `RATE_LIMITED`, `UNKNOWN_DELIVERY`, `RETRYABLE`, `INTERNAL_ERROR`).
4. **Puertos y Adaptadores de Transición**: Conserva compatibilidad total con la base de código preexistente (`MessageChannelPort`, `InboundMessageDTO`, etc.) mediante `LegacyChannelAdapterBridge` y `LegacyConversationMapper`.
5. **Fixtures Sintéticos Deterministas (CH-01)**: Conjunto completo de fixtures para los 4 canales canónicos (`whatsapp-cloud`, `instagram`, `messenger`, `telegram`), grafos de agentes, aprobaciones y eventos realtime, ejecutables en pruebas sin conexión a internet ni bases de datos externas.

---

## Estructura del Paquete

```text
packages/contracts/
├── src/
│   ├── index.ts                     # Punto de entrada público
│   ├── common/                      # TenantActor, TenantContext, Paginación, Headers
│   ├── channels/                    # Tipos, ChannelEventV1, SendMessageCommandV1, ChannelAdapterV1
│   ├── conversations/               # ConversationV1, ConversationMessageV1, CAS Commands, Realtime
│   ├── agents/                      # NodeKind, AgentGraphVersionV1, AgentRunTraceV1, ToolInvocationV1
│   ├── workflows/                   # AutomationDefinitionV1, ExecutionRecordV1
│   ├── approvals/                   # ApprovalRequestV1, ApprovalDecisionCommandV1, RiskLevel
│   ├── identities/                  # ChannelIdentityV1, MemoryRecordV1
│   ├── errors/                      # StandardErrorCode, ProblemDetailsV1, Esquemas
│   ├── adapters/                    # LegacyChannelAdapterBridge, LegacyConversationMapper
│   └── synthetic/                   # Fixtures sintéticos para 4 canales, grafos, approvals, realtime
└── tests/
    ├── channelContracts.test.ts     # Pruebas CH-01 y ChannelAdapterV1
    ├── conversationsAndCas.test.ts  # Pruebas de conversación, CAS y rooms
    ├── agentGraphsAndApprovals.test.ts # Pruebas de grafos y approvals
    ├── legacyAdapters.test.ts       # Pruebas de adaptadores y mapeo bidireccional
    ├── errorVocabulary.test.ts      # Pruebas de ProblemDetails y códigos de error
    └── isolation.test.ts            # Garantía de pruebas in-memory sin red
```

---

## Comandos del Paquete

Desde la carpeta `packages/contracts`:

```bash
# Compilar tipos TypeScript y generar dist/ (.d.ts + .js)
npm run build

# Validar comprobación de tipos estricta sin emitir
npm run typecheck

# Ejecutar suite de pruebas de contrato (Node.js test runner con tsx)
npm test
```

---

## Uso de Adaptadores para Preservar Contratos Existentes

Para integrar código nuevo sin romper controladores legacy ni migraciones:

```typescript
import {
  LegacyChannelAdapterBridge,
  mapLegacyInboundToCanonicalEvent,
  mapCanonicalCommandToLegacyOutbound,
} from '@whatsap-automat/contracts';

// Envolver un puerto legacy sin modificar su implementación interna:
const adapter = new LegacyChannelAdapterBridge(existingMessageChannelPort, {
  kind: 'whatsapp-cloud',
  defaultTenantId: '1',
  defaultConnectionId: 'conn_wa_primary',
});

// Enviar comandos canónicos a través del puerto existente
const result = await adapter.send(canonicalSendCommand);
```
