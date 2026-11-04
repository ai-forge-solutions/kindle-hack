# Subrayados

Extensión de Chrome que manda tus subrayados de Kindle a Notion, sola, una vez al día.

En Notion se crea una base de datos **«Libros de Kindle»** con una fila por libro (título, autor, portada, nº de subrayados, fecha de los últimos subrayados y enlace para abrirlo). Dentro de cada libro están sus subrayados como citas, **en el orden en que aparecen en el libro**, con su posición y tu nota del Kindle si la tiene. El orden de los libros lo eliges con las vistas de la base de datos.

## Instalación

### 1. Notion

1. Entra en [notion.so/profile/integrations](https://www.notion.so/profile/integrations) y crea una **integración interna**. Copia su **clave secreta** (empieza por `ntn_` o `secret_`).
2. Abre la página de Notion donde quieres los libros. En el menú **··· → Conexiones**, añade tu integración.
3. Copia el enlace de esa página (**Compartir → Copiar enlace**).

### 2. Chrome

1. Descarga este repo (o `git clone`).
2. Abre `chrome://extensions` y activa **Modo de desarrollador**.
3. Pulsa **Cargar descomprimida** y elige la carpeta `extension/`.
4. Abre la extensión, pega la clave y el enlace, y pulsa **Conectar**.
5. Si tu Kindle es de otra tienda de Amazon, elígela en el popup.
6. Si no tenías sesión abierta en el [Notebook de Kindle](https://read.amazon.com/notebook), ábrelo, entra y pulsa **Sincronizar ahora**.

La primera sincronización tarda unos minutos, porque Notion solo admite unas 3 peticiones por segundo. Después solo se envía lo nuevo.

## Cómo funciona

Igual que la sincronización de Readwise:

- La extensión lee el Notebook de Kindle (`read.amazon.*/notebook`) con la sesión de Amazon que ya tienes abierta en Chrome. **No guarda tu contraseña ni copia tus cookies a ningún sitio.** Solo tiene permiso para `read.amazon.*` y para la API de Notion.
- Cada hora comprueba si han pasado 20 h desde la última sincronización. Basta con abrir Chrome de vez en cuando.
- Solo relee los libros con subrayados nuevos. **Revisar todo** fuerza una revisión completa, pero nunca duplica nada.
- Los subrayados nuevos se **insertan en su sitio**, según su posición en el libro, no al final.
- Si se cierra tu sesión de Amazon, el icono muestra un `!`. Abre el Notebook, entra y sincroniza sola.
- No hay servidor ni base de datos propia. La extensión solo guarda en Chrome un registro mínimo de qué subrayado corresponde a qué bloque de Notion, para no repetir.

Lo que no hace (todavía):

- **Capítulos.** El Notebook de Kindle no dice a qué capítulo pertenece cada subrayado. Está pendiente probar si se puede sacar el índice del lector web de Kindle.
- **Cambios posteriores.** Si editas en el Kindle la nota de un subrayado que ya está en Notion, no se actualiza. Lo que edites en Notion nunca se pisa.
- **Libros borrados.** Si borras un libro en Notion, vuelve a aparecer en la siguiente sincronización que lo revise.
- **Libros que no son de Amazon.** No están en el Notebook. Para PDFs y EPUBs enviados al Kindle, usa **Importar My Clippings.txt** en el popup: los libros que ya estén en Notion solo reciben lo que falte.
- **Límite de la editorial.** Amazon puede limitar lo que muestra el Notebook en algunos libros.

Si Amazon cambia la página del Notebook, se arregla en `extension/notebook-parser.js`. Cuando no encuentra libros, el popup ofrece **Copiar diagnóstico**, que solo cuenta selectores y no incluye ningún texto tuyo.

## Estructura

| Archivo | Qué hace |
|---|---|
| `extension/background.js` | Programa la sincronización diaria y coordina Amazon → Notion. |
| `extension/notebook-parser.js` | Lee el HTML del Notebook de Kindle. |
| `extension/notion.js` | Crea la base de datos y las páginas, e inserta los subrayados en orden. |
| `extension/clippings.js` | Lee `My Clippings.txt`. |
| `extension/popup.*`, `extension/import.*` | Interfaz. |
| `supabase-version/` | Versión anterior con base de datos en Supabase y web de repaso diario. No se usa; se guarda por si queremos recuperar el repaso. |
