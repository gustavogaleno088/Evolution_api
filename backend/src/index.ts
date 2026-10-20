import "dotenv/config";
import fs from "fs";
import os from "os";
import path from "path";
import express, { NextFunction, Request, Response } from "express";
import {
  connectInstance,
  connectionState,
  createInstance,
  deleteInstance,
  fetchInstances,
  findWebhook,
  logoutInstance,
  MediaType,
  restartInstance,
  sendAudio,
  sendMedia,
  sendText,
  serverInfo,
  setWebhook,
} from "./evolution";

const app = express();
// Webhooks com mídia em base64 podem ser grandes.
app.use(express.json({ limit: "50mb" }));

const PORT = Number(process.env.PORT ?? 3000);
const BACKEND_TOKEN = process.env.BACKEND_TOKEN ?? "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "";
// Endereço que a Evolution (em container) usa para chegar neste backend.
const WEBHOOK_URL =
  process.env.WEBHOOK_URL ??
  `http://172.17.0.1:${PORT}/webhook/evolution${WEBHOOK_SECRET ? `?secret=${WEBHOOK_SECRET}` : ""}`;

function requireToken(req: Request, res: Response, next: NextFunction) {
  if (BACKEND_TOKEN && req.header("x-api-token") !== BACKEND_TOKEN) {
    return res.status(401).json({ error: "token inválido" });
  }
  next();
}

// O dashboard mexe nas instâncias: exige token sempre, mesmo se BACKEND_TOKEN estiver vazio.
function requireDashboardToken(req: Request, res: Response, next: NextFunction) {
  if (!BACKEND_TOKEN) return res.status(503).json({ error: "defina BACKEND_TOKEN no .env" });
  if (req.header("x-api-token") !== BACKEND_TOKEN) return res.status(401).json({ error: "token inválido" });
  next();
}

function handleError(res: Response, err: unknown) {
  const e = err as { status?: number; data?: unknown; message?: string };
  console.error("[erro]", e.message, JSON.stringify(e.data ?? {}));
  res.status(e.status ?? 500).json({ error: e.message, details: e.data });
}

const VALID_NAME = /^[a-zA-Z0-9_-]{1,40}$/;

function instanceParam(req: Request, res: Response): string | null {
  const name = req.params.name;
  if (!VALID_NAME.test(name)) {
    res.status(400).json({ error: "nome de instância inválido" });
    return null;
  }
  return name;
}

// ---------- Eventos recentes (memória) para o dashboard ----------
// Privacidade: o webhook só assina SEND_MESSAGE (mensagens enviadas pela API, ou seja,
// pelo sistema) e CONNECTION_UPDATE. As conversas pessoais do celular conectado
// nunca chegam aqui; se chegarem (webhook antigo), são descartadas sem registro.

interface RecentEvent {
  at: string;
  instance: string;
  event: string;
  to?: string;
  type?: string;
  text?: string;
  state?: string;
}

const MAX_EVENTS = 100;
const recentEvents: RecentEvent[] = [];
const startedAt = Date.now();
let sentCount = 0;

/** 5588994396389 -> 55 88 9****-6389 */
function maskNumber(jid: string): string {
  const n = jid.split("@")[0].replace(/\D/g, "");
  if (n.length < 8) return "****";
  return `${n.slice(0, 2)} ${n.slice(2, 4)} ${n.slice(4, 5)}****-${n.slice(-4)}`;
}

function recordEvent(payload: any): RecentEvent | null {
  const d = payload.data ?? {};
  const item: RecentEvent = { at: new Date().toISOString(), instance: payload.instance, event: payload.event };
  if (payload.event === "send.message") {
    sentCount++;
    item.to = maskNumber(d.key?.remoteJid ?? "");
    item.type = d.messageType;
    const text: string | undefined = d.message?.conversation ?? d.message?.extendedTextMessage?.text;
    if (text) item.text = text.split("\n")[0].slice(0, 120);
  } else if (payload.event === "connection.update") {
    item.state = d.state;
  } else {
    return null;
  }
  recentEvents.unshift(item);
  recentEvents.length = Math.min(recentEvents.length, MAX_EVENTS);
  return item;
}

// ---------- Rotas públicas / de integração ----------

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/whatsapp/status", requireToken, async (_req, res) => {
  try {
    res.json(await connectionState());
  } catch (err) {
    handleError(res, err);
  }
});

// POST /messages/text  { "number": "5511999999999", "text": "Olá!" }
app.post("/messages/text", requireToken, async (req, res) => {
  const { number, text } = req.body ?? {};
  if (!number || !text) return res.status(400).json({ error: "number e text são obrigatórios" });
  try {
    res.json(await sendText(String(number), String(text)));
  } catch (err) {
    handleError(res, err);
  }
});

