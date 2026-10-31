# Especificación de Diseño: Workspace Unificado
## Whatsap-Automat v0.4

**Fecha:** Octubre 2026  
**Rol:** Lead Product Designer, UX Engineer & Frontend Architect  
**Estado:** Especificación de Diseño Objetivo (Target Architecture)

---

## 1. Visión y Principios del Workspace Unificado

El Workspace Unificado de **Whatsap-Automat** transforma la herramienta desde un conjunto fragmentado de paneles aislados hacia una suite integrada de alta densidad y productividad corporativa. Su propósito es permitir a equipos de atención al cliente, operadores comerciales y supervisores de automatización gestionar flujos omnicanal, agentes inteligentes y operaciones críticas dentro de una única ventana de trabajo cohesiva.

### Principios Fundamentales de Diseño

1. **Una Sola Ventana, Cero Context-Switching:** La navegación entre mensajería, supervisión de IA, validación de comprobantes y flujos automáticos ocurre sin recargas completas ni apertura de pestañas secundarias (`window.open`).
2. **Claridad Operativa de Alta Densidad:** Diseñado para el trabajo diario intensivo (8+ horas por turno). Se prioriza el escaneo rápido de información, tipografía optimizada, estados explícitos y mínimo desplazamiento innecesario.
3. **Control Humano Garantizado (Human-in-the-Loop):** La inteligencia artificial asiste, sugiere y acelera, pero el operador humano mantiene siempre la potestad de pausar, corregir, tomar el control o requerir aprobaciones para acciones de alto impacto.
4. **Seguridad y Transaccionalidad en UI:** Toda acción destructiva o de despacho cuenta con salvaguardas optimistas (`conversation_state_version` / CAS) que impiden estados de carrera entre humanos y agentes automáticos.
5. **Accesibilidad Universal (WCAG 2.2 AA):** Contraste garantizado, soporte completo de navegación por teclado en flujos críticos, anuncios para lectores de pantalla y jerarquía de foco predecible.

---

## 2. Arquitectura del App Shell Unificado (`UnifiedWorkspaceShell`)

