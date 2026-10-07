interface CaptynThemeController {
  current(): "dark" | "light";
  toggle(): void;
}

interface Window {
  captynTheme?: CaptynThemeController;
}

type StepName = "package" | "mpesa" | "access";
type ConnectStatus = "" | "connecting" | "connected" | "failed";
type ModalKind = "connecting" | "ok" | "bad";
type NeedKey = "all" | "flash" | "everyday" | "fast" | "gulfstream";

interface HotspotParams {
  login: string;
  orig: string;
  mac: string;
  ip: string;
  error: string;
}

interface PortalSite {
  id: string;
  name: string;
  plans: PortalPlanInput[];
}

interface PortalPlanInput {
  id: string;
  name: string;
  priceKsh: number;
  category?: "standard" | "limited";
  durationSeconds: number;
  rateLimit: string | null;
  deviceLimit: number;
  maxDevices?: number;
  featured?: boolean;
  manualPricing?: boolean;
  imageFile?: string | null;
}

interface PortalPlan extends PortalPlanInput {
  site: Omit<PortalSite, "plans">;
}

interface EntitlementDevice {
  deviceMac: string;
  label?: string | null;
  addedAt: string;
  lastSeenAt?: string | null;
  signedOut?: boolean;
}

interface Entitlement {
  username: string;
  password: string;
  expiresAt: string;
  deviceLimit?: number;
  pausedSince?: string | null;
  totalCreditedSeconds?: number;
  deviceCount?: number;
  devices?: EntitlementDevice[];
  connectCode?: string;
  deviceMac?: string;
  deviceCap?: number;
  startsAt?: string;
}

interface NotificationData {
  creditId?: string;
  durationSeconds?: number;
  reason?: string;
  expiresAt?: string | null;
  deviceMac?: string | null;
  consumedAt?: string | null;
  activatable?: boolean;
}

interface NotificationItem {
  id: string; type: string; title: string; body: string; readAt: string | null; createdAt: string; data?: NotificationData | null;
}

interface ConnectedPanelOptions {
  heading?: string;
  message?: string;
  skipAutoConnect?: boolean;
  freshGrant?: boolean;
  recoveryReference?: string;
  hideCredentials?: boolean;
}

interface ManualConnectOptions {
  message?: string;
  buttonLabel?: string;
  placement?: "default" | "access";
}

interface PortalState {
  plans: PortalPlan[];
  selectedPlanId: string;
  paymentId: string;
  pollTimer: number | null;
  hotspot: HotspotParams | null;
  expiryTimer: number | null;
  activeNeed: NeedKey;
  selectedDevices: number;
  packageView: "all" | "multi" | "fast";
  paymentStartedAt?: number;
  currentEntitlement: Entitlement | null;
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing portal element #${id}`);
  return element as T;
}

const state: PortalState = { plans: [], selectedPlanId: "", paymentId: "", pollTimer: null, hotspot: null, expiryTimer: null, activeNeed: "all", currentEntitlement: null, selectedDevices: 1, packageView: "all" };
const plansEl = requireElement<HTMLDivElement>("plans");
const checkoutTitle = requireElement<HTMLHeadingElement>("checkout-title");
const checkoutPrice = requireElement<HTMLElement>("checkout-price");
const selectedSummary = requireElement<HTMLDivElement>("selected-summary");
const planIdInput = requireElement<HTMLInputElement>("plan-id");
const paymentForm = requireElement<HTMLFormElement>("payment-form");
const phoneInput = requireElement<HTMLInputElement>("phone");
const phoneField = phoneInput.closest<HTMLElement>(".field");
const payButton = requireElement<HTMLButtonElement>("pay-button");
const paymentStatus = requireElement<HTMLParagraphElement>("payment-status");
const checkoutPanel = requireElement<HTMLElement>("checkout");
const checkoutBackdrop = requireElement<HTMLDivElement>("checkout-backdrop");
const checkoutCloseBtn = requireElement<HTMLButtonElement>("checkout-close-btn");
const haveCodeBtn = requireElement<HTMLButtonElement>("have-code-btn");
const access = requireElement<HTMLElement>("access");
const accessHeading = requireElement<HTMLHeadingElement>("access-heading");
const accessTimeLeft = requireElement<HTMLParagraphElement>("access-time-left");
const accessLoginDetails = requireElement<HTMLDetailsElement>("access-login-details");
const accessUsernameCard = requireElement<HTMLElement>("access-username-card");
const accessPasswordCard = requireElement<HTMLElement>("access-password-card");
const accessRecoveryCard = requireElement<HTMLElement>("access-recovery-card");
const accessUsername = requireElement<HTMLElement>("access-username");
const accessPassword = requireElement<HTMLElement>("access-password");
const accessRecovery = requireElement<HTMLElement>("access-recovery");
const accessExpires = requireElement<HTMLElement>("access-expires");
const accessOutageNote = requireElement<HTMLElement>("access-outage-note");
const accessDevices = requireElement<HTMLElement>("access-devices");
const accessDevicesCount = requireElement<HTMLElement>("access-devices-count");
const accessDevicesNotice = requireElement<HTMLElement>("access-devices-notice");
const accessDevicesList = requireElement<HTMLElement>("access-devices-list");
const accessDevicesFeedback = requireElement<HTMLElement>("access-devices-feedback");
const accessConnectCode = requireElement<HTMLButtonElement>("access-connect-code");
const accessConnectCodeValue = requireElement<HTMLElement>("access-connect-code-value");
const extendPeriodBtn = requireElement<HTMLButtonElement>("extend-period-btn");
const signOutDeviceBtn = requireElement<HTMLButtonElement>("sign-out-device-btn");
const addDeviceBtn = requireElement<HTMLButtonElement>("add-device-btn");
const addDevicePanel = requireElement<HTMLElement>("add-device-panel");
const addDeviceOptions = requireElement<HTMLElement>("add-device-options");
const addDevicePhone = requireElement<HTMLInputElement>("add-device-phone");
const addDevicePay = requireElement<HTMLButtonElement>("add-device-pay");
const addDeviceStatus = requireElement<HTMLParagraphElement>("add-device-status");
const workspaceEl = document.querySelector<HTMLElement>(".workspace");
const introRowEl = document.querySelector<HTMLElement>(".intro-row");
const promoSection = requireElement<HTMLElement>("promo");
const promoHeading = requireElement<HTMLHeadingElement>("promo-heading");
const promoMessage = requireElement<HTMLParagraphElement>("promo-message");
const promoCountdown = requireElement<HTMLElement>("promo-countdown");
const promoNote = requireElement<HTMLParagraphElement>("promo-note");
const promoStatus = requireElement<HTMLParagraphElement>("promo-status");
let promoCountdownTimer: number | null = null;
const creditOffers = document.getElementById("credit-offers");
const manualConnectFallback = requireElement<HTMLElement>("manual-connect-fallback");
const manualConnectMessage = requireElement<HTMLParagraphElement>("manual-connect-message");
const manualConnectOpenBtn = requireElement<HTMLAnchorElement>("manual-connect-open-btn");
const manualConnectForm = requireElement<HTMLFormElement>("manual-connect-form");
const manualConnectSubmitBtn = requireElement<HTMLButtonElement>("manual-connect-submit-btn");
let pendingManualConnect: { username: string; password: string } | null = null;
const errorText = requireElement<HTMLParagraphElement>("error");
const paymentModal = requireElement<HTMLDivElement>("payment-modal");
const paymentModalIcon = requireElement<HTMLDivElement>("payment-modal-icon");
const paymentModalTitle = requireElement<HTMLHeadingElement>("payment-modal-title");
const paymentModalMessage = requireElement<HTMLParagraphElement>("payment-modal-message");
const paymentModalCancelBtn = requireElement<HTMLButtonElement>("payment-modal-cancel-btn");
const paymentModalRetryBtn = requireElement<HTMLButtonElement>("payment-modal-retry-btn");
const existingLoginToggle = requireElement<HTMLButtonElement>("existing-login-toggle");
const existingLoginForm = requireElement<HTMLFormElement>("existing-login-form");
const existingUsernameInput = requireElement<HTMLInputElement>("existing-username");
const existingPasswordInput = requireElement<HTMLInputElement>("existing-password");
const existingLoginStatus = requireElement<HTMLParagraphElement>("existing-login-status");
const voucherLoginToggle = requireElement<HTMLButtonElement>("voucher-login-toggle");
const voucherLoginForm = requireElement<HTMLFormElement>("voucher-login-form");
const voucherCodeInput = requireElement<HTMLInputElement>("voucher-code-input");
const voucherLoginStatus = requireElement<HTMLParagraphElement>("voucher-login-status");
const receiptLoginToggle = requireElement<HTMLButtonElement>("receipt-login-toggle");
const receiptLoginForm = requireElement<HTMLFormElement>("receipt-login-form");
const receiptCodeInput = requireElement<HTMLInputElement>("receipt-code-input");
const receiptPhoneInput = requireElement<HTMLInputElement>("receipt-phone-input");
const receiptLoginStatus = requireElement<HTMLParagraphElement>("receipt-login-status");
const themeToggleBtn = requireElement<HTMLButtonElement>("theme-toggle-btn");
const welcomeAccessBtn = requireElement<HTMLButtonElement>("welcome-access-btn");
const settingsToggleBtn = requireElement<HTMLButtonElement>("settings-toggle-btn");
const settingsMenu = requireElement<HTMLElement>("settings-menu");
const notifControl = document.getElementById("notif-control");
const notifToggleBtn = document.getElementById("notif-toggle-btn") as HTMLButtonElement | null;
const notifMenu = document.getElementById("notif-menu");
const notifBadge = document.getElementById("notif-badge");
const notifList = document.getElementById("notif-list");
const expiryBanner = requireElement<HTMLElement>("expiry-banner");
const expiryCountdown = requireElement<HTMLElement>("expiry-countdown");
const expiryRenewBtn = requireElement<HTMLButtonElement>("expiry-renew-btn");

function syncThemeToggleLabel() {
  if (themeToggleBtn && window.captynTheme) {
    themeToggleBtn.textContent = window.captynTheme.current() === "dark" ? "Light" : "Dark";
  }
}
syncThemeToggleLabel();
function setSettingsMenuOpen(open: boolean) {
  settingsMenu.classList.toggle("hidden", !open);
  settingsToggleBtn.setAttribute("aria-expanded", open ? "true" : "false");
}
settingsToggleBtn?.addEventListener("click", (event) => {
  event.stopPropagation();
  setSettingsMenuOpen(settingsMenu.classList.contains("hidden"));
});
themeToggleBtn?.addEventListener("click", () => {
  window.captynTheme.toggle();
  syncThemeToggleLabel();
  setSettingsMenuOpen(false);
});
welcomeAccessBtn?.addEventListener("click", () => {
  const plan = findPlanByName("CAPTYN Welcome");
  setSettingsMenuOpen(false);
  if (!plan) {
    showError("Welcome access is still loading. Try again in a moment.");
    return;
  }
  showError("");
  selectPlan(plan.id);
});
document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.closest(".settings-control")) return;
  setSettingsMenuOpen(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setSettingsMenuOpen(false);
});

// Keyed by username (see /notifications/:username on the server) --
// populated whenever the portal learns whose access it's showing, since
// that's the same moment it has a trusted identity to fetch under.
let notifUsername: string | null = null;
let notifItems: NotificationItem[] = [];
let activatingCreditId = "";

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function notificationCreditId(item: NotificationItem): string {
  return typeof item.data?.creditId === "string" ? item.data.creditId : "";
}

function notificationKey(item: NotificationItem): string {
  const creditId = notificationCreditId(item);
  return creditId ? `credit:${creditId}` : `notification:${item.id}`;
}

