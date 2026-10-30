// EJEMPLOS DE USO - Sistema de Permisos
// ⚠️ ESTE ARCHIVO ES SOLO DOCUMENTACIÓN CON EJEMPLOS DE CÓDIGO
// No es código productivo, solo referencias para desarrolladores

/* eslint-disable */
// @ts-nocheck

// ============================================
// 1. IMPORTAR SERVICIOS
// ============================================

import { PermissionService } from '@/factures/mensajeria/services/permissionService';
import { getChats, sendMessage } from '@/factures/mensajeria/services/chatService';


// ============================================
// 2. ASIGNAR UN PERMISO
// ============================================

async function asignarAccesoAChat(employeeId: string, chatId: string) {
  try {
    const result = await PermissionService.assignPermission({
      employeeId,
      chatId
    });
    console.log('Permiso asignado:', result);
    // ✅ El empleado ahora puede ver y enviar mensajes en este chat
  } catch (error) {
    console.error('Error al asignar permiso:', error);
  }
}


// ============================================
// 3. REVOCAR UN PERMISO
// ============================================

async function quitarAccesoAChat(employeeId: string, chatId: string) {
  try {
    const result = await PermissionService.revokePermission({
      employeeId,
      chatId
    });
    console.log('Permiso revocado:', result);
    // ❌ El empleado ya no podrá ver ni enviar mensajes en este chat
  } catch (error) {
    console.error('Error al revocar permiso:', error);
  }
}


// ============================================
// 4. OBTENER PERMISOS DE UN EMPLEADO
// ============================================

async function verPermisosDeEmpleado(employeeId: string) {
  try {
    const permisos = await PermissionService.getEmployeePermissions(employeeId);
    
    console.log(`El empleado tiene acceso a ${permisos.length} chats:`);
    permisos.forEach(permiso => {
      console.log(`- Chat: ${permiso.chat?.name} (ID: ${permiso.chat_id})`);
    });
    
    return permisos;
  } catch (error) {
    console.error('Error al obtener permisos:', error);
    return [];
  }
}


// ============================================
// 5. OBTENER EMPLEADOS CON ACCESO A UN CHAT
// ============================================

async function verQuienTieneAccesoAlChat(chatId: string) {
  try {
    const permisos = await PermissionService.getChatPermissions(chatId);
    
    console.log(`${permisos.length} empleados tienen acceso a este chat:`);
    permisos.forEach(permiso => {
      console.log(`- ${permiso.employee?.nombre} (${permiso.employee?.email})`);
    });
    
    return permisos;
  } catch (error) {
    console.error('Error al obtener permisos del chat:', error);
    return [];
  }
}


// ============================================
// 6. VERIFICAR SI UN EMPLEADO TIENE PERMISO
// ============================================

async function verificarAcceso(employeeId: string, chatId: string) {
  try {
    const tieneAcceso = await PermissionService.hasPermission(employeeId, chatId);
    
    if (tieneAcceso) {
      console.log('✅ El empleado tiene acceso al chat');
    } else {
      console.log('❌ El empleado NO tiene acceso al chat');
    }
    
    return tieneAcceso;
  } catch (error) {
    console.error('Error al verificar permiso:', error);
    return false;
  }
}


// ============================================
// 7. ASIGNAR MÚLTIPLES PERMISOS A LA VEZ
// ============================================

async function asignarVariosChats(employeeId: string, chatIds: string[]) {
  try {
    await PermissionService.assignMultiplePermissions(employeeId, chatIds);
    console.log(`✅ ${chatIds.length} permisos asignados correctamente`);
  } catch (error) {
    console.error('Error al asignar múltiples permisos:', error);
  }
}

// Ejemplo de uso:
// asignarVariosChats('emp123', ['chat1', 'chat2', 'chat3']);


// ============================================
// 8. REVOCAR MÚLTIPLES PERMISOS A LA VEZ
// ============================================

async function quitarVariosChats(employeeId: string, chatIds: string[]) {
  try {
    await PermissionService.revokeMultiplePermissions(employeeId, chatIds);
    console.log(`❌ ${chatIds.length} permisos revocados correctamente`);
  } catch (error) {
    console.error('Error al revocar múltiples permisos:', error);
  }
}


