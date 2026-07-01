// Vercel serverless: agrupa /api/needs de Ayuda en Camino por organización
// y devuelve los centros para inyectar en el directorio principal.
// Reglas:
// - Solo orgs con ≥ MIN_NEEDS necesidades activas
// - Excluye Zulia (ya viene de acopiozulia)
// - Normaliza al esquema de data.json

const UPSTREAM = "https://ayudaencamino.com/api/needs";
const MIN_NEEDS = 2;
const EXCLUDE_STATES = new Set(["Zulia"]);

// Category → recibe label
const CAT_MAP = {
  medicinas: "medicamentos e insumos médicos",
  alimentos: "alimentos no perecederos",
  agua: "agua potable",
  higiene: "artículos de higiene personal",
  ropa: "ropa en buen estado",
  herramientas: "materiales para refugio",
};

// Approximate coords per Venezuelan capital / major city, for map thumbnails
const STATE_COORDS = {
  "Distrito Capital": [10.4880, -66.8790],
  "La Guaira": [10.6000, -66.9330],
  "Miranda": [10.3450, -67.0420],
  "Aragua": [10.2469, -67.5958],
  "Carabobo": [10.1620, -67.9990],
  "Anzoátegui": [10.1340, -64.6850],
  "Barinas": [8.6210, -70.2050],
  "Bolívar": [8.1220, -63.5490],
  "Cojedes": [9.3690, -68.5750],
  "Falcón": [11.4030, -69.6820],
  "Guárico": [9.9090, -67.3540],
  "Lara": [10.0670, -69.3170],
  "Mérida": [8.5870, -71.1450],
  "Monagas": [9.7440, -63.1900],
  "Nueva Esparta": [11.0050, -63.7900],
  "Portuguesa": [9.0440, -69.7510],
  "Sucre": [10.4500, -64.1730],
  "Táchira": [7.7690, -72.2250],
  "Trujillo": [9.3660, -70.4360],
  "Yaracuy": [10.3300, -68.7420],
  "Amazonas": [5.6650, -67.6250],
  "Apure": [7.8890, -67.4720],
  "Delta Amacuro": [8.6350, -62.0430],
};

function normPhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^0-9]/g, "");
  if (!digits) return null;
  let d = digits;
  if (d.startsWith("0") && d.length >= 10) d = "58" + d.slice(1);
  else if (!d.startsWith("58") && d.length === 10) d = "58" + d;
  return "+" + d;
}

function urgLabel(u) {
  return ({ critica: "CRÍTICA", alta: "alta", media: "media" })[u] || u || "media";
}

function buildCentro(org, needs) {
  // Unique recibe labels from need categories
  const recibe = [];
  for (const n of needs) {
    const label = CAT_MAP[n.categoria];
    if (label && !recibe.includes(label)) recibe.push(label);
  }
  // Sort needs by urgencia critica > alta > media, then quantity desc
  const order = { critica: 0, alta: 1, media: 2 };
  const sorted = needs.slice().sort((a, b) => {
    const oa = order[a.urgencia] ?? 9, ob = order[b.urgencia] ?? 9;
    if (oa !== ob) return oa - ob;
    return (Number(b.cantidadNecesaria) || 0) - (Number(a.cantidadNecesaria) || 0);
  });
  // Build nota with concrete items
  const bullets = sorted.slice(0, 12).map((n) => {
    const q = Number(n.cantidadNecesaria) || 0;
    const cum = (Number(n.cantidadCumplida) || 0) + (Number(n.cantidadComprometida) || 0);
    const need = q > cum ? q - cum : q;
    const qty = q ? `${need} u.` : "";
    return `${qty ? qty + " " : ""}${n.nombreArticulo} (${urgLabel(n.urgencia)})`;
  });
  const extra = sorted.length > 12 ? ` … y ${sorted.length - 12} artículos más` : "";
  const nota = `🚨 Necesidades urgentes reportadas: ${bullets.join(", ")}${extra}.`;

  const coords = STATE_COORDS[org.estado] || null;
  const dirParts = [];
  if (org.direccion) dirParts.push(String(org.direccion).trim());
  if (org.ciudad) dirParts.push(String(org.ciudad).trim());
  if (org.estado) dirParts.push(String(org.estado).trim());
  const direccion = dirParts.join(", ");

  const mapsQuery = encodeURIComponent(direccion || org.nombre || "");
  const centro = {
    nombre: String(org.nombre || "").trim() || "Centro de Acopio",
    direccion,
  };
  if (coords) centro.coords = coords;
  centro.maps = `https://maps.google.com/?q=${mapsQuery}`;
  const phone = normPhone(org.contactoTelefono);
  if (phone) centro.telefono = phone;
  if (recibe.length) centro.recibe = recibe;
  centro.nota = nota;
  centro.fuente = "Necesidades urgentes registradas en Ayuda en Camino";
  return centro;
}

export default async function handler(req, res) {
  try {
    const upstream = await fetch(UPSTREAM, { headers: { "User-Agent": "centrosdeacopiovzla.com proxy" } });
    if (!upstream.ok) throw new Error("upstream " + upstream.status);
    const needs = await upstream.json();

    // Group needs by orgId
    const byOrg = new Map();
    for (const n of needs) {
      if (!n || n.status !== "activa" || !n.organizacion) continue;
      if (EXCLUDE_STATES.has(n.organizacion.estado)) continue;
      const key = n.orgId || n.organizacion.id;
      if (!byOrg.has(key)) byOrg.set(key, { org: n.organizacion, needs: [] });
      byOrg.get(key).needs.push(n);
    }

    // Group by state and city, filter by threshold
    const byState = {};
    for (const { org, needs: ns } of byOrg.values()) {
      if (ns.length < MIN_NEEDS) continue;
      const state = org.estado || "Otro";
      const city = org.ciudad || "Otras";
      if (!byState[state]) byState[state] = {};
      if (!byState[state][city]) byState[state][city] = [];
      byState[state][city].push(buildCentro(org, ns));
    }

    res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=600");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).send(JSON.stringify({ byState, fetchedAt: new Date().toISOString() }));
  } catch (err) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: "upstream_failed", message: String(err && err.message || err) });
  }
}