function mergeNotificationItems(items: NotificationItem[]) {
  const merged = new Map<string, NotificationItem>();
  for (const item of notifItems) merged.set(notificationKey(item), item);
  for (const item of items) {
    const key = notificationKey(item);
    const existing = merged.get(key);
    if (existing?.type === "credit_available" && item.type !== "credit_available") {
      merged.set(key, { ...existing, readAt: existing.readAt || item.readAt });
    } else {
      merged.set(key, { ...existing, ...item, readAt: existing?.readAt || item.readAt || null });
    }
  }
  notifItems = Array.from(merged.values()).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function isActionableCredit(item: NotificationItem) {
  if (!item.data?.creditId || item.data.consumedAt || item.data.activatable !== true) return false;
  if (!item.data.expiresAt) return true;
  return new Date(item.data.expiresAt).getTime() > Date.now();
}

function creditExpiryLabel(item: NotificationItem) {
  if (!item.data?.expiresAt) return "Activate when ready";
  const remainingMs = new Date(item.data.expiresAt).getTime() - Date.now();
  return remainingMs > 0 ? `${formatTimeLeft(remainingMs).replace(/ left$/, "")} to activate` : "Expired";
}

function renderCreditOffers() {
  const creditItems = notifItems.filter(isActionableCredit);
  if (!creditOffers) return;
  creditOffers.classList.toggle("hidden", creditItems.length === 0);
  creditOffers.innerHTML = creditItems
    .map((item) => {
      const creditId = notificationCreditId(item);
      const durationLabel = formatDuration(item.data?.durationSeconds || 0);
      const disabled = activatingCreditId === creditId ? " disabled" : "";
      const buttonLabel = activatingCreditId === creditId ? "Activating..." : "Activate";
      return `<article class="credit-offer">
        <div>
          <p class="credit-offer-title">${esc(item.title)}</p>
          <p class="credit-offer-body">${esc(item.body)}</p>
          <div class="credit-offer-meta"><span>${esc(durationLabel)}</span><span>${esc(creditExpiryLabel(item))}</span></div>
        </div>
        <button class="primary credit-activate-btn" type="button" data-activate-credit-id="${esc(creditId)}"${disabled}>${esc(buttonLabel)}</button>
      </article>`;
    })
    .join("");
}

function renderNotifications() {
  if (!notifList || !notifBadge) {
    renderCreditOffers();
    return;
  }
  notifList.innerHTML = notifItems.length
    ? notifItems
        .map(
          (item) => `<div class="notif-item ${item.readAt ? "read" : ""}">
            <p class="notif-item-title">${esc(item.title)}</p>
            <p class="notif-item-body">${esc(item.body)}</p>
            <span class="notif-item-time">${esc(relativeTime(item.createdAt))}</span>
            ${
              isActionableCredit(item)
                ? `<div class="notif-action-row"><button class="primary credit-activate-btn" type="button" data-activate-credit-id="${esc(notificationCreditId(item))}"${activatingCreditId === notificationCreditId(item) ? " disabled" : ""}>${activatingCreditId === notificationCreditId(item) ? "Activating..." : "Activate"}</button><span class="notif-credit-meta">${esc(creditExpiryLabel(item))}</span></div>`
                : ""
            }
          </div>`
        )
        .join("")
    : '<div class="notif-empty">No notifications yet.</div>';
  const unread = notifItems.filter((item) => !item.readAt).length;
  notifBadge.textContent = String(unread);
  notifBadge.classList.toggle("hidden", unread === 0);
  renderCreditOffers();
}

async function loadRedeemableCredits(username = notifUsername) {
  const params = new URLSearchParams();
  if (username) params.set("username", username);
  if (state.hotspot?.mac) params.set("deviceMac", state.hotspot.mac);
  if (!params.toString()) return;
  try {
    const response = await fetch(api(`/credits/redeemable?${params.toString()}`));
    if (!response.ok) return;
    const payload = await response.json();
    mergeNotificationItems(payload?.data?.notifications || []);
    notifControl?.classList.remove("hidden");
    renderNotifications();
  } catch (_error) {
    // Notifications are a nice-to-have overlay on top of the access flow --
    // never worth surfacing an error for or blocking anything on.
  }
}

async function loadNotifications(username: string) {
  notifUsername = username;
  try {
    const response = await fetch(api(`/notifications/${encodeURIComponent(username)}`));
    if (response.ok) {
      const payload = await response.json();
      mergeNotificationItems(payload?.data?.notifications || []);
      notifControl?.classList.remove("hidden");
      renderNotifications();
    }
  } catch (_error) {
    // Same rule as credit loading: never block access on inbox niceties.
  }
  await loadRedeemableCredits(username);
}

async function activateCredit(creditId: string) {
  if (!creditId || activatingCreditId) return;
  if (!state.hotspot?.mac) {
    showError("Connect to the CAPTYN WiFi network, then reopen this page to activate your free internet.");
    return;
  }
  activatingCreditId = creditId;
  showError("");
  renderNotifications();
  try {
    const response = await fetch(api(`/credits/${encodeURIComponent(creditId)}/activate`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: notifUsername || undefined, deviceMac: state.hotspot.mac })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Unable to activate this credit.");
    notifItems = notifItems.filter((item) => notificationCreditId(item) !== creditId);
    activatingCreditId = "";
    renderNotifications();
    showConnectedPanel(payload.data.entitlement, {
      heading: payload.data.extended ? "Free internet added" : "Free internet ready",
      recoveryReference: payload.data.sourceReference,
      hideCredentials: Boolean(state.hotspot?.login),
      freshGrant: true
    });
  } catch (error) {
    activatingCreditId = "";
    renderNotifications();
    showError(error instanceof Error ? error.message : "Unable to activate this credit.");
  }
}

function setNotifMenuOpen(open: boolean) {
  if (!notifMenu || !notifToggleBtn) return;
  notifMenu.classList.toggle("hidden", !open);
  notifToggleBtn.setAttribute("aria-expanded", open ? "true" : "false");
  if (!open || !notifUsername) return;
  const unread = notifItems.filter((item) => !item.readAt);
  if (!unread.length) return;
  unread.forEach((item) => { item.readAt = new Date().toISOString(); });
  renderNotifications();
  void Promise.all(unread.map((item) => fetch(api(`/notifications/${item.id}/read`), { method: "POST" }).catch(() => {})));
}
notifToggleBtn?.addEventListener("click", (event) => {
  event.stopPropagation();
  setSettingsMenuOpen(false);
  setNotifMenuOpen(notifMenu.classList.contains("hidden"));
});
function handleCreditActivationClick(event: Event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const button = target.closest("[data-activate-credit-id]");
  if (!(button instanceof HTMLElement)) return;
  event.preventDefault();
  event.stopPropagation();
  void activateCredit(button.dataset.activateCreditId || "");
}
notifList?.addEventListener("click", handleCreditActivationClick);
creditOffers?.addEventListener("click", handleCreditActivationClick);
document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.closest(".notif-control")) return;
  setNotifMenuOpen(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setNotifMenuOpen(false);
});

const basePath = window.location.pathname.startsWith("/wifi") ? "/wifi" : "";
const api = (path) => `${basePath}/api/public${path}`;
const servicePath = (path) => `${basePath}${path}`;

function showError(message) {
  errorText.textContent = message || "";
  errorText.classList.toggle("hidden", !message);
}
function money(value) { return `KSh ${Number(value || 0).toLocaleString()}`; }
function duration(seconds) {
  const value = Number(seconds || 0);
  if (value % 86400 === 0) return `${value / 86400} day${value / 86400 === 1 ? "" : "s"}`;
  if (value % 3600 === 0) return `${value / 3600} hour${value / 3600 === 1 ? "" : "s"}`;
  const totalMinutes = Math.round(value / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return `${hours}h ${minutes}m`;
}
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}
function rateParts(rateLimit) {
  const match = /^([\d.]+)M\/([\d.]+)M$/i.exec(String(rateLimit || "").trim());
  if (!match) return { upload: 0, download: 0 };
  return { upload: Number(match[1]) || 0, download: Number(match[2]) || 0 };
}
function friendlyRate(rateLimit) {
  const { upload, download } = rateParts(rateLimit);
  if (!download && !upload) return rateLimit ? esc(rateLimit) : "Standard speed";
  return `↓ ${download} Mbps · ↑ ${upload} Mbps`;
}
function speedTierClass(plan: { rateLimit: string | null }) {
  const { download } = rateParts(plan.rateLimit);
  if (download <= 5) return "speed-starter";
  if (download <= 10) return "speed-cruise"; // anything above 10 Mbps reads as a faster tier
  if (download <= 20) return "speed-highspeed";
  return "speed-gulfstream";
}
function normalizeMpesaPhoneInput(raw) {
  const cleaned = String(raw || "").replace(/[^\d+]/g, "").replace(/^\++/, "+");
  const digits = cleaned.startsWith("+") ? cleaned.slice(1) : cleaned;
  let normalized = "";
  if (/^254[17]\d{8}$/.test(digits)) normalized = digits;
  else if (/^2540[17]\d{8}$/.test(digits)) normalized = "254" + digits.slice(4);
  else if (/^0[17]\d{8}$/.test(digits)) normalized = "254" + digits.slice(1);
  else if (/^[17]\d{8}$/.test(digits)) normalized = "254" + digits;
  return normalized ? "+" + normalized : null;
}
function resetPhonePrefix() {
  if (!phoneInput.value.trim()) phoneInput.value = "+254";
}
function attachPhoneNormalization(input: HTMLInputElement) {
  input.addEventListener("focus", () => {
    if (!input.value.trim()) input.value = "+254";
  });
  input.addEventListener("blur", () => {
    const normalized = normalizeMpesaPhoneInput(input.value);
    if (normalized) input.value = normalized;
    else if (!input.value.trim()) input.value = "+254";
  });
  if (!input.value.trim()) input.value = "+254";
}

phoneInput.addEventListener("focus", resetPhonePrefix);
phoneInput.addEventListener("blur", () => {
  const normalized = normalizeMpesaPhoneInput(phoneInput.value);
  if (normalized) phoneInput.value = normalized;
  else resetPhonePrefix();
});
resetPhonePrefix();
attachPhoneNormalization(receiptPhoneInput);

