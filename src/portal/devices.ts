// Standalone "manage my devices" page. Deliberately independent of
// portal/main.ts: that page's whole login/connect flow requires MikroTik's
// captive-portal redirect context (state.hotspot?.login, populated only
// from ?hsLogin=... query params), which only exists while a device is
// still unauthenticated and walled-gardened. Viewing/removing devices needs
// none of that -- only the username/password the customer already has --
// so this page works from any ordinary browser tab, anytime, including
// from a device that's already fully connected.

// This file is compiled together with main.ts under the same
// tsconfig.portal.json program (both loaded as separate <script
// type="module"> tags at runtime, but tsc still type-checks every included
// .ts file as one program). An explicit `export {}` makes tsc treat this
// file as its own module scope instead of a global script, so its
// top-level names don't collide with main.ts's identically-named globals
// (basePath, api, themeToggleBtn, etc).
export {};

interface CaptynThemeController {
  current(): "dark" | "light";
  toggle(): void;
}
declare global {
  interface Window {
    captynTheme?: CaptynThemeController;
  }
}

interface DeviceRow {
  deviceMac: string;
  label?: string | null;
  addedAt: string;
  lastSeenAt?: string | null;
  signedOut?: boolean;
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing devices page element #${id}`);
  return element as T;
}

function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

function fmtDate(value?: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}

const basePath = window.location.pathname.startsWith("/wifi") ? "/wifi" : "";
const api = (path: string) => `${basePath}/api/public${path}`;

const themeToggleBtn = requireElement<HTMLButtonElement>("theme-toggle-btn");
const settingsToggleBtn = requireElement<HTMLButtonElement>("settings-toggle-btn");
const settingsMenu = requireElement<HTMLElement>("settings-menu");

const phoneSection = requireElement<HTMLElement>("account-phone");
const loginSection = requireElement<HTMLElement>("devices-login");
const loginForm = requireElement<HTMLFormElement>("devices-login-form");
const usernameInput = requireElement<HTMLInputElement>("devices-username");
const passwordInput = requireElement<HTMLInputElement>("devices-password");
const loginSubmit = requireElement<HTMLButtonElement>("devices-login-submit");
const loginStatus = requireElement<HTMLElement>("devices-login-status");
const loginToggle = requireElement<HTMLButtonElement>("devices-login-toggle");

const phoneForm = requireElement<HTMLFormElement>("account-phone-form");
const phoneInput = requireElement<HTMLInputElement>("account-phone-input");
const phoneSubmit = requireElement<HTMLButtonElement>("account-phone-submit");
const codeForm = requireElement<HTMLFormElement>("account-code-form");
const codeInput = requireElement<HTMLInputElement>("account-code-input");
const codeLabel = requireElement<HTMLElement>("account-code-label");
const codeSubmit = requireElement<HTMLButtonElement>("account-code-submit");
const codeBack = requireElement<HTMLButtonElement>("account-code-back");
const phoneStatus = requireElement<HTMLElement>("account-phone-status");

const homeSection = requireElement<HTMLElement>("account-home");
const homePhone = requireElement<HTMLElement>("account-phone-label");
const homePackages = requireElement<HTMLElement>("account-packages");
const homeStatus = requireElement<HTMLElement>("account-status");
const signOutBtn = requireElement<HTMLButtonElement>("account-sign-out-btn");

const manageSection = requireElement<HTMLElement>("devices-manage");
const manageLimit = requireElement<HTMLElement>("devices-manage-limit");
const manageList = requireElement<HTMLElement>("devices-manage-list");
const manageStatus = requireElement<HTMLElement>("devices-manage-status");
const manageSwitchBtn = requireElement<HTMLButtonElement>("devices-manage-switch");

function syncThemeToggleLabel() {
  themeToggleBtn.textContent = window.captynTheme?.current() === "dark" ? "Light mode" : "Dark mode";
}
function setSettingsMenuOpen(open: boolean) {
  settingsMenu.classList.toggle("hidden", !open);
  settingsToggleBtn.setAttribute("aria-expanded", open ? "true" : "false");
}
settingsToggleBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  setSettingsMenuOpen(settingsMenu.classList.contains("hidden"));
});
document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.closest(".settings-control")) return;
  setSettingsMenuOpen(false);
});
themeToggleBtn.addEventListener("click", () => {
  window.captynTheme?.toggle();
  syncThemeToggleLabel();
});
syncThemeToggleLabel();

const manageCode = document.getElementById("devices-manage-code") as HTMLElement;
const manageCodeValue = document.getElementById("devices-manage-code-value") as HTMLElement;
manageCode.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(manageCodeValue.textContent || "");
    const label = manageCode.querySelector("em");
    if (label) {
      label.textContent = "Copied";
      setTimeout(() => { label.textContent = "Copy"; }, 1200);
    }
  } catch (_error) {}
});

let session: { username: string; password: string } | null = null;

