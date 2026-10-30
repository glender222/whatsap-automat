# UI Design Rules

## Documento Fuente

La guia visual viva esta en `docs/DESIGN.md`. Esta rule convierte esa guia en obligaciones para cualquier cambio de UI.

## Estilo Del Producto

- Priorizar una interfaz operativa, clara y escaneable para uso repetido.
- Evitar que pantallas internas parezcan landing pages.
- Usar jerarquia visual sobria: titulos compactos, secciones claras, acciones visibles y tablas/listas faciles de leer.
- Mantener tarjetas con radio moderado; no anidar cards dentro de cards.
- Usar iconos de `lucide-react` en botones de herramientas cuando exista un icono adecuado.

## Layout

- Las vistas principales deben adaptarse a desktop y mobile sin solapamientos.
- Controles, botones y etiquetas no deben romperse ni cortar texto critico.
- Sidebars, bandejas de chat y paneles de detalle deben tener dimensiones estables para evitar saltos visuales.
- En pantallas de mensajeria, priorizar densidad, lectura rapida, estados claros y acciones cercanas al contexto.

## Tailwind Y CSS

- Preferir Tailwind en componentes.
- Usar CSS global solo para tokens, animaciones o utilidades realmente compartidas.
- No crear una paleta de un solo color; combinar neutros, estados semanticos y acentos de forma controlada.
- Evitar gradientes decorativos excesivos en superficies operativas.

## Estados

- Toda UI asincrona debe contemplar loading, empty, error y success cuando aplique.
- Los errores deben ser accionables para usuarios administradores.
- Los estados de WhatsApp Meta no deben mostrar QR; los estados WebJS legacy pueden mostrar QR si el backend lo envia.
