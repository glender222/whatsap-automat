---
version: "1.0.0"
name: "WhatsApp Ops para Pymes"
description: "Sistema de diseño visual para un SaaS operativo inteligente donde WhatsApp es el canal principal para atención, ventas, inventario e IA asistiva controlada."
colors:
  background: "#F7FAF8"
  surface: "#FFFFFF"
  surface_muted: "#EEF4F1"
  text: "#10231C"
  text_muted: "#5B6F66"
  primary: "#128C7E"
  primary_hover: "#0E766A"
  primary_soft: "#DDF4EF"
  accent: "#25D366"
  accent_soft: "#E4FBEF"
  warning: "#F59E0B"
  danger: "#DC2626"
  success: "#16A34A"
  info: "#2563EB"
  border: "#D9E5DF"
typography:
  font_family: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
  heading_weight: 700
  body_weight: 400
  label_weight: 600
  scale:
    xs: "12px"
    sm: "14px"
    base: "16px"
    lg: "18px"
    xl: "24px"
    xxl: "32px"
rounded:
  sm: "6px"
  md: "10px"
  lg: "16px"
  xl: "24px"
  full: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  xxl: "32px"
components:
  button: "Acciones claras, estados visibles y énfasis en la acción primaria."
  card: "Superficies limpias para resumir operación, ventas, inventario y conversaciones."
  conversation_list: "Bandeja priorizada con estado, canal, asignación, etiquetas y urgencia."
  message_bubble: "Mensajes humanos, de cliente y asistidos por IA diferenciados visualmente."
  inventory_badge: "Indicadores de stock disponible, bajo, reservado o agotado."
  ai_suggestion: "Sugerencias revisables, trazables y nunca confundidas con acciones ya ejecutadas."
---

# DESIGN.md

## Overview

Este sistema visual guía una interfaz SaaS para pymes que operan atención, ventas e inventario desde WhatsApp. La experiencia debe sentirse confiable, rápida y humana: una bandeja conversacional ordenada, conectada a datos reales del negocio y apoyada por IA asistiva bajo control del equipo.

La interfaz no debe parecer un chatbot genérico ni un panel corporativo pesado. Debe comunicar operación diaria: conversaciones entrantes, oportunidades de venta, stock, pedidos, derivaciones humanas y recomendaciones inteligentes claramente revisables.

## Colors

- **Primary `#128C7E`**: acciones principales, navegación activa y elementos relacionados con WhatsApp operativo.
- **Accent `#25D366`**: confirmaciones positivas, disponibilidad y momentos de avance comercial.
- **Background `#F7FAF8`**: base clara, cálida y de baja fatiga para trabajo prolongado.
- **Surface `#FFFFFF` / `#EEF4F1`**: tarjetas, bandejas, paneles laterales y áreas de detalle.
- **Warning `#F59E0B`**: stock bajo, conversación pendiente o acción que requiere revisión.
- **Danger `#DC2626`**: errores, agotado, riesgo operativo o acción destructiva.
- **Info `#2563EB`**: datos informativos, insights y contexto no crítico.

## Typography

Usar una tipografía sans-serif moderna y legible. Los títulos deben ayudar a escanear prioridades; el cuerpo debe favorecer lectura rápida de mensajes, productos y estados.

- Títulos: peso 700, alto contraste, sin exceso decorativo.
- Texto base: 16px para lectura cómoda.
- Labels y badges: 12–14px, peso 600, siempre claros.
- Evitar bloques densos: dividir información operativa en tarjetas, filas y estados visibles.

## Layout

La estructura recomendada es una aplicación de trabajo diario:

1. **Sidebar** para módulos: Bandeja, Contactos, Catálogo, Inventario, Pedidos, Automatizaciones, IA y Configuración.
2. **Bandeja conversacional** con lista filtrable por prioridad, asignado, estado, etiqueta y canal.
3. **Panel de conversación** con historial, composer, notas internas y estado de atención.
4. **Panel contextual** con cliente, inventario relacionado, pedidos, sugerencias IA y acciones rápidas.

Priorizar jerarquía, escaneo y velocidad. La UI debe mostrar qué requiere atención ahora, qué puede esperar y qué fue sugerido por IA.

## Elevation & Depth

Usar profundidad de forma funcional, no decorativa.

- Superficies base: sin sombra o sombra mínima.
- Cards operativas: borde suave `#D9E5DF` y sombra ligera.
- Modales y drawers: mayor elevación para revisión, confirmación o configuración.
- Estados críticos: contraste por color y contenido, no solo sombra.

## Shapes

Las formas deben transmitir cercanía y orden.

- Botones y campos: radio medio `10px`.
- Cards y paneles: radio amplio `16px`.
- Avatares, contadores y estados compactos: radio completo.
- Burbujas de mensaje: redondeadas, diferenciando cliente, equipo e IA asistiva.

## Components

- **Buttons**: una acción primaria por zona. Secundarias neutrales y destructivas siempre explícitas.
- **Conversation List**: mostrar cliente, último mensaje, tiempo, asignado, estado, etiquetas y alerta de IA o stock cuando aplique.
- **Message Bubbles**: separar mensajes del cliente, agentes humanos, sistema e IA. Las sugerencias IA no deben verse como enviadas.
- **Inventory Badges**: usar estados consistentes: disponible, bajo stock, reservado, agotado.
- **AI Suggestion Cards**: incluir motivo, confianza visual simple, fuente de datos y acción: editar, enviar, descartar o derivar.
- **Operational Cards**: resumir ventas, pedidos pendientes, conversaciones vencidas y productos con riesgo de quiebre.
- **Forms**: pensados para velocidad; autocompletar productos, clientes y variantes cuando sea posible.

## Do's and Don'ts

### Do's

- Diseñar para operadores de pymes que necesitan responder rápido y vender sin perder control.
- Mostrar siempre el estado de una conversación: pendiente, asignada, resuelta, escalada o automatizada.
- Diferenciar claramente datos reales del negocio, sugerencias IA y acciones humanas.
- Usar lenguaje simple: stock, pedido, cliente, responder, derivar, confirmar.
- Hacer visible cuándo una recomendación depende de inventario, catálogo o historial.

### Don'ts

- No convertir la interfaz en una consola técnica o backend administrativo.
- No ocultar la intervención de IA ni hacer que parezca una acción ya aprobada.
- No saturar con gráficos si la operación necesita primero priorización y respuesta.
- No usar colores de alerta para información normal.
- No diseñar flujos que obliguen a salir de la conversación para consultar stock o pedido básico.
