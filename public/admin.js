window.addEventListener("error", (event) => {
  const authError = document.getElementById("auth-error");
  if (authError) {
    authError.textContent = "WiFi admin failed to load. Refresh the page and try again.";
    authError.classList.remove("hidden");
  }
  console.error("CAPTYN WiFi admin runtime error", event.error || event.message);
});

const SESSION_KEY = "captyn_wifi_admin_session";
const TRUSTED_DEVICE_KEY = "captyn_wifi_admin_trusted_device";
const PORTAL_URL = `${window.location.origin}/wifi/`;

function readStoredValue(key, storage) {
  try { return storage.getItem(key) || ""; } catch (_error) { return ""; }
}
function storeValue(key, value, storage) {
  try { storage.setItem(key, value); } catch (_error) {}
}
function removeStoredValue(key, storage) {
  try { storage.removeItem(key); } catch (_error) {}
}

const state = {
  sessionToken: readStoredValue(SESSION_KEY, window.sessionStorage),
  trustedDeviceToken: readStoredValue(TRUSTED_DEVICE_KEY, window.localStorage),
  sessionUser: null,
  activePage: "overview",
  editingPlanId: "",
  cache: {}
};

const authPanel = document.getElementById("auth-panel");
const dashboard = document.getElementById("dashboard");
const loginForm = document.getElementById("login-form");
const emailInput = document.getElementById("admin-email");
const passwordInput = document.getElementById("admin-password");
const twoFactorInput = document.getElementById("admin-two-factor");
const trustedDeviceInput = document.getElementById("trusted-device");
const loginSubmit = document.getElementById("login-submit");
const authError = document.getElementById("auth-error");
const healthPill = document.getElementById("health-pill");
const refreshBtn = document.getElementById("refresh-btn");
const logoutBtn = document.getElementById("logout-btn");
const adminUserPill = document.getElementById("admin-user-pill");
const copyPortalBtn = document.getElementById("copy-portal-btn");
const themeToggleBtn = document.getElementById("theme-toggle-btn");

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

const siteForm = document.getElementById("site-form");
const siteNameInput = document.getElementById("site-name");
const siteExternalIdInput = document.getElementById("site-external-id");
const siteStatus = document.getElementById("site-status");
const siteSubmit = document.getElementById("site-submit");

const planForm = document.getElementById("plan-form");
const planIdInput = document.getElementById("plan-id");
const planSiteSelect = document.getElementById("plan-site");
const planNameInput = document.getElementById("plan-name");
const planDurationValueInput = document.getElementById("plan-duration-value");
const planDurationUnitSelect = document.getElementById("plan-duration-unit");
const planPriceInput = document.getElementById("plan-price");
const planDownloadInput = document.getElementById("plan-download");
const planUploadInput = document.getElementById("plan-upload");
const planDevicesInput = document.getElementById("plan-devices");
const planEnabledInput = document.getElementById("plan-enabled");
const planSubmit = document.getElementById("plan-submit");
const planCancel = document.getElementById("plan-cancel");
const planStatus = document.getElementById("plan-status");

const basePath = window.location.pathname.startsWith("/wifi-admin") ? "/wifi-admin" : "";
const adminApi = (path) => `${basePath}/api/admin${path}`;
const authApi = (path) => `${basePath}/api/admin-auth${path}`;
const servicePath = (path) => `${basePath}${path}`;

const endpoints = {
  sites: adminApi("/sites"),
  plans: adminApi("/plans"),
  payments: adminApi("/payment-intents"),
  entitlements: adminApi("/entitlements"),
  projections: adminApi("/radius-projections"),
  accounting: adminApi("/accounting-sessions"),
  networkStatus: adminApi("/network-status")
};

const voucherForm = document.getElementById("voucher-form");
const voucherPhoneInput = document.getElementById("voucher-phone");
const voucherPlanSelect = document.getElementById("voucher-plan");
const voucherSubmit = document.getElementById("voucher-submit");
const voucherStatus = document.getElementById("voucher-status");
const voucherResult = document.getElementById("voucher-result");

