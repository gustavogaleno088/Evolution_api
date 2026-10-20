// Cliente mínimo da Evolution API v2 (usa o fetch nativo do Node 18+).

const BASE_URL = (process.env.EVOLUTION_URL ?? "http://localhost:8080").replace(/\/$/, "");
const API_KEY = process.env.EVOLUTION_API_KEY ?? "";
const INSTANCE = process.env.EVOLUTION_INSTANCE ?? "meu-whatsapp";

export type MediaType = "image" | "video" | "audio" | "document";

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", apikey: API_KEY },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(`Evolution API ${res.status}`), { status: res.status, data });
  }
  return data as T;
}

/** Aceita "(11) 99999-9999", "5511999999999" etc. e devolve só dígitos com DDI 55. */
export function normalizeNumber(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.length <= 11 ? `55${digits}` : digits;
}

export function sendText(number: string, text: string, instance = INSTANCE) {
  return call("POST", `/message/sendText/${instance}`, {
    number: normalizeNumber(number),
    text,
  });
}

export function sendMedia(
  params: {
    number: string;
    mediatype: MediaType;
    media: string; // URL pública ou base64 (sem o prefixo data:)
    mimetype?: string;
    caption?: string;
    fileName?: string;
  },
  instance = INSTANCE,
) {
  return call("POST", `/message/sendMedia/${instance}`, {
    ...params,
    number: normalizeNumber(params.number),
  });
}

export function sendAudio(number: string, audio: string, instance = INSTANCE) {
  // Envia como áudio de voz (PTT), como se fosse gravado no app.
  return call("POST", `/message/sendWhatsAppAudio/${instance}`, {
    number: normalizeNumber(number),
    audio,
  });
}

export function connectionState(instance = INSTANCE) {
  return call("GET", `/instance/connectionState/${instance}`);
}

// ---------- Gestão de instâncias (usado pelo dashboard) ----------

export interface EvolutionInstance {
  name: string;
  connectionStatus: string;
  ownerJid: string | null;
  profileName: string | null;
  profilePicUrl: string | null;
  integration: string;
  token?: string;
  disconnectionReasonCode: number | null;
  disconnectionAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function serverInfo() {
  return call<{ version: string; whatsappWebVersion?: string }>("GET", "/");
}

export function fetchInstances() {
  return call<EvolutionInstance[]>("GET", "/instance/fetchInstances");
}

export function createInstance(instanceName: string) {
  return call<{ qrcode?: { base64?: string; pairingCode?: string } }>("POST", "/instance/create", {
    instanceName,
    qrcode: true,
    integration: "WHATSAPP-BAILEYS",
  });
}

/** Devolve o QR (base64) ou, com number, um código de pareamento. */
export function connectInstance(instance: string, number?: string) {
  const query = number ? `?number=${normalizeNumber(number)}` : "";
  return call<{ base64?: string; pairingCode?: string; instance?: { state: string } }>(
    "GET",
    `/instance/connect/${instance}${query}`,
  );
}

export function logoutInstance(instance: string) {
  return call("DELETE", `/instance/logout/${instance}`);
}

export function restartInstance(instance: string) {
  return call("POST", `/instance/restart/${instance}`);
}

export function deleteInstance(instance: string) {
  return call("DELETE", `/instance/delete/${instance}`);
}

export function findWebhook(instance: string) {
  return call<{ url?: string; enabled?: boolean; events?: string[] } | null>("GET", `/webhook/find/${instance}`);
}

export function setWebhook(instance: string, url: string) {
  return call("POST", `/webhook/set/${instance}`, {
    webhook: {
      enabled: true,
      url,
      webhookByEvents: false,
      webhookBase64: false,
      // Só o que o sistema envia e o estado da conexão; nunca as mensagens recebidas.
      events: ["SEND_MESSAGE", "CONNECTION_UPDATE"],
    },
  });
}
