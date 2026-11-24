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
      // The timer guards connecting only. It used to be cleared just on close,
      // so any conversation still running 5s after connecting had its socket
      // destroyed mid-command -- the full capacity read takes 3.5-5s over the
      // VPN, and 10-45% of samples a day came back as "router unreachable".
      const socket = net.createConnection({ host: config.routeros.host, port: config.routeros.port }, () => {
        clearTimeout(timer);
        resolve();
      });
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

  async command(words: string[], timeoutMs = config.routeros.timeoutMs) {
    const socket = this.socket;
    if (!socket) throw new Error("RouterOS API is not connected");
    const bucket: RouterSentence[] = [];
    this.pending.push(bucket);
    socket.write(encodeSentence(words));

    const deadline = Date.now() + timeoutMs;
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
  pppoeSessions: Array<{ username: string; callerId: string; address: string; sessionId: string }> | null;
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
    queueSummary: { activeCount: 0, guaranteedUploadMbps: 0, guaranteedDownloadMbps: 0 },
    pppoeSessions: null
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

    let pppoeSessions: RouterCapacityStatus["pppoeSessions"] = null;
    try {
      pppoeSessions = sentencesToRows(await client.command([
        "/ppp/active/print",
        "=.proplist=name,service,caller-id,address,session-id",
        "?service=pppoe"
      ])).map((row) => ({
        username: row.name || "",
        callerId: row["caller-id"] || "",
        address: row.address || "",
        sessionId: row["session-id"] || ""
      }));
    } catch {
      // Keep link/traffic data even when the router cannot return PPP sessions.
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
      },
      pppoeSessions
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


export type HotspotDeviceIdentity = { hostName: string | null; dhcpClassId: string | null; dhcpClientId: string | null };

export type HotspotSignInResult = {
  signedIn: boolean;
  alreadyOnline: boolean;
  identity: HotspotDeviceIdentity | null;
  skippedReason?: string;
  error?: string;
  // The router (RADIUS) turned the login down, with its reason -- as opposed
  // to the router being unreachable, where the portal should fall back.
  refusedReason?: string;
};

// Signs a device into the hotspot from the router's side, exactly as if it
// had submitted the login page: the router still authenticates the package's
// own username/password over RADIUS, so device caps, Simultaneous-Use and
// accounting are unchanged. The IP comes from the router's own host table,
// so a caller can't point a package at an address the router doesn't see.
export async function signInHotspotDevice(input: { username: string; password: string; deviceMac: string }): Promise<HotspotSignInResult> {
  const skippedReason = missingRouterConfig();
  if (skippedReason) return { signedIn: false, alreadyOnline: false, identity: null, skippedReason };

  const mac = input.deviceMac.toUpperCase();
  const client = new RouterOsApiClient();
  try {
    await client.connect();
    await client.login();
    const lease = sentencesToRows(await client.command([
      "/ip/dhcp-server/lease/print",
      "=.proplist=host-name,class-id,client-id",
      `?mac-address=${mac}`
    ]))[0];
    const identity: HotspotDeviceIdentity = {
      hostName: lease?.["host-name"] || null,
      dhcpClassId: lease?.["class-id"] || null,
      dhcpClientId: lease?.["client-id"] || null
    };
    const host = sentencesToRows(await client.command([
      "/ip/hotspot/host/print",
      "=.proplist=address,authorized,bypassed",
      `?mac-address=${mac}`
    ]))[0];
    if (!host?.address) return { signedIn: false, alreadyOnline: false, identity, skippedReason: "Device is not on the hotspot" };
    if (host.authorized === "true" || host.bypassed === "true") return { signedIn: false, alreadyOnline: true, identity };

    try {
      await client.command([
        "/ip/hotspot/active/login",
        `=user=${input.username}`,
        `=password=${input.password}`,
        `=mac-address=${mac}`,
        `=ip=${host.address}`
      ]);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "";
      // A timeout is the router being slow, not a refusal.
      if (reason && !/timed out/i.test(reason)) return { signedIn: false, alreadyOnline: false, identity, refusedReason: reason };
      throw error;
    }
    return { signedIn: true, alreadyOnline: false, identity };
  } catch (error) {
    return { signedIn: false, alreadyOnline: false, identity: null, error: error instanceof Error ? error.message : "RouterOS sign-in failed" };
  } finally {
    client.close();
  }
}

export type HotspotCookie = { id: string; user: string; deviceMac: string };

// The router's own "remember this device" cookies (login-by mac-cookie):
// while one exists, the device signs itself back in under that username on
// its next request, whatever CAPTYN decided in the meantime.
export async function listHotspotCookies(deviceMac?: string): Promise<HotspotCookie[] | null> {
  if (missingRouterConfig()) return null;
  const client = new RouterOsApiClient();
  try {
    await client.connect();
    await client.login();
    const words = ["/ip/hotspot/cookie/print", "=.proplist=.id,user,mac-address"];
    if (deviceMac) words.push(`?mac-address=${deviceMac.toUpperCase()}`);
    return sentencesToRows(await client.command(words))
      .filter((row) => row[".id"] && row.user)
      .map((row) => ({ id: row[".id"], user: row.user, deviceMac: (row["mac-address"] || "").toUpperCase() }));
  } catch {
    return null;
  } finally {
    client.close();
  }
}

export async function removeHotspotCookies(ids: string[]): Promise<{ removed: number; error?: string }> {
  if (ids.length === 0) return { removed: 0 };
  const skippedReason = missingRouterConfig();
  if (skippedReason) return { removed: 0, error: skippedReason };
  const client = new RouterOsApiClient();
  let removed = 0;
  try {
    await client.connect();
    await client.login();
    for (const id of ids) {
      // A cookie can expire between listing and removing; that's fine.
      try {
        await client.command(["/ip/hotspot/cookie/remove", `=numbers=${id}`]);
        removed += 1;
      } catch { /* already gone */ }
    }
    return { removed };
  } catch (error) {
    return { removed, error: error instanceof Error ? error.message : "RouterOS cookie removal failed" };
  } finally {
    client.close();
  }
}

// Forget a device on one package at the router, so a sign-out isn't undone
// seconds later by the device's own mac-cookie re-login.
export async function forgetHotspotDeviceForUser(deviceMac: string, username: string) {
  const cookies = await listHotspotCookies(deviceMac);
  if (!cookies) return { removed: 0, error: "Couldn't read router cookies" };
  return removeHotspotCookies(cookies.filter((cookie) => cookie.user === username).map((cookie) => cookie.id));
}

export type WaitingHotspotHost = { deviceMac: string; address: string; identity: HotspotDeviceIdentity };

// Devices on the hotspot network that aren't signed in, with what their DHCP
// lease says about them -- one router conversation for the whole list.
export async function listWaitingHotspotHosts(): Promise<WaitingHotspotHost[] | null> {
  if (missingRouterConfig()) return null;
  const client = new RouterOsApiClient();
  try {
    await client.connect();
    await client.login();
    const hosts = sentencesToRows(await client.command([
      "/ip/hotspot/host/print",
      "=.proplist=mac-address,address,authorized,bypassed",
      "?authorized=false"
    ])).filter((row) => row["mac-address"] && row.address && row.bypassed !== "true");
    if (hosts.length === 0) return [];
    const leases = new Map(sentencesToRows(await client.command([
      "/ip/dhcp-server/lease/print",
      "=.proplist=mac-address,host-name,class-id,client-id"
    ])).map((row) => [(row["mac-address"] || "").toUpperCase(), row]));
    return hosts.map((row) => {
      const deviceMac = row["mac-address"].toUpperCase();
      const lease = leases.get(deviceMac);
      return {
        deviceMac,
        address: row.address,
        identity: {
          hostName: lease?.["host-name"] || null,
          dhcpClassId: lease?.["class-id"] || null,
          dhcpClientId: lease?.["client-id"] || null
        }
      };
    });
  } catch {
    return null;
  } finally {
    client.close();
  }
}

export async function loginHotspotHost(input: { username: string; password: string; deviceMac: string; address: string }): Promise<{ ok: boolean; error?: string }> {
  const skippedReason = missingRouterConfig();
  if (skippedReason) return { ok: false, error: skippedReason };
  const client = new RouterOsApiClient();
  try {
    await client.connect();
    await client.login();
    await client.command([
      "/ip/hotspot/active/login",
      `=user=${input.username}`,
      `=password=${input.password}`,
      `=mac-address=${input.deviceMac}`,
      `=ip=${input.address}`
    ]);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "RouterOS login failed" };
  } finally {
    client.close();
  }
}

