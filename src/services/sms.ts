import { config } from "../config.js";

// WiFi's own SMS sender (TalkSasa), for sign-in codes. Throws when it can't
// send, so the portal can say so instead of waiting for a code that never comes.

export function smsConfigured() {
  return Boolean(config.sms.talksasaApiToken && config.sms.senderId);
}

export async function sendSms(phone254: string, message: string) {
  if (!smsConfigured()) throw new Error("SMS is not configured");
  const response = await fetch(`${config.sms.talksasaBaseUrl}/sms/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.sms.talksasaApiToken}`, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: phone254, sender_id: config.sms.senderId, type: "plain", message: message.slice(0, 160) }),
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`TalkSasa ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
}