function readHotspotParams() {
  const search = new URLSearchParams(window.location.search);
  const login = search.get("hsLogin");
  if (!login) return null;
  return {
    login,
    orig: search.get("hsOrig") || "",
    mac: search.get("mac") || "",
    ip: search.get("ip") || "",
    error: search.get("error") || ""
  };
}
function portalReturnUrl() {
  // nginx already maps /wifi/ onto the API's /portal/, so "/wifi/portal/"
  // became /portal/portal/ -- a 404 right after a successful login.
  const path = window.location.pathname.startsWith("/wifi") ? "/wifi/" : "/portal/";
  return new URL(path, window.location.origin).toString();
}
// For the hidden auto-connect attempt, redirecting to the OS's own original
// probe URL (msftconnecttest.com, connectivitycheck.gstatic.com, etc.) once
// login succeeds helps that OS notice it now has real internet and clear
// its own "no internet" warning -- and it's invisible to the user either
// way, since it happens inside a hidden iframe. But for the *visible*
// top-level path (the manual "Tap to connect" fallback), landing the
// user's whole tab on one of those near-blank probe pages instead of back
// on our own "you're connected" screen is a bad landing, so that path
// always prefers our own portal regardless of what triggered the redirect.
function hotspotRedirectDestination({ preferOrig = true } = {}) {
  if (preferOrig && state.hotspot?.orig) return state.hotspot.orig;
  return portalReturnUrl();
}
// Chrome (and other browsers) block *form* submissions from an HTTPS page
// to a plain-HTTP action with a full-page "not secure" interstitial --
// MikroTik's hotspot login endpoint is inherently plain HTTP, and there is
// no way to make that secure short of the router terminating TLS itself.
// Worse, when that happened inside the hidden iframe below (the silent
// auto-connect attempt), the warning rendered somewhere the user could
// never see or dismiss, so the attempt just hung forever. A plain
// GET navigation (iframe.src / window.location.href, not a <form> element)
// isn't treated as a "form" by that check, so it loads normally instead.
function autoCompleteHotspotLogin(username, password, { topLevel = false } = {}) {
  const hotspot = state.hotspot;
  if (!hotspot?.login) return;
  const params = new URLSearchParams({ username, password, dst: hotspotRedirectDestination({ preferOrig: !topLevel }), popup: "false" });
  const separator = hotspot.login.includes("?") ? "&" : "?";
  const url = hotspot.login + separator + params.toString();
  if (topLevel) {
    window.location.href = url;
    return;
  }
  let iframe = document.querySelector<HTMLIFrameElement>('iframe[data-hs-auto-login]');
  if (!iframe) {
    iframe = document.createElement("iframe");
    iframe.dataset.hsAutoLogin = "true";
    iframe.style.display = "none";
    document.body.appendChild(iframe);
  }
  iframe.src = url;
}
// Deliberately NOT gstatic.com/generate_204 — that's the exact URL Android's
// own OS-level captive-portal detector uses, so hotspot walled gardens
// commonly allow it through even before login (so Android doesn't nag with a
// "no internet" warning on the login page). Fetching it here would give a
// false "connected" reading for a device that's only got walled-garden
// access, not real internet. 1.1.1.1 is a raw IP (skips DNS-based walled
// garden rules entirely) and isn't a domain hotspots special-case allow.
function checkInternetReachable(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); resolve(false); }, timeoutMs);
    fetch("https://1.1.1.1/cdn-cgi/trace", { mode: "no-cors", cache: "no-store", signal: controller.signal })
      .then(() => { clearTimeout(timer); resolve(true); })
      .catch(() => { clearTimeout(timer); resolve(false); });
  });
}
async function waitForConnection(maxAttempts, intervalMs, checkTimeoutMs = 1500) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (await checkInternetReachable(checkTimeoutMs)) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}
function setConnectState(statusEl, formEl, state, message) {
  statusEl.className = `status-text connect-state ${state}`;
  statusEl.textContent = message || "";
  if (formEl) {
    const disable = state === "connecting";
    Array.from(formEl.elements).forEach((el) => {
      if (el instanceof HTMLInputElement || el instanceof HTMLButtonElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
        el.disabled = disable;
      }
    });
  }
}
function showPaymentModal(kind, title, message) {
  paymentModal.classList.remove("hidden");
  const iconClass = kind === "connecting" ? "spin" : kind === "ok" ? "ok" : kind === "welcome-used" ? "laugh-cry" : "bad";
  paymentModalIcon.className = `payment-modal-icon ${iconClass}`;
  paymentModalIcon.textContent = kind === "welcome-used" ? "\u{1F62D}" : "";
  paymentModalTitle.textContent = title;
  paymentModalMessage.textContent = message || "";
  paymentModalCancelBtn.classList.toggle("hidden", kind !== "connecting");
  paymentModalRetryBtn.classList.toggle("hidden", kind !== "bad" && kind !== "welcome-used");
  paymentModalRetryBtn.textContent = kind === "welcome-used" ? "Browse packages →" : "Try Again";
}
function hidePaymentModal() {
  paymentModal.classList.add("hidden");
}
function paymentActionLabel(plan = currentPlan()) {
  return Number(plan?.priceKsh || 0) === 0 ? "Start Free Access" : "Pay Now";
}
function resetPaymentAttempt() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  state.paymentId = "";
  payButton.disabled = false;
  payButton.textContent = paymentActionLabel();
  setConnectState(paymentStatus, null, "", "");
  hidePaymentModal();
}
function formatTimeLeft(remainingMs) {
  if (remainingMs <= 0) return "Expired";
  const totalMinutes = Math.ceil(remainingMs / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h left`;
  if (hours > 0) return `${hours}h ${minutes}m left`;
  if (minutes > 1) return `${minutes} minutes left`;
  return "Less than a minute left";
}
function formatDuration(totalSeconds) {
  const totalMinutes = Math.round(Number(totalSeconds || 0) / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return "under a minute";
}
// Reflects outageCredit.ts's pause/credit tracking: `pausedSince` is set
// while this device's access is currently paused for a network outage (not
// yet credited -- that only happens once it resumes), and
// `totalCreditedSeconds` is every credit already applied to this
// entitlement's expiry from past outages. Only one of these is ever shown
// at a time since a paused entitlement's own gap isn't credited yet.
function renderOutageNote(entitlement: Entitlement) {
  if (!accessOutageNote) return;
  if (entitlement.pausedSince) {
    accessOutageNote.textContent = `Paused since ${new Date(entitlement.pausedSince).toLocaleString()} due to a network outage — this time will be added back once you're reconnected.`;
    accessOutageNote.classList.remove("hidden", "credited");
    accessOutageNote.classList.add("paused");
    return;
  }
  const creditedSeconds = Number(entitlement.totalCreditedSeconds || 0);
  if (creditedSeconds > 0) {
    accessOutageNote.textContent = `${formatDuration(creditedSeconds)} credited back for past network outages.`;
    accessOutageNote.classList.remove("hidden", "paused");
    accessOutageNote.classList.add("credited");
    return;
  }
  accessOutageNote.textContent = "";
  accessOutageNote.classList.add("hidden");
  accessOutageNote.classList.remove("paused", "credited");
}
// Renders the customer's registered-device list (see WifiEntitlementDevice
// on the backend). This is separate from RADIUS's own Simultaneous-Use
// concurrent-session cap -- that keeps working regardless of what's shown
// here -- this list only controls whether a device gets remembered for
// frictionless auto-reconnect next time.
function renderDeviceList(entitlement: Entitlement) {
  const devices = entitlement.devices || [];
  const limit = Number(entitlement.deviceLimit || 1);
  accessDevices.classList.remove("hidden");
  accessDevicesFeedback.classList.add("hidden");
  // A 1-device package shows just its device: a count and a code for
  // "another device" read as if a second device could join. Multi-device
  // packages show devices used out of how many different ones they allow.
  const multiDevice = limit > 1;
  accessDevicesCount.textContent = multiDevice ? `${devices.length}/${entitlement.deviceCap || limit} used` : "";
  addDeviceBtn.classList.toggle("hidden", limit >= 3 || !addDevicePanel.classList.contains("hidden"));
  const devicesLabel = document.getElementById("access-devices-label");
  if (devicesLabel) devicesLabel.textContent = multiDevice ? "Devices" : "Device";
  accessDevicesList.innerHTML = devices.length
    ? devices
        .map((device) => {
          const isThisDevice = device.deviceMac === currentDeviceMac();
          return `<div class="device-row">
            <span class="mono">${esc(device.deviceMac)}</span>
            ${isThisDevice ? '<span class="device-tag">This device</span>' : ""}
            ${device.signedOut
              ? '<span class="device-tag signed-out">Signed out</span>'
              : isThisDevice
                ? ""
                : `<button class="link-btn" type="button" data-remove-device-mac="${esc(device.deviceMac)}">Sign out</button>`}
          </div>`;
        })
        .join("")
    : '<div class="device-row-empty">No devices registered yet.</div>';
  accessConnectCodeValue.textContent = entitlement.connectCode || "";
  accessConnectCode.classList.toggle("hidden", !entitlement.connectCode || !multiDevice);
}
function hideDeviceLimitNotice() {
  accessDevicesNotice.classList.add("hidden");
  accessDevicesNotice.textContent = "";
  accessDevices.classList.remove("at-limit");
}
// state.currentEntitlement is normally set by showConnectedPanel, but
// rememberDeviceForEntitlement can also fire from flows that haven't shown
// that panel yet (manual login, receipt code, promo claim) -- synthesize a
// minimal placeholder in that case so the device list still has
// username/password to act on (e.g. for the Remove button).
function showDeviceLimitNotice(message: string, devices: EntitlementDevice[], deviceLimit: number | undefined, username: string, password: string) {
  if (!state.currentEntitlement) {
    state.currentEntitlement = { username, password, expiresAt: "" };
  }
  state.currentEntitlement.devices = devices;
  if (deviceLimit) state.currentEntitlement.deviceLimit = deviceLimit;
  accessDevices.classList.remove("hidden");
  accessDevices.classList.add("at-limit");
  accessDevicesNotice.textContent = message;
  accessDevicesNotice.classList.remove("hidden");
  renderDeviceList(state.currentEntitlement);
}
async function removeDevice(mac: string) {
  const entitlement = state.currentEntitlement;
  if (!entitlement) return;
  // Signing out the device you're holding goes through the full sign-out
  // (clears saved access) instead of being re-registered below.
  if (mac === currentDeviceMac()) {
    signOutDeviceBtn.click();
    return;
  }
  try {
    const response = await fetch(api("/entitlements/remove-device"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: entitlement.username, password: entitlement.password, deviceMac: mac })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Couldn't sign that device out.");
    entitlement.devices = (entitlement.devices || []).map((device) => (device.deviceMac === mac ? { ...device, signedOut: true } : device));
    hideDeviceLimitNotice();
    renderDeviceList(entitlement);
    // Freed a slot -- make sure this device is recorded on the package.
    await rememberDeviceForEntitlement(entitlement.username, entitlement.password);
  } catch (error) {
    showError(error instanceof Error ? error.message : "Couldn't sign that device out.");
  }
}
document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const button = target.closest("[data-remove-device-mac]");
  if (!(button instanceof HTMLElement)) return;
  event.preventDefault();
  void removeDevice(button.dataset.removeDeviceMac || "");
});
function clockLabel(remainingMs: number) {
  const totalMinutes = Math.max(0, Math.floor(remainingMs / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (totalMinutes > 0) return `${minutes}m`;
  return `${Math.max(0, Math.floor(remainingMs / 1000))}s`;
}
// Time left as a ring: the arc is the share of the package still to run.
const CLOCK_CIRCUMFERENCE = 2 * Math.PI * 48;
function updateAccessTimeLeft(remainingMs: number, totalMs?: number) {
  if (!accessTimeLeft) return;
  const share = totalMs && totalMs > 0 ? Math.min(1, Math.max(0, remainingMs / totalMs)) : 1;
  accessTimeLeft.innerHTML = `<svg viewBox="0 0 120 120" aria-hidden="true">
      <circle class="clock-track" cx="60" cy="60" r="48"/>
      <circle class="clock-fill" cx="60" cy="60" r="48" stroke-dasharray="${CLOCK_CIRCUMFERENCE.toFixed(1)}" stroke-dashoffset="${(CLOCK_CIRCUMFERENCE * (1 - share)).toFixed(1)}"/>
    </svg>
    <span class="clock-center"><strong>${esc(clockLabel(remainingMs))}</strong><small>left</small></span>`;
}
function startExpiryWatch(expiresAt, startsAt?: string) {
  const target = new Date(expiresAt).getTime();
  const start = startsAt ? new Date(startsAt).getTime() : NaN;
  const totalMs = Number.isFinite(start) ? target - start : undefined;
  if (!Number.isFinite(target)) return;
  if (state.expiryTimer) clearInterval(state.expiryTimer);
  const WARN_MS = 2 * 60 * 1000;
  function tick() {
    const remainingMs = target - Date.now();
    updateAccessTimeLeft(remainingMs, totalMs);
    if (remainingMs <= 0) {
      expiryBanner.classList.remove("hidden");
      expiryBanner.classList.add("expired");
      expiryBanner.querySelector(".expiry-message").textContent = "Your WiFi access has expired — buy a new package to get back online.";
      clearInterval(state.expiryTimer);
      state.expiryTimer = null;
      clearRememberedAccess();
      return;
    }
    if (remainingMs <= WARN_MS) {
      expiryBanner.classList.remove("hidden");
      const totalSeconds = Math.ceil(remainingMs / 1000);
      const mm = Math.floor(totalSeconds / 60);
      const ss = String(totalSeconds % 60).padStart(2, "0");
      expiryCountdown.textContent = `${mm}:${ss}`;
    }
  }
  tick();
  state.expiryTimer = setInterval(tick, 1000);
}
function setDeviceFeedback(message: string, tone: "ok" | "bad") {
  accessDevicesFeedback.textContent = message;
  accessDevicesFeedback.className = `access-devices-feedback ${tone}`;
  accessDevicesFeedback.classList.remove("hidden");
}

// Links this device to the package before signing in, so the returning-
// device lookup recognises it next time. Devices are recorded on the
// package by FreeRADIUS at sign-in regardless; a 409 here means the package
// has used its allowance of different devices.
async function rememberDeviceForEntitlement(username, password) {
  const mac = state.hotspot?.mac;
  if (!mac) return;
  try {
    const response = await fetch(api("/entitlements/link-device"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, deviceMac: mac })
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 409) {
      showDeviceLimitNotice(
        payload.message || "This package has reached its device limit.",
        payload.data?.devices || [],
        payload.data?.deviceLimit,
        username,
        password
      );
      return;
    }
    hideDeviceLimitNotice();
    if (response.ok && payload.data?.devices) {
      if (!state.currentEntitlement) state.currentEntitlement = { username, password, expiresAt: "" };
      state.currentEntitlement.devices = payload.data.devices;
      if (payload.data.deviceLimit) state.currentEntitlement.deviceLimit = payload.data.deviceLimit;
      if (payload.data.deviceCap) state.currentEntitlement.deviceCap = payload.data.deviceCap;
      renderDeviceList(state.currentEntitlement);
    }
  } catch (_error) {
    // Best-effort -- never block the connection on this.
  }
}
// Saved before leaving for the router, so the page the router sends the
// device back to (/wifi/, no hotspot params) opens on the connected screen.
async function saveAccessBeforeLeaving(username: string, password: string) {
  try {
    const response = await fetch(api(`/entitlements/${encodeURIComponent(username)}/status`));
    const data = response.ok ? (await response.json())?.data : null;
    if (data?.expiresAt) saveRememberedAccess({ username, password, expiresAt: data.expiresAt, startsAt: data.startsAt, deviceLimit: data.deviceLimit });
  } catch (_error) {}
}
async function attemptAutoConnect(username, password, statusEl, formEl, { freshGrant = false } = {}) {
  const alreadyOnline = freshGrant ? false : await checkInternetReachable(900);
  // The router's login page is plain http and this portal is https, so a
  // hidden-iframe login is blocked as mixed content by browsers and
  // captive-portal webviews -- it never reached the router, and customers
  // only got online by finding "Tap to connect". Go to the router for real:
  // it signs the device in and redirects back to /wifi/. The fallback button
  // still appears if the navigation hasn't happened after a few seconds.
  if (!alreadyOnline && state.hotspot?.login) {
    setConnectState(statusEl, formEl, "connecting", "Signing this device in...");
    noteAutoSignIn();
    await rememberDeviceForEntitlement(username, password);
    await saveAccessBeforeLeaving(username, password);
    setTimeout(() => {
      showManualConnectFallback(username, password, {
        placement: manualConnectPlacement(),
        message: "If this device didn't connect, tap below.",
        buttonLabel: "Tap to connect"
      });
    }, 4000);
    autoCompleteHotspotLogin(username, password, { topLevel: true });
    return;
  }

  const ok = alreadyOnline || (await waitForConnection(8, 450, 900));
  if (ok) {
    hideManualConnectFallback();
    await rememberDeviceForEntitlement(username, password);
    let expiresAt = null;
    let deviceLimit;
    let devices: EntitlementDevice[] = [];
    let connectCode: string | undefined;
    let deviceCap: number | undefined;
    let startsAt: string | undefined;
    try {
      const [statusResponse, devicesResponse] = await Promise.all([
        fetch(api(`/entitlements/${encodeURIComponent(username)}/status`)),
        fetch(api("/entitlements/devices/list"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password })
        })
      ]);
      const data = statusResponse.ok ? (await statusResponse.json())?.data : null;
      expiresAt = data?.expiresAt || null;
      startsAt = data?.startsAt;
      deviceLimit = data?.deviceLimit;
      const devicesData = devicesResponse.ok ? (await devicesResponse.json())?.data : null;
      devices = devicesData?.devices || [];
      connectCode = devicesData?.connectCode;
      deviceCap = devicesData?.deviceCap;
    } catch (_error) {}
    if (expiresAt) {
      showConnectedPanel(
        { username, password, expiresAt, startsAt, deviceLimit, devices, connectCode, deviceCap },
        { heading: "You're connected", message: "You're all set. You can browse now.", skipAutoConnect: true }
      );
    } else {
      hideManualConnectFallback();
      setConnectState(statusEl, formEl, "connected", "You're connected. You can close this page.");
    }
  } else {
    updateAccessCopy("Access active");
    // Was "...is taking longer than expected" -- misleading when the retry
    // loop actually fails fast (a walled garden that resets blocked traffic
    // immediately rather than timing out silently makes this happen in a
    // couple seconds, not "longer"). Say what's actually true instead.
    setConnectState(statusEl, formEl, "failed", "Automatic sign-in didn't go through. Tap Connect below to finish.");
    showManualConnectFallback(username, password, {
      placement: manualConnectPlacement(),
      message: "Your access is active. Tap Connect to complete WiFi sign-in on this device.",
      buttonLabel: "Tap to connect"
    });
  }
}
const MOBILE_SHEET_QUERY = window.matchMedia("(max-width: 980px)");
function openCheckoutSheet() {
  if (!MOBILE_SHEET_QUERY.matches) return;
  checkoutPanel.classList.add("open");
  checkoutBackdrop.classList.add("open");
  document.body.classList.add("sheet-open");
}
function closeCheckoutSheet() {
  checkoutPanel.classList.remove("open");
  checkoutBackdrop.classList.remove("open");
  document.body.classList.remove("sheet-open");
}
checkoutCloseBtn?.addEventListener("click", closeCheckoutSheet);
checkoutBackdrop?.addEventListener("click", closeCheckoutSheet);

