import https from "node:https";
import { config } from "../config.js";
import type { RadioObservation } from "./deviceRegistry.js";

// Read-only Omada Open API client for the device collector. The controller
// runs on the owner's PC behind the router (self-signed certificate), so it
// is often unreachable; callers get null and record nothing rather than guess.

let token: { value: string; expiresAt: number } | null = null;

function request<T>(method: "GET" | "POST", path: string, body?: unknown, accessToken?: string): Promise<T> {
  const url = new URL(path, config.omada.url);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method,
        // The controller's certificate is self-signed; it's only reached over the VPN.
        rejectUnauthorized: false,
        timeout: 15000,
        headers: {
          "Content-Type": "application/json",
          ...(accessToken ? { Authorization: `AccessToken=${accessToken}` } : {}),
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {})
        }
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode && res.statusCode >= 400) return reject(new Error(`Omada ${res.statusCode}`));
            resolve(parsed as T);
          } catch {
            reject(new Error(`Omada ${res.statusCode}: unreadable response`));
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("Omada request timed out")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export function omadaConfigured() {
  const o = config.omada;
  return Boolean(o.url && o.omadacId && o.siteId && o.clientId && o.clientSecret);
}

async function accessToken(): Promise<string> {
  if (token && token.expiresAt > Date.now() + 60_000) return token.value;
  const o = config.omada;
  const response = await request<{ errorCode: number; msg?: string; result?: { accessToken: string; expiresIn: number } }>(
    "POST",
    "/openapi/authorize/token?grant_type=client_credentials",
    { omadacId: o.omadacId, client_id: o.clientId, client_secret: o.clientSecret }
  );
  if (response.errorCode !== 0 || !response.result) throw new Error(`Omada token: ${response.msg ?? response.errorCode}`);
  token = { value: response.result.accessToken, expiresAt: Date.now() + response.result.expiresIn * 1000 };
  return token.value;
}

type OmadaClient = { mac?: string; wireless?: boolean; apMac?: string; apName?: string; ssid?: string; radioId?: number; rssi?: number };

// Wireless clients Omada sees right now, by MAC ("AA:BB:..."). null = Omada
// not configured or not reachable this round.
export async function listOmadaRadios(): Promise<Map<string, RadioObservation> | null> {
  if (!omadaConfigured()) return null;
  try {
    const at = await accessToken();
    const o = config.omada;
    const radios = new Map<string, RadioObservation>();
    for (let page = 1; page <= 10; page += 1) {
      const response = await request<{ errorCode: number; result?: { data?: OmadaClient[]; totalRows?: number } }>(
        "GET", `/openapi/v1/${o.omadacId}/sites/${o.siteId}/clients?page=${page}&pageSize=200`, undefined, at
      );
      if (response.errorCode !== 0) throw new Error(`Omada clients: ${response.errorCode}`);
      const rows = response.result?.data ?? [];
      for (const row of rows) {
        if (!row.mac || !row.wireless || !row.apMac) continue;
        radios.set(row.mac.replace(/-/g, ":").toUpperCase(), {
          apMac: row.apMac,
          apName: row.apName ?? null,
          ssid: row.ssid ?? null,
          band: row.radioId === 0 ? "2.4" : row.radioId === 1 ? "5" : row.radioId === 2 ? "5-2" : null,
          rssi: typeof row.rssi === "number" ? row.rssi : null
        });
      }
      if (rows.length < 200) break;
    }
    return radios;
  } catch (error) {
    token = null;
    console.warn("[DeviceCollector] Omada unavailable:", error instanceof Error ? error.message : error);
    return null;
  }
}
