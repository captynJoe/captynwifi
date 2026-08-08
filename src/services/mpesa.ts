import { config } from "../config.js";

export interface StkPushRequest {
  amount: number;
  phoneNumber: string;
  accountReference: string;
  transactionDesc: string;
  callbackUrl?: string;
}

export interface DarajaStkPushResponse {
  MerchantRequestID?: string;
  CheckoutRequestID?: string;
  ResponseCode?: string;
  ResponseDescription?: string;
  CustomerMessage?: string;
  [key: string]: unknown;
}

let cachedAccessToken: { token: string; expiresAtMs: number } | null = null;

export function formatDarajaMsisdn(input: string): string | null {
  if (!input) return null;
  const cleaned = input.replace(/[^\d+]/g, "");
  if (cleaned.startsWith("+254") && cleaned.length === 13) return cleaned.slice(1);
  if (cleaned.startsWith("254") && cleaned.length === 12) return cleaned;
  if (cleaned.startsWith("0") && cleaned.length === 10) return `254${cleaned.slice(1)}`;
  return null;
}

function requiredMpesaMissing() {
  const required: Array<[string, string]> = [
    ["MPESA_CONSUMER_KEY", config.mpesa.consumerKey],
    ["MPESA_CONSUMER_SECRET", config.mpesa.consumerSecret],
    ["MPESA_BUSINESS_SHORT_CODE", config.mpesa.shortCode],
    ["MPESA_PASSKEY", config.mpesa.passkey],
    ["MPESA_CALLBACK_URL", config.mpesa.callbackUrl]
  ];
  return required.filter(([, value]) => !value || value.includes("change-me")).map(([name]) => name);
}

export function getMpesaStatus() {
  const missing = requiredMpesaMissing();
  return { enabled: config.mpesa.enabled, configured: config.mpesa.enabled && missing.length === 0, missing };
}

async function parseJsonSafely<T>(response: Response): Promise<T | null> {
  const raw = await response.text();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch (_error) {
    return null;
  }
}

function toTimestamp(date = new Date()): string {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}${hh}${min}${ss}`;
}

async function getAccessToken() {
  const now = Date.now();
  if (cachedAccessToken && now < cachedAccessToken.expiresAtMs) return cachedAccessToken.token;

  const auth = Buffer.from(`${config.mpesa.consumerKey}:${config.mpesa.consumerSecret}`).toString("base64");
  const response = await fetch(`${config.mpesa.baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
    method: "GET",
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(12000)
  });
  const payload = await parseJsonSafely<{ access_token?: string; expires_in?: number | string; errorMessage?: string; error_description?: string }>(response);
  if (!response.ok || !payload?.access_token) {
    throw new Error(payload?.errorMessage || payload?.error_description || `Failed to obtain Daraja access token (${response.status})`);
  }

  const expiresInSeconds = Math.max(60, Number.parseInt(String(payload.expires_in || 3600), 10) || 3600);
  cachedAccessToken = { token: payload.access_token, expiresAtMs: Date.now() + Math.max(60, expiresInSeconds - 60) * 1000 };
  return payload.access_token;
}

function buildPassword(timestamp: string) {
  return Buffer.from(`${config.mpesa.shortCode}${config.mpesa.passkey}${timestamp}`).toString("base64");
}

export async function initiateWifiStkPush(request: StkPushRequest): Promise<DarajaStkPushResponse> {
  const status = getMpesaStatus();
  if (!status.configured) {
    throw new Error(`M-PESA is not configured for CAPTYN WiFi: ${status.missing.join(", ")}`);
  }

  const token = await getAccessToken();
  const timestamp = toTimestamp();
  const payload = {
    BusinessShortCode: config.mpesa.shortCode,
    Password: buildPassword(timestamp),
    Timestamp: timestamp,
    TransactionType: config.mpesa.transactionType,
    Amount: Math.round(request.amount),
    PartyA: request.phoneNumber,
    PartyB: config.mpesa.partyB || config.mpesa.shortCode,
    PhoneNumber: request.phoneNumber,
    CallBackURL: request.callbackUrl || config.mpesa.callbackUrl,
    AccountReference: request.accountReference,
    TransactionDesc: request.transactionDesc
  };

  const response = await fetch(`${config.mpesa.baseUrl}/mpesa/stkpush/v1/processrequest`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(12000)
  });
  const body = await parseJsonSafely<DarajaStkPushResponse>(response);
  if (!response.ok || !body) throw new Error(`M-PESA STK push failed (${response.status})`);

  console.log(
    `M-PESA STK push sent: phone=${request.phoneNumber} amount=${request.amount} ` +
      `checkoutRequestId=${body.CheckoutRequestID ?? "-"} responseCode=${body.ResponseCode ?? "-"} ` +
      `responseDesc=${body.ResponseDescription ?? "-"}`
  );

  return body;
}