// ============================================
// 9. OBTENER CHATS (CON FILTRADO AUTOMÁTICO)
// ============================================

async function obtenerMisChats() {
  try {
    const chats = await getChats();
    
    // Si eres ADMIN: recibirás TODOS los chats
    // Si eres EMPLEADO: solo recibirás los chats con permisos asignados
    
    console.log(`Tienes acceso a ${chats.length} chats`);
    return chats;
  } catch (error) {
    console.error('Error al obtener chats:', error);
    return [];
  }
}


// ============================================
// 10. ENVIAR MENSAJE (CON VALIDACIÓN DE PERMISOS)
// ============================================

async function enviarMensaje(chatId: string, mensaje: string) {
  try {
    await sendMessage(chatId, mensaje);
    console.log('✅ Mensaje enviado correctamente');
  } catch (error: any) {
    if (error.message.includes('No tienes permiso')) {
      console.error('❌ Sin permiso para enviar mensajes en este chat');
      alert('No tienes acceso a este chat');
    } else {
      console.error('Error al enviar mensaje:', error);
    }
  }
}


// ============================================
// 11. CASO DE USO COMPLETO: CONFIGURAR EMPLEADO NUEVO
// ============================================

async function configurarNuevoEmpleado(
  employeeId: string, 
  chatsParaAsignar: string[]
) {
  try {
    console.log('🔄 Configurando nuevo empleado...');
    
    // 1. Verificar permisos actuales
    const permisosActuales = await PermissionService.getEmployeePermissions(employeeId);
    console.log(`📊 Permisos actuales: ${permisosActuales.length}`);
    
    // 2. Asignar nuevos chats
    await PermissionService.assignMultiplePermissions(employeeId, chatsParaAsignar);
    console.log(`✅ ${chatsParaAsignar.length} chats asignados`);
    
    // 3. Verificar configuración final
    const permisosFinales = await PermissionService.getEmployeePermissions(employeeId);
    console.log(`✅ Configuración completada. Total de chats: ${permisosFinales.length}`);
    
    return permisosFinales;
  } catch (error) {
    console.error('❌ Error al configurar empleado:', error);
    throw error;
  }
}


// ============================================
// 12. CASO DE USO: TRANSFERIR PERMISOS ENTRE EMPLEADOS
// ============================================

async function transferirPermisos(
  empleadoSaliente: string,
  empleadoEntrante: string
) {
  try {
    console.log('🔄 Transfiriendo permisos...');
    
    // 1. Obtener permisos del empleado saliente
    const permisos = await PermissionService.getEmployeePermissions(empleadoSaliente);
    const chatIds = permisos.map(p => p.chat_id);
    
    console.log(`📦 ${chatIds.length} chats para transferir`);
    
    // 2. Asignar al empleado entrante
    await PermissionService.assignMultiplePermissions(empleadoEntrante, chatIds);
    
    // 3. Opcionalmente, revocar del empleado saliente
    // await PermissionService.revokeMultiplePermissions(empleadoSaliente, chatIds);
    
    console.log('✅ Transferencia completada');
  } catch (error) {
    console.error('❌ Error al transferir permisos:', error);
    throw error;
  }
}


// ============================================
// 13. CASO DE USO: AUDITORÍA DE PERMISOS
// ============================================

async function auditarPermisos() {
  try {
    console.log('🔍 Iniciando auditoría de permisos...');
    
    // Aquí necesitarías obtener la lista de todos los empleados
    // Por ejemplo, desde EmployeeService.getAll()
    
    const empleados = await EmployeeService.getAll();
    
    for (const empleado of empleados.data) {
      if (empleado.rol === 'EMPLEADO') {
        const permisos = await PermissionService.getEmployeePermissions(empleado.id);
        
        console.log(`
          📊 Empleado: ${empleado.nombre}
          📧 Email: ${empleado.email}
          💬 Chats asignados: ${permisos.length}
        `);
        
        if (permisos.length === 0) {
          console.warn(`⚠️ ${empleado.nombre} no tiene chats asignados`);
        }
      }
    }
    
    console.log('✅ Auditoría completada');
  } catch (error) {
    console.error('❌ Error en auditoría:', error);
  }
}


