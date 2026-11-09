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
    // Una tilde suelta es "aproximadamente" (~10 %), no un tachado
    const sinTachados = texto.replace(/(?<!~)~(?!~)/g, "\\~");
    return DOMPurify.sanitize(marked.parse(sinTachados));
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
      // Los códigos e identificadores (tienda, SKU, clase…) no llevan separador de miles
      const esCodigo = /code|number|sku|id$/i.test(c);
      td.textContent = typeof v === "number" && !esCodigo
        ? v.toLocaleString("es-ES", { maximumFractionDigits: 2 })
        : v ?? "";
      if (typeof v === "number" && !esCodigo) td.className = "num";
    });
  });
  return tabla;
}

// --- Memes ---------------------------------------------------------------

const FRASES_DOGE = ["wow", "much respuesta", "very datos", "such análisis", "so cifras", "amaze", "many filas", "good boy", "10/10 would query again", "bork bork"];
const COLORES_DOGE = ["#e8590c", "#7048e8", "#0ca678", "#d6336c", "#1c7ed6", "#f08c00", "#ae3ec9"];
const aleatorio = (lista) => lista[Math.floor(Math.random() * lista.length)];
const sinMovimiento = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function dogePop(msg) {
  const pop = el("span", "doge-pop", aleatorio(FRASES_DOGE));
  pop.style.color = aleatorio(COLORES_DOGE);
  pop.setAttribute("aria-hidden", "true");
  msg.appendChild(pop);
}

function zoomies() {
  if (sinMovimiento) return;
  const perro = el("span", "zoomies", "🐕");
  perro.setAttribute("aria-hidden", "true");
  perro.addEventListener("animationend", () => perro.remove());
  document.body.appendChild(perro);
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
  const msg = el("article", "msg asistente pensando");
  const herramientas = el("div", "tools");
  const cuerpo = el("div", "cuerpo");
  const estado = el("div", "estado", "Olfateando la pregunta…");
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
  vista.estado.textContent = "Desenterrando huesos de la base de datos… such SQL";
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
  vista.estado.textContent = "Escribiendo con las patitas… very teclado";
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
  zoomies();
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
      vista.cuerpo.textContent = "Me he distraído con una ardilla y no he respondido nada. ¿Me lanzas la pregunta otra vez?";
    }
  } catch (e) {
    vista.msg.appendChild(el("div", "error", e.message || "No encuentro al servidor, se ha escapado del jardín"));
  } finally {
    vista.estado.remove();
    vista.msg.classList.remove("pensando");
    if (vista.texto) dogePop(vista.msg);
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
