const state = { plans: [], selectedPlanId: "", paymentId: "", pollTimer: null, hotspot: null, expiryTimer: null };
const plansEl = document.getElementById("plans");
const checkoutTitle = document.getElementById("checkout-title");
const checkoutPrice = document.getElementById("checkout-price");
const selectedSummary = document.getElementById("selected-summary");
const planIdInput = document.getElementById("plan-id");
const paymentForm = document.getElementById("payment-form");
const phoneInput = document.getElementById("phone");
const payButton = document.getElementById("pay-button");
const paymentStatus = document.getElementById("payment-status");
const healthPill = document.getElementById("health-pill");
const sitePill = document.getElementById("site-pill");
const planCount = document.getElementById("plan-count");
const heroMeta = document.getElementById("hero-meta");
const checkoutPanel = document.getElementById("checkout");
const checkoutBackdrop = document.getElementById("checkout-backdrop");
const checkoutCloseBtn = document.getElementById("checkout-close-btn");
const access = document.getElementById("access");
const accessHeading = document.getElementById("access-heading");
const accessMessage = document.getElementById("access-message");
const accessTimeLeft = document.getElementById("access-time-left");
const accessUsername = document.getElementById("access-username");
const accessPassword = document.getElementById("access-password");
const accessExpires = document.getElementById("access-expires");
const extendPeriodBtn = document.getElementById("extend-period-btn");
const workspaceEl = document.querySelector(".workspace");
const errorText = document.getElementById("error");
const paymentModal = document.getElementById("payment-modal");
const paymentModalIcon = document.getElementById("payment-modal-icon");
const paymentModalTitle = document.getElementById("payment-modal-title");
const paymentModalMessage = document.getElementById("payment-modal-message");
const paymentModalCancelBtn = document.getElementById("payment-modal-cancel-btn");
const paymentModalRetryBtn = document.getElementById("payment-modal-retry-btn");
const existingLoginToggle = document.getElementById("existing-login-toggle");
const existingLoginForm = document.getElementById("existing-login-form");
const existingUsernameInput = document.getElementById("existing-username");
const existingPasswordInput = document.getElementById("existing-password");
const existingLoginStatus = document.getElementById("existing-login-status");
const voucherLoginToggle = document.getElementById("voucher-login-toggle");
const voucherLoginForm = document.getElementById("voucher-login-form");
const voucherCodeInput = document.getElementById("voucher-code-input");
const voucherLoginStatus = document.getElementById("voucher-login-status");
const receiptLoginToggle = document.getElementById("receipt-login-toggle");
const receiptLoginForm = document.getElementById("receipt-login-form");
const receiptCodeInput = document.getElementById("receipt-code-input");
const receiptLoginStatus = document.getElementById("receipt-login-status");
const themeToggleBtn = document.getElementById("theme-toggle-btn");
const expiryBanner = document.getElementById("expiry-banner");
const expiryCountdown = document.getElementById("expiry-countdown");
const expiryRenewBtn = document.getElementById("expiry-renew-btn");