export type NetworkHost = { deviceMac: string; address: string | null; hostName: string | null; dhcpClassId: string | null };

// Every device on the hotspot network (signed in or not) with its DHCP name,
// in one router conversation. null = router unreachable this round.
export async function listNetworkHosts(): Promise<NetworkHost[] | null> {
  if (missingRouterConfig()) return null;
  const client = new RouterOsApiClient();
  try {
    await client.connect();
    await client.login();
    const hosts = sentencesToRows(await client.command(["/ip/hotspot/host/print", "=.proplist=mac-address,address"]));
    const leases = new Map(sentencesToRows(await client.command([
      "/ip/dhcp-server/lease/print", "=.proplist=mac-address,host-name,class-id"
    ])).map((row) => [(row["mac-address"] || "").toUpperCase(), row]));
    return hosts.filter((row) => row["mac-address"]).map((row) => {
      const deviceMac = row["mac-address"].toUpperCase();
      const lease = leases.get(deviceMac);
      return { deviceMac, address: row.address || null, hostName: lease?.["host-name"] || null, dhcpClassId: lease?.["class-id"] || null };
    });
  } catch {
    return null;
  } finally {
    client.close();
  }
}

export async function listActiveHotspotSessions(): Promise<Array<{ user: string; deviceMac: string }> | null> {
  if (missingRouterConfig()) return null;
  const client = new RouterOsApiClient();
  try {
    await client.connect();
    await client.login();
    return sentencesToRows(await client.command(["/ip/hotspot/active/print", "=.proplist=user,mac-address"]))
      .filter((row) => row.user && row["mac-address"])
      .map((row) => ({ user: row.user, deviceMac: row["mac-address"].toUpperCase() }));
  } catch {
    return null;
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

export type IspProbeReading = { customerMbps: number | null; bytes: number; seconds: number };

// Downloads a fixed file through the router itself (nothing kept) and times
// it, after reading the customer traffic already on the WAN. Together they
// show what the ISP line can carry right now. Throws when it can't measure.
export async function probeIspThroughput(url: string, timeoutMs = 60_000): Promise<IspProbeReading> {
  const missing = missingRouterConfig();
  if (missing) throw new Error(missing);
  const client = new RouterOsApiClient();
  try {
    await client.connect();
    await client.login();
    let customerMbps: number | null = null;
    try {
      const traffic = sentencesToRows(await client.command(["/interface/monitor-traffic", "=interface=ether1", "=once="]))[0] || {};
      const rx = Number(traffic["rx-bits-per-second"]);
      customerMbps = Number.isFinite(rx) ? rx / 1_000_000 : null;
    } catch {
      // The download timing alone is still worth recording.
    }
    const started = Date.now();
    const rows = sentencesToRows(await client.command(["/tool/fetch", `=url=${url}`, "=keep-result=no"], timeoutMs));
    const seconds = (Date.now() - started) / 1000;
    const last = rows[rows.length - 1] || {};
    if (last.status && last.status !== "finished") throw new Error(`Download ${last.status}`);
    // RouterOS reports "downloaded" in KiB.
    const bytes = Math.round(Number(last.downloaded) * 1024);
    if (!Number.isFinite(bytes) || bytes <= 0) throw new Error("Download returned no data");
    return { customerMbps, bytes, seconds };
  } finally {
    client.close();
  }
}
