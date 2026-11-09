"use strict";

const chat = document.getElementById("chat");
const form = document.getElementById("form");
const entrada = document.getElementById("entrada");
const enviar = document.getElementById("enviar");
const bienvenida = document.getElementById("bienvenida");

let conversacionId = null;
let ocupado = false;

// --- Utilidades ---------------------------------------------------------

function renderMarkdown(texto) {
  if (window.marked && window.DOMPurify) {
    return DOMPurify.sanitize(marked.parse(texto));
  }
  const div = document.createElement("div");
  div.textContent = texto;
  return `<p style="white-space:pre-wrap">${div.innerHTML}</p>`;
}

function el(tag, clase, texto) {
  const nodo = document.createElement(tag);
  if (clase) nodo.className = clase;
  if (texto !== undefined) nodo.textContent = texto;
  return nodo;
}

function bajarAlFinal() {
  window.scrollTo({ top: document.body.scrollHeight });
}

function tablaDeFilas(filas) {
  const columnas = Object.keys(filas[0]);
  const tabla = el("table");
  const cabecera = tabla.createTHead().insertRow();
  columnas.forEach((c) => cabecera.appendChild(el("th", null, c)));
  const cuerpo = tabla.createTBody();
  filas.forEach((fila) => {
    const tr = cuerpo.insertRow();
    columnas.forEach((c) => {
      const v = fila[c];
      const td = tr.insertCell();
      td.textContent = typeof v === "number" ? v.toLocaleString("es-ES") : v ?? "";
      if (typeof v === "number") td.className = "num";
    });
  });
  return tabla;
}

// --- Conversación -------------------------------------------------------

async function nuevaConversacion() {
  if (conversacionId) {
    fetch(`/api/conversaciones/${conversacionId}`, { method: "DELETE" }).catch(() => {});
  }
  conversacionId = null;
  chat.querySelectorAll(".msg").forEach((n) => n.remove());
  bienvenida.hidden = false;
  const res = await fetch("/api/conversaciones", { method: "POST" });
  if (!res.ok) throw new Error(`No se pudo crear la conversación (HTTP ${res.status})`);
  const datos = await res.json();
  conversacionId = datos.id;
  document.getElementById("modelo").textContent = datos.modelo;
}

function crearMensajeAsistente() {
  const msg = el("article", "msg asistente");
  const herramientas = el("div", "tools");
  const cuerpo = el("div", "cuerpo");
  const estado = el("div", "estado", "Calentando motores…");
  msg.append(herramientas, cuerpo, estado);
  chat.appendChild(msg);
  return { msg, herramientas, cuerpo, estado, texto: "", consultas: {} };
}

function mostrarConsulta(vista, ev) {
  const det = el("details", "tool");
  const resumen = el("summary");
  resumen.append(el("span", "badge", "SQL"), el("span", "tool-estado", "ejecutando…"));
  const sql = el("pre", "sql", ev.sql || "(sin SQL)");
  det.append(resumen, sql);
  vista.herramientas.appendChild(det);
  vista.consultas[ev.id] = det;
  vista.estado.textContent = "Quemando rueda en la base de datos…";
}

function completarConsulta(vista, ev) {
  const det = vista.consultas[ev.id];
  if (!det) return;
  const etiqueta = det.querySelector(".tool-estado");
  const r = ev.result || {};
  if (!ev.success || r.error) {
    det.classList.add("fallo");
    etiqueta.textContent = `error: ${r.error || ev.error || "desconocido"}`;
    return;
  }
  const n = r.count ?? 0;
  etiqueta.textContent = `${n} fila${n === 1 ? "" : "s"}${r.truncated ? " (truncado)" : ""}`;
  if (Array.isArray(r.rows) && r.rows.length) {
    const envoltorio = el("div", "tabla-scroll");
    envoltorio.appendChild(tablaDeFilas(r.rows));
    det.appendChild(envoltorio);
  }
  vista.estado.textContent = "Derrapando hacia la respuesta…";
}

function procesarEvento(vista, ev) {
  switch (ev.type) {
    case "delta":
      vista.texto += ev.text;
      vista.cuerpo.innerHTML = renderMarkdown(vista.texto);
      vista.estado.textContent = "";
      break;
    case "tool_start":
      mostrarConsulta(vista, ev);
      break;
    case "tool_end":
      completarConsulta(vista, ev);
      break;
    case "error":
      vista.msg.appendChild(el("div", "error", ev.message));
      break;
  }
  bajarAlFinal();
}

async function preguntar(texto) {
  if (ocupado || !texto.trim()) return;
  ocupado = true;
  enviar.disabled = true;
  bienvenida.hidden = true;

  chat.appendChild(el("article", "msg usuario", texto));
  const vista = crearMensajeAsistente();
  bajarAlFinal();

  try {
    if (!conversacionId) await nuevaConversacion();
    let res = await fetch(`/api/conversaciones/${conversacionId}/mensajes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mensaje: texto }),
    });
    if (res.status === 404) {
      // La conversación caducó en el servidor (reinicio, etc.): empezamos otra.
      await nuevaConversacion();
      chat.append(el("article", "msg usuario", texto), vista.msg);
      bienvenida.hidden = true;
      res = await fetch(`/api/conversaciones/${conversacionId}/mensajes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mensaje: texto }),
      });
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }

    const lector = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await lector.read();
      if (done) break;
      buffer += value;
      let corte;
      while ((corte = buffer.indexOf("\n\n")) !== -1) {
        const bloque = buffer.slice(0, corte);
        buffer = buffer.slice(corte + 2);
        const linea = bloque.split("\n").find((l) => l.startsWith("data: "));
        if (linea) procesarEvento(vista, JSON.parse(linea.slice(6)));
      }
    }
    if (!vista.texto && !vista.msg.querySelector(".error")) {
      vista.cuerpo.textContent = "El motor se ha calado sin responder. Dale otra vez.";
    }
  } catch (e) {
    vista.msg.appendChild(el("div", "error", e.message || "El servidor no arranca: no hay conexión"));
  } finally {
    vista.estado.remove();
    ocupado = false;
    enviar.disabled = false;
    entrada.focus();
    bajarAlFinal();
  }
}

// --- Eventos de la interfaz --------------------------------------------

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const texto = entrada.value.trim();
  entrada.value = "";
  entrada.style.height = "";
  preguntar(texto);
});

entrada.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    form.requestSubmit();
  }
});

entrada.addEventListener("input", () => {
  entrada.style.height = "auto";
  entrada.style.height = `${Math.min(entrada.scrollHeight, 200)}px`;
});

document.querySelectorAll(".example").forEach((b) =>
  b.addEventListener("click", () => preguntar(b.dataset.pregunta || b.textContent)),
);

document.getElementById("nueva").addEventListener("click", () => {
  if (!ocupado) nuevaConversacion().catch((e) => alert(e.message));
});

nuevaConversacion().catch(() => {
  document.getElementById("modelo").textContent = "sin conexión con el servidor";
});
