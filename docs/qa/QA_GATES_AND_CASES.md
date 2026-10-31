# QA GATES AND CASES

## 13. QA — gates estrictos, no solo unit tests

### 13.1 Pipeline obligatorio (una vez instalado)

1. formato, lint, TypeScript estrictos, análisis de dependencias/licencias y secret scanning.
2. unit tests y propiedad de esquemas.
3. contract tests entre adapter ↔ event, web ↔ API, mobile ↔ API.
4. integración PostgreSQL (migraciones clean/upgrade y RLS con roles reales).
5. Temporal tests con test server/time skipping, replay, worker restart, Signal/Approval, versioning.
6. pruebas de seguridad adversarial cross-tenant en HTTP/Socket/SQL/media.
7. agent evals: prompt injection, wrong tool, loops/cost, fallback, outputs verificables.
8. E2E web (onboarding, Inbox, agents, approvals), mobile (iOS/Android) y a11y.
9. carga/soak/control de costos y chaos (kill worker, DB outage, provider 429).
10. artefactos build, SBOM, changelog, smoke self-hosted y release sign-off.

### 13.2 Casos de aceptación por identificador

| ID | Escenario | Resultado esperado |
|---|---|---|
| SEC-01 | Tenant A consulta chat de B | `403/404`; ningún dato ni efecto |
| SEC-02 | Socket A intenta unirse room B | Denegado, 0 eventos cross-tenant |
| SEC-03 | JWT sin company claim | `401/403` sin fallback |
| SEC-04 | Conexión con PostgreSQL sin tenant context | 0 filas, write denegada |
| SEC-05 | RLS rol owner/BYPASS o elevated | Runtime no puede asumir rol privilegiado |
| SEC-06 | Media URL de tenant B | Acceso denegado; storage scoped |
| SEC-07 | FK `conversation_id` de otro tenant | DB/app rechaza escritura |
| SEC-08 | Socket `logout` sin permiso | No desconecta cuenta ajena/global |
| MSG-01 | Webhook duplicado | Una intención lógica de procesamiento |
| MSG-02 | Crash después commit y antes Temporal start | Relay reanuda workflow |
| MSG-03 | Crash después de enviar a proveedor, antes de DB ACK | Estado `unknown_delivery`, sin retry ciego |
| MSG-04 | Webhook mal firmado / Telegram secret incorrecto | 403, 0 persistencia |
| MSG-05 | `phone_number_id` desconocido | Rechazo, nunca empresa default |
| MSG-06 | Dos mensajes concurrentes mismo chat | Coordinación/versiones sin efectos duplicados |
| MSG-07 | Firma válida pero cuenta desconectada | Se rechaza/suspende según política |
| RUN-01 | Loop de grafo infinito | Terminación por presupuesto y trace |
| RUN-02 | Fan-out de 500 ramas | Cap concurrency y fairness tenant |
| RUN-03 | Herramienta sin permiso | `POLICY_DENIED`, no write |
| RUN-04 | Prompt injection ordena pago | Aprobación/policy, no autorización implícita |
| RUN-05 | Handoff durante inferencia | Envío automático invalidado |
| RUN-06 | Pausa ilegible por DB falla | No autoenvío; alerta |
| RUN-07 | Approval expira | No efecto, auditoría |
| RUN-08 | Approval duplicada con distinta versión | CAS rechaza segunda |
| RUN-09 | Worker kill, upgrade/replay | Continúa sin repetir efectos |
| RUN-10 | Diferentes graph versions en paralelo | Ejecución usa versión congelada |
| RUN-11 | Budget de modelos agotado | Hard-stop/fallback |
| RUN-12 | Sandbox de agente prueba write/send | Ninguna mutación |
| MEM-01 | Misma persona aparente en 2 canales | Ninguna fusión ni memoria compartida |
| MEM-02 | Borrado memoria | Derivados/índices/cache según retención |
| CH-01 | Contract tests cuatro adaptadores | Schemas/versiones/capabilities completos |
| CH-02 | Token vencido o scope insuficiente | `needs_reauthorization`, guía válida |
| CH-03 | Canal sin capacidad interactive | Composer oculta/bloquea con feedback |
| UX-01 | Crear workflow por wizard y probar | Sin efectos reales durante simulación |
| UX-02 | Crear/validar/publicar grafo visual | Versionado, warnings y diff |
| UX-03 | Aprobación humana móvil | Deep link seguro, CAS, confirmación |
| UX-04 | iOS/Android offline/reconnect | No pérdida/silencio ni duplicado lógico |
| UX-05 | Teclado/a11y en acciones críticas | Flujo accesible y usable |
| OSS-01 | Clone+compose demo sin keys | App web+API+Temporal+PG+worker funcional |
| OSS-02 | Fresh migration vs upgrade | Estado esquema equivalente |
| OSS-03 | `npm test` legado | Verde sin regresión (debe ejecutarse) |
| OPS-01 | Backup/restore DB negocio + Temporal | Datos y runs reconciliados |
| OPS-02 | 2 tenants, alta carga asimétrica | Fairness; límites medidos |

### 13.3 Release gates medibles

- **100% de casos P0/seguridad y regresiones críticas exigibles pasan** en CI/ambiente de pruebas.
- **0 leaks cross-tenant confirmados**, 0 vulnerabilidades críticas/altas abiertas sin tratamiento aprobado por política de release.
- Todo PR de nueva tabla tenant tiene RLS policy y prueba para role runtime.
- Todo tool mutante tiene prueba de idempotencia, aprobación/riesgo y caso de replay.
- Cada canal posee contract fixture inbound, outbound, estados y error de credencial.
- El release incluye builds Android+iOS instalables, smoke físico/emulador, compatibilidad API versionada, y smoke self-host.
- No usar porcentajes falsos de code coverage; **establecer objetivos por componente y riesgo** después de medir baseline.
- Builds/releases jamás requieren secrets reales para tests deterministas. Pruebas sandbox externas se ejecutan por entornos autorizados.
- Artefactos de evidencia: logs CI, reportes de eval, reportes a11y, pruebas de restore y aprobación de release.