function currentPlan() {
  return state.plans.find((plan) => plan.id === state.selectedPlanId) || null;
}
function setStep(active) {
  const order = ["package", "mpesa", "access"];
  const activeIndex = order.indexOf(active);
  document.querySelectorAll<HTMLElement>(".step").forEach((step) => {
    const index = order.indexOf(step.dataset.step || "");
    step.classList.toggle("active", index === activeIndex);
    step.classList.toggle("done", activeIndex > index);
  });
}
function planCategory(plan) {
  return plan?.category === "limited" || Number(plan?.priceKsh || 0) === 0 ? "limited" : "standard";
}
function isWelcomePlan(plan) {
  return String(plan.name || "").toLowerCase() === "captyn welcome";
}
// A plan's family (mirrors classifyFamily() in dynamicPlanEngine.ts server-
// side, kept in sync by hand since the backend and this browser bundle
// don't share a module) is its fixed product identity -- Everyday/Fast/
// Gulfstream/Flash each own one value axis the governor is allowed to
// flex, so the family a plan belongs to doesn't change just because
// traffic pushed its current speed into a different Mbps range this hour.
function classifyFamily(name: string): "everyday" | "fast" | "gulfstream" | "flash" | "occasion" {
  const n = String(name || "").toLowerCase();
  if (n.includes("gulfstream")) return "gulfstream";
  if (n.includes("highspeed")) return "fast";
  if (n.includes("epl")) return "occasion";
  if (n.includes("flash")) return "flash";
  return "everyday";
}
// The stored plan name (e.g. "Gulfstream 3 HR") is a fixed baseline label,
// but with dynamic pricing its actual speed/duration moves with traffic --
// keeping that name on screen means the title itself can claim a tier the
// plan isn't currently in. Displayed title is regenerated from the plan's
// family + duration instead. Exempt: non-speed-tiered plans (free access,
// occasion-based like EPL match day), since those aren't claiming anything
// about current speed -- and manualPricing plans, since dynamicPlanEngine
// never flexes those (excluded from mirroring on purpose), so there's no
// drift for the name to misrepresent. The admin's chosen name is the whole
// point of pinning a price manually; show it as-is until they untick it.
function displayPlanName(plan) {
  if (isWelcomePlan(plan) || planCategory(plan) === "limited" || plan.manualPricing) return plan.name;
  if (String(plan.name || "").toLowerCase().includes("epl")) return plan.name;
  const tier = speedTierForPlan(plan);
  return `${tier ? tier.label : "Standard"} · ${duration(plan.durationSeconds)}`;
}
function promotedBadge(plan) {
  const name = String(plan.name || "").toLowerCase();
  if (name === "cruise 4 hr") return "Recommended";
  if (name === "cruise weekly") return "Best value";
  // "Top speed" reflects the plan's *current* dynamic speed tier, not a
  // fixed name -- whichever plans are actually fastest right now earn it,
  // not whichever plan happened to be fastest at its baseline price.
  if (speedTierForPlan(plan)?.key === "gulfstream") return "Top speed";
  return "";
}
// Pitch copy keyed off the plan's current speed tier (same bucketing the
// speed tabs use) instead of its name -- a plan's rateLimit moves with
// traffic now, so a name-based pitch ("Top-speed access...") can end up
// describing a plan that's actually been throttled into a slower tier, or
// vice versa. Only non-speed claims (occasion, price tier) stay name-based.
function speedTierPitch(plan) {
  const tierKey = speedTierForPlan(plan)?.key;
  if (tierKey === "gulfstream") return "Top-speed access for heavy downloads, uploads, and urgent work.";
  if (tierKey === "fast") return "Faster access for calls, uploads, and heavier browsing.";
  if (tierKey === "everyday") return "Balanced access for browsing, TikTok, messaging and everyday use.";
  if (tierKey === "flash") return "Quick, affordable access for short sessions.";
  return "Clear speed and time for everyday browsing.";
}
function planTone(plan) {
  const name = String(plan.name || "").toLowerCase();
  const badge = promotedBadge(plan);
  if (isWelcomePlan(plan)) return { badge, pitch: "Free welcome access while support checks the live network." };
  if (planCategory(plan) === "limited") return { badge, pitch: "Quick access for chats, updates, and light browsing." };
  if (name.includes("epl")) return { badge, pitch: "Built for match day — smooth HD streaming, no buffering." };
  if (name.includes("monthly")) return { badge, pitch: `${speedTierPitch(plan)} Billed for the full month.` };
  return { badge, pitch: speedTierPitch(plan) };
}
function formatKsh(value: number) {
  return value < 10 ? String(Math.round(value * 10) / 10) : String(Math.round(value));
}
// The line under the price says what the money buys, so cards can be
// compared at a glance: cost per hour (or per day), and for faster
// packages how much faster than standard.
function planValueLine(plan, price = Number(plan.priceKsh || 0)) {
  const hours = Number(plan.durationSeconds || 0) / 3600;
  if (!hours || !price) return "";
  const rate = hours >= 24 ? `KSh ${formatKsh(price / (hours / 24))}/day` : `KSh ${formatKsh(price / hours)}/hr`;
  if (!isFastPlan(plan)) return rate;
  const multiple = rateParts(plan.rateLimit).download / standardDownloadMbps();
  return `${formatKsh(multiple)}× standard speed · ${rate}`;
}
// devices: price and describe the card for this many devices (the
// "Multiple devices" view shows every package at 2).
function planCard(plan, devices = plan.deviceLimit) {
  const selected = plan.id === state.selectedPlanId;
  const price = devicePriceFor(plan, devices);
  const tone = planTone(plan);
  const badgeHtml = tone.badge ? '<span class="plan-badge">' + esc(tone.badge) + '</span>' : "";
  // Only render the image slot when a real photo exists -- a placeholder
  // block for every photo-less card read as "this failed to load" rather
  // than an intentional empty state, especially since most utility plans
  // will likely never get a photo. Trade-off: a photo card and a text-only
  // card sharing a grid row can leave a short gap under the shorter one
  // (rows stretch to the tallest card), but that's minor next to a grid
  // full of blank color blocks.
  const imageHtml = plan.imageFile
    ? `<img class="plan-card-image" src="${servicePath(`/uploads/plan-images/${encodeURIComponent(plan.imageFile)}`)}" alt="" loading="lazy" decoding="async" />`
    : "";
  return `<button type="button" class="plan-card ${selected ? "selected" : ""} ${planCategory(plan) === "limited" ? "limited" : "standard"} ${isWelcomePlan(plan) ? "welcome" : ""}" data-plan-id="${esc(plan.id)}">
    ${imageHtml}
    <span class="plan-card-body plan-row">
      <span class="plan-main">
        <h3>${esc(displayPlanName(plan))}</h3>
        <span class="plan-facts">${duration(plan.durationSeconds)} · ${esc(devices)} device${Number(devices) === 1 ? "" : "s"}</span>
        <span class="plan-speed ${speedTierClass(plan)}">${friendlyRate(plan.rateLimit)}</span>
      </span>
      <span class="plan-side">
        ${badgeHtml}
        <strong class="plan-price">${money(price)}</strong>
        <span class="plan-value">${esc(planValueLine(plan, price))}</span>
      </span>
    </span>
  </button>`;
}
const UPGRADE_SUGGESTIONS: Record<string, string> = {
  "basic hour": "Starter 2 HR",
  "starter 2 hr": "Basic 4 HR",
  "basic 4 hr": "Basic 12 HR",
  "basic 12 hr": "Basic Day",
  "basic day": "Cruise 4 HR",
  "flash 7": "Cruise 4 HR",
  "cruise 4 hr": "Cruise Half Day",
  "cruise half day": "Cruise Day",
  "cruise day basic": "Cruise Day",
  "cruise day": "Cruise Weekly",
  "cruise weekly": "Cruise Monthly",
  "cruise monthly": "Highspeed Monthly",
  "highspeed hour": "Highspeed 6 HR",
  "highspeed 6 hr": "Highspeed Day",
  "highspeed day": "Highspeed Weekend",
  "highspeed weekend": "Highspeed Weekly",
  "highspeed weekly": "Highspeed Monthly",
  "gulfstream hour": "Gulfstream 3 HR",
  "gulfstream 3 hr": "Gulfstream 6 HR",
  "gulfstream 6 hr": "Gulfstream Day"
};
function findPlanByName(name: string) {
  const key = name.toLowerCase();
  return state.plans.find((plan) => planName(plan) === key) || null;
}
function suggestedUpgrade(plan: PortalPlan) {
  const mapped = UPGRADE_SUGGESTIONS[planName(plan)];
  if (mapped) {
    const target = findPlanByName(mapped);
    if (target && target.id !== plan.id && Number(target.priceKsh || 0) > Number(plan.priceKsh || 0)) return target;
  }
  return state.plans.find((candidate) => Number(candidate.priceKsh || 0) > Number(plan.priceKsh || 0)) || null;
}
function upgradeReason(plan: PortalPlan, upgrade: PortalPlan) {
  const currentRate = rateParts(plan.rateLimit);
  const nextRate = rateParts(upgrade.rateLimit);
  if (nextRate.download > currentRate.download) return `faster ↓ ${nextRate.download} Mbps`;
  if (Number(upgrade.deviceLimit || 0) > Number(plan.deviceLimit || 0)) return `${upgrade.deviceLimit} devices`;
  if (Number(upgrade.durationSeconds || 0) > Number(plan.durationSeconds || 0)) return `${duration(upgrade.durationSeconds)} instead of ${duration(plan.durationSeconds)}`;
  return "a stronger option";
}
function upgradeCard(plan: PortalPlan) {
  const upgrade = suggestedUpgrade(plan);
  if (!upgrade) return "";
  const extra = Number(upgrade.priceKsh || 0) - Number(plan.priceKsh || 0);
  if (extra <= 0) return "";
  return `<div class="upgrade-card">
    <button type="button" class="upgrade-main" data-plan-id="${esc(upgrade.id)}">
      <span><em>Compare</em><strong>${esc(displayPlanName(upgrade))}</strong></span>
      <span>+${money(extra)} for ${esc(upgradeReason(plan, upgrade))}</span>
    </button>
  </div>`;
}
// Mirrors src/services/devicePricing.ts for display; the server computes
// the real charge (and forces a top-up to the package's own device count).
const DEVICE_PRICE_MULTIPLIERS: Record<number, number> = { 1: 1, 2: 1.6, 3: 2.1 };
function maxDevicesForPlan(plan: PortalPlan) {
  if (Number(plan.priceKsh || 0) <= 0) return plan.deviceLimit;
  return Math.max(plan.deviceLimit, Math.min(3, Number(plan.maxDevices ?? 3)));
}
function devicePriceFor(plan: PortalPlan, devices: number) {
  if (devices <= plan.deviceLimit) return Number(plan.priceKsh || 0);
  return Math.round((Number(plan.priceKsh) * DEVICE_PRICE_MULTIPLIERS[devices]) / DEVICE_PRICE_MULTIPLIERS[plan.deviceLimit]);
}
// Adding time to an active package extends it at its own device count.
function lockedDeviceCount(): number | null {
  const entitlement = state.currentEntitlement;
  if (!entitlement?.expiresAt || new Date(entitlement.expiresAt).getTime() <= Date.now()) return null;
  return Number(entitlement.deviceLimit || 1);
}
function checkoutDevices(plan: PortalPlan) {
  const locked = lockedDeviceCount();
  if (locked) return locked;
  return Math.min(maxDevicesForPlan(plan), Math.max(plan.deviceLimit, state.selectedDevices || plan.deviceLimit));
}
function devicePicker(plan: PortalPlan) {
  const locked = lockedDeviceCount();
  if (locked) return `<p class="device-locked">For your package's ${locked} device${locked === 1 ? "" : "s"}</p>`;
  const max = maxDevicesForPlan(plan);
  if (max <= plan.deviceLimit) return `<p class="device-locked">${plan.deviceLimit} device${plan.deviceLimit === 1 ? "" : "s"}</p>`;
  const chosen = checkoutDevices(plan);
  const options = [];
  for (let devices = plan.deviceLimit; devices <= max; devices += 1) {
    options.push(`<button type="button" class="device-option ${devices === chosen ? "active" : ""}" data-devices="${devices}" role="radio" aria-checked="${devices === chosen}">
      <strong>${devices}</strong><span>device${devices === 1 ? "" : "s"}</span><em>${money(devicePriceFor(plan, devices))}</em>
    </button>`);
  }
  return `<div class="device-picker" role="radiogroup" aria-label="Devices">${options.join("")}</div>`;
}
function renderSelectedPlan() {
  const plan = currentPlan();
  if (!plan) {
    checkoutTitle.textContent = "Select access";
    checkoutPrice.textContent = "KSh 0";
    selectedSummary.innerHTML = '<div class="empty-state">Select a package to continue.</div>';
    planIdInput.value = "";
    payButton.disabled = true;
    payButton.textContent = "Continue";
    phoneInput.required = true;
    phoneField?.classList.remove("hidden");
    setStep("package");
    return;
  }
  const isFree = Number(plan.priceKsh || 0) === 0;
  checkoutTitle.textContent = displayPlanName(plan);
  const price = devicePriceFor(plan, checkoutDevices(plan));
  checkoutPrice.textContent = money(price);
  planIdInput.value = plan.id;
  payButton.disabled = false;
  payButton.textContent = Number(plan.priceKsh || 0) === 0 ? paymentActionLabel(plan) : `Pay ${money(price)}`;
  phoneInput.required = !isFree;
  phoneField?.classList.toggle("hidden", isFree);
  selectedSummary.innerHTML = `<div class="summary-meta compact"><span class="summary-pill summary-duration">${duration(plan.durationSeconds)}</span><span class="summary-pill summary-speed ${speedTierClass(plan)}">${friendlyRate(plan.rateLimit)}</span></div>${devicePicker(plan)}${upgradeCard(plan)}`;
}
function comparePlansByPrice(a: PortalPlan, b: PortalPlan) {
  const priceDelta = Number(a?.priceKsh || 0) - Number(b?.priceKsh || 0);
  if (priceDelta) return priceDelta;
  const durationDelta = Number(a?.durationSeconds || 0) - Number(b?.durationSeconds || 0);
  if (durationDelta) return durationDelta;
  return String(a?.name || "").localeCompare(String(b?.name || ""));
}

