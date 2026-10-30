# 📁 Arquitectura del Módulo Settings

## 🎯 Objetivo
Este módulo maneja toda la configuración de la aplicación, incluyendo la conexión de WhatsApp, preferencias de usuario y eventos en tiempo real.

---

## 📂 Estructura de Archivos

```
settings/
├── components/               # Componentes visuales reutilizables
│   ├── LoadingChatsOverlay.tsx
│   ├── LogoutOverlay.tsx
│   ├── WhatsAppConnectionSection.tsx
│   ├── ThemeSection.tsx
│   ├── AutoDownloadSection.tsx
│   ├── SettingsHeader.tsx
│   └── SettingsSidebar.tsx
│
├── hooks/                    # Lógica de negocio personalizada
│   ├── useWhatsAppConnection.ts
│   ├── useSocketEvents.ts
│   └── useSettings.ts
│
├── services/                 # Servicios de API y backend
│   └── whatsappService.ts
│
├── types/                    # Definiciones de tipos TypeScript
│   └── settings.types.ts
│
├── SettingsModal.tsx         # Componente principal refactorizado
├── SettingsModal.old.tsx     # Backup del archivo original
├── SettingsPage.tsx          # Página de configuración standalone
├── Sidebar.tsx               # Sidebar de navegación global
└── ARCHITECTURE.md           # Esta documentación
```

---

## 📦 Componentes

### `LoadingChatsOverlay.tsx`
**Propósito:** Overlay animado que muestra el progreso de carga de chats en tiempo real.

**Props:**
- `status`: Estado actual ('started' | 'fetching' | 'processing' | 'initial-loaded' | 'loading' | 'completed')
- `loaded`: Número de chats cargados
- `total`: Total de chats a cargar
- `percentage`: Porcentaje de progreso (0-100)
- `message`: Mensaje descriptivo del estado

**Estados visuales:**
- `fetching/processing`: Spinner sin barra de progreso
- `loading`: Barra de progreso con actualización en tiempo real
- `completed`: Checkmark verde con botón de acción

---

### `LogoutOverlay.tsx`
**Propósito:** Overlay animado durante el cierre de sesión de WhatsApp.

**Props:**
- `show`: Boolean que controla la visibilidad

**Características:**
- Animación de fade-in con gradient rojo/naranja
- Icono de logout animado con spinner
- Muestra durante 500ms antes de limpiar datos

---

### `WhatsAppConnectionSection.tsx`
**Propósito:** Sección para afiliar/desafiliar número de WhatsApp.

**Props:**
- `numeroAfiliado`: Número actual afiliado (string | null)
- `afiliando`: Estado de afiliación en progreso
- `loggingOut`: Estado de desafiliación en progreso
- `qrUrl`: URL del código QR para escanear
- `onAfiliar`: Callback para iniciar afiliación
- `onDesafiliar`: Callback para cerrar sesión

**Características:**
- Muestra número formateado (sin prefijo de país)
- Modal de QR para afiliación
- Botones contextuales según estado

---

### `ThemeSection.tsx`
**Propósito:** Selector de tema de la aplicación.

**Props:**
- `tema`: Tema actual ('Sistema' | 'Claro' | 'Oscuro')
- `onTemaChange`: Callback al cambiar tema

**Opciones:**
- Sistema (auto-detectado)
- Claro
- Oscuro

---

### `AutoDownloadSection.tsx`
**Propósito:** Configuración de descargas automáticas de archivos.

**Props:**
- `autoDownloadImagesFiles`: Estado de descarga de imágenes
- `autoDownloadDocuments`: Estado de descarga de documentos
- `onImagesFilesChange`: Callback para toggle de imágenes
- `onDocumentsChange`: Callback para toggle de documentos

**Características:**
- Dropdown con switches personalizados
- Sincronización automática con localStorage

---

### `SettingsHeader.tsx` (Móvil)
**Propósito:** Header de navegación para vista móvil.

**Props:**
- `selectedMenu`: Menú actualmente seleccionado
- `onMenuChange`: Callback al cambiar de menú
- `onClose`: Callback para cerrar modal

---

### `SettingsSidebar.tsx` (Desktop)
**Propósito:** Sidebar de navegación para vista desktop.

