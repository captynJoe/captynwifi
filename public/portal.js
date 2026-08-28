const state = { plans: [], selectedPlanId: "", paymentId: "", pollTimer: null, hotspot: null, expiryTimer: null };
const plansEl = document.getElementById("plans");
const checkoutTitle = document.getElementById("checkout-title");
const checkoutPrice = document.getElementById("checkout-price");
const selectedSummary = document.getElementById("selected-summary");
const planIdInput = document.getElementById("plan-id");
const paymentForm = document.getElementById("payment-form");
const phoneInput = document.getElementById("phone");
const phoneField = phoneInput?.closest(".field");
const payButton = document.getElementById("pay-button");
const paymentStatus = document.getElementById("payment-status");
const checkoutPanel = document.getElementById("checkout");
const checkoutBackdrop = document.getElementById("checkout-backdrop");
const checkoutCloseBtn = document.getElementById("checkout-close-btn");
const haveCodeBtn = document.getElementById("have-code-btn");
const access = document.getElementById("access");
const accessHeading = document.getElementById("access-heading");
const accessTimeLeft = document.getElementById("access-time-left");
const accessLoginDetails = document.getElementById("access-login-details");
const accessUsernameCard = document.getElementById("access-username-card");
const accessPasswordCard = document.getElementById("access-password-card");
const accessRecoveryCard = document.getElementById("access-recovery-card");
const accessUsername = document.getElementById("access-username");
const accessPassword = document.getElementById("access-password");
const accessRecovery = document.getElementById("access-recovery");
const accessExpires = document.getElementById("access-expires");
const extendPeriodBtn = document.getElementById("extend-period-btn");
const workspaceEl = document.querySelector(".workspace");
const manualConnectFallback = document.getElementById("manual-connect-fallback");
const manualConnectMessage = document.getElementById("manual-connect-message");
const manualConnectOpenBtn = document.getElementById("manual-connect-open-btn");
const manualConnectForm = document.getElementById("manual-connect-form");
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
const receiptPhoneInput = document.getElementById("receipt-phone-input");
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
function ratePartToMbps(value) {
  const match = /^(\d+(?:\.\d+)?)([kKmM])?$/.exec(String(value || "").trim());
  if (!match) return 0;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return (match[2] || "M").toLowerCase() === "k" ? amount / 1000 : amount;
}
function rateProfile(rateLimit) {
  const match = /^(\d+(?:\.\d+)?[kKmM]?)\/(\d+(?:\.\d+)?[kKmM]?)$/i.exec(String(rateLimit || "").trim());
  if (!match) return { upload: 0, download: 0 };
  return { upload: ratePartToMbps(match[1]), download: ratePartToMbps(match[2]) };
}
function friendlyRate(rateLimit) {
  const rate = rateProfile(rateLimit);
  if (!rate.upload && !rate.download) return rateLimit ? esc(rateLimit) : "Standard speed";
  const format = (value) => Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
  return `${format(rate.download)} Mbps down / ${format(rate.upload)} Mbps up`;
}
function comparePlanFor(plan) {
  const currentRate = rateProfile(plan?.rateLimit);
  const currentPrice = Number(plan?.priceKsh || 0);
  const currentDuration = Number(plan?.durationSeconds || 0);
  const sameSitePlans = state.plans.filter((candidate) => candidate.site?.id === plan?.site?.id && candidate.id !== plan?.id);
  const faster = sameSitePlans
    .map((candidate) => ({ candidate, rate: rateProfile(candidate.rateLimit) }))
    .filter(({ candidate, rate }) => rate.download > currentRate.download || (rate.download === currentRate.download && Number(candidate.durationSeconds || 0) > currentDuration))
    .sort((a, b) => (a.rate.download - b.rate.download) || (Number(a.candidate.priceKsh || 0) - Number(b.candidate.priceKsh || 0)) || (Number(a.candidate.durationSeconds || 0) - Number(b.candidate.durationSeconds || 0)))[0]?.candidate;
  if (!faster) return null;
  const fasterRate = rateProfile(faster.rateLimit);
  const priceDelta = Number(faster.priceKsh || 0) - currentPrice;
  const speedDelta = fasterRate.download > currentRate.download ? `${Number((fasterRate.download - currentRate.download).toFixed(2))} Mbps faster` : duration(faster.durationSeconds);
  return { plan: faster, detail: `${priceDelta > 0 ? `+${money(priceDelta)} for ` : ""}${speedDelta}` };
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
function autoCompleteHotspotLogin(username, password, { topLevel = false } = {}) {
  const hotspot = state.hotspot;
  if (!hotspot?.login) return;
  const frameName = "hs-auto-login-frame";
  if (!topLevel) {
    let iframe = document.querySelector(`iframe[name="${frameName}"]`);
    if (!iframe) {
      iframe = document.createElement("iframe");
      iframe.name = frameName;
      iframe.style.display = "none";
      document.body.appendChild(iframe);
    }
  }
  const form = document.createElement("form");
  form.method = "POST";
  form.action = hotspot.login;
  if (!topLevel) form.target = frameName;
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
  if (!topLevel) form.remove();
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
async function attemptAutoConnect(username, password, statusEl, formEl) {
  setConnectState(statusEl, formEl, "connecting", "Connecting you to WiFi...");
  autoCompleteHotspotLogin(username, password);
  const ok = await waitForConnection(4, 2000);
  if (ok) {
    rememberDeviceForEntitlement(username, password);
    let expiresAt = null;
    try {
      const response = await fetch(api(`/entitlements/${encodeURIComponent(username)}/status`));
      if (response.ok) expiresAt = (await response.json())?.data?.expiresAt || null;
    } catch (_error) {}
    if (expiresAt) {
      // Route every successful connect (voucher, receipt, existing-login,
      // payment) through the same connected-status panel instead of leaving
      // it as a small inline message — skipAutoConnect avoids looping back
      // into another connect attempt, since we just finished one.
      showConnectedPanel(
        { username, password, expiresAt },
        { heading: "You're connected", message: "You're all set — go ahead and browse, stream, and download.", skipAutoConnect: true }
      );
    } else {
      setConnectState(statusEl, formEl, "connected", "You're connected. You can close this page.");
    }
  } else {
    updateAccessCopy("Access active");
    setConnectState(statusEl, formEl, "failed", "Couldn't confirm the connection. Tap Connect below, then check Windows again.");
    showManualConnectFallback(username, password);
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
function planTone(plan) {
  const seconds = Number(plan.durationSeconds || 0);
  const price = Number(plan.priceKsh || 0);
  if (price === 0) return { badge: "Free access", pitch: "Open browsing access for live testing and support." };
  if (seconds <= 1800) return { badge: "Quick session", pitch: "Short, fast access for chats, updates, and light browsing." };
  if (seconds <= 43200) return { badge: "Daily flow", pitch: "Steady access for work, socials, calls, and streaming." };
  if (seconds <= 86400) return { badge: "Full day", pitch: "All-day access across your allowed devices." };
  return { badge: "Extended", pitch: "Long-running access with managed speed controls." };
}
function planCard(plan) {
  const selected = plan.id === state.selectedPlanId;
  const tone = planTone(plan);
  return `<button type="button" class="plan-card ${selected ? "selected" : ""}" data-plan-id="${esc(plan.id)}">
    <span class="plan-top"><span><h3>${esc(plan.name)}</h3></span><span class="plan-duration">${duration(plan.durationSeconds)}</span></span>
    <span class="plan-badge">${esc(tone.badge)}</span>
    <span><strong class="plan-price">${money(plan.priceKsh)}</strong></span>
    <span class="plan-caption">${esc(tone.pitch)}</span>
    <span class="plan-meta"><span>${friendlyRate(plan.rateLimit)}</span><span>${esc(plan.deviceLimit)} device${Number(plan.deviceLimit) === 1 ? "" : "s"}</span></span>
    <span class="plan-foot"><span>Instant activation</span><span>Voucher ready</span></span>
  </button>`;
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
  checkoutTitle.textContent = plan.name;
  checkoutPrice.textContent = money(plan.priceKsh);
  planIdInput.value = plan.id;
  payButton.disabled = false;
  payButton.textContent = paymentActionLabel(plan);
  phoneInput.required = !isFree;
  phoneField?.classList.toggle("hidden", isFree);
  const comparison = comparePlanFor(plan);
  selectedSummary.innerHTML = `<div class="summary-title">Selected package</div>
    <div class="summary-meta compact"><span>${duration(plan.durationSeconds)}</span><span>${friendlyRate(plan.rateLimit)}</span><span>${esc(plan.deviceLimit)} device${Number(plan.deviceLimit) === 1 ? "" : "s"}</span></div>
    ${comparison ? `<button type="button" class="upgrade-card" data-compare-plan-id="${esc(comparison.plan.id)}"><span><em>Compare</em><strong>${esc(comparison.plan.name)}</strong></span><span>${esc(comparison.detail)}</span></button>` : ""}`;
}
function renderPlans(sites) {
  state.plans = sites.flatMap((site) => site.plans.map((plan) => ({ ...plan, site })));
  if (!state.selectedPlanId && state.plans[0]) state.selectedPlanId = state.plans[0].id;
  if (state.selectedPlanId && !state.plans.some((plan) => plan.id === state.selectedPlanId)) state.selectedPlanId = state.plans[0]?.id || "";
  plansEl.innerHTML = state.plans.length ? state.plans.map(planCard).join("") : '<div class="empty-state">No WiFi packages are published yet.</div>';
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

// Remembers the last confirmed access on this device/browser so revisiting
// the portal (reload, reopened tab, no hotspot-redirect context at all)
// still shows the connected-status panel instead of the package list.
const REMEMBERED_ACCESS_KEY = "captynWifiAccess";
function saveRememberedAccess(entitlement) {
  try {
    localStorage.setItem(
      REMEMBERED_ACCESS_KEY,
      JSON.stringify({ username: entitlement.username, password: entitlement.password, expiresAt: entitlement.expiresAt })
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

// Real, visible, user-initiated top-level form submission — shown when the
// background auto-connect (hidden iframe POST) can't be confirmed, so the
// customer always has a way to finish connecting themselves regardless of
// why the automatic attempt failed (blocked, timed out, etc.).
function showManualConnectFallback(username, password) {
  if (!manualConnectFallback) return;
  if (state.hotspot?.login && manualConnectForm) {
    if (manualConnectMessage) manualConnectMessage.textContent = "Your access is active, but this device couldn't confirm it automatically.";
    manualConnectForm.action = state.hotspot.login;
    manualConnectForm.elements.username.value = username;
    manualConnectForm.elements.password.value = password;
    manualConnectForm.elements.dst.value = state.hotspot.orig || "";
    manualConnectForm.classList.remove("hidden");
    manualConnectOpenBtn?.classList.add("hidden");
  } else {
    if (manualConnectMessage) {
      manualConnectMessage.textContent = "Your package is active. Open the WiFi login page from Windows Action needed, then this portal can activate the router session.";
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

function showConnectedPanel(entitlement, { heading, skipAutoConnect, topLevelConnect, recoveryReference, hideCredentials } = {}) {
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
  startExpiryWatch(entitlement.expiresAt);
  saveRememberedAccess(entitlement);
  if (skipAutoConnect) return;
  if (state.hotspot?.login) {
    setConnectState(paymentStatus, null, "connecting", "Activating WiFi on this device...");
    if (topLevelConnect) {
      setTimeout(() => autoCompleteHotspotLogin(entitlement.username, entitlement.password, { topLevel: true }), 700);
    } else {
      void attemptAutoConnect(entitlement.username, entitlement.password, paymentStatus, null);
    }
  } else {
    updateAccessCopy("Access active");
    setConnectState(paymentStatus, null, "failed", "Windows still needs captive-portal login before internet is available.");
    showManualConnectFallback(entitlement.username, entitlement.password);
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
      topLevelConnect: true
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
      if (!response.ok || !payload?.data?.entitlement) throw new Error(payload.error || "Unable to start free access.");
      payButton.disabled = false;
      payButton.textContent = paymentActionLabel(plan);
      setConnectState(paymentStatus, null, "", "");
      showConnectedPanel(payload.data.entitlement, {
        heading: payload.data.extended ? "Free access extended" : "Free access ready",
        message: "Activating WiFi on this device now.",
        hideCredentials: Boolean(state.hotspot?.login),
        topLevelConnect: true
      });
      return;
    } catch (error) {
      showError(error instanceof Error ? error.message : "Unable to start free access.");
      setConnectState(paymentStatus, null, "", "");
      payButton.disabled = false;
      payButton.textContent = paymentActionLabel(plan);
      setStep("package");
      return;
    }
  }

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
    payButton.textContent = paymentActionLabel(plan);
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
selectedSummary?.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const compare = target.closest("[data-compare-plan-id]");
  if (compare instanceof HTMLElement) selectPlan(compare.dataset.comparePlanId || "");
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
      { username: code, password: code, expiresAt: payload.data.expiresAt },
      {
        heading: "Voucher accepted",
        message: "Activating WiFi on this device now.",
        topLevelConnect: true
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
  const phone = normalizeMpesaPhoneInput(receiptPhoneInput?.value);
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
  const remembered = loadRememberedAccess();
  if (!remembered || !state.hotspot?.login) return false;
  showError("");
  showConnectedPanel(remembered, {
    heading: "Welcome back",
    message: "You already have WiFi access saved in this browser. Reconnecting you now.",
    hideCredentials: true
  });
  return true;
}

async function bootstrap() {
  const loadPlansPromise = loadPlans().catch((error) => showError(error instanceof Error ? error.message : "Unable to load packages."));

  // If this browser already saved active access, reconnect it before showing
  // package checkout. Clearing browser storage now requires receipt, voucher,
  // or technical login proof instead of server-side MAC credential recovery.
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