// Tabs group by product family, not live Mbps -- a family is a fixed
// identity (see classifyFamily), so a tab only goes empty if the catalog
// genuinely has no plans of that family, not because traffic shifted.
const SPEED_TIERS: Array<{ key: NeedKey; label: string; range: string; title: string; description: string }> = [
  { key: "all", label: "All", range: "All packages", title: "All packages", description: "" },
  { key: "flash", label: "Flash", range: "Cheap & quick", title: "Flash", description: "" },
  { key: "everyday", label: "Everyday", range: "Balanced", title: "Everyday", description: "" },
  { key: "fast", label: "Fast", range: "High speed", title: "Fast", description: "" },
  { key: "gulfstream", label: "Gulfstream", range: "Top speed", title: "Gulfstream", description: "" }
];

function isSupportOnlyPlan(plan: PortalPlan) {
  const name = String(plan.name || "").trim().toLowerCase();
  return name === "captyn welcome" || name.includes("welcome") || Number(plan.priceKsh || 0) === 0;
}

function customerPlans() {
  return state.plans.filter((plan) => !isSupportOnlyPlan(plan));
}

function planName(plan: PortalPlan) {
  return String(plan.name || "").toLowerCase();
}
function plansByName(names: string[]) {
  const wanted = names.map((name) => name.toLowerCase());
  return wanted.map((name) => state.plans.find((plan) => planName(plan) === name)).filter((plan): plan is PortalPlan => Boolean(plan));
}
function activeSpeedTierConfig() {
  return SPEED_TIERS.find((tier) => tier.key === state.activeNeed) || SPEED_TIERS[0];
}
function isNeedKey(value: string): value is NeedKey {
  return SPEED_TIERS.some((tier) => tier.key === value);
}
// "occasion" plans (EPL match-day) don't get their own tab -- fold into
// Everyday for grouping purposes; displayPlanName still shows their real
// name, this only affects which tab they're browsable under.
function speedTierForPlan(plan: PortalPlan) {
  const family = classifyFamily(plan.name);
  const key = family === "occasion" ? "everyday" : family;
  return SPEED_TIERS.find((tier) => tier.key === key) || null;
}
function renderPlanGrid(plans: PortalPlan[], devices?: number) {
  return plans.length
    ? plans.map((plan) => planCard(plan, devices ? Math.min(maxDevicesForPlan(plan), Math.max(plan.deviceLimit, devices)) : plan.deviceLimit)).join("")
    : '<div class="empty-state">No packages in this group yet.</div>';
}
function isMultiDevicePlan(plan: PortalPlan) {
  return plan.deviceLimit > 1 || maxDevicesForPlan(plan) > 1;
}
// Packages are grouped by what actually drives their price -- time and
// speed -- instead of by name, so a pricier card never sits unexplained
// between cheaper ones: hourly and multi-day packages each get their own
// section, and anything faster than standard gets its own space below.
const FAST_DOWNLOAD_MBPS = 10;
function isFastPlan(plan: PortalPlan) {
  return rateParts(plan.rateLimit).download > FAST_DOWNLOAD_MBPS;
}
function standardDownloadMbps() {
  const speeds = customerPlans()
    .filter((plan) => !isFastPlan(plan))
    .map((plan) => rateParts(plan.rateLimit).download)
    .filter((mbps) => mbps > 0)
    .sort((a, b) => a - b);
  return speeds.length ? speeds[Math.floor(speeds.length / 2)] : FAST_DOWNLOAD_MBPS;
}
function renderPlanSection(title: string, plans: PortalPlan[], variant = "", devices?: number) {
  if (!plans.length) return "";
  return `<section class="plan-section ${variant}">
    <h3 class="plan-section-title">${esc(title)}</h3>
    <div class="intent-grid">${renderPlanGrid(plans, devices)}</div>
  </section>`;
}
// All / Multiple devices / Faster: the filters under "Packages".
function renderPackageViews(visiblePlans: PortalPlan[]) {
  const views = document.getElementById("package-views");
  if (!views) return;
  const available = { all: true, multi: visiblePlans.some(isMultiDevicePlan), fast: visiblePlans.some(isFastPlan) };
  if (!available[state.packageView]) state.packageView = "all";
  views.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => {
    const view = button.dataset.view as keyof typeof available;
    button.classList.toggle("hidden", !available[view]);
    button.classList.toggle("active", view === state.packageView);
    button.setAttribute("aria-selected", String(view === state.packageView));
  });
}
function renderPackageBrowser() {
  const visiblePlans = customerPlans();
  if (!visiblePlans.length) {
    plansEl.innerHTML = '<div class="empty-state">No WiFi packages are published yet.</div>';
    renderSelectedPlan();
    return;
  }
  renderPackageViews(visiblePlans);
  if (state.packageView === "multi") {
    plansEl.innerHTML = `<div class="plan-sections">${renderPlanSection("Priced for 2 devices", visiblePlans.filter(isMultiDevicePlan), "", 2)}</div>`;
    renderSelectedPlan();
    return;
  }
  if (state.packageView === "fast") {
    plansEl.innerHTML = `<div class="plan-sections">${renderPlanSection("Faster speeds", visiblePlans.filter(isFastPlan), "fast")}</div>`;
    renderSelectedPlan();
    return;
  }
  const standard = visiblePlans.filter((plan) => !isFastPlan(plan));
  const fast = visiblePlans.filter(isFastPlan);
  plansEl.innerHTML = `
    <div class="plan-sections">
      ${renderPlanSection("By the hour", standard.filter((plan) => Number(plan.durationSeconds) < 86400))}
      ${renderPlanSection("By the day", standard.filter((plan) => Number(plan.durationSeconds) >= 86400))}
      ${renderPlanSection("Faster speeds", fast, "fast")}
    </div>
  `;
  renderSelectedPlan();
}
function renderPlans(sites) {
  state.plans = sites.flatMap((site) => site.plans.map((plan) => ({ ...plan, site }))).sort(comparePlansByPrice);
  const visiblePlans = customerPlans();
  if (!state.selectedPlanId && visiblePlans[0]) {
    state.activeNeed = "all";
    state.selectedPlanId = visiblePlans[0].id;
  }
  if (state.selectedPlanId && !state.plans.some((plan) => plan.id === state.selectedPlanId)) state.selectedPlanId = visiblePlans[0]?.id || "";
  renderPackageBrowser();
}
async function loadPlans() {
  const response = await fetch(api("/sites"));
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Unable to load WiFi packages.");
  renderPlans(payload.data || []);
}
function selectPlan(planId) {
  const selected = state.plans.find((plan) => plan.id === planId);
  if (!selected) return;
  state.selectedPlanId = planId;
  // Picked from "Multiple devices": start checkout at 2 devices.
  state.selectedDevices = state.packageView === "multi"
    ? Math.min(maxDevicesForPlan(selected), Math.max(selected.deviceLimit, 2))
    : selected.deviceLimit;
  const selectedTier = speedTierForPlan(selected);
  if (selectedTier && !isSupportOnlyPlan(selected)) state.activeNeed = selectedTier.key;
  access.classList.add("hidden");
  resetPaymentAttempt();
  showError("");
  renderPlans(state.plans.reduce((sites, plan) => {
    const existing = sites.find((site) => site.id === plan.site.id);
    const compactPlan = { ...plan };
    delete compactPlan.site;
    if (existing) existing.plans.push(compactPlan);
    else sites.push({ ...plan.site, plans: [compactPlan] });
    return sites;
  }, []));
  setStep("package");
  openCheckoutSheet();
}
function waitingMessage() {
  const elapsedMs = state.paymentStartedAt ? Date.now() - state.paymentStartedAt : 0;
  if (elapsedMs < 12000) return "Enter your M-PESA PIN.";
  if (elapsedMs < 30000) return "Still waiting...";
  return "No prompt? Dial *334#, then try again.";
}