function syncThemeToggleLabel() {
  if (themeToggleBtn && window.captynTheme) {
    themeToggleBtn.textContent = window.captynTheme.current() === "dark" ? "Light" : "Dark";
  }
}
syncThemeToggleLabel();
themeToggleBtn?.addEventListener("click", () => {
  window.captynTheme.toggle();
  syncThemeToggleLabel();
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
  return `${Math.round(value / 60)} minutes`;
}
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}
function friendlyRate(rateLimit) {
  const match = /^([\d.]+)M\/([\d.]+)M$/i.exec(String(rateLimit || "").trim());
  if (!match) return rateLimit ? esc(rateLimit) : "Standard speed";
  const [, upload, download] = match;
  return `${download} Mbps down / ${upload} Mbps up`;
}
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
function autoCompleteHotspotLogin(username, password) {
  const hotspot = state.hotspot;
  if (!hotspot?.login) return;
  const frameName = "hs-auto-login-frame";
  let iframe = document.querySelector(`iframe[name="${frameName}"]`);
  if (!iframe) {
    iframe = document.createElement("iframe");
    iframe.name = frameName;
    iframe.style.display = "none";
    document.body.appendChild(iframe);
  }
  const form = document.createElement("form");
  form.method = "POST";
  form.action = hotspot.login;
  form.target = frameName;
  form.style.display = "none";
  const fields = { username, password, dst: hotspot.orig || "" };
  Object.entries(fields).forEach(([name, value]) => {
    if (!value) return;
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  });
  document.body.appendChild(form);
  form.submit();
  form.remove();
}
// Deliberately NOT gstatic.com/generate_204 — that's the exact URL Android's
// own OS-level captive-portal detector uses, so hotspot walled gardens
// commonly allow it through even before login (so Android doesn't nag with a
// "no internet" warning on the login page). Fetching it here would give a
// false "connected" reading for a device that's only got walled-garden
// access, not real internet. 1.1.1.1 is a raw IP (skips DNS-based walled
// garden rules entirely) and isn't a domain hotspots special-case allow.
function checkInternetReachable(timeoutMs) {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); resolve(false); }, timeoutMs);
    fetch("https://1.1.1.1/cdn-cgi/trace", { mode: "no-cors", cache: "no-store", signal: controller.signal })
      .then(() => { clearTimeout(timer); resolve(true); })
      .catch(() => { clearTimeout(timer); resolve(false); });
  });
}
async function waitForConnection(maxAttempts, intervalMs) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (await checkInternetReachable(3000)) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}
function setConnectState(statusEl, formEl, state, message) {
  statusEl.className = `status-text connect-state ${state}`;
  statusEl.textContent = message || "";
  if (formEl) {
    const disable = state === "connecting";
    Array.from(formEl.elements).forEach((el) => { el.disabled = disable; });
  }
}
function showPaymentModal(kind, title, message) {
  paymentModal.classList.remove("hidden");
  paymentModalIcon.className = `payment-modal-icon ${kind === "connecting" ? "spin" : kind === "ok" ? "ok" : "bad"}`;
  paymentModalTitle.textContent = title;
  paymentModalMessage.textContent = message || "";
  paymentModalCancelBtn.classList.toggle("hidden", kind !== "connecting");
  paymentModalRetryBtn.classList.toggle("hidden", kind !== "bad");
}
function hidePaymentModal() {
  paymentModal.classList.add("hidden");
}
function resetPaymentAttempt() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  state.paymentId = "";
  payButton.disabled = false;
  payButton.textContent = "Pay Now";
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
function updateAccessTimeLeft(remainingMs) {
  if (!accessTimeLeft) return;
  accessTimeLeft.innerHTML = `<span class="time-left-label">Time left</span>${esc(formatTimeLeft(remainingMs))}`;
}
function startExpiryWatch(expiresAt) {
  const target = new Date(expiresAt).getTime();
  if (!Number.isFinite(target)) return;
  if (state.expiryTimer) clearInterval(state.expiryTimer);
  const WARN_MS = 2 * 60 * 1000;
  function tick() {
    const remainingMs = target - Date.now();
    updateAccessTimeLeft(remainingMs);
    if (remainingMs <= 0) {
      expiryBanner.classList.remove("hidden");
      expiryBanner.classList.add("expired");
      expiryBanner.querySelector(".expiry-message").textContent = "Your WiFi access has expired — buy a new package to get back online.";
      clearInterval(state.expiryTimer);
      state.expiryTimer = null;
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
async function startExpiryWatchForUsername(username) {
  try {
    const response = await fetch(api(`/entitlements/${encodeURIComponent(username)}/status`));
    if (!response.ok) return;
    const payload = await response.json();
    if (payload?.data?.expiresAt) startExpiryWatch(payload.data.expiresAt);
  } catch (_error) {}
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
async function attemptAutoConnect(username, password, statusEl, formEl) {
  setConnectState(statusEl, formEl, "connecting", "Connecting you to WiFi...");
  autoCompleteHotspotLogin(username, password);
  const ok = await waitForConnection(4, 2000);
  if (ok) {
    setConnectState(statusEl, formEl, "connected", "You're connected. You can close this page.");
    void startExpiryWatchForUsername(username);
    rememberDeviceForEntitlement(username, password);
  } else {
    setConnectState(statusEl, formEl, "failed", "Couldn't confirm the connection. Double-check the details above and try again.");
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
  document.querySelectorAll(".step").forEach((step) => {
    const index = order.indexOf(step.dataset.step || "");
    step.classList.toggle("active", index === activeIndex);
    step.classList.toggle("done", activeIndex > index);
  });
}
async function checkHealth() {
  try {
    const response = await fetch(servicePath("/health"));
    healthPill.className = `pill ${response.ok ? "ok" : "bad"}`;
    healthPill.textContent = response.ok ? "Online" : "Offline";
  } catch (_error) {
    healthPill.className = "pill bad";
    healthPill.textContent = "Offline";
  }
}
function planCard(plan) {
  const selected = plan.id === state.selectedPlanId;
  return `<button type="button" class="plan-card ${selected ? "selected" : ""}" data-plan-id="${esc(plan.id)}">
    <span class="plan-top"><span><span class="plan-site">${esc(plan.site.name)}</span><h3>${esc(plan.name)}</h3></span><span class="choose-label">${selected ? "Selected" : "Choose"}</span></span>
    <span><strong class="plan-price">${money(plan.priceKsh)}</strong></span>
    <span class="plan-meta"><span>${duration(plan.durationSeconds)}</span><span>${friendlyRate(plan.rateLimit)}</span><span>${esc(plan.deviceLimit)} device${Number(plan.deviceLimit) === 1 ? "" : "s"}</span></span>
  </button>`;
}
function renderSelectedPlan() {
  const plan = currentPlan();
  if (!plan) {
    checkoutTitle.textContent = "Select a package";
    checkoutPrice.textContent = "KSh 0";
    selectedSummary.innerHTML = '<div class="empty-state">No package selected.</div>';
    planIdInput.value = "";
    payButton.disabled = true;
    setStep("package");
    return;
  }
  checkoutTitle.textContent = plan.name;
  checkoutPrice.textContent = money(plan.priceKsh);
  planIdInput.value = plan.id;
  payButton.disabled = false;
  selectedSummary.innerHTML = `<div class="summary-title">${esc(plan.site.name)}</div>
    <div class="summary-meta"><span>${duration(plan.durationSeconds)}</span><span>${friendlyRate(plan.rateLimit)}</span><span>${esc(plan.deviceLimit)} device${Number(plan.deviceLimit) === 1 ? "" : "s"}</span></div>`;
}
function renderPlans(sites) {
  state.plans = sites.flatMap((site) => site.plans.map((plan) => ({ ...plan, site })));
  if (!state.selectedPlanId && state.plans[0]) state.selectedPlanId = state.plans[0].id;
  if (state.selectedPlanId && !state.plans.some((plan) => plan.id === state.selectedPlanId)) state.selectedPlanId = state.plans[0]?.id || "";
  plansEl.innerHTML = state.plans.length ? state.plans.map(planCard).join("") : '<div class="empty-state">No WiFi packages are published yet.</div>';
  planCount.textContent = `${state.plans.length} package${state.plans.length === 1 ? "" : "s"}`;
  const siteNames = [...new Set(state.plans.map((plan) => plan.site.name).filter(Boolean))];
  sitePill.textContent = siteNames.length ? siteNames.join(", ") : "No site";
  sitePill.className = `pill ${siteNames.length ? "ok" : "warn"}`;
  heroMeta.innerHTML = state.plans.length
    ? `<span>${esc(siteNames[0] || "WiFi")}</span><span>${state.plans.length} package${state.plans.length === 1 ? "" : "s"}</span>`
    : "<span>No packages available right now</span>";
  renderSelectedPlan();
}
async function loadPlans() {
  const response = await fetch(api("/sites"));
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Unable to load WiFi packages.");
  renderPlans(payload.data || []);
}
function selectPlan(planId) {
  if (!state.plans.some((plan) => plan.id === planId)) return;
  state.selectedPlanId = planId;
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
  if (elapsedMs < 12000) return "Check your phone for the M-PESA prompt and enter your PIN.";
  if (elapsedMs < 30000) return "Still waiting for M-PESA... this can take up to a minute.";
  return "Still waiting — if no prompt appeared, dial *334# to clear a stuck M-PESA session, then try again.";
}

// Takes over from the package-browsing UI once a customer has confirmed,
// working access — used both right after a purchase and when a returning
// device already has valid access, so paying customers stop seeing package
// cards they don't need and see their status instead.
function showConnectedPanel(entitlement, { heading, message }) {
  if (workspaceEl) workspaceEl.classList.add("hidden");
  accessHeading.textContent = heading;
  accessMessage.textContent = message;
  accessUsername.textContent = entitlement.username;
  accessPassword.textContent = entitlement.password;
  accessExpires.textContent = new Date(entitlement.expiresAt).toLocaleString();
  access.classList.remove("hidden");
  setStep("access");
  closeCheckoutSheet();
  access.scrollIntoView({ behavior: "smooth", block: "start" });
  startExpiryWatch(entitlement.expiresAt);
  if (state.hotspot?.login) {
    void attemptAutoConnect(entitlement.username, entitlement.password, paymentStatus, null);
  } else {
    setConnectState(paymentStatus, null, "connected", "Use the username and password above to log in to the WiFi if you're not online yet.");
  }
}
extendPeriodBtn?.addEventListener("click", () => {
  if (workspaceEl) workspaceEl.classList.remove("hidden");
  resetPaymentAttempt();
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
    payButton.textContent = "Pay Now";
    const failureMessage = payment.failureReason || "Payment didn't go through. Tap Pay Now to try again.";
    setConnectState(paymentStatus, null, "failed", failureMessage);
    showPaymentModal("bad", "Payment didn't go through", failureMessage);
  }

  if (payment.entitlement) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
    hidePaymentModal();
    showConnectedPanel(payment.entitlement, {
      heading: payment.extended ? "Your access has been extended" : "You're connected",
      message: payment.extended
        ? "Your existing package's time has been topped up — no need to log in again."
        : "You're all set — go ahead and browse, stream, and download."
    });
  }
}
paymentForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("");
  const plan = currentPlan();
  if (!plan) { showError("Choose a package first."); return; }
  payButton.disabled = true;
  payButton.textContent = "Sending prompt...";
  setConnectState(paymentStatus, null, "connecting", "Sending the M-PESA prompt to your phone...");
  showPaymentModal("connecting", "Sending prompt", "Sending the M-PESA prompt to your phone...");
  setStep("mpesa");
  try {
    const response = await fetch(api("/payments/mpesa/stk"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planId: plan.id, phone: phoneInput.value.trim(), deviceMac: state.hotspot?.mac || undefined })
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
    state.pollTimer = setInterval(pollPayment, 4000);
    setTimeout(pollPayment, 1500);
  } catch (error) {
    showError(error instanceof Error ? error.message : "Unable to start payment.");
    setConnectState(paymentStatus, null, "", "");
    hidePaymentModal();
    payButton.disabled = false;
    payButton.textContent = "Pay Now";
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
plansEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const card = target.closest("[data-plan-id]");
  if (card instanceof HTMLElement) selectPlan(card.dataset.planId || "");
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
voucherLoginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = voucherCodeInput.value.trim().toUpperCase();
  if (!code) return;
  if (!state.hotspot?.login) {
    setConnectState(voucherLoginStatus, null, "failed", "Connect to this WiFi network first, then reopen this page to redeem your code.");
    return;
  }
  await attemptAutoConnect(code, code, voucherLoginStatus, voucherLoginForm);
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

void checkHealth();
loadPlans().catch((error) => showError(error instanceof Error ? error.message : "Unable to load packages."));
void attemptReturningDeviceAutoConnect();