function renderDevices(deviceLimit: number, devices: DeviceRow[], connectCode?: string, deviceCap?: number) {
  manageLimit.textContent = `${devices.length}/${deviceCap || deviceLimit} devices used`;
  manageCode.classList.toggle("hidden", !connectCode);
  manageCodeValue.textContent = connectCode || "";
  manageList.innerHTML = devices.length
    ? devices
        .map(
          (device) => `<div class="device-row">
            <span class="mono">${esc(device.deviceMac)}</span>
            ${device.signedOut
              ? '<span class="device-tag signed-out">Signed out</span>'
              : `<span class="device-tag">Added ${esc(fmtDate(device.addedAt))}</span>
            <button class="link-btn" type="button" data-remove-device-mac="${esc(device.deviceMac)}">Sign out</button>`}
          </div>`
        )
        .join("")
    : '<div class="device-row-empty">No devices registered yet.</div>';
}

async function loadDevices() {
  if (!session) return;
  manageStatus.textContent = "Loading...";
  try {
    const response = await fetch(api("/entitlements/devices/list"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(session)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Unable to load your devices.");
    manageStatus.textContent = "";
    renderDevices(payload.data?.deviceLimit || 1, payload.data?.devices || [], payload.data?.connectCode, payload.data?.deviceCap);
  } catch (error) {
    manageStatus.textContent = error instanceof Error ? error.message : "Unable to load your devices.";
  }
}

async function removeDevice(mac: string) {
  if (!session) return;
  manageStatus.textContent = "Signing out...";
  try {
    const response = await fetch(api("/entitlements/remove-device"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...session, deviceMac: mac })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Couldn't sign that device out.");
    manageStatus.textContent = "Device signed out.";
    await loadDevices();
  } catch (error) {
    manageStatus.textContent = error instanceof Error ? error.message : "Couldn't sign that device out.";
  }
}

manageList.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const button = target.closest("[data-remove-device-mac]");
  if (!(button instanceof HTMLElement)) return;
  void removeDevice(button.dataset.removeDeviceMac || "");
});

manageSwitchBtn.addEventListener("click", () => {
  session = null;
  manageSection.classList.add("hidden");
  phoneSection.classList.remove("hidden");
  loginStatus.textContent = "";
  passwordInput.value = "";
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  if (!username || !password) return;
  loginSubmit.disabled = true;
  loginStatus.textContent = "Checking...";
  try {
    const response = await fetch(api("/entitlements/devices/list"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "That username and password don't match an active plan.");
    session = { username, password };
    loginStatus.textContent = "";
    phoneSection.classList.add("hidden");
    manageSection.classList.remove("hidden");
    renderDevices(payload.data?.deviceLimit || 1, payload.data?.devices || [], payload.data?.connectCode, payload.data?.deviceCap);
  } catch (error) {
    loginStatus.textContent = error instanceof Error ? error.message : "Unable to check that account.";
  } finally {
    loginSubmit.disabled = false;
  }
});

// ---------- My WiFi: phone confirmed by SMS ----------
// The session token lives in this browser only; a captive-portal window
// keeps its own, which is why the portal links here from inside it.

interface AccountDevice extends DeviceRow { online: boolean; name: string | null }
interface AccountPackage {
  id: string; name: string; expiresAt: string; paused: boolean; deviceLimit: number; deviceCap: number;
  switchesLeft: number; deviceCode: string; devices: AccountDevice[]; login: { username: string; password: string };
}

const TOKEN_KEY = "captyn-wifi-account";
const readToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch (_error) { return null; } };
const writeToken = (token: string | null) => {
  try { if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY); } catch (_error) {}
};
let pendingPhone = "";