const bulkVoucherForm = document.getElementById("bulk-voucher-form");
const bulkVoucherPhonesInput = document.getElementById("bulk-voucher-phones");
const bulkVoucherPlanSelect = document.getElementById("bulk-voucher-plan");
const bulkVoucherSubmit = document.getElementById("bulk-voucher-submit");
const bulkVoucherStatus = document.getElementById("bulk-voucher-status");
const bulkVoucherSummary = document.getElementById("bulk-voucher-summary");

function text(value, fallback = "-") {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}
function fmtDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return text(value);
  return date.toLocaleString();
}
function fmtMoney(value) { return `KSh ${Number(value || 0).toLocaleString()}`; }
function durationLabel(seconds) {
  const value = Number(seconds || 0);
  if (!Number.isFinite(value) || value <= 0) return "-";
  if (value % 86400 === 0) return `${value / 86400} day${value / 86400 === 1 ? "" : "s"}`;
  if (value % 3600 === 0) return `${value / 3600} hour${value / 3600 === 1 ? "" : "s"}`;
  return `${Math.round(value / 60)} minutes`;
}
function shortDuration(seconds) {
  const value = Number(seconds || 0);
  if (!Number.isFinite(value) || value <= 0) return "-";
  if (value % 86400 === 0) return `${value / 86400}d`;
  if (value % 3600 === 0) return `${value / 3600}h`;
  return `${Math.round(value / 60)}m`;
}
function durationSeconds(value, unit) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (unit === "days") return Math.round(amount * 86400);
  if (unit === "hours") return Math.round(amount * 3600);
  return Math.round(amount * 60);
}
function durationParts(seconds) {
  const value = Number(seconds || 0);
  if (value > 0 && value % 86400 === 0) return { value: value / 86400, unit: "days" };
  if (value > 0 && value % 3600 === 0) return { value: value / 3600, unit: "hours" };
  return { value: Math.max(1, Math.round(value / 60)), unit: "minutes" };
}
function composeRateLimit(downloadMbps, uploadMbps) {
  const down = Number(downloadMbps);
  const up = Number(uploadMbps);
  const hasDown = Number.isFinite(down) && down > 0;
  const hasUp = Number.isFinite(up) && up > 0;
  if (!hasDown && !hasUp) return "";
  // MikroTik Rate-Limit format is upload/download from the router's point of view.
  return `${hasUp ? up : down}M/${hasDown ? down : up}M`;
}
function parseRateLimit(rateLimit) {
  const match = /^([\d.]+)M\/([\d.]+)M$/i.exec(String(rateLimit || "").trim());
  if (!match) return { download: "", upload: "" };
  return { upload: match[1], download: match[2] };
}
function friendlyRate(rateLimit) {
  const { download, upload } = parseRateLimit(rateLimit);
  if (!download && !upload) return rateLimit ? escapeHtml(rateLimit) : "Standard speed";
  const parts = [];
  if (download) parts.push(`${download} Mbps down`);
  if (upload) parts.push(`${upload} Mbps up`);
  return parts.join(" / ");
}
function escapeHtml(value) {
  return text(value, "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}
function status(value) {
  const normalized = text(value, "unknown");
  return `<span class="status ${escapeHtml(normalized)}">${escapeHtml(normalized.replaceAll("_", " "))}</span>`;
}
function cells(values) { return values.map((value) => `<td>${value}</td>`).join(""); }
function setHealth(kind, label) { healthPill.className = `pill ${kind}`; healthPill.textContent = label; }
function setAuthError(message) { authError.textContent = message; authError.classList.toggle("hidden", !message); }
function setInlineStatus(element, message, kind = "") { if (element) { element.textContent = message; element.className = kind; } }

function enabledPlans() {
  return (state.cache.plans || []).filter((plan) => plan.enabled);
}

function setSignedIn(user) {
  state.sessionUser = user || null;
  adminUserPill.textContent = user?.email || "";
  adminUserPill.classList.toggle("hidden", !user?.email);
  logoutBtn.classList.toggle("hidden", !user?.email);
}
function clearSession() {
  state.sessionToken = "";
  state.sessionUser = null;
  state.cache = {};
  removeStoredValue(SESSION_KEY, window.sessionStorage);
  setSignedIn(null);
  dashboard.classList.add("hidden");
  authPanel.classList.remove("hidden");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.headers || {}), "x-captyn-wifi-admin-session": state.sessionToken }
  });
  if (response.status === 401) {
    clearSession();
    throw new Error("Please sign in again.");
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed with ${response.status}`);
  return payload.data;
}
function writeApi(path, method, body) {
  return api(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
async function checkHealth() {
  try {
    const response = await fetch(servicePath("/health"));
    setHealth(response.ok ? "ok" : "warn", response.ok ? "Online" : "Degraded");
  } catch (_error) {
    setHealth("bad", "Offline");
  }
}
async function login(credentials) {
  const response = await fetch(authApi("/login"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(credentials)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || "Unable to sign in.");
    error.code = payload.code;
    throw error;
  }
  return payload.data;
}

function renderRows(id, rows, mapper, emptyColspan = 8) {
  const body = document.getElementById(`${id}-body`);
  const count = document.getElementById(`${id}-count`);
  if (count) count.textContent = `${rows.length} rows`;
  body.innerHTML = rows.length
    ? rows.map((row) => `<tr>${cells(mapper(row))}</tr>`).join("")
    : `<tr><td class="muted" colspan="${emptyColspan}">No records yet.</td></tr>`;
}

function renderSummary(summary) {
  const metrics = summary.metrics || {};
  const published = enabledPlans().length;
  document.getElementById("metric-sites").textContent = text(metrics.siteCount, "0");
  document.getElementById("metric-plans").textContent = text(metrics.planCount, "0");
  document.getElementById("metric-published").textContent = String(published);
  document.getElementById("metric-active").textContent = text(metrics.activeEntitlementCount, "0");
  document.getElementById("metric-pending").textContent = text(metrics.pendingProjectionCount, "0");
  const networkMetrics = state.cache.networkStatus?.metrics || {};
  const failures = Number(metrics.failedProjectionCount || 0) + Number(networkMetrics.appliedMissingRadiusRowsCount || 0);
  document.getElementById("metric-failures").textContent = String(failures);
  document.getElementById("metric-revenue").textContent = fmtMoney(metrics.revenueKsh);
  document.getElementById("published-count").textContent = String(published);
  document.getElementById("published-plural").textContent = published === 1 ? "" : "s";
  document.getElementById("radius-health-label").textContent = Number(metrics.failedProjectionCount || 0) > 0 ? "Needs review" : "Ready";
}

function renderSiteOptions() {
  const sites = state.cache.sites || [];
  const current = planSiteSelect.value;
  planSiteSelect.innerHTML = sites.length
    ? sites.map((site) => `<option value="${escapeHtml(site.id)}">${escapeHtml(site.name)}</option>`).join("")
    : '<option value="">Create a site first</option>';
  if (current && sites.some((site) => site.id === current)) planSiteSelect.value = current;
  planSiteSelect.disabled = sites.length === 0;
  planSubmit.disabled = sites.length === 0;
}

function renderVoucherPlanOptions() {
  if (!voucherPlanSelect) return;
  const plans = enabledPlans();
  const current = voucherPlanSelect.value;
  voucherPlanSelect.innerHTML = plans.length
    ? plans.map((plan) => `<option value="${escapeHtml(plan.id)}">${escapeHtml(plan.site?.name)} — ${escapeHtml(plan.name)} (${fmtMoney(plan.priceKsh)})</option>`).join("")
    : '<option value="">Publish a package first</option>';
  if (current && plans.some((plan) => plan.id === current)) voucherPlanSelect.value = current;
  voucherPlanSelect.disabled = plans.length === 0;
  if (voucherSubmit) voucherSubmit.disabled = plans.length === 0;
}

function renderBulkVoucherPlanOptions() {
  if (!bulkVoucherPlanSelect) return;
  const plans = enabledPlans();
  const current = bulkVoucherPlanSelect.value;
  bulkVoucherPlanSelect.innerHTML = plans.length
    ? plans.map((plan) => `<option value="${escapeHtml(plan.id)}">${escapeHtml(plan.site?.name)} — ${escapeHtml(plan.name)} (${fmtMoney(plan.priceKsh)})</option>`).join("")
    : '<option value="">Publish a package first</option>';
  if (current && plans.some((plan) => plan.id === current)) bulkVoucherPlanSelect.value = current;
  bulkVoucherPlanSelect.disabled = plans.length === 0;
  if (bulkVoucherSubmit) bulkVoucherSubmit.disabled = plans.length === 0;
}

function renderVouchers() {
  const vouchers = (state.cache.payments || []).filter((item) => item.provider === "voucher");
  renderRows("vouchers", vouchers, (item) => [
    `<span class="mono">${escapeHtml(item.entitlement?.username)}</span>`,
    escapeHtml(item.plan?.name),
    text(item.customerPhone, "Not linked"),
    status(item.entitlement?.status || item.status),
    fmtDate(item.entitlement?.expiresAt)
  ], 5);
}

function rateCard(plan, withAction = false) {
  return `<article class="rate-card">
    <div>
      <div class="site">${escapeHtml(plan.site?.name)}</div>
      <h3>${escapeHtml(plan.name)}</h3>
    </div>
    <strong>${fmtMoney(plan.priceKsh)}</strong>
    <div class="rate-meta">
      <span>${durationLabel(plan.durationSeconds)}</span>
      <span>${friendlyRate(plan.rateLimit)}</span>
      <span>${escapeHtml(plan.deviceLimit)} device${Number(plan.deviceLimit) === 1 ? "" : "s"}</span>
    </div>
    ${withAction ? `<span class="action-row"><button class="secondary" type="button" data-edit-plan="${escapeHtml(plan.id)}">Edit</button><a class="button-link secondary" href="/wifi/" target="_blank" rel="noreferrer">View</a></span>` : ""}
  </article>`;
}

function renderPlanCards() {
  const published = enabledPlans();
  const preview = document.getElementById("client-preview");
  const cards = document.getElementById("package-cards");
  document.getElementById("preview-count").textContent = `${published.length} published`;
  document.getElementById("package-card-count").textContent = `${published.length} visible to clients`;
  const empty = '<div class="empty-state">No published packages.</div>';
  preview.innerHTML = published.length ? published.map((plan) => rateCard(plan)).join("") : empty;
  cards.innerHTML = published.length ? published.map((plan) => rateCard(plan, true)).join("") : empty;
}


function renderNetworkStatus() {
  const diagnostics = state.cache.networkStatus || {};
  const items = diagnostics.pipeline || [];
  const html = items.length
    ? items.map((item) => `<div class="flow-item ${escapeHtml(item.state)}">
      <span class="flow-dot" aria-hidden="true"></span>
      <div><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.detail)}</span></div>
      <em>${escapeHtml(item.state)}</em>
    </div>`).join("")
    : '<div class="empty-state">No diagnostics loaded.</div>';
  document.querySelectorAll("#network-flow, #failure-points").forEach((element) => { element.innerHTML = html; });
  const generated = document.getElementById("network-status-generated");
  if (generated) generated.textContent = diagnostics.generatedAt ? `Checked ${fmtDate(diagnostics.generatedAt)}` : "";
  const worst = items.some((item) => item.state === "bad") ? "Needs repair" : items.some((item) => item.state === "warn") ? "Watch" : "Ready";
  document.getElementById("radius-health-label").textContent = worst;
}

function renderAll() {
  renderSiteOptions();
  renderVoucherPlanOptions();
  renderBulkVoucherPlanOptions();
  renderPlanCards();
  renderNetworkStatus();
  renderVouchers();

  const payments = state.cache.payments || [];
  const entitlements = state.cache.entitlements || [];

  renderRows("overview-payments", payments.slice(0, 5), (item) => [
    `<span class="mono">${escapeHtml(item.sourceReference)}</span>`,
    escapeHtml(item.plan?.name),
    status(item.status),
    fmtMoney(item.amountKsh)
  ], 4);

  renderRows("overview-access", entitlements.slice(0, 5), (item) => [
    `<span class="mono">${escapeHtml(item.username)}</span>`,
    escapeHtml(item.plan?.name),
    status(item.status),
    fmtDate(item.expiresAt)
  ], 4);

  renderRows("sites", state.cache.sites || [], (item) => [
    escapeHtml(item.name),
    `<span class="mono">${escapeHtml(item.externalId)}</span>`,
    escapeHtml(item.source),
    escapeHtml(item._count?.plans ?? 0),
    escapeHtml(item._count?.intents ?? 0),
    escapeHtml(item._count?.entitlements ?? 0),
    fmtDate(item.updatedAt)
  ], 7);

  renderRows("plans", state.cache.plans || [], (item) => [
    escapeHtml(item.name),
    escapeHtml(item.site?.name),
    shortDuration(item.durationSeconds),
    fmtMoney(item.priceKsh),
    friendlyRate(item.rateLimit),
    escapeHtml(item.deviceLimit),
    item.enabled ? status("published") : status("disabled"),
    `<span class="action-row"><button class="secondary" type="button" data-edit-plan="${escapeHtml(item.id)}">Edit</button>${item.enabled ? '<a class="button-link secondary" href="/wifi/" target="_blank" rel="noreferrer">View</a>' : ""}</span>`
  ], 8);

  renderRows("payments", payments, (item) => [
    `<span class="mono">${escapeHtml(item.sourceReference)}</span>`,
    escapeHtml(item.site?.name),
    escapeHtml(item.plan?.name),
    escapeHtml(item.customerPhone),
    status(item.status),
    fmtMoney(item.amountKsh),
    fmtDate(item.createdAt)
  ], 7);

  renderRows("entitlements", entitlements, (item) => [
    `<span class="mono">${escapeHtml(item.username)}</span>`,
    escapeHtml(item.site?.name),
    escapeHtml(item.plan?.name),
    status(item.status),
    fmtDate(item.startsAt),
    fmtDate(item.expiresAt),
    escapeHtml(item.deviceLimit),
    status(item.projection?.status || "missing")
  ], 8);

  renderRows("projections", state.cache.projections || [], (item) => [
    `<span class="mono">${escapeHtml(item.username)}</span>`,
    escapeHtml(item.entitlement?.site?.name),
    escapeHtml(item.entitlement?.plan?.name),
    status(item.status),
    `<span class="mono">${escapeHtml((item.checkItems || []).length)}</span>`,
    `<span class="mono">${escapeHtml((item.replyItems || []).length)}</span>`,
    fmtDate(item.updatedAt),
    escapeHtml(item.lastError)
  ], 8);

  renderRows("accounting", state.cache.accounting || [], (item) => [
    `<span class="mono">${escapeHtml(item.username)}</span>`,
    `<span class="mono">${escapeHtml(item.acctSessionId)}</span>`,
    escapeHtml(item.callingStationId),
    escapeHtml(item.nasIdentifier || item.nasIpAddress),
    escapeHtml(item.framedIpAddress),
    escapeHtml(item.acctSessionTimeSeconds),
    `${escapeHtml(item.inputOctets || 0)} / ${escapeHtml(item.outputOctets || 0)}`,
    fmtDate(item.updatedAt)
  ], 8);
}

async function loadDashboard() {
  setAuthError("");
  refreshBtn.disabled = true;
  try {
    const [summary, sites, plans, payments, entitlements, projections, accounting, networkStatus] = await Promise.all([
      api(adminApi("/summary")),
      api(endpoints.sites),
      api(endpoints.plans),
      api(endpoints.payments),
      api(endpoints.entitlements),
      api(endpoints.projections),
      api(endpoints.accounting),
      api(endpoints.networkStatus)
    ]);
    state.cache = { sites, plans, payments, entitlements, projections, accounting, networkStatus };
    renderSummary(summary);
    renderAll();
    authPanel.classList.add("hidden");
    dashboard.classList.remove("hidden");
    setPage(state.activePage);
  } catch (error) {
    dashboard.classList.add("hidden");
    authPanel.classList.remove("hidden");
    setAuthError(error instanceof Error ? error.message : "Unable to open admin.");
  } finally {
    refreshBtn.disabled = false;
  }
}

function setPage(page) {
  state.activePage = page || "overview";
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.page === state.activePage));
  document.querySelectorAll("[data-page-panel]").forEach((panel) => panel.classList.toggle("hidden", panel.dataset.pagePanel !== state.activePage));
}

function resetPlanForm() {
  state.editingPlanId = "";
  planIdInput.value = "";
  planForm.reset();
  planDurationUnitSelect.value = "hours";
  planDevicesInput.value = "1";
  planDownloadInput.value = "";
  planUploadInput.value = "";
  planEnabledInput.checked = true;
  planSubmit.textContent = "Save package";
  planCancel.classList.add("hidden");
  setInlineStatus(planStatus, "");
  renderSiteOptions();
}

function editPlan(planId) {
  const plan = (state.cache.plans || []).find((item) => item.id === planId);
  if (!plan) return;
  const duration = durationParts(plan.durationSeconds);
  state.editingPlanId = plan.id;
  planIdInput.value = plan.id;
  planSiteSelect.value = plan.siteId;
  planNameInput.value = plan.name || "";
  planDurationValueInput.value = String(duration.value);
  planDurationUnitSelect.value = duration.unit;
  planPriceInput.value = String(plan.priceKsh || 0);
  const rate = parseRateLimit(plan.rateLimit);
  planDownloadInput.value = rate.download;
  planUploadInput.value = rate.upload;
  planDevicesInput.value = String(plan.deviceLimit || 1);
  planEnabledInput.checked = Boolean(plan.enabled);
  planSubmit.textContent = "Update package";
  planCancel.classList.remove("hidden");
  setInlineStatus(planStatus, "Editing", "warn");
  setPage("setup");
  window.scrollTo({ top: dashboard.offsetTop, behavior: "smooth" });
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setAuthError("");
  loginSubmit.disabled = true;
  loginSubmit.textContent = "Signing in";
  try {
    const credentials = {
      email: emailInput.value.trim(),
      password: passwordInput.value,
      twoFactorCode: twoFactorInput.value.trim(),
      backupCode: twoFactorInput.value.trim(),
      trustedDeviceToken: state.trustedDeviceToken,
      trustDevice: trustedDeviceInput.checked
    };
    const result = await login(credentials);
    state.sessionToken = result.sessionToken;
    storeValue(SESSION_KEY, state.sessionToken, window.sessionStorage);
    if (result.trustedDeviceToken) {
      state.trustedDeviceToken = result.trustedDeviceToken;
      storeValue(TRUSTED_DEVICE_KEY, state.trustedDeviceToken, window.localStorage);
    }
    setSignedIn(result.user);
    passwordInput.value = "";
    twoFactorInput.value = "";
    await loadDashboard();
  } catch (error) {
    setAuthError(error instanceof Error ? error.message : "Unable to sign in.");
    if (error && typeof error === "object" && error.code === "TWO_FACTOR_REQUIRED") twoFactorInput.focus();
  } finally {
    loginSubmit.disabled = false;
    loginSubmit.textContent = "Sign in";
  }
});

siteForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  siteSubmit.disabled = true;
  setInlineStatus(siteStatus, "Saving");
  try {
    await writeApi(adminApi("/sites"), "POST", { name: siteNameInput.value.trim(), externalId: siteExternalIdInput.value.trim() });
    siteForm.reset();
    setInlineStatus(siteStatus, "Saved", "ok");
    await loadDashboard();
  } catch (error) {
    setInlineStatus(siteStatus, error instanceof Error ? error.message : "Failed", "bad");
  } finally {
    siteSubmit.disabled = false;
  }
});

planForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  planSubmit.disabled = true;
  setInlineStatus(planStatus, "Saving");
  try {
    const body = {
      siteId: planSiteSelect.value,
      name: planNameInput.value.trim(),
      durationSeconds: durationSeconds(planDurationValueInput.value, planDurationUnitSelect.value),
      priceKsh: Number(planPriceInput.value || 0),
      rateLimit: composeRateLimit(planDownloadInput.value, planUploadInput.value),
      deviceLimit: Number(planDevicesInput.value || 1),
      enabled: planEnabledInput.checked
    };
    if (state.editingPlanId) await writeApi(adminApi(`/plans/${encodeURIComponent(state.editingPlanId)}`), "PATCH", body);
    else await writeApi(adminApi("/plans"), "POST", body);
    resetPlanForm();
    setInlineStatus(planStatus, "Saved", "ok");
    await loadDashboard();
    setPage("packages");
  } catch (error) {
    setInlineStatus(planStatus, error instanceof Error ? error.message : "Failed", "bad");
  } finally {
    planSubmit.disabled = false;
  }
});

function renderVoucherResult(data) {
  voucherResult.innerHTML = `
    <div class="voucher-credential voucher-code"><span>Voucher Code</span><strong class="mono">${escapeHtml(data.code)}</strong></div>
    <div class="voucher-credential"><span>Package</span><strong>${escapeHtml(data.entitlement?.plan?.name)}</strong></div>
    <div class="voucher-credential"><span>Expires</span><strong>${fmtDate(data.expiresAt)}</strong></div>
    <p class="field-hint">Give the customer just this code — at captyn.shop/wifi they tap "Have a voucher code?" and enter it. No phone or payment needed.</p>
  `;
}

voucherForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  voucherSubmit.disabled = true;
  setInlineStatus(voucherStatus, "Issuing");
  try {
    const data = await writeApi(adminApi("/vouchers"), "POST", {
      customerPhone: voucherPhoneInput.value.trim() || undefined,
      planId: voucherPlanSelect.value
    });
    renderVoucherResult(data);
    voucherForm.reset();
    setInlineStatus(voucherStatus, "Issued", "ok");
    await loadDashboard();
    setPage("vouchers");
  } catch (error) {
    setInlineStatus(voucherStatus, error instanceof Error ? error.message : "Failed", "bad");
  } finally {
    voucherSubmit.disabled = false;
  }
});

function renderBulkVoucherResults(payload) {
  const body = document.getElementById("bulk-voucher-body");
  const { results, summary } = payload;
  bulkVoucherSummary.textContent = `${summary.created} created, ${summary.failed} failed`;
  body.innerHTML = results.length
    ? results
        .map(
          (row) => `<tr>${cells([
            escapeHtml(row.phone),
            status(row.status),
            row.status === "created" ? `<span class="mono">${escapeHtml(row.code)}</span>` : escapeHtml(row.error || ""),
            row.status === "created" ? fmtDate(row.expiresAt) : "-"
          ])}</tr>`
        )
        .join("")
    : '<tr><td colspan="4" class="empty-state">Gift vouchers to see per-phone results here.</td></tr>';
}

bulkVoucherForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const phones = bulkVoucherPhonesInput.value
    .split(/[\n,]/)
    .map((phone) => phone.trim())
    .filter(Boolean);
  if (!phones.length) {
    setInlineStatus(bulkVoucherStatus, "Enter at least one phone number", "bad");
    return;
  }
  bulkVoucherSubmit.disabled = true;
  setInlineStatus(bulkVoucherStatus, `Issuing ${phones.length} voucher${phones.length === 1 ? "" : "s"}`);
  try {
    const data = await writeApi(adminApi("/vouchers/bulk"), "POST", {
      planId: bulkVoucherPlanSelect.value,
      phones
    });
    renderBulkVoucherResults(data);
    bulkVoucherForm.reset();
    setInlineStatus(bulkVoucherStatus, `${data.summary.created} issued`, data.summary.failed ? "bad" : "ok");
    await loadDashboard();
    setPage("vouchers");
  } catch (error) {
    setInlineStatus(bulkVoucherStatus, error instanceof Error ? error.message : "Failed", "bad");
  } finally {
    bulkVoucherSubmit.disabled = false;
  }
});

refreshBtn.addEventListener("click", () => { void checkHealth(); if (state.sessionToken) void loadDashboard(); });
logoutBtn.addEventListener("click", clearSession);
planCancel.addEventListener("click", resetPlanForm);
copyPortalBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(PORTAL_URL);
    copyPortalBtn.textContent = "Copied";
    setTimeout(() => { copyPortalBtn.textContent = "Copy URL"; }, 1200);
  } catch (_error) {
    window.prompt("Client portal", PORTAL_URL);
  }
});

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const planId = target.dataset.editPlan;
  if (planId) editPlan(planId);
});
document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => setPage(button.dataset.page)));

void checkHealth();
if (state.sessionToken) void loadDashboard();