// POST /messages/media
// { "number": "...", "mediatype": "image|video|audio|document", "media": "https://... ou base64",
//   "caption": "opcional", "fileName": "opcional.pdf", "mimetype": "opcional" }
app.post("/messages/media", requireToken, async (req, res) => {
  const { number, mediatype, media, caption, fileName, mimetype } = req.body ?? {};
  const types: MediaType[] = ["image", "video", "audio", "document"];
  if (!number || !media || !types.includes(mediatype)) {
    return res.status(400).json({ error: "number, media e mediatype (image|video|audio|document) são obrigatórios" });
  }
  try {
    const result =
      mediatype === "audio"
        ? await sendAudio(String(number), String(media))
        : await sendMedia({ number: String(number), mediatype, media, caption, fileName, mimetype });
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

// Webhook da Evolution (eventos SEND_MESSAGE e CONNECTION_UPDATE, webhookByEvents=false):
//   http://SEU_IP:3000/webhook/evolution?secret=...
app.post("/webhook/evolution", (req, res) => {
  if (WEBHOOK_SECRET && req.query.secret !== WEBHOOK_SECRET) return res.sendStatus(401);

  // Responde rápido; a Evolution reenvia se demorar/der erro.
  res.sendStatus(200);

  const item = recordEvent(req.body ?? {});
  if (item?.event === "send.message") console.log(`[envio] ${item.instance} -> ${item.to} (${item.type})`);
  if (item?.event === "connection.update") console.log(`[conexão] ${item.instance}: ${item.state}`);
});

// ---------- Dashboard ----------

app.get("/", (_req, res) => res.redirect("/dashboard/"));
app.use("/dashboard", express.static(path.join(__dirname, "..", "public"), { index: "dashboard.html" }));

const api = express.Router();
api.use(requireDashboardToken);

// No Linux, MemAvailable conta o cache como livre (os.freemem() não).
function availableMemory(): number {
  try {
    const m = fs.readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+) kB/m);
    if (m) return Number(m[1]) * 1024;
  } catch {
    // fora do Linux
  }
  return os.freemem();
}

api.get("/overview", async (_req, res) => {
  let evolution: { online: boolean; version?: string; whatsappWebVersion?: string } = { online: false };
  try {
    const info = await serverInfo();
    evolution = { online: true, version: info.version, whatsappWebVersion: info.whatsappWebVersion };
  } catch {
    // Evolution fora do ar: o dashboard mostra offline
  }
  res.json({
    evolution,
    backend: { uptimeSec: Math.round((Date.now() - startedAt) / 1000), sentCount },
    server: {
      hostname: os.hostname(),
      uptimeSec: Math.round(os.uptime()),
      load: os.loadavg(),
      cpus: os.cpus().length,
      memTotal: os.totalmem(),
      memFree: availableMemory(),
    },
  });
});

api.get("/instances", async (_req, res) => {
  try {
    const list = await fetchInstances();
    // Nunca devolve o token da instância para o navegador.
    res.json(
      list.map((i) => ({
        name: i.name,
        status: i.connectionStatus,
        number: i.ownerJid?.split("@")[0] ?? null,
        profileName: i.profileName,
        profilePicUrl: i.profilePicUrl,
        integration: i.integration,
        disconnectionReasonCode: i.disconnectionReasonCode,
        disconnectionAt: i.disconnectionAt,
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
      })),
    );
  } catch (err) {
    handleError(res, err);
  }
});

api.post("/instances", async (req, res) => {
  const name = String(req.body?.name ?? "");
  if (!VALID_NAME.test(name)) {
    return res.status(400).json({ error: "use só letras, números, - e _ (até 40)" });
  }
  try {
    const created = await createInstance(name);
    await setWebhook(name, WEBHOOK_URL);
    res.json({ name, qr: created.qrcode?.base64 ?? null });
  } catch (err) {
    handleError(res, err);
  }
});

api.get("/instances/:name/connect", async (req, res) => {
  const name = instanceParam(req, res);
  if (!name) return;
  try {
    const number = typeof req.query.number === "string" ? req.query.number : undefined;
    const r = await connectInstance(name, number);
    res.json({ qr: r.base64 ?? null, pairingCode: r.pairingCode ?? null, state: r.instance?.state ?? null });
  } catch (err) {
    handleError(res, err);
  }
});

api.get("/instances/:name/webhook", async (req, res) => {
  const name = instanceParam(req, res);
  if (!name) return;
  try {
    const w = await findWebhook(name);
    // Esconde o ?secret= da URL.
    res.json(w ? { enabled: w.enabled, url: w.url?.split("?")[0], events: w.events } : null);
  } catch (err) {
    handleError(res, err);
  }
});

api.post("/instances/:name/webhook", async (req, res) => {
  const name = instanceParam(req, res);
  if (!name) return;
  try {
    await setWebhook(name, WEBHOOK_URL);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});

api.post("/instances/:name/restart", async (req, res) => {
  const name = instanceParam(req, res);
  if (!name) return;
  try {
    res.json(await restartInstance(name));
  } catch (err) {
    handleError(res, err);
  }
});

api.post("/instances/:name/logout", async (req, res) => {
  const name = instanceParam(req, res);
  if (!name) return;
  try {
    res.json(await logoutInstance(name));
  } catch (err) {
    handleError(res, err);
  }
});

api.delete("/instances/:name", async (req, res) => {
  const name = instanceParam(req, res);
  if (!name) return;
  try {
    res.json(await deleteInstance(name));
  } catch (err) {
    handleError(res, err);
  }
});

api.post("/instances/:name/test", async (req, res) => {
  const name = instanceParam(req, res);
  if (!name) return;
  const { number, text } = req.body ?? {};
  if (!number || !text) return res.status(400).json({ error: "number e text são obrigatórios" });
  try {
    res.json(await sendText(String(number), String(text), name));
  } catch (err) {
    handleError(res, err);
  }
});

api.get("/events", (req, res) => {
  const instance = typeof req.query.instance === "string" ? req.query.instance : "";
  res.json(instance ? recentEvents.filter((e) => e.instance === instance) : recentEvents);
});

app.use("/api", api);

app.listen(PORT, "0.0.0.0", () => console.log(`Backend ouvindo em http://0.0.0.0:${PORT}`));