El nuevo App Shell fusiona las antiguas rutas `/gestion-web/*` y `/dashboard/*` bajo una sola estructura modular:

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ TOPBAR UNIFICADO                                                                       │
│ [🏢 Acme Corp ▼]  [🔍 Buscar o presionar Ctrl+K]      [🟢 En línea ▼] [🔔 (3)] [👤 Ana]│
├───────────────┬────────────────────────────────────────────────────────────────────────┤
│ SIDEBAR       │ ÁREA DE TRABAJO PRINCIPAL (Dynamic Workspace Area)                     │
│ (240px / 64px)│                                                                        │
│               │                                                                        │
│ 📥 Inbox      │                                                                        │
│ 🤖 Studio     │                                                                        │
│ ⚡ Auto       │               (Renderizado de Módulo Activo)                          │
│ 🛡️ Approvals  │                                                                        │
│ 📊 Ops        │                                                                        │
│ 🔌 Canales    │                                                                        │
│ 📦 Catálogos  │                                                                        │
│ ⚙️ Ajustes    │                                                                        │
├───────────────┤                                                                        │
│ [⚙️ Sistema]  │                                                                        │
│ [🌙 Tema]     │                                                                        │
└───────────────┴────────────────────────────────────────────────────────────────────────┘
```

### 2.1. Selector de Tenant / Workspace
- **Ubicación:** Esquina superior izquierda del Topbar.
- **Comportamiento:**
  - Despliega un modal accesible con búsqueda en tiempo real de empresas autorizadas para el usuario logueado.
  - Muestra nombre de la empresa, avatar/logo, identificador único de tenant (`tenant_id`), y badge de estado de la cuenta (`Activo`, `En Configuración`, `Suspendido`).
  - Al conmutar de empresa, el cliente invalida de forma inmediata la caché local (Jotai atoms, React Query / SWR), desconecta las salas de Socket.IO previas y se reconecta a las salas exclusivas del nuevo tenant con handshake autenticado.
  - Si el usuario carece de permisos multi-tenant, el selector se renderiza como una etiqueta fija de solo lectura.

### 2.2. Barra de Navegación Lateral (Sidebar Primario)
- **Modos:** Expandido (240px de ancho) y Colapsado (64px icon-only con tooltips flotantes accesibles).
- **Persistencia:** Guarda la preferencia en `localStorage('workspace_sidebar_collapsed')`.
- **Navegación por Módulos:**
  1. **📥 Inbox Omnicanal** (`/workspace/inbox`): Bandeja unificada para WhatsApp, Telegram e Instagram.
  2. **🤖 Agent Studio** (`/workspace/agent-studio`): Editor de grafos visuales, prompts y sandbox de simulación.
  3. **⚡ Automatizaciones** (`/workspace/automations`): Wizard declarativo y catálogo de plantillas.
  4. **🛡️ Aprobaciones** (`/workspace/approvals`): Cola de validación humana con semáforo de riesgo.
  5. **📊 Operaciones & Métricas** (`/workspace/operations`): Trazas OTel, mapa de calor, SLA y dead-letter.
  6. **🔌 Canales y Conexiones** (`/workspace/channels`): Hub de proveedores oficiales (Meta Cloud, Telegram, IG).
  7. **📦 Comercial y Catálogos** (`/workspace/commercial`): Gestión de stock, inventario y comprobantes de pago.
  8. **👥 Estaciones y Empleados** (`/workspace/stations`): Gestión de turnos y máquinas operativas.
  9. **⚙️ Configuración y Permisos** (`/workspace/settings`): RBAC granular, políticas de seguridad y webhooks.

### 2.3. Topbar de Utilidades
- **Buscador Global (Command Palette - `Ctrl+K` / `Cmd+K`):** Permite saltar rápidamente a conversaciones, clientes, agentes, pedidos o ejecutar acciones rápidas (*"Pausar IA en chat 51987..."*, *"Crear nuevo agente"*).
- **Indicador de Disponibilidad del Operador:** Selector de estado con opciones: `🟢 Disponible`, `🟡 Ocupado / En pausa`, `🔴 Fuera de turno`. Este estado informa al router de asignación automática de chats.
- **Campana de Alertas en Tiempo Real:** Agrupa notificaciones críticas (violaciones de SLA inminentes, solicitudes de handoff prioritarias, errores de conexión de webhooks).
- **Menú de Perfil:** Acceso rápido a datos del usuario, conmutador de tema claro/oscuro y cierre de sesión seguro.

---

## 3. Módulo 1: Inbox Omnicanal

La nueva bandeja de entrada resuelve la sobrecarga cognitiva mediante una disposición clásica de 3 paneles en escritorio y navegación fluida tipo drill-down en dispositivos móviles.

```text
┌─────────────────────────┬───────────────────────────────────┬──────────────────────────┐
│ PANEL 1: BANDEJA (320px)│ PANEL 2: TIMELINE CENTRAL (Flex)  │ PANEL 3: CONTEXTO (300px)│
├─────────────────────────┼───────────────────────────────────┼──────────────────────────┤
│ [Canales: Todos ▼]      │ Cliente: Juan Pérez (+51 987...)  │ 👤 DATOS DEL CLIENTE     │
│ [🔍 Buscar chat...]     │ Canal: WhatsApp Cloud · SLA: 3min │ Nombre: Juan Pérez       │
│ Filtros: Míos | IA | All│ [⚡ Tomar control] [⏸ Pausar IA] │ Tags: [VIP] [Cotizando]  │
├─────────────────────────┼───────────────────────────────────┼──────────────────────────┤
│ • Juan Pérez     10:42  │ [10:35] Cliente: Hola, precios?   │ 🤖 ACTIVIDAD RECIENTE    │
│   WhatsApp · Cotizando  │ [10:35] 🤖 Agente: Hola Juan! Aquí│ Intención: Consulta Prod │
│   [Badge: 2] [SLA: 4m]  │         tienes nuestro catálogo.  │ Confianza: 94%           │
│                         │ [10:40] Cliente: Quiero 2 cajas.  │ Herramienta: get_catalog │
│ • Carlos Ruiz    10:30  │ [10:41] 🤖 Sugerencia de respuesta│                          │
│   Telegram · Soporte    │         "Con gusto. ¿Deseas envío │ 📦 PEDIDO ACTIVO         │
│   [Handoff Pendiente]   │          a Lima o provincias?"    │ Total: S/ 180.00         │
│                         │   [Aceptar y enviar] [Editar]     │ Estado: Por Cobrar       │
│ • María Gómez    09:15  ├───────────────────────────────────┤                          │
│   Instagram · Nuevo     │ Composer adaptable al canal       │ 📝 NOTAS INTERNAS        │
│   [Resuelto]            │ [📎] [😊] [Escribe un mensaje...] │ "Cliente solicita factura"│
└─────────────────────────┴───────────────────────────────────┴──────────────────────────┘
```

### 3.1. Panel Izquierdo: Bandeja y Filtros Omnicanal
- **Filtro Multi-Proveedor:** Píldoras interactivas para alternar rápidamente entre `Todos`, `WhatsApp Business`, `Telegram` e `Instagram`.
- **Filtros de Estado de Conversación:**
  - *Mis Chats:* Asignados al operador actual.
  - *Atendidos por IA:* Conversaciones donde el agente responde de forma autónoma.
  - *Requiere Humano (Handoff):* Chats donde la IA se declaró incapaz o el cliente solicitó asesor.
  - *En Espera / Riesgo SLA:* Chats con cuenta regresiva activa próxima a vencer el umbral fijado por la empresa.
- **Lista Virtualizada:** Utiliza virtualización de filas para garantizar scroll suave a 60 FPS incluso con más de 5,000 conversaciones cargadas.
- **Tarjeta de Chat Enriquecida:**
  - Avatar con badge de proveedor en la esquina inferior.
  - Nombre del contacto o número formateado bajo estándar E.164.
  - Preview del último mensaje con iconos de estado de entrega (enviado, entregado, leído, error).
  - Píldora de SLA con temporizador dinámico: verde si restan > 5 min, ámbar si restan < 5 min, rojo con pulsación si hubo breach.

### 3.2. Panel Central: Línea de Tiempo y Composer Inteligente
- **Cabecera del Chat Activo:**
  - Nombre del cliente, número verificado y canal origen.
  - Estado del Agente en el Chat: `🟢 IA Activa (Auto)`, `🟡 IA en Sugerencia`, `🔴 IA Pausada`.
  - Botón de Acción Principal: Si el chat está en IA, muestra `[Tomar Control]`. Al pulsar, se despacha un evento transaccional con `conversation_state_version` que invalida cualquier turno automático pendiente y asigna la conversación al operador.
- **Línea de Tiempo Multimodal:**
  - Burbujas de mensaje con diferenciación visual:
    * *Inbound (Cliente):* Fondo blanco/gris neutro, alineado a la izquierda.
    * *Outbound Humano:* Fondo verde esmeralda suave, alineado a la derecha, con avatar diminuto del operador.
    * *Outbound IA:* Fondo azul grisáceo tenue, con badge distintivo `🤖 Agente Virtual`, indicador del modelo utilizado y enlace directo a la traza de ejecución.
    * *Eventos del Sistema:* Marcadores centrados que indican traspasos (*"Ana tomó el chat"*, *"IA pausada por 24 horas"*).
- **Channel Capabilities Engine (Composer Adaptable):**
  - **Detección de Ventana de 24 Horas (WhatsApp):** Si la ventana de servicio de Meta ha expirado, el composer de texto libre se bloquea automáticamente y despliega un banner de advertencia: *"Han transcurrido más de 24h desde el último mensaje del cliente. Selecciona una plantilla aprobada por Meta para reabrir la conversación"*. Al pulsar, abre un selector de plantillas con vista previa de variables.
  - **Soporte de Adjuntos por Proveedor:** Valida tamaño y extensiones permitidas según el canal antes de iniciar la subida (Meta Cloud máx 16MB/100MB según tipo; Telegram hasta 50MB).
  - **Banner de Sugerencias de IA:** Cuando el agente trabaja en modo sugerencia, presenta un contenedor flotante con el texto propuesto, nivel de confianza (ej. 94%), lista de fuentes consultadas y botones de acción rápida: `[Aceptar y Enviar (Ctrl+Enter)]`, `[Editar en Composer]`, `[Regenerar]`, `[Descartar]`.

### 3.3. Panel Derecho: Inspector de Contexto e Identidad
- **Acordeón Modular Colapsable:**
  - *Identidad del Cliente:* Nombre registrado, número telefónico, canal ID, fecha de primer contacto, etiquetas asociadas (con selector directo para añadir/quitar).
  - *Línea de Actividad de IA:* Muestra los últimos eventos ejecutados por el bot (ej. `Búsqueda en catálogo`, `Comprobación de stock: 12 unidades`, `Detección de intención: Pago`).
  - *Resumen Comercial:* Si el cliente cuenta con pedidos en curso, muestra el número de pedido, total monetario y estado de pago, con botón para abrir el comprobante en modal de validación rápida.
  - *Notas Internas Privadas:* Espacio para que los agentes registren anotaciones visibles solo para el equipo interno, con firma de usuario y marca temporal.

---

## 4. Módulo 2: Agent Studio con Grafo Visual

El Agent Studio evoluciona desde el formulario monolítico actual hacia un entorno visual interactivo basado en nodos y conexiones, manteniendo paridad total con el esquema declarativo v0.4.

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ BARRA DE CONTROL DE VERSIÓN                                                            │
│ Agente: [Ventas e-Commerce v2.4 (Borrador)]   [Validar] [Simular] [Ver Diff] [Publicar]│
├───────────────────────────────┬────────────────────────────────────────┬───────────────┤
│ PALETA DE NODOS               │ LIENZO DEL GRAFO (Node Canvas)        │ INSPECTOR     │
├───────────────────────────────┼────────────────────────────────────────┼───────────────┤
│ 📥 Triggers                   │   ┌───────────────┐                    │ Config. Nodo: │
│   • Mensaje entrante          │   │  TRIGGER:     │                    │ "LLM Vendedor"│
│   • Inactividad               │   │  Nuevo Mensaje│                    │               │
│                               │   └───────┬───────┘                    │ Modelo:       │
│ 🛡️ Guardas & Políticas        │           ▼                            │ Gemini 1.5 Pro│
│   • Comprobar horario         │   ┌───────────────┐                    │ Temp: 0.3     │
│   • Filtro de moderación      │   │ POLICY GUARD: │                    │               │
│                               │   │ ¿Horario OK?  │                    │ Prompt Sys:   │
│ 🧠 Razonamiento LLM           │   └───┬───────┬───┘                    │ [Editar...]   │
│   • Gemini 1.5 Pro            │  (No) │       │ (Sí)                   │               │
│   • OpenAI GPT-4o             │       ▼       ▼                        │ Tools Activas:│
│   • Modelo Local (vLLM)       │   ┌───────┐ ┌───────────────┐          │ ☑ Catálogo    │
│                               │   │Respuesta│ LLM REASONER: │          │ ☑ Stock       │
│ 🔧 Herramientas (Tools)       │   │Fuera  │ │ Ventas Bot    │          │ ☐ Cobro       │
│   • Consultar catálogo        │   │Horario│ └───────┬───────┘          │               │
│   • Verificar stock           │   └───────┘         ▼                  │ Fallback:     │
│   • Registrar pedido          │             ┌───────────────┐          │ Pasar a humano│
│                               │             │  TOOL CALL:   │          │ si conf < 0.7 │
│ 👤 Intervención Humana        │             │ get_catalog() │          │               │
│   • Gate de Aprobación        │             └───────────────┘          │               │
└───────────────────────────────┴────────────────────────────────────────┴───────────────┘
```