**Props:**
- `selectedMenu`: Menú actualmente seleccionado
- `onMenuChange`: Callback al cambiar de menú
- `onClose`: Callback para cerrar modal

---

## 🪝 Hooks Personalizados

### `useWhatsAppConnection.ts`
**Propósito:** Maneja toda la lógica de conexión de WhatsApp.

**Estado gestionado:**
```typescript
{
  numeroAfiliado: string | null;
  qrUrl: string | null;
  afiliando: boolean;
  loggingOut: boolean;
  showLogoutAnimation: boolean;
}
```

**Métodos:**
- `fetchNumeroAfiliado()`: Obtiene el número actual del backend
- `handleAfiliar()`: Inicia proceso de afiliación (obtiene QR)
- `handleDesafiliar()`: Cierra sesión de WhatsApp
- `updateState()`: Actualiza estado desde eventos externos

**Características:**
- Polling cada 2s durante afiliación
- Manejo de logout vía socket o HTTP fallback
- Timeout de 5s para fallback

---

### `useSocketEvents.ts`
**Propósito:** Centraliza todos los listeners de eventos socket.

**Eventos escuchados:**

1. **`ready`**: WhatsApp conectado después de escanear QR
2. **`loading-chats`**: Progreso de carga de chats (estados: fetching, processing, initial-loaded, loading, completed)
3. **`chats-updated`**: Nuevos chats disponibles
4. **`disconnected`**: Sesión cerrada (detecta logout)
5. **`qr`**: Nuevo código QR generado
6. **`logout-confirmed`**: Confirmación de logout del servidor
7. **`auth_failure`**: Error de autenticación

**Callbacks:**
- `onLoadingUpdate`: Actualiza estado de carga
- `onConnectionUpdate`: Actualiza estado de conexión
- `onNumeroDetected`: Se detectó número afiliado

---

### `useSettings.ts`
**Propósito:** Maneja preferencias de configuración persistentes.

**Estado gestionado:**
```typescript
{
  tema: string;
  autoDownloadImagesFiles: boolean;
  autoDownloadDocuments: boolean;
}
```

**Métodos:**
- `updateSettings()`: Actualiza una o más configuraciones

**Características:**
- Carga automática desde localStorage al montar
- Sincronización automática al cambiar valores
- Manejo de errores silencioso

---

## 🔧 Servicios

### `whatsappService.ts`
**Propósito:** Encapsula todas las llamadas API relacionadas con WhatsApp.

**Métodos:**

- `fetchNumeroAfiliado()`: GET /me → Obtiene número actual
- `fetchNumeroAfiliadoFromChats()`: ❌ DEPRECATED - usaba GET /chats (usar /tags/{id}/chats/full en su lugar)
- `fetchQR()`: GET /qr → Obtiene código QR
- `logoutViaHTTP()`: POST /api/auth/logout → Cierre de sesión HTTP
- `formatNumeroAfiliado()`: Formatea número (remueve prefijo)

**Configuración:**
```typescript
const API_BASE_URL = 'http://localhost:3000';
```

**⚠️ NOTA:** La API antigua `GET /chats` ha sido completamente deprecada.
Usa `/tags/{id}/chats/full` (vía `tagsService.getChatsByTag(tagId)`) en su lugar.
La etiqueta "Todo" es la default en la BD y equivale a `GET /chats` pero mejorada.

---

## 📘 Types

### `settings.types.ts`

**Tipos principales:**

```typescript
type LoadingStatus = 
  | 'started' 
  | 'fetching' 
  | 'processing' 
  | 'initial-loaded' 
  | 'loading' 
  | 'completed';

interface LoadingChatsState {
  isLoading: boolean;
  status: LoadingStatus;
  loaded: number;
  total: number;
  percentage: number;
  message: string;
}

interface WhatsAppConnectionState {
  numeroAfiliado: string | null;
  qrUrl: string | null;
  afiliando: boolean;
  loggingOut: boolean;
  showLogoutAnimation: boolean;
}

interface SettingsState {
  tema: string;
  autoDownloadImagesFiles: boolean;
  autoDownloadDocuments: boolean;
}

interface SocketEventData {
  status?: LoadingStatus;
  loaded?: number;
  total?: number;
  percentage?: number;
  message?: string;
  reason?: string;
  success?: boolean;
}
```

---

## 🔄 Flujos de Datos

