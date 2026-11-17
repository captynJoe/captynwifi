function isJsonObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export async function readApiJson(response, fallbackMessage) {
    const body = await response.text();
    let payload;
    try {
        payload = JSON.parse(body);
    }
    catch {
        payload = undefined;
    }
    if (!response.ok) {
        if (isJsonObject(payload)) {
            const message = [payload.error, payload.message].find((value) => typeof value === "string" && value.trim().length > 0);
            if (message)
                throw new Error(message);
        }
        if (response.status === 429) {
            throw new Error("CAPTYN WiFi is temporarily busy. Please wait a moment and try again.");
        }
        throw new Error(`${fallbackMessage} (HTTP ${response.status}).`);
    }
    if (!isJsonObject(payload)) {
        throw new Error("CAPTYN WiFi returned an unexpected response. Please refresh and try again.");
    }
    return payload;
}