### 4.1. Arquitectura Dual: Visual Canvas <-> Editor Declarativo
- **Grafo Visual:** Representación interactiva con zoom, paneo libre, mini-mapa en la esquina inferior y auto-layout jerárquico.
- **Editor de Código Sincronizado:** Pestaña lateral que permite visualizar y editar la especificación en formato YAML/JSON conforme al schema contractual de agentes. Cualquier cambio en el editor visual actualiza el código en tiempo real y viceversa, sin pérdida de metadatos de posicionamiento.
- **Tipología de Nodos Soportados:**
  - *Trigger Node:* Punto de entrada del grafo (mensaje recibido, palabra clave detectada, evento webhook).
  - *Policy Guard Node:* Evalúa reglas deterministas antes de invocar modelos (ej. horario de atención, detección de palabras prohibidas, validación de cuotas de tokens).
  - *Memory & Retrieval Node:* Carga historial conversacional y realiza búsqueda vectorial RAG sobre documentos de la empresa.
  - *LLM Node:* Generador de respuesta con selección de proveedor, versión de prompt del sistema y temperatura.
  - *Tool Node:* Ejecución de acciones con permisos delimitados (least-privilege tool grants).
  - *Human Gate Node:* Punto de interrupción que suspende el flujo y genera una solicitud en la cola de aprobaciones humanas.
  - *Handoff Node:* Deriva la conversación a la cola de agentes humanos con una razón tipificada.

