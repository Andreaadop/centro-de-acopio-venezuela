// Vercel serverless function: proxy + normalizer for acopiozulia.com
// Returns { ciudades: [...] } in our data.json schema, ready to drop into estado "Zulia".

const UPSTREAM = "https://acopiozulia.com/api/centros";

const NEED_MAP = {
  agua: "agua potable",
  alimentos: "alimentos no perecederos",
  medicinas: "medicamentos e insumos médicos",
  insumos_medicos: "medicamentos e insumos médicos",
  antibioticos: "antibióticos",
  suero: "suero, sales de rehidratación y bebidas isotónicas",
  higiene: "artículos de higiene personal",
  menstrual: "insumos de gestión menstrual (toallas sanitarias, tampones)",
  ropa: "ropa en buen estado",
  panales: "pañales de bebé",
  panales_adulto: "pañales de adulto",
  formula: "fórmula infantil y comida para bebé",
  abrigo: "mantas y cobijas",
  bebes: "artículos para niños",
  limpieza: "artículos de limpieza",
  utensilios: "utensilios de cocina (ollas, platos, cubiertos)",
  mascotas: "alimentos para mascotas",
  veterinario: "insumos veterinarios (correas, arneses, medicinas)",
  refugio: "materiales para refugio",
  linternas: "linternas, pilas y cargadores portátiles",
  colchones: "colchones, almohadas y colchones inflables",
  epp: "equipos de protección personal (guantes, mascarillas, botas, cascos)",
  rescate: "herramientas de rescate (palas, picos, martillos)",
  cadaveres: "bolsas para cadáveres",
};

// Normalize a phone to international VE format (+58...)
function normPhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^0-9]/g, "");
  if (!digits) return null;
  let d = digits;
  if (d.startsWith("0") && d.length >= 10) d = "58" + d.slice(1);
  else if (!d.startsWith("58") && d.length === 10) d = "58" + d;
  return "+" + d;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function buildCentro(c) {
  const recibe = [];
  for (const n of c.necesidades || []) {
    const label = NEED_MAP[n];
    if (label && !recibe.includes(label)) recibe.push(label);
  }
  const lat = Number(c.lat), lng = Number(c.lng);
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);
  const phone = normPhone(c.whatsapp || c.contacto);

  // Build a single direccion string with horario
  const parts = [];
  if (c.direccion) parts.push(String(c.direccion).trim());
  if (c.horario) parts.push("Horario: " + String(c.horario).trim());
  const direccion = parts.join(" · ");

  // Nota: combine necesidadesTexto, noNecesita, voluntarios
  const notaParts = [];
  if (c.necesidadesTexto) notaParts.push(String(c.necesidadesTexto).trim());
  if (c.noNecesita) notaParts.push("⚠️ NO está recibiendo: " + String(c.noNecesita).trim());
  if ((c.necesidades || []).includes("voluntarios")) notaParts.push("Necesitan voluntarios.");
  const nota = notaParts.join(" · ") || undefined;

  const centro = {
    nombre: String(c.nombre || "").trim() || "Centro de Acopio",
    direccion,
  };
  if (hasCoords) {
    centro.coords = [round4(lat), round4(lng)];
    centro.maps = `https://maps.google.com/?q=${centro.coords[0]},${centro.coords[1]}`;
  }
  if (phone) centro.telefono = phone;
  if (recibe.length) centro.recibe = recibe;
  if (nota) centro.nota = nota;
  centro.fuente = "Datos verificados de la comunidad";
  return centro;
}

export default async function handler(req, res) {
  try {
    const upstream = await fetch(UPSTREAM, { headers: { "User-Agent": "centrosdeacopiovzla.com proxy" } });
    if (!upstream.ok) throw new Error("upstream " + upstream.status);
    const data = await upstream.json();

    // Filter: estado activo, no oculto, verificado true
    const items = (Array.isArray(data) ? data : []).filter(
      (c) => c && c.estado === "activo" && !c.oculto && c.verificado !== false
    );

    // Group by municipio
    const byCity = new Map();
    for (const c of items) {
      const city = (c.municipio && String(c.municipio).trim()) || "Sin municipio";
      const centro = buildCentro(c);
      if (!byCity.has(city)) byCity.set(city, []);
      byCity.get(city).push(centro);
    }

    // Sort cities alphabetically (Maracaibo first by convention if present)
    const ciudades = [...byCity.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], "es"))
      .map(([nombre, centros]) => ({ nombre, centros }));

    res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=600");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).send(JSON.stringify({ ciudades, fetchedAt: new Date().toISOString() }));
  } catch (err) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: "upstream_failed", message: String(err && err.message || err) });
  }
}
