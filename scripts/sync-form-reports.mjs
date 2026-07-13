#!/usr/bin/env node
// Sincroniza los reportes del Google Sheet (form público) al data.json.
// Corre diario vía GitHub Actions. Idempotente: no agrega duplicados.
//
// Reglas:
// - Solo procesa filas con Status "pendiente" o vacío
// - Filtra el WhatsApp del centro si coincide con el contacto del reportante
// - Descarta filas con nombre vacío o dirección incoherente
// - Usa coords aproximados por ciudad (state fallback)
// - Fuente: "Reporte comunitario verificado"

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data.json");
const SHEET_URL = "https://docs.google.com/spreadsheets/d/11kaHudI4RHFy6pF8AkgwR2maK83Mn4IyQc7Dw21hJBQ/export?format=csv";

// --- Coords fallback ---
const CITY_COORDS = {
  Maracaibo: [10.6740, -71.6200],
  Caracas: [10.4880, -66.8790],
  "Los Teques": [10.3450, -67.0420],
  Carrizal: [10.3380, -67.0270],
  Petare: [10.4760, -66.8120],
  Catia: [10.5050, -66.9320],
  "San Francisco": [10.5750, -71.6400],
  "Ciudad Ojeda": [10.1968, -71.3151],
  Cabimas: [10.3900, -71.4400],
  Valencia: [10.1620, -67.9990],
  Barquisimeto: [10.0670, -69.3170],
  Maracay: [10.2469, -67.5958],
  "San Juan de los Morros": [9.9090, -67.3540],
  Barcelona: [10.1340, -64.6850],
  "Puerto La Cruz": [10.2200, -64.6300],
  Cumaná: [10.4500, -64.1730],
  Maturín: [9.7440, -63.1900],
  Coro: [11.4030, -69.6820],
  "Punto Fijo": [11.6800, -70.2100],
  Guanare: [9.0440, -69.7510],
  Mérida: [8.5870, -71.1450],
  "El Vigía": [8.6240, -71.6460],
  "San Cristóbal": [7.7690, -72.2250],
  Barinas: [8.6210, -70.2050],
  "Villa del Rosario": [10.3270, -72.2820],
  Pampatar: [11.0050, -63.7900],
};
const STATE_COORDS = {
  "Distrito Capital": [10.4880, -66.8790],
  "La Guaira": [10.6000, -66.9330],
  Miranda: [10.3450, -67.0420],
  Aragua: [10.2469, -67.5958],
  Carabobo: [10.1620, -67.9990],
  Anzoátegui: [10.1340, -64.6850],
  Barinas: [8.6210, -70.2050],
  Bolívar: [8.1220, -63.5490],
  Cojedes: [9.3690, -68.5750],
  Falcón: [11.4030, -69.6820],
  Guárico: [9.9090, -67.3540],
  Lara: [10.0670, -69.3170],
  Mérida: [8.5870, -71.1450],
  Monagas: [9.7440, -63.1900],
  "Nueva Esparta": [11.0050, -63.7900],
  Portuguesa: [9.0440, -69.7510],
  Sucre: [10.4500, -64.1730],
  Táchira: [7.7690, -72.2250],
  Trujillo: [9.3660, -70.4360],
  Yaracuy: [10.3300, -68.7420],
  Amazonas: [5.6650, -67.6250],
  Apure: [7.8890, -67.4720],
  "Delta Amacuro": [8.6350, -62.0430],
  Zulia: [10.6740, -71.6200],
};