### 4.2. Ciclo de Vida: Borrador, Validación, Simulación y Publicación
- **Barra de Acciones Persistente:**
  - `[Validar Grafo]`: Analiza la topología en busca de nodos desconectados, bucles sin condición de salida y herramientas requeridas sin credencial configurada.
  - `[Simular en Sandbox]`: Abre un drawer lateral interactivo con una consola de chat simulada. Permite enviar mensajes de prueba e ilumina los nodos en tiempo real a medida que se ejecutan, mostrando inputs, outputs y tiempos de latencia paso a paso.
  - `[Ver Diff de Versión]`: Despliega un comparador visual que resalta los cambios entre el borrador actual y la versión publicada activa en producción.
  - `[Publicar con Confirmación]`: Despliega un modal que resume el impacto del cambio, requiere confirmación del usuario y genera un nuevo registro inmutable en el historial de versiones con autoría y marca temporal.
  - `[Revertir Versión]`: Permite seleccionar cualquier versión anterior y restaurarla en producción con un solo clic.

---

## 5. Módulo 3: Constructor Guiado de Automatizaciones (Automations Wizard)

En estricta observancia del Blueprint v0.4 (§11.1), el constructor de automatizaciones en su primera versión evita la complejidad de un lienzo genérico de workflows y se implementa como un **Wizard Lineal Declarativo de 5 Pasos**:

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ WIZARD DE NUEVA AUTOMATIZACIÓN                                                         │
│ [1. Disparador] ──► [2. Condiciones] ──► [3. Acciones] ──► [4. Espera] ──► [5. Dry-Run]│
├────────────────────────────────────────────────────────────────────────────────────────┤
│ PASO 5: RESUMEN EN LENGUAJE NATURAL Y SIMULACIÓN                                       │
│                                                                                        │
│ 📋 Resumen de la Regla:                                                               │
│ "CUANDO un cliente escriba por WhatsApp fuera del horario de atención (09:00 - 18:00), │
│  Y la etiqueta del cliente NO sea 'Empleado',                                         │
│  ENTONCES enviar la plantilla 'mensaje_fuera_de_horario',                              │
│  Y asignar la etiqueta 'Pendiente Atención Mañana',                                   │
│  Y registrar un ticket en la cola de operaciones con prioridad Media."                 │
│                                                                                        │
│ 🧪 Simulación Dry-Run:                                                                 │
│ [Disparar Evento Sintético de Prueba] ──► Resultado: Éxito                             │
│ Acciones Simuladas (`simulatedActions`):                                              │
│ • SendMessage: template='mensaje_fuera_de_horario' (Validado con schema Meta)          │
│ • AssignTag: id='tag-992'                                                             │
│ • CreateTicket: priority='medium'                                                      │
│                                                                                        │
│ [◄ Paso Anterior]                                     [Guardar y Activar Workflow]    │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 5.1. Pasos del Asistente
1. **Paso 1: Disparador (Trigger):**
   - Selección mediante tarjetas ilustradas: *Mensaje entrante*, *Primer contacto*, *Inactividad de chat (> X minutos)*, *Palabra clave en mensaje*, *Nuevo comprobante de pago subido*.
