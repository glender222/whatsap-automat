# Auditoría Integral de UX/UI, Accesibilidad y Arquitectura Frontend
## Whatsap-Automat (Baseline v0.4)

**Fecha:** Octubre 2026  
**Rol:** Lead Product Designer, UX Engineer & Frontend Architect  
**Alcance:** Frontend React (`Frontend_py_whatsaapweb`), componentes compartidos, rutas y experiencia operativa.

---

## 1. Resumen Ejecutivo y Diagnóstico Global

La auditoría técnica y de producto del frontend de **Whatsap-Automat** revela una aplicación que ha crecido orgánicamente a través de múltiples sprints funcionales (Sprints 1 al 6), acumulando valor operativo real (mensajería en tiempo real, integración con WhatsApp Cloud API, panel administrativo bento-grid, gestión de catálogos y agentes de IA). Sin embargo, este crecimiento acelerado ha generado una profunda fragmentación en la experiencia de usuario (UX), inconsistencias visuales críticas, graves barreras de accesibilidad (WCAG 2.2 AA) y una deuda técnica arquitectónica considerable.

### Principales Hallazgos Críticos

1. **Esquizofrenia de Doble Shell:** Coexisten dos aplicaciones completas e incompatibles dentro del mismo frontend: `/gestion-web/*` (shell oscuro, barra lateral de 64px icon-only, estilo legacy WhatsApp) y `/dashboard/*` (shell blanco con acentos esmeralda `#128C7E`, barra lateral colapsable de 256px, estilo SaaS moderno). El usuario es transferido violentamente entre ambos mundos.
2. **Hacks de Ventanas y Navegación Antipatrón:** El cambio entre la bandeja de chat y el dashboard recurre a llamadas nativas `window.open('', 'w_chat_panel')`, intentos de enfocar ventanas secundarias y ejecución de `window.close()`, lo que falla en navegadores modernos con bloqueadores de popups y desorienta al operador.
3. **Monolitos de Código en UI:** Pantallas críticas como `AgentsPage.tsx` (1,534 líneas) e `InventoryPage.tsx` (1,125 líneas) concentran lógica de negocio, manipulación directa de formularios, llamadas API y renderizado masivo en un solo archivo, imposibilitando el testing unitario y la evolución paralela.
4. **Cascadas N+1 en Cliente:** Componentes como `PermissionManager.tsx` ejecutan consultas HTTP secuenciales en un bucle `for` (una petición por cada tag existente) para determinar los permisos de un empleado, provocando cuelgues de la interfaz ante volúmenes moderados.
5. **Barreras de Accesibilidad (WCAG 2.2 AA):** Más del 60% de los botones basados en iconos carecen de `aria-label` o texto alternativo; elementos `<li>` y `<div>` interactivos no tienen `role="button"` ni manejo de teclado (`Enter`/`Space`); modales carecen de confinamiento de foco (`focus-trap`); y los contrastes de texto tenue fallan el ratio mínimo de 4.5:1.
6. **Manejo Frágil del Tiempo Real y Estados de Carrera:** La bandeja de entrada carece de guardas contra carreras de estados (`conversation_state_version` / CAS). Si un operador humano interviene mientras el agente automático formula una sugerencia, no existe invalidación transaccional garantizada en UI.

---

## 2. El Problema Central: La Esquizofrenia de Doble Shell

La raíz de la fricción cognitiva en la plataforma es la coexistencia de dos shells de navegación independientes y desconectados:

```text
┌────────────────────────────────────────────────────────────────────────┐
│                          APLICACIÓN FRONTEND                            │
├───────────────────────────────────┬────────────────────────────────────┤
│         RUTA: /gestion-web/*      │          RUTA: /dashboard/*        │
├───────────────────────────────────┼────────────────────────────────────┤
│ • Layout: GestionWeb.tsx          │ • Layout: DashboardLayout.tsx      │
│ • Sidebar: Sidebar.tsx (Dark 64px)│ • Sidebar: DashboardSidebar (White)│
│ • Tema: Fondo slate-800 / gris     │ • Tema: Fondo blanco / green-600   │
│ • Rol predeterminado: EMPLEADO    │ • Rol predeterminado: ADMIN        │
│ • Título: "GestionWeb"            │ • Título: "Administración AI Pro"  │
│ • Módulos: Inicio (Chat),         │ • Módulos: Métricas Bento, Pagos,  │
│   Máquinas, Reportes, Permisos    │   Handoff, Agentes, Inventario     │
│ • Comunicación: window.open hack  │ • Comunicación: Link a /gestion-web│
└───────────────────────────────────┴────────────────────────────────────┘
```

