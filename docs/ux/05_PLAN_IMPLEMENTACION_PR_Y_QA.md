# Plan de Implementación UX/UI por PR y Criterios de QA
## Whatsap-Automat v0.4 — Roadmap de Entrega Paralela

**Fecha:** Octubre 2026  
**Rol:** Lead Product Designer, UX Engineer & Frontend Architect  
**Alineación:** PR Roadmap v0.4 (§14) y QA Gates v0.4 (§13)

---

## 1. Estrategia de Migración y Reglas de Desarrollo Paralelo

Para permitir que múltiples desarrolladores y agentes de IA trabajen simultáneamente sin colisiones ni bloqueos:
1. **Sin Big-Bang Replacements:** Las rutas legadas (`/gestion-web/*` y `/dashboard/*`) se mantienen plenamente operativas durante la fase de transición.
2. **Feature Flags de Enrutamiento:** La nueva experiencia se despliega bajo la bandera `FEATURE_UNIFIED_WORKSPACE=true`. Cuando esté activa, la raíz redirige a `/workspace/*`. Si está apagada, redirige a las rutas legadas.
3. **Desacoplamiento Estricto:** Los nuevos componentes se crean en carpetas aisladas (`src/workspace/` o dentro de `docs/ux/prototypes/` en la presente fase documental). No se sobreescriben componentes productivos preexistentes en `src/factures/` hasta que cada PR alcance su fase de merge autorizada.
4. **Mocks y Contratos v0.4:** Toda dependencia de backend no terminada (ej. contratos de PR-04 o endpoints de PR-11) se consume a través de contratos tipados con adaptadores mock documentados.

---

