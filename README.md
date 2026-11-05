# Subrayados

Extensión de Chrome que manda tus subrayados de Kindle a Notion, sola, una vez al día.

En Notion se crea una base de datos **«Libros de Kindle»** con una fila por libro (título, autor, portada, nº de subrayados, fecha de los últimos subrayados y enlace para abrirlo). Dentro de cada libro están sus subrayados como citas, **en el orden en que aparecen en el libro**, con su posición y tu nota si la tiene. Si el libro viene de una exportación de la app de Kindle, los subrayados se agrupan **por capítulo**, cada uno en un encabezado desplegable. El orden de los libros lo eliges con las vistas de la base de datos. El título y el autor solo se ponen al crear el libro: si los cambias en Notion, se respetan.

Hay dos formas de que lleguen los subrayados:

| | Libros comprados en Amazon | Documentos tuyos (PDF, EPUB enviados al Kindle) |
|---|---|---|
| Cómo | Automático, cada día, desde el Notebook de Kindle | Exportas el cuaderno desde la app de Kindle del móvil (.html) y lo sueltas en **Importar** |
| Capítulos | No (el Notebook no los da) | Sí |

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

## Exportaciones desde el iPhone, por correo

La app de Kindle del iPhone solo deja exportar el cuaderno de un libro por email. Un script de Google Apps Script, que corre en tu propia cuenta de Google, revisa tu Gmail cada 10 minutos y manda a Notion las exportaciones que te envíes a **`tuusuario+kindle@gmail.com`**, con capítulos y sin duplicar. Comprueba lo que ya hay leyendo Notion, así que no choca con la extensión.

### Instalación (una vez, unos 10 minutos)

1. Entra en [script.google.com](https://script.google.com) con tu cuenta de Gmail → **Nuevo proyecto**. Ponle de nombre «Subrayados».
2. Borra lo que haya en `Código.gs` y pega el contenido de [`apps-script/Code.gs`](apps-script/Code.gs) (también está en tu web de Netlify, en `/apps-script.txt`). Guarda con Cmd+S.
3. Abre **Configuración del proyecto** (rueda dentada) → **Propiedades del script** → añade:
   - `NOTION_TOKEN`: la clave de la integración de Notion (la misma de la extensión).
   - `NOTION_PAGE`: el enlace de la página de Notion donde está «Libros de Kindle».
4. Vuelve al editor, elige la función **`configurar`** en el desplegable de arriba y pulsa **Ejecutar**.
5. Google pedirá permisos. Como el script es tuyo y no está publicado, avisa de que «Google no ha verificado esta aplicación»: pulsa **Configuración avanzada → Ir a Subrayados** y acepta. Pide leer y etiquetar tu Gmail y conectarse a Notion.
6. En el registro de ejecución debería salir «Listo. Manda las exportaciones de Kindle a …+kindle@gmail.com».

### Uso

En la app de Kindle del iPhone: libro → cuaderno → **Exportar cuaderno** → correo, y envíalo a `tuusuario+kindle@gmail.com`. Tiene que salir **desde tu cuenta de Gmail**: por seguridad, el script solo procesa correos tuyos. En menos de 10 minutos aparece en Notion. Guárdate la dirección como contacto, por ejemplo «Kindle → Notion».

- Los correos procesados quedan con la etiqueta **Subrayados/Importado**, y los que fallan con **Subrayados/Error**. Para reintentar los fallidos, ejecuta `reintentarErrores`.
- Puedes volver a exportar un libro cuando quieras: solo se añade lo nuevo.
- El registro de cada vuelta está en **Ejecuciones**, en el menú de la izquierda del editor.

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
- **Libros que no son de Amazon.** No están en el Notebook. Para PDFs y EPUBs enviados al Kindle, exporta el cuaderno desde la app de Kindle del móvil y usa **Importar** en el popup (acepta varios .html a la vez, y también `My Clippings.txt` en los Kindle que lo tienen). Volver a importar un libro solo añade lo nuevo, cada subrayado en su capítulo.
- **Subrayados nuevos al principio de un capítulo.** Si un libro ya importado recibe un subrayado anterior al primero que había en ese capítulo, se añade al final del capítulo: la API de Notion no permite insertar al principio de un desplegable.
- **Límite de la editorial.** Amazon puede limitar lo que muestra el Notebook en algunos libros.

Si Amazon cambia la página del Notebook, se arregla en `extension/notebook-parser.js`. Cuando no encuentra libros, el popup ofrece **Copiar diagnóstico**, que solo cuenta selectores y no incluye ningún texto tuyo.

## Estructura

| Archivo | Qué hace |
|---|---|
| `extension/background.js` | Programa la sincronización diaria y coordina Amazon → Notion. |
| `extension/notebook-parser.js` | Lee el HTML del Notebook de Kindle. |
| `extension/notion.js` | Crea la base de datos y las páginas, e inserta los subrayados en orden. |
| `extension/kindle-export.js` | Lee el HTML de «Exportar cuaderno» de la app de Kindle (capítulos, subrayados y notas). |
| `extension/clippings.js` | Lee `My Clippings.txt`. |
| `extension/popup.*`, `extension/import.*` | Interfaz. |
| `site/`, `build.sh`, `netlify.toml` | Web de descarga en Netlify: en cada push empaqueta `extension/` en un .zip y publica la guía. |
| `apps-script/Code.gs` | Script de Google Apps Script: de Gmail (`+kindle`) a Notion. |
| `supabase-version/` | Versión anterior con base de datos en Supabase y web de repaso diario. No se usa; se guarda por si queremos recuperar el repaso. |