async function accountFetch(path: string, init: RequestInit = {}) {
  const token = readToken();
  const response = await fetch(api(`/account${path}`), {
    ...init,
    headers: { "Content-Type": "application/json", ...(token ? { "x-captyn-wifi-account": token } : {}), ...(init.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    writeToken(null);
    showPhoneStep();
  }
  if (!response.ok) throw new Error(payload.error || "Something went wrong. Try again.");
  return payload.data;
}

function showPhoneStep(message = "") {
  homeSection.classList.add("hidden");
  manageSection.classList.add("hidden");
  phoneSection.classList.remove("hidden");
  phoneForm.classList.remove("hidden");
  codeForm.classList.add("hidden");
  signOutBtn.classList.add("hidden");
  phoneStatus.textContent = message;
}

function timeLeft(expiresAt: string, paused: boolean) {
  if (paused) return "Paused";
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "Ended";
  const minutes = Math.floor(ms / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  return days > 0 ? `${days}d ${hours}h left` : hours > 0 ? `${hours}h ${minutes % 60}m left` : `${minutes}m left`;
}

function deviceStatus(device: AccountDevice) {
  if (device.signedOut) return '<span class="device-tag signed-out">Signed out</span>';
  if (device.online) return '<span class="device-tag online">Online</span>';
  return '<span class="device-tag offline">Offline</span>';
}

function renderPackages(packages: AccountPackage[]) {
  homePackages.innerHTML = packages.length
    ? packages.map((pkg) => `<article class="account-package">
        <div class="account-package-head"><strong>${esc(pkg.name)}</strong><span>${esc(timeLeft(pkg.expiresAt, pkg.paused))}</span></div>
        <button type="button" class="credential access-connect-code" data-copy-code="${esc(pkg.deviceCode)}"><span>Device code</span><strong class="mono">${esc(pkg.deviceCode)}</strong><em>Copy</em></button>
        <div class="access-devices-head"><span>Devices</span><strong>${pkg.switchesLeft > 0 ? `${pkg.switchesLeft} more device${pkg.switchesLeft === 1 ? "" : "s"} allowed` : "Full"}</strong></div>
        <div class="access-devices-list">${pkg.devices.length
          ? pkg.devices.map((device) => `<div class="device-row">
              <span class="mono" title="${esc(device.deviceMac)}">${esc(device.name || device.deviceMac)}</span>
              ${deviceStatus(device)}
              ${device.signedOut ? "" : `<button class="link-btn" type="button" data-sign-out-package="${esc(pkg.id)}" data-sign-out-mac="${esc(device.deviceMac)}">Sign out</button>`}
            </div>`).join("")
          : '<div class="device-row-empty">No devices yet.</div>'}</div>
        <details class="login-details"><summary>Connection details</summary>
          <p class="mono">${esc(pkg.login.username)}<br />${esc(pkg.login.password)}</p>
        </details>
      </article>`).join("")
    : '<div class="device-row-empty">No active packages on this number.</div>';
}

async function loadAccount() {
  homeStatus.textContent = "Loading...";
  try {
    const data = await accountFetch("/me");
    phoneSection.classList.add("hidden");
    manageSection.classList.add("hidden");
    homeSection.classList.remove("hidden");
    signOutBtn.classList.remove("hidden");
    homePhone.textContent = data.phone || "";
    renderPackages(data.packages || []);
    homeStatus.textContent = "";
  } catch (error) {
    if (readToken()) homeStatus.textContent = error instanceof Error ? error.message : "Couldn't load My WiFi.";
  }
}

phoneForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const phone = phoneInput.value.trim();
  if (!phone) return;
  phoneSubmit.disabled = true;
  phoneStatus.textContent = "Sending code...";
  try {
    const data = await accountFetch("/phone/start", { method: "POST", body: JSON.stringify({ phone }) });
    pendingPhone = phone;
    phoneForm.classList.add("hidden");
    codeForm.classList.remove("hidden");
    codeLabel.textContent = `Code sent to ${data.sentTo}`;
    phoneStatus.textContent = "";
    codeInput.value = "";
    codeInput.focus();
  } catch (error) {
    phoneStatus.textContent = error instanceof Error ? error.message : "Couldn't send the code.";
  } finally {
    phoneSubmit.disabled = false;
  }
});

codeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = codeInput.value.trim();
  if (!/^\d{6}$/.test(code)) {
    phoneStatus.textContent = "Enter the 6-digit code from the SMS.";
    return;
  }
  codeSubmit.disabled = true;
  phoneStatus.textContent = "Checking...";
  try {
    const data = await accountFetch("/phone/verify", { method: "POST", body: JSON.stringify({ phone: pendingPhone, code }) });
    writeToken(data.token);
    phoneStatus.textContent = "";
    await loadAccount();
  } catch (error) {
    phoneStatus.textContent = error instanceof Error ? error.message : "Couldn't check the code.";
  } finally {
    codeSubmit.disabled = false;
  }
});

codeBack.addEventListener("click", () => showPhoneStep());

homePackages.addEventListener("click", async (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const copy = target?.closest<HTMLElement>("[data-copy-code]");
  if (copy) {
    try {
      await navigator.clipboard.writeText(copy.dataset.copyCode || "");
      const label = copy.querySelector("em");
      if (label) { label.textContent = "Copied"; setTimeout(() => { label.textContent = "Copy"; }, 1200); }
    } catch (_error) {}
    return;
  }
  const signOut = target?.closest<HTMLButtonElement>("[data-sign-out-mac]");
  if (!signOut) return;
  if (!window.confirm("Sign this device out? It keeps its place on the package.")) return;
  signOut.disabled = true;
  homeStatus.textContent = "Signing out...";
  try {
    await accountFetch("/devices/sign-out", { method: "POST", body: JSON.stringify({ packageId: signOut.dataset.signOutPackage, deviceMac: signOut.dataset.signOutMac }) });
    await loadAccount();
    homeStatus.textContent = "Device signed out.";
  } catch (error) {
    signOut.disabled = false;
    homeStatus.textContent = error instanceof Error ? error.message : "Couldn't sign that device out.";
  }
});

signOutBtn.addEventListener("click", async () => {
  try { await accountFetch("/sign-out", { method: "POST" }); } catch (_error) {}
  writeToken(null);
  showPhoneStep();
});

loginToggle.addEventListener("click", () => {
  loginSection.classList.toggle("hidden");
});

// This script supports phone sign-in: show it, tuck the package login away.
loginToggle.classList.remove("hidden");
loginSection.classList.add("hidden");
phoneForm.classList.remove("hidden");
if (readToken()) void loadAccount();
