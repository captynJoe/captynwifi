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

const loginSection = requireElement<HTMLElement>("devices-login");
const loginForm = requireElement<HTMLFormElement>("devices-login-form");
const usernameInput = requireElement<HTMLInputElement>("devices-username");
const passwordInput = requireElement<HTMLInputElement>("devices-password");
const loginSubmit = requireElement<HTMLButtonElement>("devices-login-submit");
const loginStatus = requireElement<HTMLElement>("devices-login-status");

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

let session: { username: string; password: string } | null = null;

function renderDevices(deviceLimit: number, devices: DeviceRow[]) {
  manageLimit.textContent = `${devices.length}/${deviceLimit} devices`;
  manageList.innerHTML = devices.length
    ? devices
        .map(
          (device) => `<div class="device-row">
            <span class="mono">${esc(device.deviceMac)}</span>
            <span class="device-tag">Added ${esc(fmtDate(device.addedAt))}</span>
            <button class="link-btn" type="button" data-remove-device-mac="${esc(device.deviceMac)}">Remove</button>
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
    renderDevices(payload.data?.deviceLimit || 1, payload.data?.devices || []);
  } catch (error) {
    manageStatus.textContent = error instanceof Error ? error.message : "Unable to load your devices.";
  }
}

async function removeDevice(mac: string) {
  if (!session) return;
  manageStatus.textContent = "Removing...";
  try {
    const response = await fetch(api("/entitlements/remove-device"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...session, deviceMac: mac })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Unable to remove that device.");
    manageStatus.textContent = "Device removed.";
    await loadDevices();
  } catch (error) {
    manageStatus.textContent = error instanceof Error ? error.message : "Unable to remove that device.";
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
  loginSection.classList.remove("hidden");
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
    loginSection.classList.add("hidden");
    manageSection.classList.remove("hidden");
    renderDevices(payload.data?.deviceLimit || 1, payload.data?.devices || []);
  } catch (error) {
    loginStatus.textContent = error instanceof Error ? error.message : "Unable to check that account.";
  } finally {
    loginSubmit.disabled = false;
  }
});