## 2. Desglose Detallado de PRs

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ ROADMAP DE IMPLEMENTACIÓN UX/UI                                                       │
├────────────────────┬───────────────────────────────────┬───────────────────────────────┤
│ PR-ID              │ ALCANCE TÉCNICO                   │ GATES DE QA ASOCIADAS         │
├────────────────────┼───────────────────────────────────┼───────────────────────────────┤
│ **PR-16**          │ Workspace Web Unificado           │ • UX-05 (Teclado y a11y)      │
│ (Ola 3)            │ e Inbox Omnicanal                 │ • SEC-01/02 (Auth y Tenant)   │
│                    │                                   │ • E2E Enviar/Tomar/Pausar     │
├────────────────────┼───────────────────────────────────┼───────────────────────────────┤
│ **PR-17**          │ Agent Studio Visual               │ • UX-02 (Grafo/Diff/Publish)  │
│ (Ola 3)            │ Canvas + Sandbox Simulador        │ • RUN-12 (Sandbox Replay)     │
│                    │                                   │ • Keyboard Canvas a11y        │
├────────────────────┼───────────────────────────────────┼───────────────────────────────┤
│ **PR-18**          │ Constructor de Automatizaciones   │ • UX-01 (Wizard & Dry-Run)    │
│ (Ola 3)            │ + Cola Aprobaciones & Ops         │ • UX-03 (Aprobaciones CAS)    │
│                    │                                   │ • RUN-07/08 (Workflow Trace)  │
├────────────────────┼───────────────────────────────────┼───────────────────────────────┤
│ **PR-19**          │ Mobile Foundation iOS/Android     │ • Build nativo Expo limpio    │
│ (Ola 4)            │ Shell, Auth, Secure Storage       │ • Cero secrets en cliente     │
│                    │                                   │ • Sesión revocada operable    │
├────────────────────┼───────────────────────────────────┼───────────────────────────────┤
│ **PR-20**          │ Mobile Inbox, Approvals           │ • UX-03/04 (Offline & CAS)    │
│ (Ola 4)            │ Push Notifications Cero-PII       │ • Push sin datos de clientes  │
│                    │                                   │ • Reconnect sin duplicados    │
└────────────────────┴───────────────────────────────────┴───────────────────────────────┘
```

---

### PR-16: Workspace Web e Inbox Omnicanal
* **Dependencias:** PR-02 (Socket.IO seguro), PR-04 (Contratos base), PR-05 (Tenant scope). Integra PR-11, PR-14 y PR-15 progresivamente.
* **Archivos a Crear / Modificar:**
  - `src/workspace/shell/UnifiedWorkspaceShell.tsx`: Shell unificado con Topbar y Sidebar colapsable.
  - `src/workspace/shell/TenantSelector.tsx`: Selector seguro de organización con validación de membresía.
  - `src/workspace/inbox/OmnichannelInbox.tsx`: Disposición de 3 paneles en desktop / 1 pantalla en móvil.
  - `src/workspace/inbox/components/ChannelTabs.tsx`: Filtros rápidos por proveedor (WhatsApp, Telegram, IG).
  - `src/workspace/inbox/components/ChatTimeline.tsx`: Renderizado multimodal diferenciando cliente, humano e IA.
  - `src/workspace/inbox/components/ChannelComposer.tsx`: Motor de capacidades (bloqueo fuera de 24h, plantillas HSM).
  - `src/workspace/inbox/components/TakeoverBanner.tsx`: Botón transaccional de toma de control con CAS.
  - `src/workspace/inbox/components/CustomerIdentityPanel.tsx`: Acordeón de cliente, etiquetas, pedidos y notas.
* **Estrategia de Feature Flag:**
  - Si `localStorage.getItem('FEATURE_UNIFIED_WORKSPACE') === 'true'`, `/` redirige a `/workspace/inbox`.
  - Rutas antiguas accesibles como fallback en `/legacy/gestion-web` y `/legacy/dashboard`.
* **Criterios de Aceptación QA:**
  - **UX-05:** Todo el flujo de selección de chat, lectura de historial y envío es operable mediante teclado.
  - **SEC-01/02:** Ningún mensaje de otro tenant aparece en la lista tras conmutar de empresa en el selector.
  - **E2E:** Prueba automatizada Playwright que simula: 1) Cliente escribe por WhatsApp; 2) IA sugiere respuesta; 3) Operador presiona "Tomar control"; 4) La sugerencia previa se invalida; 5) Operador envía mensaje manual y el estado refleja entregado.
* **Plan de Rollback:**
  - Revertir flag `FEATURE_UNIFIED_WORKSPACE=false`; el tráfico web vuelve instantáneamente a `GestionWeb.tsx`.

---

### PR-17: Agent Studio Visual y Simulador
* **Dependencias:** PR-09 (Motor de agentes v0.4), PR-10 (Tool registry), PR-11 (Runtime sandbox), PR-12 (Provider ledger).
* **Archivos a Crear / Modificar:**
  - `src/workspace/studio/AgentStudioLayout.tsx`: Contenedor principal con barra persistente de versiones.
  - `src/workspace/studio/canvas/AgentGraphCanvas.tsx`: Lienzo interactivo basado en `@xyflow/react` o SVG nativo accesible.
  - `src/workspace/studio/canvas/nodes/*`: Componentes para nodos Trigger, Policy, LLM, Tool y Gate.
  - `src/workspace/studio/inspector/NodeInspectorDrawer.tsx`: Panel lateral de configuración de parámetros del nodo.
  - `src/workspace/studio/editor/DeclarativeSchemaEditor.tsx`: Editor bidireccional YAML/JSON.
  - `src/workspace/studio/sandbox/AgentSandboxDrawer.tsx`: Consola de chat interactiva con iluminación de nodos.
  - `src/workspace/studio/diff/VersionDiffModal.tsx`: Comparador visual entre borrador y versión publicada.
* **Criterios de Aceptación QA:**
  - **UX-02:** Creación, edición, validación de ciclos y publicación de un agente con historial inmutable de versiones.
  - **RUN-12:** El sandbox reproduce ejecuciones paso a paso mostrando los inputs y outputs de cada nodo sin invocar efectos reales en producción.
  - **Accesibilidad:** Soporte de navegación por nodos mediante teclado (`Tab`, teclas de flechas y atajos para añadir conexiones).
* **Plan de Rollback:**
  - Revertir vista a `AgentsPage.tsx` modularizada sin eliminar las especificaciones guardadas en base de datos.

---

### PR-18: Constructor Guiado de Automatizaciones, Aprobaciones y Operaciones
* **Dependencias:** PR-08 (Orquestación/Temporal), PR-11 (Runtime), PR-16 (Workspace Web).
* **Archivos a Crear / Modificar:**
  - `src/workspace/automations/AutomationsWizard.tsx`: Asistente lineal de 5 pasos.
  - `src/workspace/automations/components/StepTrigger.tsx`, `StepConditions.tsx`, `StepActions.tsx`, `StepDryRun.tsx`.
  - `src/workspace/automations/templates/TemplateGallery.tsx`: Catálogo de recetas predefinidas.
  - `src/workspace/approvals/ApprovalsQueue.tsx`: Cola de tareas humanas con semáforo de riesgo y TTL.
  - `src/workspace/approvals/components/ApprovalInspectionModal.tsx`: Visualizador de diff y botones de acción CAS.
  - `src/workspace/operations/OperationsTimeline.tsx`: Trazador visual de ejecuciones con correlación OTel.
  - `src/workspace/operations/DeadLetterQueueTable.tsx`: Visualizador de fallos con reintento idempotente.
* **Criterios de Aceptación QA:**
  - **UX-01:** Creación de workflow mediante wizard y ejecución exitosa de simulación dry-run con array `simulatedActions` sin emitir llamadas reales a la API de WhatsApp.
  - **UX-03:** Aprobación de una acción crítica mediante token CAS de un solo uso; los clics repetidos o concurrentes devuelven 409/410 sin duplicar el despacho.
  - **RUN-07/08:** La línea de tiempo de operaciones muestra cada hito de ejecución de un workflow con su `traceId`.
* **Plan de Rollback:**
  - Desactivar la habilitación de nuevos workflows mediante switch administrativo; conservar ejecuciones en curso en cola.

---

### PR-19: Mobile Foundation iOS/Android
* **Dependencias:** PR-01 (Auth P0), PR-02 (Socket.IO auth), PR-04 (Contratos compartidos).
* **Archivos a Crear:**
  - `apps/mobile/App.tsx`: Inicialización de React Native con Expo Router.
  - `apps/mobile/src/auth/SecureStorage.ts`: Adaptador de Keychain (iOS) y Keystore (Android) para tokens de sesión.
  - `apps/mobile/src/auth/BiometricAuth.ts`: Integración con FaceID / TouchID / BiometricPrompt.
  - `apps/mobile/src/navigation/RootNavigator.tsx`: Pila de navegación nativa (Login, WorkspaceSelect, MainTabs).
  - `apps/mobile/src/api/client.ts`: Cliente HTTP configurado con allowlist de dominios y rotación de tokens.
* **Criterios de Aceptación QA:**
  - Build nativo ejecutable y validado en emuladores oficiales (Android API 33+ e iOS 16+).
  - Auditoría de seguridad del bundle APK/IPA: cero tokens de proveedores de LLM o claves privadas de Meta empaquetadas en el código cliente.
  - Al revocar la sesión desde la web, la app móvil detecta el evento y redirige a login con borrado de caché local.

---

### PR-20: Mobile Inbox, Aprobaciones y Push Notifications
* **Dependencias:** PR-19 (Mobile Foundation), PR-11 (Runtime), PR-16 (Workspace Web).
* **Archivos a Crear:**
  - `apps/mobile/src/screens/InboxScreen.tsx`: Lista de chats optimizada para uso táctil a una mano.
  - `apps/mobile/src/screens/ChatDetailScreen.tsx`: Chat a pantalla completa con teclado reactivo.
  - `apps/mobile/src/screens/ApprovalsScreen.tsx`: Cola de aprobaciones rápidas con gestos de swipe.
  - `apps/mobile/src/services/PushService.ts`: Manejador de notificaciones APNs / FCM con payload mínimo.
  - `apps/mobile/src/storage/OfflineQueue.ts`: Cola local cifrada para envíos en modo offline.
* **Criterios de Aceptación QA:**
  - **UX-03:** Aprobación rápida mediante gesto táctil con confirmación biométrica en acciones de riesgo alto.
  - **UX-04:** Enviar un mensaje sin cobertura móvil; el mensaje se muestra como "En cola"; al restablecer la conexión Wi-Fi, se despacha automáticamente sin duplicarse en el backend.
  - **Privacidad Push:** Las notificaciones push no contienen PII (nombre del cliente, teléfono ni extracto del mensaje); el contenido se recupera bajo demanda vía TLS tras abrir la app.
* **Plan de Rollback:**
  - Desactivar el servicio de push en el backend; la app móvil continúa funcionando mediante polling y Socket.IO en primer plano.

---

## 3. Matriz de Cobertura de Criterios QA (Blueprint §13)

| Código Gate | Requisito Formal | Evidencia Esperada en PR | Responsable de Validación |
|---|---|---|---|
| **UX-01** | Crear workflow por wizard y simular | Test E2E de dry-run sin peticiones salientes a Meta/Telegram | QA Automatizado + Reviewer UX |
| **UX-02** | Crear, validar y publicar grafo de agente | Validación de topología, advertencias de ciclos y diff de publicación | Lead Frontend + Reviewer UX |
| **UX-03** | Aprobación humana segura (Web y Móvil) | CAS token verificado, prevención de replay y deep-link autenticado | Reviewer Seguridad + QA |
| **UX-04** | Resiliencia offline y reconexión móvil | Desconexión forzada de red, redacción de mensaje y reconexión sin pérdida ni duplicados | QA Móvil en dispositivo físico |
| **UX-05** | Flujos críticos accesibles por teclado | Auditoría axe-core con 0 violaciones críticas y navegación por teclado documentada | Reviewer Accesibilidad / UX |
| **SEC-01/02**| Aislamiento de datos por Tenant | Pruebas de conmutación de workspace sin fuga de estado en caché o sockets | Reviewer Seguridad |