// --- Item mapping ---
const ITEM_KW = {
  "agua potable": ["agua"],
  "alimentos no perecederos": ["aliment", "enlatad", "arroz", "pasta", "granos", "leche en polvo"],
  "medicamentos e insumos médicos": ["medicament", "insumos m", "medicin"],
  "kits de primeros auxilios": ["primeros auxili", "kit"],
  "artículos de higiene personal": ["higiene", "jab", "shampoo", "toalla"],
  "pañales de bebé": ["pañal.+beb", "pañales de beb"],
  "pañales de adulto": ["pañal.+adult", "pañales de adult"],
  "artículos para niños": ["niño", "bebe", "bebé", "fórmula", "formula", "compota"],
  "ropa en buen estado": ["ropa", "calzad", "zapato"],
  "mantas y cobijas": ["manta", "cobija"],
  "abrigos y otros implementos de protección": ["abrigo"],
  "equipos de protección personal (guantes, mascarillas, botas, cascos)": ["casco", "guante", "mascarill"],
  "artículos de limpieza": ["limpieza"],
  "materiales para refugio": ["refugio", "carpa", "lona"],
  "linternas, pilas y cargadores portátiles": ["lintern", "pila", "cargador"],
  "power banks": ["power bank"],
  "colchones y colchones inflables": ["colchon"],
  "colchonetas": ["colchoneta"],
  "alimentos para mascotas": ["mascota", "alimento seco"],
};

function parseRecibe(str) {
  const s = (str || "").toLowerCase();
  const out = new Set();
  for (const [label, kws] of Object.entries(ITEM_KW)) {
    if (kws.some((kw) => new RegExp(kw, "i").test(s))) out.add(label);
  }
  return [...out];
}

function normalizeIg(raw) {
  if (!raw) return null;
  const s = raw.trim();
  if (s.startsWith("http")) {
    const m = s.match(/instagram\.com\/([^/?]+)/);
    return m ? m[1].replace(/\/$/, "").toLowerCase() : null;
  }
  return s.replace(/^@/, "").trim().toLowerCase();
}

function normalizePhone(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/[^\d+]/g, "");
  if (!s || /^0+$/.test(s) || s === "#error!") return null;
  let d = s.replace(/^\+/, "");
  if (d.startsWith("0") && d.length >= 10) d = "58" + d.slice(1);
  else if (!d.startsWith("58") && d.length === 10) d = "58" + d;
  if (d.length < 11) return null;
  return "+" + d;
}

