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


export type RouterCapacityStatus = {
  configured: boolean;
  connected: boolean;
  generatedAt: string;
  error?: string;
  wan: { interface: string; status: string; rate: string; rateMbps: number | null; rxMbps: number | null; txMbps: number | null };
  ethernet: Array<{ name: string; status: string; rate: string; rateMbps: number | null; fullDuplex: boolean | null; partnerAdvertising: string }>;
  queues: Array<{ name: string; target: string; limitAt: string; maxLimit: string; rate: string }>;
  queueSummary: { activeCount: number; guaranteedUploadMbps: number; guaranteedDownloadMbps: number };
};

function sentencesToRows(sentences: RouterSentence[]) {
  return sentences.filter((sentence) => sentence.type === "!re").map((sentence) => sentence.attrs);
}

export type RouterOutageProbe = {
  configured: boolean;
  routerReachable: boolean;
  wanLinkUp: boolean | null;
  internetReachable: boolean | null;
  reachableTargets: string[];
  checkedAt: string;
  error?: string;
};

/**
 * Read-only outage corroboration. A silent RADIUS accounting stream alone is
 * ambiguous; this checks the MikroTik WAN link and two independent public IPs.
 * API failures are unknown, never evidence that the customer network is down.
 */
export async function probeRouterOutageHealth(): Promise<RouterOutageProbe> {
  const checkedAt = new Date().toISOString();
  const missingConfig = missingRouterConfig();
  const unavailable: RouterOutageProbe = {
    configured: !missingConfig,
    routerReachable: false,
    wanLinkUp: null,
    internetReachable: null,
    reachableTargets: [],
    checkedAt,
    error: missingConfig || undefined
  };
  if (!unavailable.configured) return unavailable;

  const client = new RouterOsApiClient();
  try {
    await client.connect();
    await client.login();

    const wanRow = sentencesToRows(await client.command([
      "/interface/ethernet/monitor", "=numbers=ether1", "=once="
    ]))[0] || {};
    const wanLinkUp = wanRow.status === "link-ok"
      ? true
      : wanRow.status === "no-link"
        ? false
        : wanRow.running === "true"
          ? true
          : wanRow.running === "false"
            ? false
            : null;
    const reachableTargets: string[] = [];

    if (wanLinkUp !== false) {
      for (const address of ["1.1.1.1", "8.8.8.8"]) {
        const sentences = await client.command([
          "/ping", `=address=${address}`, "=count=2", "=interval=250ms"
        ]);
        const rows = sentencesToRows(sentences);
        const done = sentences.find((sentence) => sentence.type === "!done");
        const reportedReceived = Number(done?.attrs.received);
        const replies = Number.isFinite(reportedReceived)
          ? reportedReceived
          : rows.filter((row) => row.status !== "timeout" && (row.time !== undefined || row.ttl !== undefined)).length;
        if (replies > 0) reachableTargets.push(address);
      }
    }

    client.close();
    return {
      configured: true,
      routerReachable: true,
      wanLinkUp,
      internetReachable: wanLinkUp === false ? false : reachableTargets.length > 0,
      reachableTargets,
      checkedAt
    };
  } catch (error) {
    client.close();
    return {
      ...unavailable,
      routerReachable: false,
      error: error instanceof Error ? error.message : "RouterOS outage probe failed"
    };
  }
}

