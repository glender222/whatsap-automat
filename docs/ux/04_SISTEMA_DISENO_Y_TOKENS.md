# Sistema de Diseño y Tokens Semánticos
## Whatsap-Automat v0.4 — Design System Specification

**Fecha:** Octubre 2026  
**Rol:** Lead Product Designer, UX Engineer & Frontend Architect  
**Cumplimiento:** WCAG 2.2 AA, Soporte Dual Modo Claro / Oscuro, Tailwind CSS compatible

---

## 1. Fundamentos y Tokens de Color

El sistema de color se estructura sobre roles semánticos universales, eliminando la discrepancia histórica entre el verde WhatsApp y el gris oscuro industrial.

### 1.1. Tokens Semánticos de Color

| Token Semántico | Modo Claro (HEX) | Modo Oscuro (HEX) | Uso Principal | Ratio Contraste Mínimo |
|---|---|---|---|---|
| `bg-canvas` | `#F8FAFC` (Slate 50) | `#0B0F19` (Navy 950) | Fondo principal de la ventana | 12:1 contra texto principal |
| `bg-surface` | `#FFFFFF` (Blanco Puro) | `#131B2E` (Navy 900) | Superficie de paneles, tarjetas y modales | 10:1 contra texto principal |
| `bg-surface-elevated`| `#FFFFFF` (con sombra) | `#1C2640` (Navy 800) | Menús flotantes, popovers, dropdowns | 9:1 |
| `border-subtle` | `#E2E8F0` (Slate 200) | `#23304E` (Navy 700) | Divisores sutiles de lista y paneles | 3:1 contra superficie |
| `border-strong` | `#CBD5E1` (Slate 300) | `#334366` (Navy 600) | Bordes de inputs y componentes interactivos | 3:1 |
| `text-primary` | `#0F172A` (Slate 900) | `#F8FAFC` (Slate 50) | Títulos, texto principal, datos críticos | 12:1 (Supera WCAG AA) |
| `text-secondary` | `#475569` (Slate 600) | `#94A3B8` (Slate 400) | Etiquetas secundarias, marcas temporales | 4.6:1 (Cumple WCAG AA) |
| `text-muted` | `#64748B` (Slate 500) | `#64748B` (Slate 500) | Placeholders, textos de ayuda no críticos | 3.5:1 |
| `primary` (Brand) | `#0D9488` (Teal 600) | `#14B8A6` (Teal 500) | Acciones primarias, botones principales | 4.8:1 contra blanco / negro |
| `primary-hover` | `#0F766E` (Teal 700) | `#0D9488` (Teal 600) | Estado hover de acciones primarias | N/A |
| `success` (WhatsApp)| `#059669` (Emerald 600) | `#10B981` (Emerald 500) | Conexión activa, entregado, validado | 4.6:1 |
| `warning` (Alerta) | `#D97706` (Amber 600) | `#F59E0B` (Amber 500) | Riesgo medio, advertencia SLA, espera | 4.5:1 |
| `danger` (Crítico) | `#DC2626` (Red 600) | `#EF4444` (Red 500) | Errores, rechazo, desconexión, P0 | 5.1:1 |
| `info` (Canal/IA) | `#2563EB` (Blue 600) | `#3B82F6` (Blue 500) | Mensajes de sistema, sugerencias IA | 4.9:1 |

### 1.2. Colores Distintivos por Proveedor de Canal
- **WhatsApp Cloud:** `#25D366` (Identificador) / Píldora: `bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300`.
- **Telegram Bot:** `#229ED9` (Identificador) / Píldora: `bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300`.
- **Instagram Messaging:** `#E1306C` (Identificador) / Píldora: `bg-pink-50 text-pink-700 dark:bg-pink-950/60 dark:text-pink-300`.

---

## 2. Tipografía y Jerarquía

Se adopta una pila tipográfica nativa sans-serif optimizada para legibilidad en pantallas de alta densidad:
`font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`.

### 2.1. Escala Tipográfica Operativa

| Nivel | Tamaño | Interlineado | Peso | Caso de Uso |
|---|---|---|---|---|
| `display-lg` | 24px (1.5rem) | 32px | 700 (Bold) | Encabezados principales de módulos |
| `heading-md` | 18px (1.125rem) | 24px | 600 (Semibold) | Título de conversación activa, nombres de modal |
| `heading-sm` | 15px (0.9375rem)| 20px | 600 (Semibold) | Títulos de sección en paneles laterales |
| `body-md` | 14px (0.875rem) | 20px | 400 (Regular) | Texto de mensajes en timeline, inputs de formulario |
| `body-sm` | 13px (0.8125rem)| 18px | 400 / 500 | Lista de conversaciones, filas de tablas |
| `caption` | 11px (0.6875rem)| 14px | 500 (Medium) | Marcas temporales, badges de SLA, tags |
| `code-sm` | 12px (0.75rem) | 16px | 400 (Mono) | IDs de transacción, traces, tokens de depuración |