// Remembers the last confirmed access on this device/browser so revisiting
// the portal (reload, reopened tab, no hotspot-redirect context at all)
// still shows the connected-status panel instead of the package list.
const REMEMBERED_ACCESS_KEY = "captynWifiAccess";
function saveRememberedAccess(entitlement) {
  try {
    localStorage.setItem(
      REMEMBERED_ACCESS_KEY,
      JSON.stringify({
        username: entitlement.username,
        password: entitlement.password,
        expiresAt: entitlement.expiresAt,
        startsAt: entitlement.startsAt,
        deviceLimit: entitlement.deviceLimit,
        // The router's post-login redirect back to /wifi/ carries no MAC, so
        // keep it here for "Sign out this device".
        deviceMac: state.hotspot?.mac || entitlement.deviceMac || loadRememberedAccess()?.deviceMac || ""
      })
    );
  } catch (_error) {}
}
function loadRememberedAccess() {
  try {
    const raw = localStorage.getItem(REMEMBERED_ACCESS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.username || !parsed?.password || !parsed?.expiresAt) return null;
    if (new Date(parsed.expiresAt).getTime() <= Date.now()) {
      localStorage.removeItem(REMEMBERED_ACCESS_KEY);
      return null;
    }
    return parsed;
  } catch (_error) {
    return null;
  }
}
function currentDeviceMac(): string {
  return state.hotspot?.mac || loadRememberedAccess()?.deviceMac || "";
}
function clearRememberedAccess() {
  try { localStorage.removeItem(REMEMBERED_ACCESS_KEY); } catch (_error) {}
}

// Real, visible, user-initiated navigation — shown when the background
// auto-connect (hidden iframe) can't be confirmed, so the customer always
// has a way to finish connecting themselves regardless of why the
// automatic attempt failed (blocked, timed out, etc.).
function placeManualConnectFallback(placement: ManualConnectOptions["placement"] = "default") {
  if (placement === "access" && !access.classList.contains("hidden")) {
    access.insertBefore(manualConnectFallback, extendPeriodBtn);
    return;
  }
  // "default" is a fixed, centered modal overlay (see portal.css) rather
  // than an inline page element -- previously it was inserted as a normal
  // sibling, which meant it silently rendered *behind* the mobile checkout
  // bottom sheet (position: fixed; z-index: 40) whenever a login attempt
  // failed mid-checkout, since a hidden-but-present element isn't visible
  // just because it's unhidden. Being a fixed overlay in front of
  // everything (and living outside .checkout-panel, so that panel's
  // transform can't turn it into a new containing block) means DOM
  // placement doesn't matter for visibility anymore -- it always appears
  // centered on top, regardless of what panel is open underneath it.
  const portalApp = document.querySelector<HTMLElement>(".portal-app");
  if (portalApp && manualConnectFallback.parentElement !== portalApp) {
    portalApp.insertBefore(manualConnectFallback, errorText);
  }
}
function manualConnectPlacement(): ManualConnectOptions["placement"] {
  return access.classList.contains("hidden") ? "default" : "access";
}
function showManualConnectFallback(username, password, options: ManualConnectOptions = {}) {
  if (!manualConnectFallback) return;
  placeManualConnectFallback(options.placement);
  if (state.hotspot?.login && manualConnectForm) {
    if (manualConnectMessage) {
      manualConnectMessage.textContent = options.message || "Your access is active. Tap below if this device does not connect automatically.";
    }
    manualConnectSubmitBtn.textContent = options.buttonLabel || "Tap to connect";
    pendingManualConnect = { username, password };
    manualConnectForm.classList.remove("hidden");
    manualConnectOpenBtn?.classList.add("hidden");
  } else {
    if (manualConnectMessage) {
      manualConnectMessage.textContent = options.message || "Your package is active. Tap below to open your device's WiFi sign-in page, then this portal can activate the connection.";
    }
    manualConnectForm?.classList.add("hidden");
    manualConnectOpenBtn?.classList.remove("hidden");
  }
  manualConnectFallback.classList.remove("hidden");
}
function hideManualConnectFallback() {
  manualConnectFallback?.classList.add("hidden");
}

// Takes over from the package-browsing UI once a customer has confirmed,
// working access — used both right after a purchase and when a returning
// device already has valid access, so paying customers stop seeing package
// cards they don't need and see their status instead.
function updateAccessCopy(heading) {
  if (heading) accessHeading.textContent = heading;
}

async function loadConnectCode(entitlement: Entitlement) {
  try {
    const response = await fetch(api("/entitlements/devices/list"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: entitlement.username, password: entitlement.password })
    });
    const data = response.ok ? (await response.json())?.data : null;
    if (!data || state.currentEntitlement !== entitlement) return;
    entitlement.connectCode = data.connectCode;
    entitlement.deviceCap = data.deviceCap;
    entitlement.devices = data.devices || entitlement.devices;
    if (data.deviceLimit) entitlement.deviceLimit = data.deviceLimit;
    renderDeviceList(entitlement);
  } catch (_error) {}
}
function showConnectedPanel(entitlement: Entitlement, { heading, skipAutoConnect, freshGrant, recoveryReference, hideCredentials }: ConnectedPanelOptions = {}) {
  if (workspaceEl) workspaceEl.classList.add("hidden");
  hideManualConnectFallback();
  updateAccessCopy(heading || "Access active");
  accessUsername.textContent = entitlement.username;
  accessPassword.textContent = entitlement.password;
  if (accessRecovery) accessRecovery.textContent = recoveryReference || "";
  const shouldShowLoginDetails = Boolean(recoveryReference) || !hideCredentials;
  accessLoginDetails?.classList.toggle("hidden", !shouldShowLoginDetails);
  if (accessLoginDetails && !shouldShowLoginDetails) accessLoginDetails.open = false;
  accessUsernameCard?.classList.toggle("hidden", Boolean(hideCredentials));
  accessPasswordCard?.classList.toggle("hidden", Boolean(hideCredentials));
  accessRecoveryCard?.classList.toggle("hidden", !recoveryReference);
  accessExpires.textContent = new Date(entitlement.expiresAt).toLocaleString(undefined, { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" });
  if (introRowEl) introRowEl.classList.add("hidden");
  renderOutageNote(entitlement);
  state.currentEntitlement = entitlement;
  hideDeviceLimitNotice();
  renderDeviceList(entitlement);
  // Remembered access (a later visit on this device) doesn't carry the
  // device code -- fetch it so "Code for another device" always shows.
  if (!entitlement.connectCode && entitlement.password) void loadConnectCode(entitlement);
  void loadNotifications(entitlement.username);
  access.classList.remove("hidden");
  setStep("access");
  closeCheckoutSheet();
  access.scrollIntoView({ behavior: "smooth", block: "start" });
  startExpiryWatch(entitlement.expiresAt, entitlement.startsAt);
  saveRememberedAccess(entitlement);
  signOutDeviceBtn.classList.toggle("hidden", !currentDeviceMac());
  if (skipAutoConnect) return;
  if (state.hotspot?.login) {
    // attemptAutoConnect navigates to the router's login page (a hidden
    // iframe login is blocked as mixed content -- see there).
    void attemptAutoConnect(entitlement.username, entitlement.password, paymentStatus, null, { freshGrant: Boolean(freshGrant) });
  } else {
    updateAccessCopy("Access active");
    setConnectState(paymentStatus, null, "failed", "This device still needs to complete WiFi sign-in before internet is available.");
    showManualConnectFallback(entitlement.username, entitlement.password, { placement: manualConnectPlacement() });
  }
}
extendPeriodBtn?.addEventListener("click", () => {
  if (workspaceEl) workspaceEl.classList.remove("hidden");
  if (introRowEl) introRowEl.classList.remove("hidden");
  resetPaymentAttempt();
  // Always land on "all" here rather than whatever tier happens to still be
  // selected from earlier in the session (e.g. the tier they originally
  // bought) -- someone adding time wants to see everything available, not
  // get funneled back into just one speed tier.
  state.activeNeed = "all";
  renderPackageBrowser();
  plansEl.scrollIntoView({ behavior: "smooth", block: "start" });
});

async function pollPayment() {
  if (!state.paymentId) return;
  const response = await fetch(api(`/payments/${encodeURIComponent(state.paymentId)}`));
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) return;
  const payment = payload.data;

  if (payment.status === "pending_confirmation") {
    const message = waitingMessage();
    setConnectState(paymentStatus, null, "connecting", message);
    showPaymentModal("connecting", "Check your phone", message);
  } else if (payment.status === "payment_failed" || payment.status === "failed") {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
    payButton.disabled = false;
    payButton.textContent = paymentActionLabel();
    const failureMessage = payment.failureReason || "Payment didn't go through. Tap Pay Now to try again.";
    setConnectState(paymentStatus, null, "failed", failureMessage);
    showPaymentModal("bad", "Payment didn't go through", failureMessage);
  }

  if (payment.entitlement) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
    hidePaymentModal();
    showConnectedPanel(payment.entitlement, {
      heading: payment.extended ? "Access extended" : "Access ready",
      message: payment.extended
        ? "Your existing package's time has been topped up. Activating WiFi on this device now."
        : "Payment complete. Activating WiFi on this device now.",
      recoveryReference: payment.receiptNumber || payment.providerReference || payment.sourceReference,
      hideCredentials: true,
      freshGrant: true
    });
  }
}
paymentForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("");
  const plan = currentPlan();
  if (!plan) { showError("Choose a package first."); return; }
  payButton.disabled = true;
  const isFree = Number(plan.priceKsh || 0) === 0;
  if (isFree) {
    payButton.textContent = "Starting...";
    setConnectState(paymentStatus, null, "connecting", "Creating free access for this device...");
    setStep("mpesa");
    try {
      const response = await fetch(api("/access/free"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: plan.id, deviceMac: state.hotspot?.mac || undefined })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        // "CAPTYN Welcome" only blocks on a prior claim (see activateFreePlan),
        // active or long expired -- the API hands back whichever entitlement
        // triggered the block either way, so tell those two cases apart here:
        // still active means reconnect them to what they already have; a
        // long-expired one means they already used their one-time welcome
        // offer and this is a dead end, not something to reconnect to.
        if (response.status === 400 && payload?.entitlement) {
          payButton.disabled = false;
          payButton.textContent = paymentActionLabel(plan);
          setConnectState(paymentStatus, null, "", "");
          const stillActive = new Date(payload.entitlement.expiresAt).getTime() > Date.now();
          if (stillActive) {
            showConnectedPanel(payload.entitlement, {
              heading: "Free access already active",
              message: "This device already has active free access — reconnecting you now.",
              hideCredentials: Boolean(state.hotspot?.login)
            });
          } else {
            showPaymentModal(
              "welcome-used",
              "Nah bro \u{1F62D}",
              "Someone already used your welcome access on this device. It's a one-time thing — grab one of the packages below instead."
            );
          }
          return;
        }
        throw new Error(payload.error || "Unable to start free access.");
      }
      if (!payload?.data?.entitlement) throw new Error("Unable to start free access.");
      payButton.disabled = false;
      payButton.textContent = Number(plan.priceKsh || 0) === 0 ? paymentActionLabel(plan) : `Pay ${money(plan.priceKsh)}`;
      setConnectState(paymentStatus, null, "", "");
      showConnectedPanel(payload.data.entitlement, {
        heading: payload.data.extended ? "Free access extended" : "Free access ready",
        message: "Activating WiFi on this device now.",
        hideCredentials: Boolean(state.hotspot?.login),
        freshGrant: true
      });
      return;
    } catch (error) {
      showError(error instanceof Error ? error.message : "Unable to start free access.");
      setConnectState(paymentStatus, null, "", "");
      payButton.disabled = false;
      payButton.textContent = Number(plan.priceKsh || 0) === 0 ? paymentActionLabel(plan) : `Pay ${money(plan.priceKsh)}`;
      setStep("package");
      return;
    }
  }

  const normalizedPhone = normalizeMpesaPhoneInput(phoneInput.value);
  if (!normalizedPhone) {
    showError("Enter a valid M-PESA number starting with +2547, +2541, 07, 01, 7, or 1.");
    payButton.disabled = false;
    payButton.textContent = Number(plan.priceKsh || 0) === 0 ? paymentActionLabel(plan) : `Pay ${money(devicePriceFor(plan, checkoutDevices(plan)))}`;
    phoneInput.focus();
    setStep("package");
    return;
  }
  phoneInput.value = normalizedPhone;

  payButton.textContent = "Sending prompt...";
  setConnectState(paymentStatus, null, "connecting", "Sending prompt...");
  showPaymentModal("connecting", "Sending prompt", "Sending prompt...");
  setStep("mpesa");
  try {
    const response = await fetch(api("/payments/mpesa/stk"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planId: plan.id, phone: normalizedPhone, deviceMac: state.hotspot?.mac || undefined, deviceCount: checkoutDevices(plan) })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Unable to start M-PESA payment.");
    state.paymentId = payload.data.id;
    state.paymentStartedAt = Date.now();
    payButton.textContent = "Waiting for M-PESA...";
    const message = payload.data.customerMessage || waitingMessage();
    setConnectState(paymentStatus, null, "connecting", message);
    showPaymentModal("connecting", "Check your phone", message);
    payButton.disabled = true;
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(pollPayment, 2500);
    setTimeout(pollPayment, 1000);
  } catch (error) {
    showError(error instanceof Error ? error.message : "Unable to start payment.");
    setConnectState(paymentStatus, null, "", "");
    hidePaymentModal();
    payButton.disabled = false;
    payButton.textContent = Number(plan.priceKsh || 0) === 0 ? paymentActionLabel(plan) : `Pay ${money(plan.priceKsh)}`;
    setStep("package");
  }
});

