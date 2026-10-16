// Demo pública: lee una factura (PDF o imagen) con Claude y devuelve sus datos en JSON.
// Requiere la variable de entorno ANTHROPIC_API_KEY configurada en Vercel.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

export const config = { maxDuration: 60 };

const client = new Anthropic();

const Factura = z.object({
  es_factura: z.boolean(),
  tipo_comprobante: z.string(),
  letra: z.string(),
  punto_venta: z.string(),
  numero: z.string(),
  fecha_emision: z.string(),
  emisor_razon_social: z.string(),
  emisor_cuit: z.string(),
  emisor_condicion_iva: z.string(),
  receptor_razon_social: z.string(),
  receptor_cuit: z.string(),
  items: z.array(z.object({
    descripcion: z.string(),
    cantidad: z.number().nullable(),
    precio_unitario: z.number().nullable(),
    subtotal: z.number().nullable(),
  })),
  neto_gravado: z.number().nullable(),
  iva: z.number().nullable(),
  otros_tributos: z.number().nullable(),
  total: z.number().nullable(),
  moneda: z.string(),
  cae: z.string(),
  vencimiento_cae: z.string(),
  confianza: z.enum(["alta", "media", "baja"]),
  observaciones: z.string(),
});

const SYSTEM = `Sos un sistema de extracción de datos de comprobantes fiscales argentinos (facturas, notas de crédito y débito emitidas bajo ARCA, ex AFIP).
Reglas:
- Si el documento no es un comprobante fiscal, devolvé es_factura=false, completá observaciones explicando qué es y dejá el resto vacío.
- No inventes datos: si un campo no figura o no se lee, usá "" para textos y null para números.
- Importes como números con punto decimal y sin separador de miles (ej: 184300.5).
- Fechas en formato AAAA-MM-DD.
- CUIT con formato XX-XXXXXXXX-X.
- punto_venta con 5 dígitos y numero con 8 dígitos, completando con ceros a la izquierda.
- tipo_comprobante en palabras (ej: "Factura", "Nota de Crédito") y letra por separado (A, B, C, E o M).
- Incluí como máximo 8 ítems; si hay más, resumí el resto en observaciones.
- confianza: "baja" si la imagen es borrosa o hay campos clave dudosos.`;

const TIPOS_OK = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_BASE64 = 4_200_000; // ~3 MB de archivo; Vercel limita el cuerpo a 4,5 MB
const ORIGEN_OK = /^(https:\/\/automatika[a-z0-9-]*\.vercel\.app|http:\/\/localhost(:\d+)?)$/;

// Límite simple por IP (por instancia). Para producción conviene sumar una regla en Vercel Firewall.
const VENTANA_MS = 10 * 60 * 1000;
const MAX_POR_VENTANA = 6;
const usos = new Map();
function superoLimite(ip) {
  const ahora = Date.now();
  const lista = (usos.get(ip) || []).filter((t) => ahora - t < VENTANA_MS);
  lista.push(ahora);
  usos.set(ip, lista);
  return lista.length > MAX_POR_VENTANA;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método no permitido." });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Falta ANTHROPIC_API_KEY en las variables de entorno");
    return res.status(503).json({ error: "La demo no está disponible en este momento." });
  }
  const origen = req.headers.origin;
  if (origen && !ORIGEN_OK.test(origen)) {
    return res.status(403).json({ error: "Origen no permitido." });
  }
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "anon";
  if (superoLimite(ip)) {
    return res.status(429).json({ error: "Alcanzaste el límite de pruebas. Volvé a intentar en unos minutos o escribinos por WhatsApp." });
  }

  const { media_type: tipo, data } = req.body || {};
  if (!TIPOS_OK.has(tipo) || typeof data !== "string" || !data.length) {
    return res.status(400).json({ error: "Subí un PDF o una imagen (JPG, PNG o WEBP)." });
  }
  if (data.length > MAX_BASE64) {
    return res.status(413).json({ error: "El archivo es demasiado grande. Probá con uno de hasta 3 MB." });
  }

  const archivo = tipo === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: tipo, data } }
    : { type: "image", source: { type: "base64", media_type: tipo, data } };

  const inicio = Date.now();
  try {
    const response = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 8000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: zodOutputFormat(Factura) },
      system: SYSTEM,
      messages: [{
        role: "user",
        content: [archivo, { type: "text", text: "Extraé los datos de este comprobante." }],
      }],
    });

    if (response.stop_reason === "refusal") {
      return res.status(422).json({ error: "No pudimos procesar este archivo. Probá con otra factura." });
    }
    const texto = response.content.find((b) => b.type === "text")?.text;
    let parsed = null;
    try { parsed = texto ? Factura.safeParse(JSON.parse(texto)) : null; } catch { parsed = null; }
    if (!parsed?.success) {
      return res.status(502).json({ error: "La lectura no fue concluyente. Probá con una imagen más nítida." });
    }
    return res.status(200).json({ datos: parsed.data, ms: Date.now() - inicio });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: "Hay mucha demanda en este momento. Probá de nuevo en un minuto." });
    }
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      console.error("Credenciales de Anthropic inválidas o ausentes", err.status);
      return res.status(503).json({ error: "La demo no está disponible en este momento." });
    }
    if (err instanceof Anthropic.BadRequestError) {
      console.error("Solicitud rechazada", err.message);
      return res.status(400).json({ error: "No pudimos leer este archivo. Probá con otro formato." });
    }
    if (err instanceof Anthropic.APIError) {
      console.error("Error de la API", err.status, err.message);
      return res.status(502).json({ error: "El servicio de IA no respondió. Probá de nuevo en un momento." });
    }
    console.error(err);
    return res.status(500).json({ error: "Ocurrió un error inesperado." });
  }
}
