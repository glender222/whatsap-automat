# WhatsApp Service - Arquitectura Modular

## 📁 Estructura de Componentes

El servicio de WhatsApp ha sido refactorizado de un archivo monolítico de 774 líneas a una arquitectura modular con responsabilidades separadas.

```
src/services/
├── whatsappService.ts              # Fachada principal
└── whatsapp/
    ├── WhatsAppClient.js           # Cliente principal (~180 líneas)
    ├── ChatManager.js              # Gestión de chats (~240 líneas)
    ├── MessageHandler.js           # Manejo de mensajes (~145 líneas)
    ├── MediaHandler.js             # Gestión multimedia (~60 líneas)
    ├── EventHandler.js             # Eventos de WhatsApp (~145 líneas)
    └── ChatValidator.js            # Validación de chats (~90 líneas)
```

## 🎯 Responsabilidades de Cada Componente

### 1. **whatsappService.ts** (Facade)
- **Responsabilidad**: Punto de entrada único que delega a los componentes especializados
- **Líneas**: ~85
- **Métodos principales**:
  - Gestión de conexión (initialize, logout, destroy)
  - Delegación a componentes (getChats, sendMessage, downloadMedia)

### 2. **WhatsAppClient.js** (Core)
- **Responsabilidad**: Gestión del cliente de WhatsApp y coordinación de componentes
- **Líneas**: ~180
- **Funciones clave**:
  - Inicializar cliente con timeout
  - Coordinar componentes (EventHandler, ChatManager, MessageHandler, MediaHandler)
  - Gestionar estado de conexión
  - Limpiar datos locales

### 3. **EventHandler.js**
- **Responsabilidad**: Manejo de eventos del cliente WhatsApp
- **Líneas**: ~145
- **Eventos gestionados**:
  - `qr`: Generar y emitir código QR
  - `ready`: Iniciar carga de chats y polling
  - `disconnected`: Limpiar estado
  - `auth_failure`: Manejar errores de autenticación
  - `state_changed`: Notificar cambios de estado
  - `message`: Procesar mensajes entrantes

### 4. **ChatManager.js**
- **Responsabilidad**: Gestión completa de la lista de chats
- **Líneas**: ~240
- **Funciones principales**:
  - `loadChats()`: Carga progresiva en lotes (50 iniciales + 20 progresivos)
  - `processChatForList()`: Procesar chat individual para la lista
  - `updateChatInList()`: Actualizar chat existente
  - `refreshRecentChats()`: Polling para detectar actividad remota

### 5. **MessageHandler.js**
- **Responsabilidad**: Envío, recepción y formateo de mensajes
- **Líneas**: ~145
- **Funciones principales**:
  - `formatMessage()`: Formatear mensajes para el frontend
  - `getChatMessages()`: Obtener historial de mensajes
  - `sendMessage()`: Enviar texto o multimedia con fallback
  - `markAsRead()`: Marcar mensajes como leídos

### 6. **MediaHandler.js**
- **Responsabilidad**: Gestión de archivos multimedia
- **Líneas**: ~60
- **Funciones principales**:
  - `downloadMedia()`: Descargar archivos de mensajes
  - `getProfilePhoto()`: Obtener y cachear fotos de perfil

### 7. **ChatValidator.js**
- **Responsabilidad**: Validación y filtrado de chats/mensajes
- **Líneas**: ~90
- **Funciones principales**:
  - `isValidChat()`: Filtrar status, newsletters, canales
  - `isRealMessage()`: Detectar mensajes reales vs eventos de sistema
  - `sortChats()`: Ordenar chats por actividad (no leídos primero)

## 🔄 Flujo de Datos

```
API Request
    ↓
whatsappService.ts (Facade)
    ↓
WhatsAppClient.js (Coordinator)
    ↓
┌─────────────┬──────────────┬──────────────┬─────────────┐
│EventHandler │ChatManager   │MessageHandler│MediaHandler │
└─────────────┴──────────────┴──────────────┴─────────────┘
    ↓               ↓              ↓              ↓
ChatValidator.js (Utilities)
```

## ✅ Ventajas de la Nueva Arquitectura

1. **Mantenibilidad**: Cada archivo tiene un propósito claro y < 250 líneas
2. **Testabilidad**: Componentes independientes fáciles de probar
3. **Escalabilidad**: Fácil agregar nuevas funcionalidades sin afectar otros componentes
4. **Legibilidad**: Código más organizado y fácil de entender
5. **Separación de responsabilidades**: Cada clase tiene un único objetivo (Single Responsibility Principle)

## 🚀 Uso

El uso desde otros módulos **no cambia**, el facade mantiene la misma interfaz:

```javascript
import WhatsAppService from './services/whatsappService';
const service = new WhatsAppService();

// Mismo uso que antes
await service.initialize();
const chats = service.getChats();
await service.sendMessage(chatId, "Hola");
```

## 🔧 Agregar Nueva Funcionalidad

### Ejemplo: Agregar función para buscar mensajes

1. **Agregar método en MessageHandler.js**:
```javascript
async searchMessages(chatId, query) {
  // Lógica de búsqueda
}
```

2. **Exponer en whatsappService.ts**:
```javascript
async searchMessages(chatId, query) {
  return await this.whatsappClient.messageHandler.searchMessages(chatId, query);
}
```

## 📊 Comparación

| Aspecto | Antes | Después |
|---------|-------|---------|
| Archivo único | 774 líneas | 85 líneas (facade) |
| Componentes | 1 clase | 7 componentes |
| Mayor archivo | 774 líneas | 240 líneas |
| Responsabilidades | Mixtas | Separadas |
| Testabilidad | Difícil | Fácil |

## 🎨 Patrón de Diseño

Esta refactorización implementa varios patrones:

- **Facade Pattern**: `whatsappService.ts` simplifica el acceso a subsistemas
- **Single Responsibility**: Cada clase tiene una única responsabilidad
- **Dependency Injection**: Componentes reciben referencia al WhatsAppClient
- **Strategy Pattern**: Validadores pueden intercambiarse fácilmente
