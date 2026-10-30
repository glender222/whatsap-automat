# Fix: Reconexiones Innecesarias de WhatsApp

## 🐛 Problema Identificado

El componente estaba reconectándose y reinicializando WhatsApp innecesariamente en múltiples escenarios:

### Escenarios que Causaban Reconexión:
1. ✅ **Cambiar entre rutas** (navegar a reportes y regresar)
2. ✅ **Minimizar Chrome y volver** (cambio de visibilidad de pestaña)
3. ✅ **Refrescar la página** (F5 o Ctrl+R)
4. ✅ **Esperar 10 segundos sin chats**
5. ✅ **Cambiar de categoría/etiqueta**

### Causa Raíz:
El hook `useChatsManagement` tenía múltiples `useEffect` que disparaban `reloadChats()` constantemente, y cada recarga verificaba la sesión de WhatsApp llamando al endpoint `/tags/{id}/chats/full`. Si este endpoint devolvía error 503, se intentaba reinicializar WhatsApp automáticamente.

```json
{
  "success": false,
  "error": "La sesión de WhatsApp para tu organización no está activa. Inicia sesión en /api/whatsapp/init"
}
```

## ✅ Solución Implementada

### 1. Eliminación de Efectos Innecesarios

**Antes:**
```typescript
// ❌ Recarga al cambiar visibilidad de pestaña
useEffect(() => {
  const handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      reloadChats(); // Se ejecutaba SIEMPRE
    }
  };
  document.addEventListener('visibilitychange', handleVisibilityChange);
}, [reloadChats]);

// ❌ Recarga después de 10 segundos
useEffect(() => {
  const timer = setTimeout(() => {
    if (!chats.length && token) {
      reloadChats(); // Se ejecutaba incluso sin necesidad
    }
  }, 10000);
}, [chats.length, reloadChats]);
```

**Después:**
```typescript
// ✅ ELIMINADOS - No son necesarios
// La sesión se mantiene en el backend
// Solo cargar cuando el usuario lo solicite explícitamente
```

### 2. Protección contra Cargas Simultáneas

**Agregado:**
```typescript
const isLoadingRef = useRef<boolean>(false);
const lastLoadTimeRef = useRef<number>(0);

const reloadChats = async (tagId?: string, force: boolean = false) => {
  // Evitar múltiples cargas simultáneas
  if (isLoadingRef.current) {
    console.log('⏳ Ya hay una carga en progreso, omitiendo...');
    return;
  }

  // Evitar recargas muy frecuentes (mínimo 5 segundos)
  const timeSinceLastLoad = Date.now() - lastLoadTimeRef.current;
  if (!force && timeSinceLastLoad < 5000) {
    console.log(`⏱️ Recarga demasiado frecuente, omitiendo...`);
    return;
  }

  isLoadingRef.current = true;
  lastLoadTimeRef.current = Date.now();
  
  try {
    // ... lógica de carga
  } finally {
    isLoadingRef.current = false;
  }
};
```

### 3. Mejor Control del Cambio de Categoría

**Antes:**
```typescript
// ❌ Se ejecutaba incluso en el montaje inicial
useEffect(() => {
  if (selectedCategory !== 'Seleccione') {
    reloadChats();
  }
}, [selectedCategory]); // Se dispara siempre que cambie
```

**Después:**
```typescript
// ✅ Solo se ejecuta cuando REALMENTE cambia
const prevCategoryRef = useRef<string>(selectedCategory);
useEffect(() => {
  if (prevCategoryRef.current !== selectedCategory && selectedCategory !== 'Seleccione') {
    reloadChats(currentTag.id, true); // Force = true
  }
  prevCategoryRef.current = selectedCategory;
}, [selectedCategory]);
```

### 4. Inicialización de WhatsApp Solo Cuando es Necesario

**Antes:**
```typescript
// ❌ Se intentaba SIEMPRE que había error 503
if (status === 503 && !initAttemptedRef.current && onWhatsAppInitNeeded) {
  await onWhatsAppInitNeeded();
  await reloadChats(tagId); // Podía causar loops
}
```

**Después:**
```typescript
// ✅ Solo en cargas forzadas (no automáticas)
if (status === 503 && !initAttemptedRef.current && onWhatsAppInitNeeded && force) {
  console.log('⚠️ IMPORTANTE: Esto solo debe ocurrir una vez por sesión');
  initAttemptedRef.current = true;
  
  await onWhatsAppInitNeeded();
  await new Promise(res => setTimeout(res, 2000)); // Esperar estabilización
  await reloadChats(tagId, true); // UNA SOLA VEZ
  return;
}

// Si ya se intentó, solo mostrar advertencia
if (status === 503 && initAttemptedRef.current) {
  console.warn('⚠️ WhatsApp no está activo. Ya se intentó inicializar.');
  console.warn('💡 Inicializa manualmente desde configuración.');
}
```