function rateMbps(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.trim().match(/^([\d.]+)\s*(k|M|G)?(?:bps)?$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = (match[2] || "").toLowerCase();
  if (!Number.isFinite(amount)) return null;
  return amount * (unit === "g" ? 1000 : unit === "m" ? 1 : unit === "k" ? 0.001 : 0.000001);
}

function ratePairMbps(value: string | undefined) {
  const [upload = "", download = ""] = (value || "").split("/");
  return { upload: rateMbps(upload), download: rateMbps(download) };
}

/** Read-only live link, WAN traffic and active simple-queue capacity snapshot. */
export async function getRouterCapacityStatus(): Promise<RouterCapacityStatus> {
  const generatedAt = new Date().toISOString();
  const missingConfig = missingRouterConfig();
  const unavailable: RouterCapacityStatus = {
    configured: !missingConfig,
    connected: false,
    generatedAt,
    error: missingConfig || undefined,
    wan: { interface: "ether1", status: "unknown", rate: "", rateMbps: null, rxMbps: null, txMbps: null },
    ethernet: [],
    queues: [],
    queueSummary: { activeCount: 0, guaranteedUploadMbps: 0, guaranteedDownloadMbps: 0 }
  };
  if (!unavailable.configured) return unavailable;

  const client = new RouterOsApiClient();
  try {
    await client.connect();
    await client.login();
    const ethernet: RouterCapacityStatus["ethernet"] = [];
    for (let port = 1; port <= 8; port += 1) {
      const name = `ether${port}`;
      try {
        const rows = sentencesToRows(await client.command([
          "/interface/ethernet/monitor", `=numbers=${name}`, "=once="
        ]));
        const row = rows[0] || {};
        ethernet.push({
          name,
          status: row.status || "unknown",
          rate: row.rate || "",
          rateMbps: rateMbps(row.rate),
          fullDuplex: row["full-duplex"] === undefined ? null : row["full-duplex"] === "true",
          partnerAdvertising: row["link-partner-advertising"] || ""
        });
      } catch {
        ethernet.push({ name, status: "unavailable", rate: "", rateMbps: null, fullDuplex: null, partnerAdvertising: "" });
      }
    }

    let rxMbps: number | null = null;
    let txMbps: number | null = null;
    try {
      const traffic = sentencesToRows(await client.command([
        "/interface/monitor-traffic", "=interface=ether1", "=once="
      ]))[0] || {};
      const rx = Number(traffic["rx-bits-per-second"]);
      const tx = Number(traffic["tx-bits-per-second"]);
      rxMbps = Number.isFinite(rx) ? rx / 1_000_000 : null;
      txMbps = Number.isFinite(tx) ? tx / 1_000_000 : null;
    } catch {
      // Traffic counters are optional; physical link status remains useful.
    }

    const wanPort = ethernet.find((port) => port.name === "ether1");
    const queues = sentencesToRows(await client.command([
      "/queue/simple/print",
      "=.proplist=name,target,limit-at,max-limit,rate",
      "?dynamic=true"
    ])).map((row) => ({
      name: row.name || "Queue",
      target: row.target || "",
      limitAt: row["limit-at"] || "0/0",
      maxLimit: row["max-limit"] || "0/0",
      rate: row.rate || ""
    }));
    const guaranteed = queues.reduce((sum, queue) => {
      const pair = ratePairMbps(queue.limitAt);
      return { upload: sum.upload + (pair.upload || 0), download: sum.download + (pair.download || 0) };
    }, { upload: 0, download: 0 });

    return {
      configured: true,
      connected: true,
      generatedAt,
      wan: {
        interface: "ether1",
        status: wanPort?.status || "unknown",
        rate: wanPort?.rate || "",
        rateMbps: wanPort?.rateMbps ?? null,
        rxMbps,
        txMbps
      },
      ethernet,
      queues,
      queueSummary: {
        activeCount: queues.length,
        guaranteedUploadMbps: Math.round(guaranteed.upload * 10) / 10,
        guaranteedDownloadMbps: Math.round(guaranteed.download * 10) / 10
      }
    };
  } catch (error) {
    return {
      ...unavailable,
      connected: false,
      error: error instanceof Error ? error.message : "RouterOS read failed"
    };
  } finally {
    client.close();
  }
}

// Like kickHotspotUser, but only the session from one device -- used when a
// customer signs out a single device on a multi-device package.
export async function kickHotspotDevice(deviceMac: string): Promise<RouterSessionKickResult> {
  const skippedReason = missingRouterConfig();
  if (skippedReason) return { enabled: config.routeros.enabled, attempted: false, removed: 0, skippedReason };

  const client = new RouterOsApiClient();
  try {
    await client.connect();
    await client.login();
    const sessions = await client.command(["/ip/hotspot/active/print", `?mac-address=${deviceMac}`]);
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


export async function kickPppoeUser(username: string): Promise<RouterSessionKickResult> {
  const skippedReason = missingRouterConfig();
  if (skippedReason) return { enabled: config.routeros.enabled, attempted: false, removed: 0, skippedReason };

  const client = new RouterOsApiClient();
  try {
    await client.connect();
    await client.login();
    const sessions = await client.command(["/ppp/active/print", `?name=${username}`]);
    const ids = sessions
      .filter((sentence) => sentence.type === "!re" && sentence.attrs[".id"])
      .map((sentence) => sentence.attrs[".id"]);

    let removed = 0;
    for (const id of ids) {
      await client.command(["/ppp/active/remove", `=numbers=${id}`]);
      removed += 1;
    }
    return { enabled: true, attempted: true, removed };
  } catch (error) {
    return { enabled: true, attempted: true, removed: 0, error: error instanceof Error ? error.message : "RouterOS PPP action failed" };
  } finally {
    client.close();
  }
}


/** Verify that the MikroTik currently sees this exact MAC/IP on a hotspot host. */
export async function isCurrentHotspotHost(deviceMac: string, deviceIp: string): Promise<boolean> {
  if (missingRouterConfig() || !deviceIp.trim()) return false;
  const client = new RouterOsApiClient();
  try {
    await client.connect();
    await client.login();
    const rows = sentencesToRows(await client.command([
      "/ip/hotspot/host/print",
      "=.proplist=mac-address,address",
      `?mac-address=${deviceMac.toUpperCase()}`
    ]));
    return rows.some((row) => row["mac-address"]?.toUpperCase() === deviceMac.toUpperCase() && row.address === deviceIp.trim());
  } catch {
    return false;
  } finally {
    client.close();
  }
}