paymentModalCancelBtn.addEventListener("click", () => {
  resetPaymentAttempt();
  setStep("package");
});
paymentModalRetryBtn.addEventListener("click", () => {
  resetPaymentAttempt();
  setStep("package");
});
manualConnectSubmitBtn.addEventListener("click", () => {
  if (!pendingManualConnect) return;
  autoCompleteHotspotLogin(pendingManualConnect.username, pendingManualConnect.password, { topLevel: true });
});
plansEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const speedButton = target.closest("[data-speed-key]");
  const speedKey = speedButton instanceof HTMLElement ? speedButton.dataset.speedKey || "" : "";
  if (isNeedKey(speedKey)) {
    state.activeNeed = speedKey;
    renderPackageBrowser();
    return;
  }
  const card = target.closest("[data-plan-id]");
  if (card instanceof HTMLElement) selectPlan(card.dataset.planId || "");
});
selectedSummary.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const speedButton = target.closest("[data-view-speed-key]");
  const speedKey = speedButton instanceof HTMLElement ? speedButton.dataset.viewSpeedKey || "" : "";
  if (isNeedKey(speedKey)) {
    state.activeNeed = speedKey;
    renderPackageBrowser();
    closeCheckoutSheet();
    plansEl.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  const compareCard = target.closest("[data-plan-id]");
  if (compareCard instanceof HTMLElement) selectPlan(compareCard.dataset.planId || "");
});
document.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const copyTarget = target.closest("[data-copy-target]");
  if (!(copyTarget instanceof HTMLElement)) return;
  const value = document.getElementById(copyTarget.dataset.copyTarget || "")?.textContent || "";
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    const label = copyTarget.querySelector("em");
    if (label) {
      label.textContent = "Copied";
      setTimeout(() => { label.textContent = "Copy"; }, 1200);
    }
  } catch (_error) {}
});

expiryRenewBtn?.addEventListener("click", () => {
  closeCheckoutSheet();
  plansEl.scrollIntoView({ behavior: "smooth", block: "start" });
});

state.hotspot = readHotspotParams();
// FreeRADIUS rejects a login past the plan's Simultaneous-Use limit with
// "You are already logged in - access denied" -- reword it for customers.
function friendlyHotspotError(raw: string): string {
  if (/already logged in|simultaneous/i.test(raw)) {
    return "Your package is already in use on its other device. Sign that device out, or buy a package for this one with a different M-PESA number.";
  }
  return raw;
}
// The router just turned this device away (the error param is only set on
// a failed sign-in). Auto-signing in again would bounce straight back here
// -- a device on a full package reloaded the portal every few seconds and
// could never reach the packages to buy. So: no automatic sign-in after a
// refusal, and never more than once per 2 minutes on this device.
const AUTO_SIGN_IN_KEY = "captynWifiAutoSignInAt";
function autoSignInAllowed(): boolean {
  if (state.hotspot?.error) return false;
  try {
    const last = Number(sessionStorage.getItem(AUTO_SIGN_IN_KEY) || 0);
    return Date.now() - last > 2 * 60 * 1000;
  } catch (_error) {
    return true;
  }
}
function noteAutoSignIn() {
  try { sessionStorage.setItem(AUTO_SIGN_IN_KEY, String(Date.now())); } catch (_error) {}
}
if (state.hotspot?.error) showError(friendlyHotspotError(decodeURIComponent(state.hotspot.error)));

voucherLoginToggle?.addEventListener("click", () => {
  voucherLoginForm.classList.toggle("hidden");
  if (!voucherLoginForm.classList.contains("hidden")) voucherCodeInput.focus();
});
// On mobile the checkout panel is a bottom sheet that only opens via
// selectPlan() — without this, someone with a voucher/receipt/existing
// login has no way to reach those forms without first tapping a package
// they don't intend to buy.
haveCodeBtn?.addEventListener("click", () => {
  if (workspaceEl) workspaceEl.classList.remove("hidden");
  access.classList.add("hidden");
  resetPaymentAttempt();
  voucherLoginForm.classList.remove("hidden");
  receiptLoginForm.classList.add("hidden");
  existingLoginForm.classList.add("hidden");
  setStep("package");
  openCheckoutSheet();
  setTimeout(() => {
    voucherCodeInput.focus();
    checkoutPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, 40);
});
voucherLoginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = voucherCodeInput.value.trim().toUpperCase();
  if (!code) return;
  // Device codes (shown on an already-connected device) are 6 characters;
  // vouchers are 8+, so length alone tells them apart.
  const deviceCode = code.replace(/[\s-]/g, "");
  if (deviceCode.length === 6) {
    if (!state.hotspot?.login) {
      setConnectState(voucherLoginStatus, null, "failed", "Connect to this WiFi network first, then reopen this page to enter your code.");
      return;
    }
    setConnectState(voucherLoginStatus, voucherLoginForm, "connecting", "Checking your code...");
    try {
      const response = await fetch(api("/entitlements/connect-code/redeem"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: deviceCode })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.data?.username) throw new Error(payload.error || "That code isn't valid.");
      await attemptAutoConnect(payload.data.username, payload.data.password, voucherLoginStatus, voucherLoginForm);
    } catch (error) {
      setConnectState(voucherLoginStatus, voucherLoginForm, "failed", error instanceof Error ? error.message : "That code isn't valid.");
    }
    return;
  }
  if (!state.hotspot?.login) {
    setConnectState(voucherLoginStatus, null, "failed", "Connect to this WiFi network first, then reopen this page to redeem your code.");
    showManualConnectFallback(code, code, { placement: manualConnectPlacement() });
    return;
  }

  setConnectState(voucherLoginStatus, voucherLoginForm, "connecting", "Checking your voucher and activating WiFi...");
  try {
    const response = await fetch(api(`/entitlements/${encodeURIComponent(code)}/status`));
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.data?.status !== "active") {
      throw new Error(payload.error || "That voucher is expired or was not found.");
    }
    showConnectedPanel(
      { username: code, password: code, expiresAt: payload.data.expiresAt, deviceLimit: payload.data.deviceLimit },
      {
        heading: "Voucher accepted",
        message: "Activating WiFi on this device now.",
        freshGrant: true
      }
    );
  } catch (error) {
    setConnectState(voucherLoginStatus, voucherLoginForm, "failed", error instanceof Error ? error.message : "Voucher could not be redeemed.");
  }
});
existingLoginToggle?.addEventListener("click", () => {
  existingLoginForm.classList.toggle("hidden");
  if (!existingLoginForm.classList.contains("hidden")) existingUsernameInput.focus();
});
existingLoginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const username = existingUsernameInput.value.trim();
  const password = existingPasswordInput.value;
  if (!username || !password) return;
  if (!state.hotspot?.login) {
    setConnectState(existingLoginStatus, null, "failed", "Connect to this WiFi network first, then reopen this page to log in.");
    return;
  }
  await attemptAutoConnect(username, password, existingLoginStatus, existingLoginForm);
});

receiptLoginToggle?.addEventListener("click", () => {
  receiptLoginForm.classList.toggle("hidden");
  if (!receiptLoginForm.classList.contains("hidden")) receiptCodeInput.focus();
});
receiptLoginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const receipt = receiptCodeInput.value.trim().toUpperCase();
  const phone = normalizeMpesaPhoneInput(receiptPhoneInput.value);
  if (!receipt) return;
  if (!phone) {
    setConnectState(receiptLoginStatus, receiptLoginForm, "failed", "Enter the Safaricom phone number used for this payment.");
    return;
  }
  if (!state.hotspot?.login) {
    setConnectState(receiptLoginStatus, null, "failed", "Connect to this WiFi network first, then reopen this page to log in.");
    return;
  }
  setConnectState(receiptLoginStatus, receiptLoginForm, "connecting", "Checking your M-PESA code...");
  try {
    const response = await fetch(api("/payments/lookup-by-receipt"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ receipt, phone })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Couldn't find that M-PESA code.");
    await attemptAutoConnect(payload.data.username, payload.data.password, receiptLoginStatus, receiptLoginForm);
  } catch (error) {
    setConnectState(receiptLoginStatus, receiptLoginForm, "failed", error instanceof Error ? error.message : "Couldn't find that M-PESA code.");
  }
});

