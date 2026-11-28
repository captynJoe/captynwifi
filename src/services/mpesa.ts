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

export interface DarajaStkQueryResponse {
  MerchantRequestID?: string;
  CheckoutRequestID?: string;
  ResponseCode?: string;
  ResponseDescription?: string;
  ResultCode?: string | number;
  ResultDesc?: string;
  [key: string]: unknown;
}

let cachedAccessToken: { token: string; expiresAtMs: number } | null = null;

export function formatDarajaMsisdn(input: string): string | null {
  if (!input) return null;
  const cleaned = input.replace(/[^\d+]/g, "").replace(/^\++/, "+");
  const digits = cleaned.startsWith("+") ? cleaned.slice(1) : cleaned;
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  if (/^2540[17]\d{8}$/.test(digits)) return `254${digits.slice(4)}`;
  if (/^0[17]\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^[17]\d{8}$/.test(digits)) return `254${digits}`;
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

export function isSuccessfulStkQuery(response: DarajaStkQueryResponse | null | undefined, checkoutRequestId: string) {
  if (!response || response.CheckoutRequestID !== checkoutRequestId) return false;
  return Number(response.ResultCode) === 0;
}

// Daraja rate-limits STK queries (429). The reconciler checked up to 25
// payments in a burst every 90 s, so callbacks -- where a customer is
// waiting -- got throttled too. Queries are now spaced >= 1 s apart; a 429
// starts a back-off (30 s, doubling to 5 min, reset on success) during which
// background checks don't run. Callback checks always go through.
export class MpesaThrottledError extends Error {}
const STK_QUERY_SPACING_MS = 1000;
let stkCooldownUntil = 0;
let stkBackoffMs = 0;
let stkNextSlot = 0;

export function nextStkBackoffMs(previousMs: number) {
  return Math.min(300_000, Math.max(30_000, previousMs * 2));
}

export async function queryWifiStkPush(checkoutRequestId: string, { background = false } = {}): Promise<DarajaStkQueryResponse> {
  const status = getMpesaStatus();
  if (!status.configured) {
    throw new Error(`M-PESA is not configured for CAPTYN WiFi: ${status.missing.join(", ")}`);
  }
  if (background && Date.now() < stkCooldownUntil) {
    throw new MpesaThrottledError("M-PESA STK query backing off after 429");
  }
  const slot = Math.max(Date.now(), stkNextSlot);
  stkNextSlot = slot + STK_QUERY_SPACING_MS;
  if (slot > Date.now()) await new Promise((resolve) => setTimeout(resolve, slot - Date.now()));

  const token = await getAccessToken();
  const timestamp = toTimestamp();
  const payload = {
    BusinessShortCode: config.mpesa.shortCode,
    Password: buildPassword(timestamp),
    Timestamp: timestamp,
    CheckoutRequestID: checkoutRequestId
  };

  const response = await fetch(`${config.mpesa.baseUrl}/mpesa/stkpushquery/v1/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(12000)
  });
  const body = await parseJsonSafely<DarajaStkQueryResponse>(response);
  if (response.status === 429) {
    stkBackoffMs = nextStkBackoffMs(stkBackoffMs);
    stkCooldownUntil = Date.now() + stkBackoffMs;
    throw new MpesaThrottledError(`M-PESA STK query failed (429); background checks paused ${Math.round(stkBackoffMs / 1000)} s`);
  }
  if (!response.ok || !body) throw new Error(`M-PESA STK query failed (${response.status})`);
  stkBackoffMs = 0;

  console.log(
    `M-PESA STK query checked: checkoutRequestId=${checkoutRequestId} ` +
      `responseCode=${body.ResponseCode ?? "-"} resultCode=${body.ResultCode ?? "-"} ` +
      `resultDesc=${body.ResultDesc ?? body.ResponseDescription ?? "-"}`
  );

  return body;
}
