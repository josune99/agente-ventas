# Agente simple de ventas

Extraído de la sección **Agente simple de ventas** de `original.ipynb`.
Incluye `sales_data.db`, descargada desde el enlace del notebook.

Repositorio: <https://github.com/juananpe/agente-ventas>

## Puesta en marcha con el contenedor (recomendada)

Solo necesitas [Docker](https://www.docker.com/products/docker-desktop/) y
[Visual Studio Code](https://code.visualstudio.com/) con la extensión
**Dev Containers**. Da igual si usas Windows, macOS o Linux.

1. Clona el repositorio:

```sh
git clone https://github.com/juananpe/agente-ventas.git
```

2. Abre esa carpeta en VS Code y elige **Reopen in Container**
   (`F1` → `Dev Containers: Reopen in Container`).

VS Code construye el contenedor y deja el entorno listo: Python 3.13, las
dependencias y el runtime del SDK. La primera vez tarda un par de minutos; las
siguientes son instantáneas.

3. Abre `.env` y pega tu clave de OpenRouter. Es el único paso manual:

```
OPENROUTER_API_KEY=tu_clave
```

Puedes crear una clave en <https://openrouter.ai/keys>. El `.env` ya existe (el
contenedor lo crea a partir de `.env.example`) y está excluido de Git, así que
tu clave no se sube al repositorio.

4. Ejecuta el agente en la terminal de VS Code:

```sh
python agente_ventas.py
```

También admite una pregunta única:

```sh
python agente_ventas.py --pregunta "¿Cuál es el top 5 de tiendas por ventas totales?"
```

Dentro del contenedor `python` ya apunta al entorno correcto: no hay que activar
nada ni usar rutas con `.venv`.

## Puesta en marcha sin Docker

Si prefieres ejecutarlo directamente en tu equipo necesitas Python 3.11 o
posterior. Crea el entorno virtual:

```sh
python3 -m venv .venv
```

macOS y Linux:

```sh
./.venv/bin/python -m pip install -r requirements.txt
cp .env.example .env        # y pega tu clave en .env
./.venv/bin/python agente_ventas.py
```

Windows (PowerShell):

```powershell
.venv\Scripts\python -m pip install -r requirements.txt
copy .env.example .env
.venv\Scripts\python agente_ventas.py
```

## Detalles

Usa OpenRouter con el modelo `deepseek/deepseek-v4.1-flash`; puedes elegir otro
con `--modelo ID_DEL_MODELO`. En el modo interactivo, escribe `salir` para
terminar.

La clave se lee de `.env` al arrancar. Si `OPENROUTER_API_KEY` ya está definida
en el entorno, también la usa.

El SDK descarga su runtime nativo en el primer arranque (el contenedor de
desarrollo ya lo trae predescargado).

La base SQLite se abre en modo de solo lectura y se devuelven como máximo 100
filas por consulta.

## Versión web

`web.py` sirve una interfaz de chat en el navegador (backend FastAPI, frontend
HTML + JS sin frameworks en `static/`). Reutiliza el mismo agente y la misma
herramienta `query_sales` que la versión de terminal.

```sh
python web.py                      # http://127.0.0.1:8000
python web.py --port 8080 --modelo ID_DEL_MODELO
```

También se puede lanzar con `uvicorn web:app --reload` (el modelo se elige
entonces con la variable de entorno `MODELO`).

Cada pestaña del navegador abre su propia conversación con el agente. Las
respuestas llegan en streaming (SSE) y cada consulta SQL que ejecuta el agente
se muestra plegada junto con las filas devueltas.

API:

- `POST /api/conversaciones` → `{"id", "modelo"}`
- `POST /api/conversaciones/{id}/mensajes` con `{"mensaje": "..."}` → flujo SSE
  de eventos `delta`, `tool_start`, `tool_end`, `error` y `done`
- `DELETE /api/conversaciones/{id}`
