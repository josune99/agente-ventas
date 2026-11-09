#!/usr/bin/env python3
"""Versión web del agente de ventas: API FastAPI con streaming SSE y frontend estático."""

import argparse
import asyncio
from contextlib import asynccontextmanager
import json
import os
import uuid

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware
from pydantic import BaseModel, Field

from agente_ventas import DB_PATH, DEFAULT_MODEL, ROOT, create_client, create_session, get_api_key
from copilot.session_events import SessionEventType


STATIC_DIR = ROOT / "static"
MODEL = os.environ.get("MODELO", DEFAULT_MODEL)
# Tiempo máximo sin recibir eventos del agente antes de dar el turno por perdido.
EVENT_TIMEOUT = 180
MAX_CONVERSATIONS = 50
# Hosts aceptados: evita que una web ajena use el agente (y tu crédito) por DNS rebinding.
# En Codespaces el puerto reenviado se sirve como <codespace>-8000.app.github.dev.
ALLOWED_HOSTS = ["localhost", "127.0.0.1"]
if os.environ.get("CODESPACES") == "true":
    ALLOWED_HOSTS.append("*.app.github.dev")
ALLOWED_HOSTS += [h.strip() for h in os.environ.get("ALLOWED_HOSTS", "").split(",") if h.strip()]


class Conversation:
    """Una sesión del SDK por conversación del navegador.

    Los eventos de la sesión se reenvían a la cola del turno en curso; solo hay
    un turno a la vez por conversación (lo garantiza `lock`).
    """

    def __init__(self, session):
        self.session = session
        self.lock = asyncio.Lock()
        self.queue: asyncio.Queue | None = None
        loop = asyncio.get_running_loop()

        def on_event(event):
            if self.queue is not None:
                loop.call_soon_threadsafe(self.queue.put_nowait, event)

        session.on(on_event)


conversations: dict[str, Conversation] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not DB_PATH.is_file():
        raise FileNotFoundError(f"No existe la base de datos: {DB_PATH}")
    get_api_key()  # falla al arrancar si no hay clave
    client = create_client()
    await client.start()
    app.state.client = client
    try:
        yield
    finally:
        for conv in conversations.values():
            await conv.session.disconnect()
        conversations.clear()
        await client.stop()


app = FastAPI(title="Agente de ventas", lifespan=lifespan)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=ALLOWED_HOSTS)


@app.middleware("http")
async def revalidar_frontend(request, call_next):
    # Que el navegador pida siempre la última versión del frontend tras un cambio
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


class MessageIn(BaseModel):
    mensaje: str = Field(min_length=1, max_length=4000)


def sse(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False, default=str)}\n\n"


def parse_tool_result(data) -> dict | None:
    if data.result is None:
        return None
    try:
        return json.loads(data.result.content)
    except (TypeError, ValueError):
        return {"text": data.result.content}


def event_to_payload(event) -> dict | None:
    data = event.data
    match event.type:
        case SessionEventType.ASSISTANT_MESSAGE_DELTA:
            return {"type": "delta", "text": data.delta_content or ""}
        case SessionEventType.TOOL_EXECUTION_START:
            args = data.arguments if isinstance(data.arguments, dict) else {}
            return {"type": "tool_start", "id": data.tool_call_id, "tool": data.tool_name, "sql": args.get("sql")}
        case SessionEventType.TOOL_EXECUTION_COMPLETE:
            return {
                "type": "tool_end",
                "id": data.tool_call_id,
                "success": data.success,
                "result": parse_tool_result(data),
                "error": data.error.message if data.error else None,
            }
        case SessionEventType.SESSION_ERROR:
            return {"type": "error", "message": data.message}
    return None


@app.post("/api/conversaciones")
async def new_conversation() -> dict:
    if len(conversations) >= MAX_CONVERSATIONS:
        oldest = next(iter(conversations))
        await conversations.pop(oldest).session.disconnect()
    session = await create_session(app.state.client, MODEL)
    conv_id = uuid.uuid4().hex
    conversations[conv_id] = Conversation(session)
    return {"id": conv_id, "modelo": MODEL}


@app.delete("/api/conversaciones/{conv_id}", status_code=204)
async def delete_conversation(conv_id: str) -> None:
    conv = conversations.pop(conv_id, None)
    if conv is not None:
        await conv.session.disconnect()


@app.post("/api/conversaciones/{conv_id}/mensajes")
async def send_message(conv_id: str, body: MessageIn) -> StreamingResponse:
    conv = conversations.get(conv_id)
    if conv is None:
        raise HTTPException(404, "La conversación no existe o ha caducado")
    if conv.lock.locked():
        raise HTTPException(409, "El agente todavía está respondiendo al mensaje anterior")

    async def stream():
        async with conv.lock:
            conv.queue = asyncio.Queue()
            try:
                await conv.session.send(body.mensaje.strip())
                while True:
                    try:
                        event = await asyncio.wait_for(conv.queue.get(), EVENT_TIMEOUT)
                    except TimeoutError:
                        await conv.session.abort()
                        yield sse({"type": "error", "message": "El agente tardó demasiado en responder"})
                        break
                    if event.type == SessionEventType.SESSION_IDLE:
                        break
                    payload = event_to_payload(event)
                    if payload:
                        yield sse(payload)
                    if event.type == SessionEventType.SESSION_ERROR:
                        break
            except Exception as exc:
                yield sse({"type": "error", "message": str(exc)})
            finally:
                conv.queue = None
            yield sse({"type": "done"})

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


if __name__ == "__main__":
    import uvicorn

    parser = argparse.ArgumentParser(description="Agente de ventas — versión web")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--modelo", default=MODEL, help="Modelo de OpenRouter")
    args = parser.parse_args()
    MODEL = args.modelo
    uvicorn.run(app, host=args.host, port=args.port)