async function attemptReturningDeviceAutoConnect() {
  if (!state.hotspot?.login || !autoSignInAllowed()) return false;

  const remembered = loadRememberedAccess();
  if (remembered) {
    showError("");
    // Was hideCredentials: true -- but that left someone who'd genuinely
    // forgotten their password with no way to see it again short of the
    // M-PESA receipt lookup, even though they're looking right at their own
    // valid session. Showing it here lets them copy it straight to a 2nd
    // device instead.
    showConnectedPanel(remembered, {
      heading: "Welcome back",
      message: "You already have WiFi access saved in this browser. Reconnecting you now."
    });
    return true;
  }

  // localStorage misses a lot of devices that should still be recognized --
  // the captive-portal helper (iOS/Android's built-in sign-in webview) often
  // opens a fresh, non-persistent context on each reconnect, wiping storage
  // even when the device's own MAC hasn't changed. Fall back to a
  // server-side MAC lookup before giving up and showing someone who already
  // paid the package list again.
  const mac = state.hotspot?.mac;
  if (!mac) return false;
  try {
    const response = await fetch(api(`/entitlements/by-device/${encodeURIComponent(mac)}`));
    if (!response.ok) return false;
    const payload = await response.json();
    if (!payload?.data?.username) return false;
    showError("");
    showConnectedPanel(payload.data, {
      heading: "Welcome back",
      message: "You already have WiFi access on this device — reconnecting you now."
    });
    return true;
  } catch (_error) {
    return false;
  }
}

function startPromoCountdown(endsAt: string) {
  const target = new Date(endsAt).getTime();
  if (!Number.isFinite(target)) return;
  if (promoCountdownTimer) clearInterval(promoCountdownTimer);
  function tick() {
    const remainingMs = target - Date.now();
    if (remainingMs <= 0) {
      promoCountdown.textContent = "Ending now";
      if (promoCountdownTimer) clearInterval(promoCountdownTimer);
      promoCountdownTimer = null;
      return;
    }
    promoCountdown.textContent = formatTimeLeft(remainingMs).replace(/ left$/, "");
  }
  tick();
  promoCountdownTimer = window.setInterval(tick, 30000);
}

// A live promo takes priority over everything else -- including a returning
// device's own paid entitlement, which is safe to leave alone since it's
// frozen (promoPausedAt) rather than being spent while the free grant is in
// use. Anyone hitting the portal while a promo is active sees this instead
// of the normal package list, whether they've paid before or not.
async function checkPromo(): Promise<boolean> {
  let promo;
  try {
    const response = await fetch(api("/promo"));
    if (!response.ok) return false;
    const payload = await response.json();
    if (!payload?.data?.active) return false;
    promo = payload.data;
  } catch (_error) {
    return false;
  }

  if (workspaceEl) workspaceEl.classList.add("hidden");
  if (introRowEl) introRowEl.classList.add("hidden");
  access.classList.add("hidden");
  promoHeading.textContent = promo.heading || "Thank you for choosing CAPTYN";
  promoMessage.textContent = promo.message || "Every device on the network gets full-speed access, on us — no purchase, no fine print.";
  promoNote.textContent = "Got an active package? It's on pause, not spent — every minute picks back up the second this event ends.";
  promoSection.classList.remove("hidden");
  promoSection.scrollIntoView({ behavior: "smooth", block: "start" });
  startPromoCountdown(promo.endsAt);

  const mac = state.hotspot?.mac;
  if (!mac) {
    promoStatus.textContent = "Connect to the CAPTYN WiFi network, then reopen this page to grab your free access.";
    return true;
  }

  promoStatus.textContent = "Unlocking your free access...";
  try {
    const response = await fetch(api("/promo/claim"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceMac: mac })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Couldn't activate free access.");
    await attemptAutoConnect(payload.data.username, payload.data.password, promoStatus, null, { freshGrant: true });
  } catch (error) {
    promoStatus.textContent = error instanceof Error ? error.message : "Couldn't activate free access.";
  }
  return true;
}

// The router's own Sign out (status page) only ends the router session. Its
// "See you soon" page sends the device here with ?signedOut=1&mac=..., so
// the sign-out sticks like the portal's button: the device is marked signed
// out on the package and this browser forgets the access, instead of being
// signed straight back in on its next visit.
async function finishRouterSignOut() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has("signedOut")) return;
  const remembered = loadRememberedAccess();
  const deviceMac = params.get("mac") || remembered?.deviceMac || "";
  clearRememberedAccess();
  if (!remembered || !deviceMac) return;
  try {
    await fetch(api("/entitlements/sign-out-device"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: remembered.username, password: remembered.password, deviceMac })
    });
  } catch (_error) {}
}
async function bootstrap() {
  await finishRouterSignOut();
  const loadPlansPromise = loadPlans().catch((error) => showError(error instanceof Error ? error.message : "Unable to load packages."));

  const promoActive = await checkPromo();
  if (promoActive) {
    await loadPlansPromise;
    return;
  }

  void loadRedeemableCredits(null);

  // Recognizes a returning device two ways, in order: this browser's own
  // remembered access (fast, no network call), then a server-side by-device
  // MAC lookup as a fallback for when storage didn't survive a fresh
  // captive-portal webview. Receipt/voucher/technical login remain the
  // manual fallback for whatever neither of those two catches (e.g. the
  // device's MAC itself rotated too).
  const reconnectedViaDevice = await attemptReturningDeviceAutoConnect();
  if (!reconnectedViaDevice) {
    const remembered = loadRememberedAccess();
    if (remembered) {
      // This is also reachable outside the captive-portal redirect (e.g. a
      // bookmarked visit from a device that's already fully connected) --
      // showing credentials here is what makes it possible to grab your
      // password to sign in a 2nd device without needing the M-PESA receipt
      // recovery flow.
      // After a refusal, leave the packages on screen so this device can
      // still buy; the error above says why it was turned away.
      if (!state.hotspot?.error) {
        showConnectedPanel(remembered, {
          heading: "Access active",
          skipAutoConnect: !state.hotspot?.login || !autoSignInAllowed()
        });
      }
    }
  }

  await loadPlansPromise;
}
void bootstrap();

signOutDeviceBtn.addEventListener("click", async () => {
  const entitlement = state.currentEntitlement;
  const deviceMac = currentDeviceMac();
  if (!entitlement || !deviceMac) return;
  if (!window.confirm("Sign out this device? Your package time keeps running.")) return;
  signOutDeviceBtn.disabled = true;
  signOutDeviceBtn.textContent = "Signing out...";
  try {
    const response = await fetch(api("/entitlements/sign-out-device"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: entitlement.username, password: entitlement.password, deviceMac })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Couldn't sign this device out.");
    clearRememberedAccess();
    window.location.replace(`${portalReturnUrl()}?signedOut=1`);
  } catch (error) {
    signOutDeviceBtn.disabled = false;
    signOutDeviceBtn.textContent = "Sign out this device";
    showError(error instanceof Error ? error.message : "Couldn't sign this device out.");
  }
});
if (new URLSearchParams(window.location.search).has("signedOut")) {
  const note = document.querySelector<HTMLElement>(".intro-note");
  if (note) note.textContent = "This device is signed out. Your package time keeps running.";
}

selectedSummary.addEventListener("click", (event) => {
  const option = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-devices]") : null;
  if (!option) return;
  state.selectedDevices = Number(option.dataset.devices || 1);
  renderSelectedPlan();
});

// "Add a device": pay the time-left share to raise this package's device
// limit (POST /payments/mpesa/add-device); RADIUS lets the extra device in
// as soon as the payment confirms.
let addDeviceChoice = 0;
addDeviceBtn.addEventListener("click", async () => {
  const entitlement = state.currentEntitlement;
  if (!entitlement) return;
  addDeviceBtn.classList.add("hidden");
  addDevicePanel.classList.remove("hidden");
  addDeviceStatus.textContent = "";
  addDeviceOptions.innerHTML = '<p class="device-locked">Loading prices...</p>';
  if (!addDevicePhone.value && /^254\d{9}$/.test(entitlement.username)) addDevicePhone.value = `+${entitlement.username}`;
  try {
    const response = await fetch(api("/entitlements/add-device/quote"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: entitlement.username, password: entitlement.password })
    });
    const payload = await response.json().catch(() => ({}));
    const options: Array<{ devices: number; priceKsh: number }> = payload.data?.options || [];
    if (!response.ok || !options.length) {
      addDeviceOptions.innerHTML = '<p class="device-locked">This package can\'t take more devices.</p>';
      addDevicePay.disabled = true;
      return;
    }
    addDeviceChoice = options[0].devices;
    const render = () => {
      addDeviceOptions.innerHTML = `<div class="device-picker">${options
        .map((option) => `<button type="button" class="device-option ${option.devices === addDeviceChoice ? "active" : ""}" data-add-devices="${option.devices}"><strong>${option.devices}</strong><span>devices</span><em>+${money(option.priceKsh)}</em></button>`)
        .join("")}</div>`;
      const chosen = options.find((option) => option.devices === addDeviceChoice);
      addDevicePay.textContent = chosen ? `Pay ${money(chosen.priceKsh)}` : "Pay";
      addDevicePay.disabled = !chosen;
    };
    addDeviceOptions.onclick = (event) => {
      const button = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-add-devices]") : null;
      if (!button) return;
      addDeviceChoice = Number(button.dataset.addDevices);
      render();
    };
    render();
  } catch (_error) {
    addDeviceOptions.innerHTML = '<p class="device-locked">Couldn\'t load prices. Try again.</p>';
  }
});
addDevicePay.addEventListener("click", async () => {
  const entitlement = state.currentEntitlement;
  const phone = normalizeMpesaPhoneInput(addDevicePhone.value);
  if (!entitlement || !addDeviceChoice) return;
  if (!phone) {
    addDeviceStatus.textContent = "Enter the M-PESA number to pay with.";
    return;
  }
  addDevicePay.disabled = true;
  addDeviceStatus.textContent = "Check your phone for the M-PESA prompt.";
  try {
    const response = await fetch(api("/payments/mpesa/add-device"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: entitlement.username, password: entitlement.password, phone: phone.replace(/^\+/, ""), deviceCount: addDeviceChoice })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.data?.status === "failed") throw new Error(payload.error || "Couldn't send the M-PESA prompt.");
    const paymentId = payload.data.id;
    const startedAt = Date.now();
    const poll = async () => {
      const result = await fetch(api(`/payments/${encodeURIComponent(paymentId)}`)).then((r) => r.json()).catch(() => null);
      const status = result?.data?.status;
      if (status === "activated") {
        entitlement.deviceLimit = addDeviceChoice;
        addDevicePanel.classList.add("hidden");
        addDevicePay.disabled = false;
        await loadConnectCode(entitlement);
        renderDeviceList(entitlement);
        setDeviceFeedback(`Done. This package now covers ${addDeviceChoice} devices.`, "ok");
        return;
      }
      if (status === "failed") {
        addDeviceStatus.textContent = result?.data?.failureReason || "Payment didn't go through. Try again.";
        addDevicePay.disabled = false;
        return;
      }
      if (Date.now() - startedAt > 3 * 60 * 1000) {
        addDeviceStatus.textContent = "Still waiting for M-PESA. If you paid, your devices will update shortly.";
        addDevicePay.disabled = false;
        return;
      }
      setTimeout(poll, 3000);
    };
    setTimeout(poll, 3000);
  } catch (error) {
    addDeviceStatus.textContent = error instanceof Error ? error.message : "Couldn't send the M-PESA prompt.";
    addDevicePay.disabled = false;
  }
});

document.getElementById("package-views")?.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-view]") : null;
  if (!button) return;
  state.packageView = (button.dataset.view as "all" | "multi" | "fast") || "all";
  renderPackageBrowser();
});
