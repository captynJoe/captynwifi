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
}

interface PortalPlan extends PortalPlanInput {
  site: Omit<PortalSite, "plans">;
}

interface Entitlement {
  username: string;
  password: string;
  expiresAt: string;
  deviceLimit?: number;
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
  paymentStartedAt?: number;
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing portal element #${id}`);
  return element as T;
}

const state: PortalState = { plans: [], selectedPlanId: "", paymentId: "", pollTimer: null, hotspot: null, expiryTimer: null, activeNeed: "all" };
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
const extendPeriodBtn = requireElement<HTMLButtonElement>("extend-period-btn");
const workspaceEl = document.querySelector<HTMLElement>(".workspace");
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
const receiptLoginStatus = requireElement<HTMLParagraphElement>("receipt-login-status");
const themeToggleBtn = requireElement<HTMLButtonElement>("theme-toggle-btn");
const welcomeAccessBtn = requireElement<HTMLButtonElement>("welcome-access-btn");
const settingsToggleBtn = requireElement<HTMLButtonElement>("settings-toggle-btn");
const settingsMenu = requireElement<HTMLElement>("settings-menu");
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
  if (download <= 12) return "speed-cruise";
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
phoneInput.addEventListener("focus", resetPhonePrefix);
phoneInput.addEventListener("blur", () => {
  const normalized = normalizeMpesaPhoneInput(phoneInput.value);
  if (normalized) phoneInput.value = normalized;
  else resetPhonePrefix();
});
resetPhonePrefix();

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
  const path = window.location.pathname.startsWith("/wifi") ? "/wifi/portal/" : "/portal/";
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
  paymentModalIcon.textContent = kind === "welcome-used" ? "\u{1F923}\u{1F62D}" : "";
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
function updateAccessTimeLeft(remainingMs, deviceLimit?: number) {
  if (!accessTimeLeft) return;
  const deviceBadge = Number(deviceLimit) > 0
    ? `<span class="time-left-devices">&middot; ${esc(String(deviceLimit))} device${Number(deviceLimit) === 1 ? "" : "s"}</span>`
    : "";
  accessTimeLeft.innerHTML = `<span class="time-left-label">Time left</span>${esc(formatTimeLeft(remainingMs))}${deviceBadge}`;
}
function startExpiryWatch(expiresAt, deviceLimit?: number) {
  const target = new Date(expiresAt).getTime();
  if (!Number.isFinite(target)) return;
  if (state.expiryTimer) clearInterval(state.expiryTimer);
  const WARN_MS = 2 * 60 * 1000;
  function tick() {
    const remainingMs = target - Date.now();
    updateAccessTimeLeft(remainingMs, deviceLimit);
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
function rememberDeviceForEntitlement(username, password) {
  const mac = state.hotspot?.mac;
  if (!mac) return;
  fetch(api("/entitlements/link-device"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, deviceMac: mac })
  }).catch(() => {});
}
async function attemptAutoConnect(username, password, statusEl, formEl, { freshGrant = false } = {}) {
  let alreadyOnline = false;
  if (freshGrant) {
    setConnectState(statusEl, formEl, "connecting", "Package active. Authenticating this device...");
    autoCompleteHotspotLogin(username, password);
    showManualConnectFallback(username, password, {
      placement: manualConnectPlacement(),
      message: "Connecting automatically. If your device still says Sign in required, tap to connect now.",
      buttonLabel: "Tap to connect now"
    });
  } else {
    setConnectState(statusEl, formEl, "connecting", "Checking this device...");
    alreadyOnline = await checkInternetReachable(900);
    if (!alreadyOnline) {
      setConnectState(statusEl, formEl, "connecting", "Reconnecting this device...");
      autoCompleteHotspotLogin(username, password);
      showManualConnectFallback(username, password, {
        placement: manualConnectPlacement(),
        message: "Reconnecting automatically. If the WiFi screen still says Action needed, tap to connect.",
        buttonLabel: "Tap to connect"
      });
    }
  }

  const ok = alreadyOnline || (await waitForConnection(8, 450, 900));
  if (ok) {
    hideManualConnectFallback();
    rememberDeviceForEntitlement(username, password);
    let expiresAt = null;
    let deviceLimit;
    try {
      const response = await fetch(api(`/entitlements/${encodeURIComponent(username)}/status`));
      const data = response.ok ? (await response.json())?.data : null;
      expiresAt = data?.expiresAt || null;
      deviceLimit = data?.deviceLimit;
    } catch (_error) {}
    if (expiresAt) {
      showConnectedPanel(
        { username, password, expiresAt, deviceLimit },
        { heading: "You're connected", message: "You're all set. You can browse now.", skipAutoConnect: true }
      );
    } else {
      hideManualConnectFallback();
      setConnectState(statusEl, formEl, "connected", "You're connected. You can close this page.");
    }
  } else {
    updateAccessCopy("Access active");
    setConnectState(statusEl, formEl, "failed", "Automatic confirmation is taking longer than expected. Tap Connect to finish.");
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
// family + duration instead. Only non-speed-tiered plans (free access,
// occasion-based like EPL match day) keep their original name, since those
// aren't claiming anything about current speed.
function displayPlanName(plan) {
  if (isWelcomePlan(plan) || planCategory(plan) === "limited") return plan.name;
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
function planCard(plan) {
  const selected = plan.id === state.selectedPlanId;
  const tone = planTone(plan);
  const badgeHtml = tone.badge ? '<span class="plan-badge">' + esc(tone.badge) + '</span>' : "";
  return `<button type="button" class="plan-card ${selected ? "selected" : ""} ${planCategory(plan) === "limited" ? "limited" : "standard"} ${isWelcomePlan(plan) ? "welcome" : ""}" data-plan-id="${esc(plan.id)}">
    <span class="plan-top">
      <span><h3>${esc(displayPlanName(plan))}</h3></span>
      <span class="plan-top-badges">
        <span class="plan-duration">${duration(plan.durationSeconds)}</span>
        <span class="plan-devices">${esc(plan.deviceLimit)} device${Number(plan.deviceLimit) === 1 ? "" : "s"}</span>
      </span>
    </span>
    ${badgeHtml}
    <span><strong class="plan-price">${money(plan.priceKsh)}</strong></span>
    <span class="plan-caption">${esc(tone.pitch)}</span>
    <span class="plan-meta"><span class="plan-speed ${speedTierClass(plan)}">${friendlyRate(plan.rateLimit)}</span></span>
    <span class="plan-cta">Get ${duration(plan.durationSeconds)} →</span>
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
  if (Number(upgrade.durationSeconds || 0) > Number(plan.durationSeconds || 0)) return `more time`;
  return "a stronger option";
}
function upgradeCard(plan: PortalPlan) {
  const upgrade = suggestedUpgrade(plan);
  if (!upgrade) return "";
  const extra = Number(upgrade.priceKsh || 0) - Number(plan.priceKsh || 0);
  if (extra <= 0) return "";
  const tier = speedTierForPlan(upgrade);
  const viewTier = tier ? `<button type="button" class="upgrade-view" data-view-speed-key="${esc(tier.key)}">View ${esc(tier.range)}</button>` : "";
  return `<div class="upgrade-card">
    <button type="button" class="upgrade-main" data-plan-id="${esc(upgrade.id)}">
      <span><em>Compare</em><strong>${esc(displayPlanName(upgrade))}</strong></span>
      <span>+${money(extra)} for ${esc(upgradeReason(plan, upgrade))}</span>
    </button>
    ${viewTier}
  </div>`;
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
  checkoutPrice.textContent = money(plan.priceKsh);
  planIdInput.value = plan.id;
  payButton.disabled = false;
  payButton.textContent = Number(plan.priceKsh || 0) === 0 ? paymentActionLabel(plan) : `Pay ${money(plan.priceKsh)}`;
  phoneInput.required = !isFree;
  phoneField?.classList.toggle("hidden", isFree);
  selectedSummary.innerHTML = `<div class="summary-meta compact"><span class="summary-pill summary-duration">${duration(plan.durationSeconds)}</span><span class="summary-pill summary-speed ${speedTierClass(plan)}">${friendlyRate(plan.rateLimit)}</span><span class="summary-pill summary-device">${esc(plan.deviceLimit)} device${Number(plan.deviceLimit) === 1 ? "" : "s"}</span></div>${upgradeCard(plan)}`;
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
function plansForSpeedTier(tier: ReturnType<typeof activeSpeedTierConfig>) {
  const plans = customerPlans();
  if (tier.key === "all") return plans;
  return plans.filter((plan) => speedTierForPlan(plan)?.key === tier.key);
}
function visibleSpeedTiers() {
  // Every plan's speed moves together with traffic now, so a tab that's
  // populated today can go empty tomorrow (e.g. everything getting faster in
  // a quiet spell can empty out "Basic" entirely) -- don't show a tab that
  // currently has nothing in it.
  return SPEED_TIERS.filter((tier) => tier.key === "all" || plansForSpeedTier(tier).length > 0);
}
function renderNeedTabs() {
  return visibleSpeedTiers().map((tier) => `<button type="button" class="speed-tab ${tier.key === state.activeNeed ? "active" : ""}" data-speed-key="${esc(tier.key)}"><span>${esc(tier.label)}</span><small>${esc(tier.range)}</small></button>`).join("");
}
function renderPlanGrid(plans: PortalPlan[]) {
  return plans.length ? plans.map(planCard).join("") : '<div class="empty-state">No packages in this group yet.</div>';
}
function renderPackageBrowser() {
  const visiblePlans = customerPlans();
  if (!visiblePlans.length) {
    plansEl.innerHTML = '<div class="empty-state">No WiFi packages are published yet.</div>';
    renderSelectedPlan();
    return;
  }
  if (!visibleSpeedTiers().some((candidate) => candidate.key === state.activeNeed)) state.activeNeed = "all";
  const tier = activeSpeedTierConfig();
  const focusedPlans = plansForSpeedTier(tier);
  plansEl.innerHTML = `
    <section class="speed-browser" aria-label="Browse packages by speed">
      <div class="speed-rail" role="tablist" aria-label="Speed tiers">${renderNeedTabs()}</div>
      <div class="intent-block focused-block speed-tier-block">
        <div class="intent-head speed-tier-copy"><span>${esc(tier.range)}</span><h3>${esc(tier.title)}</h3></div>
        <div class="intent-grid">${renderPlanGrid(focusedPlans)}</div>
      </div>
    </section>
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
      JSON.stringify({ username: entitlement.username, password: entitlement.password, expiresAt: entitlement.expiresAt, deviceLimit: entitlement.deviceLimit })
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
  accessExpires.textContent = new Date(entitlement.expiresAt).toLocaleString();
  access.classList.remove("hidden");
  setStep("access");
  closeCheckoutSheet();
  access.scrollIntoView({ behavior: "smooth", block: "start" });
  startExpiryWatch(entitlement.expiresAt, entitlement.deviceLimit);
  saveRememberedAccess(entitlement);
  if (skipAutoConnect) return;
  if (state.hotspot?.login) {
    // Used to do a real top-level navigation away to MikroTik and back for
    // a fresh grant (payment/free-access/voucher), on the theory that the
    // hidden-iframe path needed a visible browser tab to survive Chrome's
    // "not secure" form warning. That's no longer true now that the login
    // itself is a plain GET (see autoCompleteHotspotLogin) rather than a
    // <form> submission, so it's not subject to that warning either way --
    // and the hidden path is much faster to land on, since it never leaves
    // this already-loaded page for a full navigate-away-and-back round trip.
    void attemptAutoConnect(entitlement.username, entitlement.password, paymentStatus, null, { freshGrant: Boolean(freshGrant) });
  } else {
    updateAccessCopy("Access active");
    setConnectState(paymentStatus, null, "failed", "This device still needs to complete WiFi sign-in before internet is available.");
    showManualConnectFallback(entitlement.username, entitlement.password);
  }
}
extendPeriodBtn?.addEventListener("click", () => {
  if (workspaceEl) workspaceEl.classList.remove("hidden");
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
    payButton.textContent = Number(plan.priceKsh || 0) === 0 ? paymentActionLabel(plan) : `Pay ${money(plan.priceKsh)}`;
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
      body: JSON.stringify({ planId: plan.id, phone: normalizedPhone, deviceMac: state.hotspot?.mac || undefined })
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
if (state.hotspot?.error) showError(decodeURIComponent(state.hotspot.error));

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
  if (!state.hotspot?.login) {
    setConnectState(voucherLoginStatus, null, "failed", "Connect to this WiFi network first, then reopen this page to redeem your code.");
    showManualConnectFallback(code, code);
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
  if (!receipt) return;
  if (!state.hotspot?.login) {
    setConnectState(receiptLoginStatus, null, "failed", "Connect to this WiFi network first, then reopen this page to log in.");
    return;
  }
  setConnectState(receiptLoginStatus, receiptLoginForm, "connecting", "Checking your M-PESA code...");
  try {
    const response = await fetch(api("/payments/lookup-by-receipt"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ receipt })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Couldn't find that M-PESA code.");
    await attemptAutoConnect(payload.data.username, payload.data.password, receiptLoginStatus, receiptLoginForm);
  } catch (error) {
    setConnectState(receiptLoginStatus, receiptLoginForm, "failed", error instanceof Error ? error.message : "Couldn't find that M-PESA code.");
  }
});

async function attemptReturningDeviceAutoConnect() {
  const mac = state.hotspot?.mac;
  if (!mac || !state.hotspot?.login) return false;
  try {
    const response = await fetch(api(`/entitlements/by-device/${encodeURIComponent(mac)}`));
    if (!response.ok) return false;
    const payload = await response.json();
    if (!payload?.data?.username) return false;
    showError("");
    showConnectedPanel(payload.data, {
      heading: "Welcome back",
      message: "You already have Wi-Fi access on this device — reconnecting you now."
    });
    return true;
  } catch (_error) {
    return false;
  }
}

async function bootstrap() {
  const loadPlansPromise = loadPlans().catch((error) => showError(error instanceof Error ? error.message : "Unable to load packages."));

  // A genuine hotspot-redirect device match (fresh from the server) takes
  // priority; otherwise fall back to what this browser remembers locally so
  // reloading the page or reopening the tab still shows "connected" instead
  // of the package list, even without hotspot-redirect context.
  const reconnectedViaDevice = await attemptReturningDeviceAutoConnect();
  if (!reconnectedViaDevice) {
    const remembered = loadRememberedAccess();
    if (remembered) {
      showConnectedPanel(remembered, {
        heading: "Access active",
        skipAutoConnect: !state.hotspot?.login,
        hideCredentials: true
      });
    }
  }

  await loadPlansPromise;
}
void bootstrap();
