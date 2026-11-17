type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readApiJson<T extends JsonObject>(
  response: Response,
  fallbackMessage: string,
): Promise<T> {
  const body = await response.text();
  let payload: unknown;

  try {
    payload = JSON.parse(body);
  } catch {
    payload = undefined;
  }

  if (!response.ok) {
    if (isJsonObject(payload)) {
      const message = [payload.error, payload.message].find(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      );
      if (message) throw new Error(message);
    }

    if (response.status === 429) {
      throw new Error("CAPTYN WiFi is temporarily busy. Please wait a moment and try again.");
    }
    throw new Error(`${fallbackMessage} (HTTP ${response.status}).`);
  }

  if (!isJsonObject(payload)) {
    throw new Error("CAPTYN WiFi returned an unexpected response. Please refresh and try again.");
  }

  return payload as T;
}
