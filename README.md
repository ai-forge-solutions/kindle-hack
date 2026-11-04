# Subrayados

Tus subrayados de Kindle, sincronizados solos cada día, con un repaso diario para no olvidarlos.

Tiene tres piezas:

| Carpeta | Qué es |
|---|---|
| `extension/` | Extensión de Chrome. Una vez al día lee tu [Notebook de Kindle](https://read.amazon.com/notebook) con la sesión de Amazon que ya tienes abierta en Chrome y sube los subrayados nuevos. |
| `web/` | La app: repaso diario, biblioteca, buscador, importación de `My Clippings.txt` y exportación a Markdown/CSV. HTML + JS sin build. |
| `supabase/` | Base de datos (Postgres + Auth). Cada persona solo ve lo suyo (RLS). |

## Cómo funciona la sincronización

Igual que la de Readwise:

- La extensión **no guarda tu contraseña de Amazon** ni copia tus cookies a ningún servidor. Solo tiene permiso para `read.amazon.*` (para leer el Notebook) y para tu proyecto de Supabase (para guardar).
- Cada hora comprueba si han pasado 20 h desde la última sincronización. Basta con abrir Chrome de vez en cuando.
- Solo relee los libros con subrayados nuevos (compara la fecha del último subrayado de cada libro). «Releer todo» fuerza una lectura completa.
- Deja ~0,7 s entre peticiones a Amazon.
- Si se cierra tu sesión de Amazon, el icono muestra un `!`. Abre el Notebook, entra y sincroniza sola.
- La sincronización solo escribe lo que viene de Amazon (texto, nota del Kindle, posición, color). Tus favoritos, notas propias y repasos nunca se pisan.

Limitaciones:

- Solo aparecen libros comprados en Amazon. Para PDFs/EPUBs enviados al Kindle, importa `My Clippings.txt` desde la web.
- Amazon puede limitar lo que muestra el Notebook en algunos libros (límite de la editorial).
- La página del Notebook no está documentada. Si Amazon la cambia, se arregla en `extension/notebook-parser.js`. El popup ofrece «Copiar diagnóstico», que solo cuenta selectores y no incluye ningún texto tuyo.

## Puesta en marcha

### 1. Supabase

1. Crea un proyecto en Supabase.
2. En **SQL Editor**, ejecuta `supabase/migrations/0001_init.sql`.
3. En **Authentication → Email Templates → Magic Link**, añade el código al correo, porque la app y la extensión entran con un código de 6 dígitos. Por ejemplo:
   ```html
   <h2>Tu código para Subrayados</h2>
   <p style="font-size:24px;letter-spacing:4px"><strong>{{ .Token }}</strong></p>
   ```
4. En **Project Settings → API**, copia la *Project URL* y la clave *anon public*.
5. Opcional: cuando el equipo ya tenga cuenta, desactiva los registros nuevos en **Authentication → Sign In / Providers**.

El correo de Supabase por defecto solo deja unos pocos envíos por hora. Para un equipo pequeño basta; si se queda corto, configura un SMTP propio.

### 2. Configuración

Pon la URL y la clave anon en `web/config.js` y en `extension/config.js`. En la extensión, pon también `WEB_URL` (la dirección de la web). La clave anon es pública: la seguridad la dan las políticas RLS.

### 3. Web (Netlify)

Conecta el repo en Netlify. `netlify.toml` ya publica la carpeta `web/` sin build.

Para probarla en local:
```bash
cd web && python3 -m http.server 8000
```

### 4. Extensión de Chrome

1. Abre `chrome://extensions` y activa **Modo de desarrollador**.
2. Pulsa **Cargar descomprimida** y elige la carpeta `extension/`.
3. Abre la extensión, entra con tu email (mismo email que en la web) y el código que te llega.
4. Si tu Kindle es de otra tienda de Amazon, elige la tienda en el popup.
5. Si no tenías sesión abierta en el Notebook de Kindle, ábrelo, entra y pulsa «Sincronizar ahora».
