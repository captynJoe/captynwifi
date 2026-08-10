import net from "node:net";
import { config } from "../config.js";

export type RouterSessionKickResult = {
  enabled: boolean;
  attempted: boolean;
  removed: number;
  skippedReason?: string;
  error?: string;
};

type RouterSentence = {
  type: string;
  attrs: Record<string, string>;
};

function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  if (length < 0x4000) return Buffer.from([(length >> 8) | 0x80, length & 0xff]);
  if (length < 0x200000) return Buffer.from([(length >> 16) | 0xc0, (length >> 8) & 0xff, length & 0xff]);
  if (length < 0x10000000) {
    return Buffer.from([(length >> 24) | 0xe0, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]);
  }
  return Buffer.from([0xf0, (length >> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]);
}

function decodeLength(buffer: Buffer, offset: number) {
  if (offset >= buffer.length) return null;
  const first = buffer[offset];
  if ((first & 0x80) === 0) return { length: first, bytes: 1 };
  if ((first & 0xc0) === 0x80) {
    if (offset + 1 >= buffer.length) return null;
    return { length: ((first & ~0xc0) << 8) + buffer[offset + 1], bytes: 2 };
  }
  if ((first & 0xe0) === 0xc0) {
    if (offset + 2 >= buffer.length) return null;
    return { length: ((first & ~0xe0) << 16) + (buffer[offset + 1] << 8) + buffer[offset + 2], bytes: 3 };
  }
  if ((first & 0xf0) === 0xe0) {
    if (offset + 3 >= buffer.length) return null;
    return { length: ((first & ~0xf0) << 24) + (buffer[offset + 1] << 16) + (buffer[offset + 2] << 8) + buffer[offset + 3], bytes: 4 };
  }
  if (offset + 4 >= buffer.length) return null;
  return { length: (buffer[offset + 1] << 24) + (buffer[offset + 2] << 16) + (buffer[offset + 3] << 8) + buffer[offset + 4], bytes: 5 };
}

function encodeSentence(words: string[]) {
  const parts: Buffer[] = [];
  for (const word of words) {
    const payload = Buffer.from(word, "utf8");
    parts.push(encodeLength(payload.length), payload);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function parseWords(words: string[]): RouterSentence {
  const [type = ""] = words;
  const attrs: Record<string, string> = {};
  for (const word of words.slice(1)) {
    if (!word.startsWith("=")) continue;
    const secondEquals = word.indexOf("=", 1);
    if (secondEquals === -1) continue;
    attrs[word.slice(1, secondEquals)] = word.slice(secondEquals + 1);
  }
  return { type, attrs };
}

class RouterOsApiClient {
  private socket: net.Socket | null = null;
  private buffer = Buffer.alloc(0);
  private pending: RouterSentence[][] = [];
  private current: string[] = [];

  async connect() {
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: config.routeros.host, port: config.routeros.port }, resolve);
      const timer = setTimeout(() => {
        socket.destroy(new Error("RouterOS API connection timed out"));
      }, config.routeros.timeoutMs);
      socket.on("data", (chunk) => this.onData(chunk));
      socket.on("error", reject);
      socket.on("close", () => clearTimeout(timer));
      this.socket = socket;
    });
  }

  close() {
    this.socket?.end();
    this.socket = null;
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let offset = 0;
    for (;;) {
      const decoded = decodeLength(this.buffer, offset);
      if (!decoded) break;
      if (this.buffer.length < offset + decoded.bytes + decoded.length) break;
      offset += decoded.bytes;
      if (decoded.length === 0) {
        const sentence = parseWords(this.current);
        this.current = [];
        const last = this.pending[this.pending.length - 1] ?? [];
        last.push(sentence);
        if (sentence.type === "!done" || sentence.type === "!fatal") {
          this.pending.push([]);
        }
      } else {
        this.current.push(this.buffer.slice(offset, offset + decoded.length).toString("utf8"));
        offset += decoded.length;
      }
    }
    this.buffer = this.buffer.slice(offset);
  }

  async command(words: string[]) {
    const socket = this.socket;
    if (!socket) throw new Error("RouterOS API is not connected");
    const bucket: RouterSentence[] = [];
    this.pending.push(bucket);
    socket.write(encodeSentence(words));

    const deadline = Date.now() + config.routeros.timeoutMs;
    while (Date.now() < deadline) {
      if (bucket.some((sentence) => sentence.type === "!done" || sentence.type === "!fatal")) {
        const trap = bucket.find((sentence) => sentence.type === "!trap" || sentence.type === "!fatal");
        if (trap) throw new Error(trap.attrs.message || trap.type);
        return bucket;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("RouterOS API command timed out");
  }

  async login() {
    await this.command(["/login", `=name=${config.routeros.username}`, `=password=${config.routeros.password}`]);
  }
}

function missingRouterConfig() {
  if (!config.routeros.enabled) return "RouterOS API automation is disabled.";
  if (!config.routeros.host) return "RouterOS API host is not configured.";
  if (!config.routeros.username || !config.routeros.password) return "RouterOS API credentials are not configured.";
  return null;
}

export async function kickHotspotUser(username: string): Promise<RouterSessionKickResult> {
  const skippedReason = missingRouterConfig();
  if (skippedReason) return { enabled: config.routeros.enabled, attempted: false, removed: 0, skippedReason };

  const client = new RouterOsApiClient();
  try {
    await client.connect();
    await client.login();
    const sessions = await client.command(["/ip/hotspot/active/print", `?user=${username}`]);
    const ids = sessions
      .filter((sentence) => sentence.type === "!re" && sentence.attrs[".id"])
      .map((sentence) => sentence.attrs[".id"]);

    let removed = 0;
    for (const id of ids) {
      await client.command(["/ip/hotspot/active/remove", `=numbers=${id}`]);
      removed += 1;
    }
    return { enabled: true, attempted: true, removed };
  } catch (error) {
    return { enabled: true, attempted: true, removed: 0, error: error instanceof Error ? error.message : "RouterOS API action failed" };
  } finally {
    client.close();
  }
}