// --- CSV parser (handles quoted commas) ---
function parseCSV(text) {
  const rows = [];
  let row = [], cur = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inQ) {
      if (c === '"' && n === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\r") { /* skip */ }
      else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
      else cur += c;
    }
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

// --- Resolve maps short URL if possible ---
async function resolveMaps(url) {
  if (!url) return null;
  const s = url.trim();
  if (!/^https?:\/\/(maps\.app\.goo\.gl|share\.google|goo\.gl)/i.test(s)) return s;
  try {
    const r = await fetch(s, { redirect: "manual", headers: { "User-Agent": "Mozilla/5.0" } });
    const loc = r.headers.get("location");
    if (loc) return loc;
  } catch {}
  return s;
}

// --- Main ---
async function main() {
  const data = JSON.parse(readFileSync(DATA_PATH, "utf-8"));
  const csv = await fetch(SHEET_URL).then((r) => r.text());
  const rows = parseCSV(csv);
  const headers = rows[0];
  const idx = (h) => headers.indexOf(h);
  const iName = idx("Nombre"), iState = idx("Estado"), iCity = idx("Ciudad"),
        iAddr = idx("Dirección"), iMaps = idx("Google Maps"), iIg = idx("Instagram"),
        iWa = idx("WhatsApp"), iHor = idx("Horario"), iRec = idx("Reciben"),
        iRepName = idx("Reportado por"), iRepContact = idx("Contacto reporta"),
        iStatus = idx("Status");

  // Build existing keys set for dedup
  // Aggressive normalization: strip accents/punctuation/quotes so minor
  // variations between sheet vs data.json don't count as new.
  const norm = (s) =>
    (s || "")
      .toString()
      .toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  // Nombre canónico: solo letras/números, sin acentos ni dashes.
  // Después usamos un match por overlap de palabras (evita falsos positivos
  // en variantes chicas y falsos negativos en nombres muy distintos).
  const canonWords = (s) => {
    return (s || "")
      .toString()
      .toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !["centro","acopio","comercial","colegio","iglesia","fundacion","sede","filial","todas","sus","sedes","ciudad","ojeda","maracaibo","del","los","las","por","con","para","zulia","miranda","caracas"].includes(w));
  };
  // Index every existing centro by (estado → array de sus canonWords sets).
  const existingByState = new Map();
  for (const state of data.estados || []) {
    const arr = [];
    for (const city of state.ciudades || []) {
      for (const centro of city.centros || []) {
        arr.push(new Set(canonWords(centro.nombre)));
      }
    }
    existingByState.set(state.nombre, arr);
  }
  function isDuplicate(nombre, estado) {
    const words = new Set(canonWords(nombre));
    if (words.size === 0) return false;
    const bag = existingByState.get(estado) || [];
    for (const other of bag) {
      // Coincide si al menos 2 palabras clave se comparten, o si compartimos
      // el 70%+ de las palabras del nombre más corto.
      let overlap = 0;
      for (const w of words) if (other.has(w)) overlap++;
      if (overlap >= 2) return true;
      const minSize = Math.min(words.size, other.size);
      if (minSize > 0 && overlap / minSize >= 0.7) return true;
    }
    return false;
  }

  const added = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const nombre = (row[iName] || "").trim();
    const estado = (row[iState] || "").trim();
    const ciudad = (row[iCity] || "").trim();
    const direccionRaw = (row[iAddr] || "").trim();
    if (!nombre || !estado || !ciudad || !direccionRaw) continue;
    const status = (row[iStatus] || "").trim().toLowerCase();
    if (status && status !== "pendiente") continue; // ya publicado o rechazado

    // Descarta centros de alcaldías/gobernaciones/PC/GNB dentro de Venezuela
    const govt = /\balcald[íi]a\b|\bgobernaci[óo]n\b|\bprotecci[óo]n civil\b|\bguardia nacional\b|\bgnb\b|gobierno bolivariano|ministerio/i;
    const insideVE = !!STATE_COORDS[estado];
    if (insideVE && govt.test(`${nombre} ${direccionRaw}`)) continue;

    const horario = (row[iHor] || "").trim();
    const direccion = horario ? `${direccionRaw} · Horario: ${horario}` : direccionRaw;
    if (isDuplicate(nombre, estado)) continue;

    // Filter reporter's own phone
    const reporterContact = normalizePhone(row[iRepContact]);
    let telefono = normalizePhone(row[iWa]);
    if (telefono && reporterContact && telefono === reporterContact) telefono = null;

    const ig = normalizeIg(row[iIg]);
    const maps = await resolveMaps(row[iMaps]);
    const coords = CITY_COORDS[ciudad] || STATE_COORDS[estado] || [10.5, -66.9];
    const recibe = parseRecibe(row[iRec]);

    // Find or create state/city
    let stateNode = data.estados.find((s) => s.nombre === estado);
    if (!stateNode) { stateNode = { nombre: estado, ciudades: [] }; data.estados.push(stateNode); }
    let cityNode = stateNode.ciudades.find((c) => norm(c.nombre) === norm(ciudad));
    if (!cityNode) { cityNode = { nombre: ciudad, centros: [] }; stateNode.ciudades.push(cityNode); }

    const centro = { nombre, direccion, coords };
    if (maps) centro.maps = maps;
    if (ig) centro.instagram = ig;
    if (telefono) centro.telefono = telefono;
    if (recibe.length) centro.recibe = recibe;
    centro.fuente = "Reporte comunitario verificado";
    cityNode.centros.push(centro);
    // Refresh the index so subsequent rows in this run also dedup
    (existingByState.get(estado) || []).push(new Set(canonWords(nombre)));
    added.push(`[${estado}/${ciudad}] ${nombre}`);
  }

  if (added.length === 0) {
    console.log("No hay reportes nuevos.");
    return;
  }
  writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + "\n", "utf-8");
  console.log(`Agregados ${added.length}:`);
  for (const a of added) console.log("  -", a);
}

main().catch((err) => { console.error(err); process.exit(1); });