// ============================================
// 14. MANEJO DE ERRORES TÍPICOS
// ============================================

async function manejarErroresComunes() {
  try {
    // Intenta asignar un permiso
    await PermissionService.assignPermission({
      employeeId: 'emp123',
      chatId: 'chat456'
    });
  } catch (error: any) {
    // Errores típicos y cómo manejarlos
    
    if (error.response?.status === 401) {
      console.error('🔒 No autenticado - Token inválido o expirado');
      // Redirigir al login
    }
    
    if (error.response?.status === 403) {
      console.error('🚫 Sin permisos - Solo ADMIN puede gestionar permisos');
      // Mostrar mensaje de acceso denegado
    }
    
    if (error.response?.status === 404) {
      console.error('❓ Empleado o chat no encontrado');
      // Verificar que los IDs sean correctos
    }
    
    if (error.response?.status === 409) {
      console.error('⚠️ El permiso ya existe');
      // No hacer nada, ya está asignado
    }
    
    // Error genérico
    console.error('❌ Error desconocido:', error.message);
  }
}


// ============================================
// 15. HOOKS DE REACT (EJEMPLO)
// ============================================

import { useState, useEffect } from 'react';

function useEmployeePermissions(employeeId: string) {
  const [permissions, setPermissions] = useState<PermissionWithChat[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  useEffect(() => {
    async function loadPermissions() {
      try {
        setLoading(true);
        const permisos = await PermissionService.getEmployeePermissions(employeeId);
        setPermissions(permisos);
        setError(null);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    
    if (employeeId) {
      loadPermissions();
    }
  }, [employeeId]);
  
  const assignPermission = async (chatId: string) => {
    await PermissionService.assignPermission({ employeeId, chatId });
    // Recargar permisos
    const updated = await PermissionService.getEmployeePermissions(employeeId);
    setPermissions(updated);
  };
  
  const revokePermission = async (chatId: string) => {
    await PermissionService.revokePermission({ employeeId, chatId });
    // Recargar permisos
    const updated = await PermissionService.getEmployeePermissions(employeeId);
    setPermissions(updated);
  };
  
  return {
    permissions,
    loading,
    error,
    assignPermission,
    revokePermission
  };
}

// Uso del hook:
// const { permissions, loading, assignPermission } = useEmployeePermissions('emp123');


// ============================================
// 16. CONSTANTES ÚTILES
// ============================================

export const ROLES = {
  ADMIN: 'ADMIN',
  EMPLEADO: 'EMPLEADO'
} as const;

export const PERMISSION_ERRORS = {
  NOT_AUTHENTICATED: 'Usuario no autenticado',
  NOT_AUTHORIZED: 'Solo administradores pueden gestionar permisos',
  EMPLOYEE_NOT_FOUND: 'Empleado no encontrado',
  CHAT_NOT_FOUND: 'Chat no encontrado',
  PERMISSION_EXISTS: 'El permiso ya existe',
  PERMISSION_NOT_FOUND: 'Permiso no encontrado'
} as const;


// ============================================
// 📚 REFERENCIAS RÁPIDAS
// ============================================

/*
  ENDPOINTS DEL BACKEND:
  ----------------------
  POST   /api/permissions/assign
  POST   /api/permissions/revoke
  GET    /api/permissions/employee/:employeeId
  GET    /api/permissions/chat/:chatId
  GET    /api/chats (filtrado automático por rol)
  
  TIPOS DISPONIBLES:
  -----------------
  - ChatPermission
  - PermissionWithChat
  - PermissionWithEmployee
  - AssignPermissionRequest
  - RevokePermissionRequest
  - PermissionResponse
  
  SERVICIOS:
  ----------
  - PermissionService (gestión de permisos)
  - getChats() (obtener chats filtrados)
  - sendMessage() (enviar con validación)
  
  PÁGINAS:
  --------
  - /gestion-web/permisos (gestión de permisos)
  - /gestion-web/inicio (ver chats)
  - /gestion-web/administrar-estaciones (gestionar empleados)
*/