2. **Paso 2: Condiciones (Rules Engine):**
   - Constructor visual de reglas tipo `SI (Condición A) Y/O (Condición B)`:
     - Horario comercial de la empresa (dentro / fuera de horas).
     - Canal origen (WhatsApp, Telegram, Instagram).
     - Etiquetas existentes en el contacto.
     - Monto del pedido o estado comercial.
3. **Paso 3: Acciones (Actions):**
   - Acciones encadenables:
     - Enviar mensaje o plantilla oficial aprobada.
     - Añadir o remover etiquetas de segmentación.
     - Asignar a un equipo o agente humano específico.
     - Activar o pausar el agente de IA en la conversación.
     - Despachar un webhook saliente a un CRM externo.
4. **Paso 4: Espera y Control de Frecuencia:**
   - Temporizador de retardo configurable (ej. *esperar 10 minutos antes de ejecutar*).
   - Límite de frecuencia (rate limit por cliente): *no disparar más de 1 vez cada 24 horas al mismo contacto*.
5. **Paso 5: Resumen en Lenguaje Natural y Dry-Run:**
   - La interfaz compila la regla en una descripción textual clara y sin tecnicismos.
   - Botón de **Dry-Run**: Ejecuta el motor con un evento mock en memoria y devuelve la lista de `simulatedActions` sin producir efectos colaterales reales ni despachar mensajes a clientes.