### 1️⃣ **Flujo de Afiliación (Login)**

```mermaid
Usuario hace click en "Afiliar"
    ↓
useWhatsAppConnection.handleAfiliar()
    ↓
WhatsAppService.fetchQR() → Backend GET /qr
    ↓
Se muestra QR en WhatsAppConnectionSection
    ↓
Usuario escanea QR con WhatsApp
    ↓
Backend emite evento "ready" vía socket
    ↓
useSocketEvents captura "ready"
    ↓
Oculta QR + Activa LoadingChatsOverlay
    ↓
Backend emite eventos "loading-chats" progresivos
    ↓
LoadingChatsOverlay actualiza barra en tiempo real
    ↓
Backend emite "loading-chats" status: "completed"
    ↓
Overlay se oculta después de 2s
```

### 2️⃣ **Flujo de Cierre de Sesión (Logout)**

```mermaid
Usuario hace click en "Desafiliar"
    ↓
useWhatsAppConnection.handleDesafiliar()
    ↓
Socket emite "logout" al backend
    ↓
LogoutOverlay aparece inmediatamente
    ↓
Backend cierra sesión de WhatsApp
    ↓
Backend emite "disconnected" con reason: "LOGOUT"
    ↓
useSocketEvents captura "disconnected"
    ↓
Espera 500ms (animación suave)
    ↓
Limpia numeroAfiliado, qrUrl, afiliando
    ↓
Espera 1.5s más
    ↓
Oculta LogoutOverlay
    ↓
Backend emite nuevo "qr" (opcional)
    ↓
Listo para nueva afiliación
```

### 3️⃣ **Flujo de Carga de Chats (Real-time)**

```mermaid
Backend detecta sesión activa
    ↓
Evento "loading-chats" status: "fetching"
    → Mensaje: "Obteniendo lista de chats..."
    ↓
Evento "loading-chats" status: "processing"
    → Mensaje: "Procesando 362 chats..."
    ↓
Evento "loading-chats" status: "initial-loaded"
    → loaded: 50, total: 362, percentage: 13%
    ↓
Evento "loading-chats" status: "loading"
    → Se emite cada 20 chats
    → loaded: 70, 90, 110... percentage: 19%, 24%, 30%...
    ↓
Evento "loading-chats" status: "completed"
    → loaded: 362, total: 362, percentage: 100%
```

---

## 🎨 Responsividad

### Móvil (`< 768px`)
- Header con tabs horizontales
- Contenido full-height
- Dropdowns optimizados para touch
- QR más pequeño (160x160px)

### Desktop (`≥ 768px`)
- Sidebar vertical de navegación
- Modal centrado (max-width: 1024px)
- QR más grande (192x192px)
- Hover states en todos los botones

---

## 🚀 Mejoras Futuras

### Corto plazo
- [ ] Agregar tests unitarios para hooks
- [ ] Agregar tests de integración para flujos completos
- [ ] Implementar retry automático en caso de error de red
- [ ] Agregar modo offline

### Largo plazo
- [ ] Migrar a zustand o redux para estado global
- [ ] Implementar WebSocket reconnection automático
- [ ] Agregar más temas personalizables
- [ ] Implementar configuración de bot (sección Bot)
- [ ] Agregar analytics de uso

---

## 📝 Notas Importantes

### ⚠️ Consideraciones de Seguridad
- El QR es temporal y expira
- El número afiliado NO incluye información sensible
- Los eventos socket están protegidos en el backend

### 🐛 Debugging
Para debugging, revisa los logs en consola:
- `✅` - Eventos de conexión exitosos
- `📊` - Eventos de progreso
- `🔴` - Eventos de logout
- `⚠️` - Warnings o fallbacks

### 🔧 Mantenimiento
Al agregar nuevas configuraciones:
1. Agregar tipo en `settings.types.ts`
2. Actualizar `useSettings.ts` con persistencia
3. Crear componente en `components/`
4. Agregar al `SettingsModal.tsx`

---

## 📚 Referencias

- [Socket.IO Client API](https://socket.io/docs/v4/client-api/)
- [React Hooks Best Practices](https://react.dev/reference/react)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)

---

**Última actualización:** Octubre 14, 2025
**Versión:** 2.0 (Refactorizada)
**Líneas de código:** ~200 (antes: 700+)
