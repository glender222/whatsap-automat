# Política de Seguridad — Whatsap-Automat

La seguridad y la privacidad de los datos empresariales son pilares fundamentales de la arquitectura de Whatsap-Automat. Esta política describe nuestras normas de seguridad, el procedimiento de divulgación responsable de vulnerabilidades y los mecanismos de protección del sistema.

---

## 1. Versiones Soportadas

Actualmente, el proyecto se encuentra en su fase de desarrollo activo bajo la especificación del **Blueprint v0.4**.

| Versión / Rama | Soporte Activo | Parches de Seguridad |
| :--- | :--- | :--- |
| `main` (v0.4 track) | :white_check_mark: Sí | :white_check_mark: Sí |
| Versiones pre-v0.4 | :x: No | :x: No |

---

## 2. Reporte Responsable de Vulnerabilidades

**NUNCA publiques detalles de una vulnerabilidad de seguridad en un Issue público de GitHub, pull request o canal de chat comunitario.**

Si has descubierto una vulnerabilidad potencial de seguridad en Whatsap-Automat:

1. **Vía GitHub Security Advisories (Recomendado):**  
   Dirígete a la pestaña de **Security** del repositorio en GitHub y selecciona **"Report a vulnerability"** para abrir un reporte privado.
2. **Vía Correo Electrónico:**  
   Envía los detalles a: `glender.vargasv@upeu.edu.pe` con el asunto `[SECURITY] Reporte de Vulnerabilidad en Whatsap-Automat`.

### Información a Incluir:
- Descripción detallada de la vulnerabilidad y vector de ataque.
- Pasos de reproducción detallados o prueba de concepto (PoC) mínima.
- Módulos afectados (Frontend, Backend, Webhooks, Base de datos).
- Impacto potencial estimado (ej. fuga de datos cross-tenant, escalada de privilegios, omisión de autenticación).
- Sugerencia de remediación si está disponible.

### Compromiso de Respuesta:
- **Confirmación inicial:** dentro de las 48 horas posteriores a la recepción del reporte.
- **Evaluación y remediación:** nos comprometemos a validar, clasificar y desarrollar un parche antes de la divulgación pública.

---

## 3. Política Estricta Sobre Secretos y Credenciales

- **Cero tolerancia a credenciales en repositorios:** Nunca confirmes (`git commit`), envíes en logs ni compartas en issues:
  - Tokens de acceso de WhatsApp Meta Cloud API (`META_WA_ACCESS_TOKEN`).
  - Secretos de aplicación de Meta (`META_APP_SECRET`).
  - Tokens de verificación de webhooks (`META_WEBHOOK_VERIFY_TOKEN`).
  - Secretos de firma JWT (`JWT_SECRET`).
  - Credenciales de base de datos (`DB_PASSWORD`).
  - Claves API de LLM (OpenAI, OpenCode u otros proveedores).
- Cualquier token o secreto expuesto en código o historial público debe considerarse **comprometido de inmediato** y revocado sin excepción.

---

## 4. Pilares de Seguridad del Sistema (Blueprint v0.4)

Whatsap-Automat implementa una estrategia de **defensa en profundidad**:

1. **Autenticación Fail-Closed:**  
   Todas las rutas operativas requieren JWT firmado válido con claim explícito de tenant (`company_id`). No se admiten accesos no autenticados con asignaciones silenciosas por defecto.
2. **Aislamiento Multi-tenant en Base de Datos (RLS):**  
   PostgreSQL Row-Level Security activado y forzado (`FORCE ROW LEVEL SECURITY`) en todas las tablas de negocio. Cada conexión ejecuta con el contexto del tenant autenticado (`TenantScopedUoW`).
3. **Salas de Socket.IO Segregadas:**  
   Las conexiones WebSocket requieren autenticación estricta durante el handshake. Las emisiones de eventos se limitan a salas scoped por tenant y conversación (`emitTenant`, `emitConversation`). Se prohíben difusiones globales (`io.emit`).
4. **Cifrado en Reposo de Credenciales:**  
   Las credenciales de canales y tokens de Meta se almacenan cifradas con claves simétricas gestionadas (`META_TOKEN_ENCRYPTION_KEY`).
5. **Policy Engine y Sandbox de Agentes IA:**  
   Las llamadas a herramientas de agentes IA clasificadas como de riesgo medio o alto requieren validación de políticas y aprobación explícita.

El catálogo de extensiones admite fichas y reseñas. La instalación queda deshabilitada hasta verificar la firma y los permisos de cada artefacto y aislar el acceso de su código a archivos y red.