### Impacto en la Experiencia de Usuario:
- **Pérdida de Ubicación:** Al hacer clic en "Gestion web" desde el Dashboard, el sidebar colapsa, el fondo cambia de blanco a gris oscuro (#1F2937), desaparece el topbar y el usuario pierde el botón de retroceso natural.
- **Doble Menú Móvil:** Ambas secciones implementan botones hamburguesa independientes con menús drawer desincronizados.
- **Autenticación Bifurcada:** En `LoginForm.tsx`, un `ADMIN` es redirigido a `/dashboard`, mientras un `EMPLEADO` es forzado a `/gestion-web/inicio`. Si el admin necesita atender chats, abandona el entorno administrativo.

---

## 3. Auditoría Exhaustiva Pantalla por Pantalla

### 3.1. Autenticación (`/auth/login`, `/auth/register`, `/auth/forgot-password`)
* **Archivos auditados:** `LoginForm.tsx`, `RegisterForm.tsx`, `ForgotPasswordForm.tsx`.
* **Componentes clave:** Formularios con validación en cliente, toggles de visibilidad de contraseña, componente `GlobalTransition`.
* **Hallazgos:**
  - **Usabilidad:** `LoginForm` impone un `setTimeout` artificial de 1,500 ms con un overlay a pantalla completa (`GlobalTransition` con `zIndex: 9999`) después de recibir la respuesta exitosa del backend. Esto degrada innecesariamente el Time-to-Interactive (TTI) percibido.
  - **Accesibilidad:** Los botones para conmutar la visibilidad de la contraseña (`Eye` / `EyeOff`) son botones `<button>` nativos pero carecen de `aria-label="Mostrar contraseña"` o `aria-pressed`.
  - **Responsive:** En pantallas menores a 360px de ancho, el padding del contenedor `p-6 sm:p-8` comprime el input y el texto de ayuda se desborda horizontalmente.

### 3.2. Bandeja de Entrada / Mensajería (`/gestion-web/inicio`)
* **Archivos auditados:** `Inicio.tsx`, `ChatSidebar.tsx`, `LocalTopbar.tsx`, `ChatContainer.tsx`, `MessagesPanel.tsx`, `MessageInputBar.tsx`, `CustomerHistoryPanel.tsx`.
* **Componentes clave:**
  - **ChatSidebar (Bandeja Izquierda):**
    * *Búsqueda:* Input de texto reactivo con debounce local. Falla al buscar números con código de país si el usuario no escribe el prefijo exacto.
    * *Categorías / Etiquetas:* Dropdown custom con estado abierto controlado por click fuera. El menú contextual (clic derecho) calcula coordenadas `x, y` absolutas con `e.clientX`, lo que provoca que el menú se dibuje cortado si el usuario hace clic cerca del borde inferior o derecho.
    * *Lista de Chats:* Cada ítem es un `<li>` con `onClick`. No soporta navegación con teclas de flecha ni selección con teclado. El unread badge no posee texto de asistencia para lectores (`aria-label="3 mensajes sin leer"`).
  - **LocalTopbar (Cabecera Superior):**
    * *Filtros Hardcoded:* Líneas 41-55 muestran botones de filtro "Pendiente" (count: 10) y "Completo" (count: 35) con valores estáticos cableados en código, desconectados de la realidad de la base de datos.
    * *Botón Fantasma:* Líneas 68-72 contienen un `<button>` con un SVG de lápiz sin handler `onClick`, sin texto y sin `aria-label`.
    * *Branding Inconsistente:* Logo con texto inline "GestionWeb" en color `#23c16b` y fuente Montserrat, ajeno al resto del sistema.
  - **MessageInputBar (Composer Central):**
    * *Capabilities del Canal:* El input es un `<textarea>` libre que no valida si el canal actual (WhatsApp Cloud) se encuentra fuera de la ventana de 24 horas (Service Window) donde Meta restringe el envío exclusivo a Plantillas Aprobadas (HSM).
    * *Menú de Adjuntos:* El menú flotante (`isAttachMenuOpen`) no implementa trampa de foco ni escucha `Escape` para cerrarse limpiamente.
    * *Control Optimista:* El mensaje temporal `temp-file-${Date.now()}` no almacena hash de contenido ni identificador de versión, arriesgando mensajes huérfanos si la conexión Socket.IO parpadea.
  - **ChatContainer & Panel de IA:**
    * *Takeover / Pausa de IA:* Botones "Pausar IA", "Tomar chat" y "Sugerir respuesta". Funcionan con llamadas aisladas pero carecen de bloqueo optimista transaccional (`CAS`). Si dos agentes humanos pulsan "Tomar chat" simultáneamente, ambos asumen control sin advertencia.
    * *Historial de Cliente (`CustomerHistoryPanel`):* Ocupa 320px fijos a la derecha (`w-[300px] 2xl:w-80`). En resoluciones estándar de laptop (1366x768), deja apenas 450px para el panel de mensajes central, ahogando la conversación.

### 3.3. Agent Studio Legacy (`/dashboard/ia/agentes`, `/dashboard/ia/dominios`)
* **Archivos auditados:** `AgentsPage.tsx` (1,534 líneas), `AiDomainsPage.tsx`, `AgentTestSessionPage.tsx`, `RuntimeLogsViewer.tsx`.
* **Componentes clave:** Navegación por 7 pestañas locales (`general`, `tools`, `prompt`, `knowledge`, `rules`, `test`, `logs`), formularios masivos, tabla de herramientas, sandbox interactivo.
* **Hallazgos:**
  - **Arquitectura:** Monolito inmanejable de 1,534 líneas. Todo el estado del agente, fuentes de conocimiento, reglas de negocio, asignación de dominios y logs de depuración conviven en el estado local de un solo componente React.
  - **Grafo Visual Ausente:** La interfaz se compone exclusivamente de formularios tabulares y campos de texto plano. No existe visualización de flujo, ramificaciones condicionales ni inspectores de entrada/salida como exige la especificación v0.4.
  - **Publicación y Versionado:** El botón "Guardar cambios" sobreescribe directamente la configuración en base de datos. No existe concepto de "Borrador vs Publicado", diff visual de impacto, ni mecanismo de rollback previo.
  - **Sandbox / Test:** La pestaña "Test" depende de que el agente ya esté guardado en base de datos; no permite simulación en seco con mocks ni aislamiento de efectos colaterales.

### 3.4. Operaciones, Handoff y Pagos (`/dashboard/handoff`, `/dashboard/pagos`, `/dashboard`)
* **Archivos auditados:** `HandoffPage.tsx`, `HandoffWidget.tsx`, `PaymentsPage.tsx`, `DashboardPage.tsx`.
* **Componentes clave:** Tablas de comprobantes de pago, widgets de tickets pendientes, mapas de calor horario.
* **Hallazgos:**
  - **Validación de Pagos:** El modal de validación/rechazo de comprobante no provee zoom adecuado para imágenes de comprobante de baja resolución. Si el comprobante es un PDF, no hay visor embebido accesible.
  - **Cola de Handoff:** La acción de tomar ticket navega inmediatamente o despacha un evento, pero no actualiza el estado de la conversación en la bandeja del operador sin un refresh manual si el socket se reconecta.
  - **Heatmap Grid:** La matriz de 7 días x 24 horas carece de etiquetas de accesibilidad en las celdas; un usuario de lector de pantalla solo escucha elementos div vacíos sin información de volumen ni hora.

### 3.5. Inventario y Catálogos (`/dashboard/inventario`, `/dashboard/catalogos`)
* **Archivos auditados:** `InventoryPage.tsx` (1,125 líneas), `CatalogsPage.tsx`.
* **Hallazgos:**
  - **Manejo de Formularios:** `InventoryPage` contiene 6 sub-modales implementados condicionalmente dentro del mismo JSX.
  - **Ajuste de Stock:** Los botones de incremento/decremento rápido `+` y `-` no cuentan con debounce ni protección contra doble clic, lo que puede disparar múltiples mutaciones de stock concurrentes.

### 3.6. Estaciones y Máquinas (`/gestion-web/administrar-estaciones`)
* **Archivos auditados:** `administradorestaciones.tsx`, `StationCard.tsx`, modales de credenciales.
* **Hallazgos:**
  - **Terminología Confusa:** Se hace referencia indistintamente a "Estaciones", "Máquinas" y "Empleados" en la misma pantalla.
  - **Seguridad en UI:** El modal de "Ver Credenciales" muestra contraseñas y claves en texto plano sin timeout de ocultamiento automático ni registro de auditoría visual.

### 3.7. Gestión de Permisos (`/gestion-web/permisos`)
* **Archivos auditados:** `PermissionsPage.tsx`, `PermissionManager.tsx`.
* **Hallazgos:**
  - **Cascada N+1:** En `PermissionManager.tsx` (líneas 47-57), al abrir el gestor para un empleado, se recorre cada etiqueta del sistema ejecutando una llamada a `EmployeeTagService.getEmployeesWithTag(tag.id)`. Con 30 etiquetas, se lanzan 30 peticiones HTTP concurrentes.
  - **Feedback Visual Inconsistente:** El componente `Toast` tiene estilos y animaciones custom que no se comparten con los modales del dashboard.

### 3.8. Configuración WhatsApp y Canales (`/gestion-web/settings`)
* **Archivos auditados:** `SettingsModal.tsx`, `WhatsAppConnectionSection.tsx`, `BotSettingsPage.tsx`.
* **Hallazgos:**
  - **Confusión entre QR y Meta Cloud:** Si la empresa usa Meta Cloud API pero el proveedor backend no responde inmediatamente el handshake, la interfaz cae en un fallback que renderiza el modal de escaneo de QR propio de la librería legacy `whatsapp-web.js`. Esto confunde severamente a usuarios corporativos que ya contrataron la API oficial.
  - **Fuga de Secretos en Formularios:** El campo "Token permanente" en `WhatsAppConnectionSection` permite escribir y sobreescribir tokens de Meta, pero no muestra un indicador claro de validez ni fecha de expiración.

---

## 4. Matriz de Hallazgos y Severidad

| ID | Pantalla / Módulo | Severidad | Tipo | Descripción del Problema | Impacto |
|---|---|---|---|---|---|
| **AUD-01** | Global / Shell | **P0 (Crítico)** | Arquitectura / UX | Esquizofrenia de doble shell (`/gestion-web` vs `/dashboard`). Navegación rota y desorientación. | Bloquea la adopción unificada. |
| **AUD-02** | Mensajería / Sidebar | **P0 (Crítico)** | UX / Código | Uso de `window.open` y `window.name` para alternar entre chat y dashboard. | Falla en navegadores con popup-blocker. |
| **AUD-03** | Agentes | **P1 (Alto)** | Deuda Técnica | Monolito de 1,534 líneas en `AgentsPage.tsx`. Sin grafo visual, sin borrador/publicación. | Impide testing y extensibilidad. |
| **AUD-04** | Permisos | **P1 (Alto)** | Rendimiento | Cascada N+1 de peticiones HTTP en `PermissionManager.tsx`. | Congela el navegador con múltiples tags. |
| **AUD-05** | Mensajería / Composer | **P1 (Alto)** | Usabilidad / Regulación | El composer no respeta la ventana de 24h de WhatsApp ni capacidades por canal. | Mensajes rechazados por Meta con error 400. |
| **AUD-06** | Autenticación | **P2 (Medio)** | Rendimiento Percibido | Delay forzado de 1.5s con spinner en login y logout. | Frustración de usuario en cada acceso. |
| **AUD-07** | LocalTopbar | **P2 (Medio)** | Usabilidad / Consistencia | Contadores de filtro cableados en código estático (10 y 35). Botón fantasma sin acción. | Pérdida de confianza en las métricas. |
| **AUD-08** | Configuración Canales | **P2 (Medio)** | UX / Claridad | Renderizado erróneo de QR legacy cuando falla la conexión con Meta Cloud. | Confusión operativa en clientes oficiales. |
| **AUD-09** | Global / Modales | **P2 (Medio)** | Accesibilidad (WCAG) | Modales sin confinamiento de foco (`focus-trap`) ni retorno al elemento disparador. | Incumple WCAG 2.2 AA (Criterio 2.4.3). |
| **AUD-10** | Bandeja de Chats | **P2 (Medio)** | Accesibilidad (WCAG) | Menús contextuales y listas `<li>` sin navegación por teclado (`ArrowDown`, `Enter`). | Incumple WCAG 2.2 AA (Criterio 2.1.1). |
| **AUD-11** | Mensajes / Heatmap | **P3 (Bajo)** | Accesibilidad (WCAG) | Contraste insuficiente en textos secundarios (`#9CA3AF` sobre fondos claros). | Dificultad de lectura en exteriores/móvil. |
| **AUD-12** | Panel de Cliente | **P3 (Bajo)** | Responsive | El panel derecho de 320px comprime el chat a menos de 450px en pantallas laptop. | Incomodidad visual y scroll horizontal forzado. |

---

## 5. Directrices de Remediación Inmediata

1. **Unificar el App Shell:** Construir un `UnifiedWorkspaceShell` único que sirva tanto para administradores como para operadores, con navegación colapsable, tema neutro consistente y selector explícito de workspace/tenant.
2. **Modularizar `AgentsPage`:** Descomponer el archivo en dominios específicos (`AgentProfileView`, `AgentToolsView`, `AgentKnowledgeView`, `AgentRulesView`, `AgentCanvasView`).
3. **Optimizar Consultas:** Sustituir la cascada N+1 de `PermissionManager` por un endpoint agregado (`GET /api/employees/:id/permissions`).
4. **Implementar tokens WCAG 2.2 AA:** Adoptar paleta accesible de alto contraste y envolver todos los diálogos en primitivas con `focus-trap` nativo.
5. **Preparar Prototipos Aislados:** Crear la nueva especificación en `docs/ux/` sin tocar las rutas productivas actuales hasta la fase de ejecución por PRs (PR-16, PR-17, PR-18).