### 5.2. Galería de Plantillas Pre-configuradas (Templates)
- *Atención Fuera de Horario:* Respuesta automática y derivación a cola de inicio de jornada.
- *Calificación y Asignación de Leads:* Pregunta inicial de interés y enrutamiento al equipo de ventas correspondiente.
- *Cobranza Digital Rápida:* Envío de datos de pago (Yape/Plin/Cuenta bancaria) ante mención de cotización y solicitud de comprobante.
- *Escalamiento Inmediato por Reclamo:* Detección de palabras de disconformidad, pausa de IA y alerta de máxima urgencia a supervisor.

---

## 6. Módulo 4: Cola de Aprobaciones Humanas (Human-in-the-Loop)

Diseñado para gobernar las decisiones críticas sugeridas por agentes de IA o workflows automáticos antes de que impacten al cliente o a las finanzas de la empresa.

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ COLA DE APROBACIONES PENDIENTES                                           [Filtros ▼]  │
├──────┬──────────────┬──────────────────┬───────────────────────┬─────────┬─────────────┤
│RIESGO│ AGENTE / ORIG│ CLIENTE / CANAL  │ ACCIÓN PROPUESTA      │ TTL     │ ACCIONES    │
├──────┼──────────────┼──────────────────┼───────────────────────┼─────────┼─────────────┤
│ 🔴   │ Cobranza IA  │ Juan Pérez       │ Validar Pago S/ 450.00│ 14 min  │ [Revisar]   │
│ ALTO │ Workflow #12 │ WhatsApp Cloud   │ Voucher: #99482.jpg   │ restante│ [Aprobar]   │
├──────┼──────────────┼──────────────────┼───────────────────────┼─────────┼─────────────┤
│ 🟡   │ Ventas Bot   │ Distribuidora Sol│ Cotización especial   │ 45 min  │ [Revisar]   │
│ MEDIO│ Agent #04    │ Telegram         │ Descuento 15% (S/3,20)│ restante│ [Aprobar]   │
├──────┼──────────────┼──────────────────┼───────────────────────┼─────────┼─────────────┤
│ 🟢   │ FollowUp Bot │ María López      │ Mensaje de seguimiento│ Expira  │ [Revisar]   │
│ BAJO │ Workflow #02 │ Instagram        │ Plantilla de postventa│ mañana  │ [Aprobar]   │
└──────┴──────────────┴──────────────────┴───────────────────────┴─────────┴─────────────┘
```

### 6.1. Clasificación por Nivel de Riesgo
- 🔴 **Riesgo Alto:** Movimientos financieros, validación de pagos, cancelación de pedidos, despacho de mensajes masivos, o transferencias de datos sensibles.
- 🟡 **Riesgo Medio:** Aplicación de descuentos comerciales fuera de lista, promesas de entrega extraordinarias o modificación de datos de cliente.
- 🟢 **Riesgo Bajo:** Respuestas automáticas con bajo nivel de confianza estadística del modelo (entre 60% y 75%).

### 6.2. Modal de Inspección y Diff
Al hacer clic en `[Revisar]`, se abre un modal de pantalla completa o drawer lateral con:
- **Resumen de la Solicitud:** Quién la generó, qué regla o prompt la disparó y cuál es la justificación de la IA.
- **Diff Visual:** Visualización clara de los datos actuales vs datos propuestos (ej. comprobante escaneado vs monto detectado por OCR).
- **Acciones Resolutivas:**
  - `[Aprobar y Ejecutar]`: Firma la acción con el hash único de aprobación (`approval_token`) y la despacha al bus de eventos.
  - `[Modificar antes de Enviar]`: Permite al supervisor corregir el texto o monto propuesto y aprobar la versión corregida.
  - `[Rechazar con Feedback]`: Cancela la acción y solicita obligatoriamente una razón breve que se inyecta en el historial de reentrenamiento del agente.
- **Protección contra Replay:** Los botones se deshabilitan inmediatamente al ser pulsados, empleando un CAS token de un solo uso que previene aprobaciones duplicadas ante concurrencia.

---

## 7. Módulo 5: Operaciones y Observabilidad

El centro neurálgico para supervisores técnicos y administradores de sistema.

- **Línea de Tiempo de Ejecución (Tracing Visual):**
  - Permite ingresar un `traceId` o `conversationId` y visualizar el recorrido completo del evento a través de los adaptadores, colas, evaluadores de políticas y modelos LLM.
  - Cada paso muestra su duración en milisegundos, estado (`OK`, `Warning`, `Error`) y costo en tokens/moneda.
- **Gestor de Dead-Letter Queue (DLQ):**
  - Lista de mensajes o tareas que no pudieron entregarse tras agotar los reintentos automáticos.
  - Muestra el código de error devuelto por el proveedor externo (ej. error de webhook de Telegram, número inexistente en WhatsApp, limitación de tasa).
  - Incluye botón de `[Reintentar Tarea]` idempotente y `[Descartar y Archivar]`.
- **Panel de Monitoreo de SLA:**
  - Métricas en tiempo real sobre cumplimiento de tiempos de respuesta.
  - Identificación visual de cuellos de botella por franja horaria y por operador.

---

## 8. Módulo 6: Hub de Canales y Conexiones

Resuelve definitivamente la confusión existente en la configuración de proveedores:

- **Tarjetas de Canal Independientes:**
  - **WhatsApp Business (Meta Cloud API):**
    - Configuración limpia de `Phone Number ID`, `WABA ID` y token permanente cifrado.
    - Indicador de estado del Webhook con ping de diagnóstico en tiempo real.
    - Cero código QR en la interfaz de Meta Cloud.
  - **Telegram Bot API:**
    - Configuración guiada con BotFather (`Bot Token`).
    - Verificación inmediata de conectividad con la API de Telegram.
  - **Instagram Messaging API:**
    - Asistente de vinculación con Meta Facebook Login y selección de cuenta profesional.
- **Simulador Zero-Config (Demo Mode):**
  - Permite a empresas nuevas explorar el producto sin haber configurado números ni APIs reales.
  - Crea un canal virtual simulado que inyecta conversaciones y mensajes sintéticos para capacitar al personal o realizar pruebas de grafos en un entorno 100% seguro.

---

## 9. Módulo 7: Experiencia Móvil Nativa (iOS / Android)

Basada en **React Native con Expo development builds** (conforme al ADR-0013), priorizando las necesidades operativas del personal en movimiento:

### 9.1. Alcance Funcional Móvil
- **Login Seguro con Biometría:** Soporte para FaceID / Huella dactilar tras la autenticación inicial con credenciales.
- **Bandeja de Entrada Móvil (Single-Column Drill-Down):**
  - Lista de conversaciones con scroll ultrarrápido y badges táctiles grandes.
  - Al pulsar un chat, transiciona a pantalla completa con teclado nativo optimizado.
- **Composer Móvil Nativo:**
  - Acceso directo a la cámara del dispositivo y selector de galería con compresión previa al envío.
  - Soporte de notas de voz con grabación y reproducción nativa.
- **Aprobaciones Rápidas por Gestos:**
  - La cola de aprobaciones en móvil implementa gestos swipe:
    - *Deslizar a la derecha:* Aprobar acción crítica.
    - *Deslizar a la izquierda:* Rechazar acción.
- **Takeover Inmediato:** Botón destacado en cabecera para pausar la IA y asumir control del chat con un solo toque táctil.

### 9.2. Seguridad y Resiliencia Móvil
- **Cero PII en Notificaciones Push:**
  - Los payloads de Apple Push Notification Service (APNs) y Firebase Cloud Messaging (FCM) contienen únicamente identificadores anónimos (`notification_id`, `chat_id`). El texto del cliente y su información personal nunca viajan en el push.
  - Al recibir la notificación, la app consulta el backend mediante conexión TLS autenticada para hidratar el contenido en pantalla protegida.
- **Modo Offline y Reconexión Transaccional:**
  - Los mensajes enviados sin cobertura se almacenan en una cola local protegida en SQLite/WatermelonDB con estado "En espera de red".
  - Al recuperar la señal, el motor móvil despacha los mensajes en orden cronológico estricto, utilizando claves de idempotencia (`effectKey`) que impiden duplicados lógicos en el backend.
