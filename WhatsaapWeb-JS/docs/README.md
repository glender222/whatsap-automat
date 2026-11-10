# Documentación Del Backend WhatsApp

Este directorio concentra la memoria técnica y de sprint del backend `WhatsaapWeb-JS`.

## Documentos Permanentes

Estos archivos deben mantenerse vivos durante todo el proyecto:

- `architecture.md`: arquitectura general del backend, capas, módulos, integraciones y decisiones base.
- `current-state.md`: estado actual del proyecto, sprint activo, sprint cerrado más reciente y foco inmediato.
- `specs/catalogo-comercial-inventario.md`: especificación del catálogo comercial operable por IA para productos, servicios, cursos, suscripciones y ofertas vendibles.

## Mercado Pago

- [Intenciones, despacho y conciliación](payment-checkout-intents.md) explica los estados y las pruebas de PostgreSQL.
- [Ruta administrativa y configuración](payment-checkout-reconciliation-runtime.md) describe los permisos, las credenciales y el despliegue.

## Documentos De Sprint

Estos archivos describen el cierre o planificación de cada sprint:

- `sprints/sprint-4-cierre.md`: evidencia de cierre del Sprint 4 según el Excel de entregables.
- `uml/sprint-4/README.md`: modelado UML general del Sprint 4, con componentes, casos de uso, dominio y secuencia de recepción de mensajes.
- `sprints/sprint-5-plan.md`: alcance, historias y desglose inicial del Sprint 5.
- `sprints/sprint-5-desglose-por-hoja.md`: desglose del Sprint 5 hoja por hoja desde el Excel.

## Fuente Actual

La planificación inicial de Sprint 4 y Sprint 5 se tomó de:

- `C:\Users\Glend\Downloads\Entregables principales(3).xlsx`

Hojas usadas:

- `Sprint Backlog`: evidencia de trabajo del Sprint 4.
- `Sprint gool`: objetivo del Sprint 4.
- `product backlog`: historias marcadas con `SPRINT = 5`.
- `sprints`: desglose operativo de tareas por historia.
- `requerimientos no funcionales`: restricciones de rendimiento, seguridad, usabilidad y mantenibilidad aplicables al Sprint 5.

## Convención

- La documentación de arquitectura y estado vive en `docs/`.
- Las reglas de trabajo de Codex viven en `.codex/rules/`.
- Las skills externas o locales viven en `.codex/skills/`.
- `AGENTS.md` funciona como índice principal para que Codex encuentre reglas, skills y documentación.