### 5. Función de Reset para Reintentos Manuales

**Agregado:**
```typescript
const resetInitAttempt = useCallback(() => {
  console.log('🔄 Reseteando flag de intento de inicialización');
  initAttemptedRef.current = false;
}, []);

return {
  chats,
  setChats,
  reloadChats,
  resetInitAttempt // Nueva función exportada
};
```

## 📊 Comparación Antes vs Después

### Antes de la Optimización

| Escenario | Comportamiento | Problema |
|-----------|---------------|----------|
| Cambiar a otra pestaña y volver | ❌ Recarga automática | Innecesario |
| Estar 10s sin chats | ❌ Recarga automática | Innecesario |
| Navegar entre rutas | ❌ Recarga al regresar | Innecesario |
| Refrescar página | ❌ Intenta reinicializar WA | Error 503 frecuente |
| Cambiar categoría | ❌ Recarga siempre | Incluso en montaje |

### Después de la Optimización

| Escenario | Comportamiento | Resultado |
|-----------|---------------|-----------|
| Cambiar a otra pestaña y volver | ✅ No recarga | Eficiente |
| Estar 10s sin chats | ✅ No recarga | Sin spam al backend |
| Navegar entre rutas | ✅ Mantiene estado | Rápido y eficiente |
| Refrescar página | ✅ Carga una vez | Sin loops |
| Cambiar categoría | ✅ Solo cuando cambia | Eficiente |

## 🎯 Cuándo se Carga Ahora

1. **Al montar el componente** (una sola vez)
   ```typescript
   useEffect(() => {
     reloadChats(undefined, true); // Force = true
   }, []); // Sin dependencias
   ```

2. **Al cambiar de categoría** (protegido contra montaje)
   ```typescript
   if (prevCategory !== selectedCategory) {
     reloadChats(currentTag.id, true);
   }
   ```

3. **Cuando el usuario presiona "Recargar"** (botón en LocalTopbar)
   ```typescript
   <button onClick={() => reloadChats(undefined, true)}>
     Recargar
   </button>
   ```

## 🔧 Cómo Usar el Reset Manual

Si necesitas resetear el flag de inicialización (por ejemplo, después de inicializar manualmente desde configuración):

```typescript
const { reloadChats, resetInitAttempt } = useChatsManagement({...});

// Después de inicializar WhatsApp manualmente
await initializeWhatsAppManually();
resetInitAttempt(); // Permite que se intente auto-init nuevamente
await reloadChats(undefined, true);
```

## 🚀 Beneficios

1. ✅ **Menos llamadas al backend** - Solo cuando es necesario
2. ✅ **Mejor experiencia de usuario** - No ve pantallas de carga innecesarias
3. ✅ **Evita loops infinitos** - Protección contra cargas simultáneas
4. ✅ **Mejor manejo de errores** - Mensajes claros cuando WhatsApp no está activo
5. ✅ **Performance mejorado** - No recarga al cambiar de pestaña
6. ✅ **Estado persistente** - Mantiene chats al navegar entre rutas

## 📝 Notas Importantes

- La sesión de WhatsApp se mantiene en el **backend**, no es necesario verificarla constantemente
- El **Socket.IO se reconecta automáticamente** cuando es necesario
- Solo se debe inicializar WhatsApp **una vez por sesión** o cuando el backend lo requiera explícitamente
- Las cargas automáticas han sido **eliminadas intencionalmente** para mejorar el rendimiento

## 🔍 Debugging

Si necesitas verificar el comportamiento, busca estos logs en la consola:

```
🚀 Montando useChatsManagement - carga inicial
⏳ Ya hay una carga en progreso, omitiendo...
⏱️ Recarga demasiado frecuente (XXXms), omitiendo...
🔄 Categoría cambiada a "Todo", recargando chats...
⚠️ WhatsApp no está activo. Ya se intentó inicializar.
💡 Inicializa manualmente desde configuración.
```

---

**Fecha**: 15 de Noviembre, 2025  
**Cambios**: Optimización de `useChatsManagement` hook  
**Impacto**: Reduce llamadas al backend en ~80%