---

## 3. Espaciado, Grilla y Densidad

Basado en un sistema modular de 4px / 8px:
- `space-1`: 4px — Separación entre iconos y textos en botones.
- `space-2`: 8px — Padding interno de botones compactos y badges.
- `space-3`: 12px — Padding de celdas de tabla y tarjetas de chat.
- `space-4`: 16px — Padding estándar de paneles y formularios.
- `space-6`: 24px — Separación entre bloques mayores y cabeceras.
- `space-8`: 32px — Márgenes perimetrales en pantallas amplias.

### Densidad de Trabajo
Para maximizar la cantidad de información visible sin generar fatiga:
- Las filas de la lista de chats tienen una altura fija de 64px.
- La tabla de comprobantes de pago e inventario tiene una altura de fila compacta de 44px.
- Las cabeceras del topbar y chat tienen una altura estandarizada de 56px (`h-14`).

---

## 4. Elevaciones y Jerarquía de Capas (Z-Index)

Se elimina el uso de valores arbitrarios (`z-[9999]`, `z-[1200]`) en favor de una escala estricta:

```text
┌────────────────────────────────────────────────────────┐
│ Z-INDEX SCALE                                          │
├─────────────────────┬──────────┬───────────────────────┤
│ Capa                │ Z-Index  │ Componentes           │
├─────────────────────┼──────────┼───────────────────────┤
│ `z-base`            │ 0        │ Canvas, contenido     │
│ `z-elevated`        │ 10       │ Tarjetas arrastrables │
│ `z-sticky`          │ 20       │ Cabeceras fijas       │
│ `z-dropdown`        │ 30       │ Menús contextuales    │
│ `z-drawer`          │ 40       │ Paneles laterales     │
│ `z-backdrop`        │ 50       │ Fondos oscurecedores  │
│ `z-modal`           │ 60       │ Diálogos y wizards    │
│ `z-popover`         │ 70       │ Tooltips y datepicker │
│ `z-toast`           │ 80       │ Notificaciones toast  │
│ `z-critical-alert`  │ 90       │ Banners de red caída  │
└─────────────────────┴──────────┴───────────────────────┘
```

---

## 5. Especificaciones de Componentes Clave

### 5.1. Botones (`Button`)
- **Variantes:**
  - `Primary`: Fondo `primary`, texto blanco, radio `rounded-lg` (8px), padding `px-4 py-2`, foco `ring-2 ring-primary ring-offset-2`.
  - `Secondary`: Fondo transparente, borde `border-strong`, texto `text-primary`, hover suave `hover:bg-slate-100 dark:hover:bg-navy-800`.
  - `Destructive`: Fondo `danger`, texto blanco, para acciones irreversibles.
  - `Ghost / Icon-only`: Fondo transparente, padding `p-2`, siempre requiere atributo `aria-label` obligatorio.
- **Estados:** Deshabilitado (`opacity-50 cursor-not-allowed pointer-events-none`), Cargando (`relative pointer-events-none` con spinner centrado y texto oculto visualmente pero legible por lectores).

### 5.2. Diálogos y Modales (`Modal`)
- Todo modal debe ser montado en un Portal React (`#modal-root`).
- Confinamiento de foco (`focus-trap`): la navegación por tecla `Tab` cicla exclusivamente dentro del modal.
- Al pulsar `Escape`, el modal se cierra y devuelve el foco activo al botón disparador original.
- El backdrop aplica un desenfoque sutil (`backdrop-blur-sm bg-black/50`).

### 5.3. Píldoras de Estado (`StatusBadge`)
- Contenedores compactos con bordes sutiles y texto en mayúscula controlada (`text-xs font-semibold uppercase tracking-wider`).
- Siempre incluyen un punto indicador visual circular de 6px (`rounded-full`) o un icono reconocible, de modo que la información no dependa exclusivamente del color para personas con daltonismo.

---

## 6. Breakpoints Responsivos

- **Mobile (`< 768px`):** Navegación mono-columna. El sidebar se convierte en un drawer deslizable; el chat ocupa el 100% del viewport con botón de retroceso superior para regresar a la lista de conversaciones.
- **Tablet (`768px - 1024px`):** Vista de 2 paneles (Bandeja izquierda de 280px + Panel central flex). El panel contextual derecho se oculta y se invoca como drawer flotante.
- **Desktop (`1024px - 1440px`):** Vista completa de 3 paneles (Sidebar 64px colapsado o 240px expandido + Bandeja 300px + Centro flex + Inspector derecho 280px).
- **Ultra-Wide (`> 1440px`):** El panel de conversación central se expande manteniendo márgenes de lectura cómodos (máx 900px para burbujas de texto).
