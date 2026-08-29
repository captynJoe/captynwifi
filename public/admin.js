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
  sessionToken: readStoredValue(SESSION_KEY, window.localStorage),
  trustedDeviceToken: readStoredValue(TRUSTED_DEVICE_KEY, window.localStorage),
  sessionUser: null,
  activePage: "overview",
  editingPlanId: "",
  selectedEntitlementId: "",
  accessDetail: null,
  accessActionMessage: "",
  cache: {}
};

const authPanel = document.getElementById("auth-panel");
const dashboard = document.getElementById("dashboard");
const bootLoading = document.getElementById("boot-loading");
function finishBoot() { bootLoading?.classList.add("hidden"); }
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
const planCategorySelect = document.getElementById("plan-category");
const planDownloadInput = document.getElementById("plan-download");
const planUploadInput = document.getElementById("plan-upload");
const planDevicesInput = document.getElementById("plan-devices");
const planEnabledInput = document.getElementById("plan-enabled");
const planFeaturedInput = document.getElementById("plan-featured");
const planManualPricingInput = document.getElementById("plan-manual-pricing");
const planImageInput = document.getElementById("plan-image");
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
  networkStatus: adminApi("/network-status"),
  governorStatus: adminApi("/governor-status"),
  dynamicPlanStatus: adminApi("/dynamic-plan-status"),
  outageCredits: adminApi("/outage-credits"),
  promo: adminApi("/promo")
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
const accessDetailPanel = document.getElementById("access-detail-panel");
const accessDetailTitle = document.getElementById("access-detail-title");
const accessDetailStatus = document.getElementById("access-detail-status");
const accessDetailBody = document.getElementById("access-detail-body");

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
  const totalMinutes = Math.round(value / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
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
function ratePartFromMbps(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "";
  if (Number.isInteger(number)) return `${number}M`;
  return `${Math.max(1, Math.round(number * 1000))}k`;
}
function mbpsFromRatePart(value) {
  const match = /^(\d+)([kKmM])?$/.exec(String(value || "").trim());
  if (!match) return "";
  const number = Number(match[1]);
  if (!Number.isFinite(number) || number <= 0) return "";
  return (match[2] || "M").toLowerCase() === "k" ? String(number / 1000) : String(number);
}
function composeRateLimit(downloadMbps, uploadMbps) {
  const down = ratePartFromMbps(downloadMbps);
  const up = ratePartFromMbps(uploadMbps);
  if (!down && !up) return "";
  // MikroTik Rate-Limit format is upload/download from the router's point of view.
  return `${up || down}/${down || up}`;
}
function parseRateLimit(rateLimit) {
  const match = /^(\d+(?:[kKmM])?)\/(\d+(?:[kKmM])?)$/.exec(String(rateLimit || "").trim());
  if (!match) return { download: "", upload: "" };
  return { upload: mbpsFromRatePart(match[1]), download: mbpsFromRatePart(match[2]) };
}
function friendlyRate(rateLimit) {
  const { download, upload } = parseRateLimit(rateLimit);
  if (!download && !upload) return rateLimit ? escapeHtml(rateLimit) : "Standard speed";
  const parts = [];
  if (download) parts.push(`↓ ${download} Mbps`);
  if (upload) parts.push(`↑ ${upload} Mbps`);
  return parts.join(" / ");
}
function adminRateParts(plan) {
  const parsed = parseRateLimit(plan?.rateLimit);
  return { download: Number(parsed.download || 0), upload: Number(parsed.upload || 0) };
}
function speedTierClass(plan) {
  const { download } = adminRateParts(plan);
  if (download <= 5) return "speed-starter";
  if (download <= 12) return "speed-cruise";
  if (download <= 20) return "speed-highspeed";
  return "speed-gulfstream";
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

// Mirrors public.ts's /sites orderBy exactly: featured first, then price.
function comparePlansByPrice(a, b) {
  const featuredDelta = (b?.featured ? 1 : 0) - (a?.featured ? 1 : 0);
  if (featuredDelta) return featuredDelta;
  const priceDelta = Number(a?.priceKsh || 0) - Number(b?.priceKsh || 0);
  if (priceDelta) return priceDelta;
  const durationDelta = Number(a?.durationSeconds || 0) - Number(b?.durationSeconds || 0);
  if (durationDelta) return durationDelta;
  return String(a?.name || "").localeCompare(String(b?.name || ""));
}

function enabledPlans() {
  return (state.cache.plans || []).filter((plan) => plan.enabled).sort(comparePlansByPrice);
}

// Mirrors the public catalog query in routes/public.ts exactly: once a paid
// captyn_admin plan has a captyn_dynamic mirror, the admin baseline row is a
// reference rate card only (edited via the Packages UI, not sold directly)
// and only its mirror is customer-facing. Free/promotional captyn_admin
// plans (priceKsh 0) are never mirrored and stay visible as-is, and so are
// manualPricing captyn_admin plans -- the admin pinned that price on
// purpose and dynamicPlanEngine skips mirroring them. Without this, every
// priced package shows up here twice -- the static baseline next to its
// live-tuned mirror -- which reads as a duplicate-packages bug even though
// nothing is actually wrong with what customers see.
function publiclyVisiblePlans() {
  return enabledPlans().filter(
    (plan) => plan.source === "captyn_dynamic" || Number(plan.priceKsh) === 0 || plan.manualPricing
  );
}

function setSignedIn(user) {
  state.sessionUser = user || null;
  adminUserPill.textContent = user?.email || "";
  adminUserPill.classList.toggle("hidden", !user?.email);
  logoutBtn.classList.toggle("hidden", !user?.email);
}
function clearSession(options = {}) {
  state.sessionToken = "";
  state.sessionUser = null;
  state.cache = {};
  removeStoredValue(SESSION_KEY, window.localStorage);
  if (options.forgetTrusted) {
    state.trustedDeviceToken = "";
    removeStoredValue(TRUSTED_DEVICE_KEY, window.localStorage);
  }
  setSignedIn(null);
  dashboard.classList.add("hidden");
  authPanel.classList.remove("hidden");
  finishBoot();
}
function storeAdminSession(result) {
  state.sessionToken = result.sessionToken;
  storeValue(SESSION_KEY, state.sessionToken, window.localStorage);
  if (result.trustedDeviceToken) {
    state.trustedDeviceToken = result.trustedDeviceToken;
    storeValue(TRUSTED_DEVICE_KEY, state.trustedDeviceToken, window.localStorage);
  }
  setSignedIn(result.user);
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
async function restoreTrustedSession() {
  if (!state.trustedDeviceToken) return false;
  try {
    const response = await fetch(authApi("/trusted-session"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trustedDeviceToken: state.trustedDeviceToken })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Trusted device expired.");
    storeAdminSession(payload.data);
    await loadDashboard();
    return true;
  } catch (_error) {
    state.trustedDeviceToken = "";
    removeStoredValue(TRUSTED_DEVICE_KEY, window.localStorage);
    dashboard.classList.add("hidden");
    authPanel.classList.remove("hidden");
    finishBoot();
    return false;
  }
}

function renderRows(id, rows, mapper, emptyColspan = 8, rowAttrs) {
  const body = document.getElementById(`${id}-body`);
  const count = document.getElementById(`${id}-count`);
  if (count) count.textContent = `${rows.length} rows`;
  body.innerHTML = rows.length
    ? rows.map((row) => `<tr${rowAttrs ? ` ${rowAttrs(row)}` : ""}>${cells(mapper(row))}</tr>`).join("")
    : `<tr><td class="muted" colspan="${emptyColspan}">No records yet.</td></tr>`;
}

function renderSummary(summary) {
  const metrics = summary.metrics || {};
  const published = publiclyVisiblePlans().length;
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
  const plans = publiclyVisiblePlans();
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
  const plans = publiclyVisiblePlans();
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

function accessRowAttrs(item) {
  const selected = item.id === state.selectedEntitlementId ? " selected" : "";
  return `class="clickable-row${selected}" data-entitlement-id="${escapeHtml(item.id)}" tabindex="0"`;
}

function snapshotState(entitlement) {
  if (!entitlement?.plan) return "unknown";
  const sameRate = String(entitlement.rateLimit || "") === String(entitlement.plan.rateLimit || "");
  const sameDevices = Number(entitlement.deviceLimit || 0) === Number(entitlement.plan.deviceLimit || 0);
  return sameRate && sameDevices ? "synced" : "different";
}

function accessStat(label, value, extra = "") {
  return `<div class="access-stat"><span>${escapeHtml(label)}</span><strong>${value}</strong>${extra ? `<em>${extra}</em>` : ""}</div>`;
}

function renderAttributeRows(rows) {
  return rows?.length
    ? rows.map((row) => `<tr>${cells([escapeHtml(row.attribute), escapeHtml(row.op), `<span class="mono">${escapeHtml(row.value)}</span>`])}</tr>`).join("")
    : '<tr><td colspan="3" class="muted">No rows.</td></tr>';
}

function renderAccountingRows(rows) {
  return rows?.length
    ? rows.map((row) => `<tr>${cells([
        `<span class="mono">${escapeHtml(row.acctSessionId)}</span>`,
        escapeHtml(row.callingStationId),
        escapeHtml(row.framedIpAddress),
        escapeHtml(row.acctSessionTimeSeconds),
        `${escapeHtml(row.inputOctets || 0)} / ${escapeHtml(row.outputOctets || 0)}`,
        fmtDate(row.updatedAt)
      ])}</tr>`).join("")
    : '<tr><td colspan="6" class="muted">No accounting sessions yet.</td></tr>';
}

function renderAccessDetail(message = state.accessActionMessage || "") {
  if (!state.selectedEntitlementId) {
    accessDetailPanel?.classList.add("hidden");
    return;
  }
  accessDetailPanel?.classList.remove("hidden");
  const cached = (state.cache.entitlements || []).find((item) => item.id === state.selectedEntitlementId);
  const detail = state.accessDetail;
  const entitlement = detail?.entitlement || cached;
  accessDetailTitle.textContent = entitlement ? `Access: ${entitlement.username}` : "Access detail";
  accessDetailStatus.textContent = message || (entitlement ? snapshotState(entitlement) : "Loading");
  accessDetailStatus.className = message ? "warn" : snapshotState(entitlement);

  if (!entitlement || !detail) {
    accessDetailBody.innerHTML = '<div class="empty-state">Loading access detail...</div>';
    return;
  }

  const planRate = entitlement.plan?.rateLimit || "";
  const accessRate = entitlement.rateLimit || "";
  const packageMeta = `${friendlyRate(planRate)} / ${escapeHtml(entitlement.plan?.deviceLimit || 0)} device${Number(entitlement.plan?.deviceLimit) === 1 ? "" : "s"}`;
  const accessMeta = `${friendlyRate(accessRate)} / ${escapeHtml(entitlement.deviceLimit || 0)} device${Number(entitlement.deviceLimit) === 1 ? "" : "s"}`;
  const payment = entitlement.paymentIntent || {};
  const reference = payment.receiptNumber || payment.providerReference || payment.sourceReference || "-";

  const currentRate = parseRateLimit(entitlement.rateLimit);
  accessDetailBody.innerHTML = `
    <div class="access-detail-grid">
      ${accessStat("Status", status(entitlement.status))}
      ${accessStat("Customer", `<span class="mono">${escapeHtml(entitlement.username)}</span>`, escapeHtml(entitlement.deviceMac || "No device lock"))}
      ${accessStat("Current access", accessMeta)}
      ${accessStat("Current package", packageMeta, snapshotState(entitlement) === "synced" ? "settings synced" : "package changed")}
      ${accessStat("Starts", fmtDate(entitlement.startsAt))}
      ${accessStat("Expires", fmtDate(entitlement.expiresAt))}
      ${accessStat("Payment", `<span class="mono">${escapeHtml(reference)}</span>`, fmtMoney(payment.amountKsh || 0))}
      ${accessStat("RADIUS", status(entitlement.projection?.status || "missing"), fmtDate(entitlement.projection?.appliedAt))}
    </div>
    <div class="access-actions">
      <label class="field compact" for="access-extension-seconds"><span>Add time</span><select id="access-extension-seconds"><option value="1800">30 minutes</option><option value="3600">1 hour</option><option value="21600">6 hours</option><option value="86400">1 day</option><option value="604800">7 days</option></select></label>
      <button type="button" class="secondary" data-access-action="extend">Extend</button>
      <button type="button" class="secondary" data-access-action="sync_package_settings">Sync package limits</button>
      <button type="button" class="secondary" data-access-action="reapply_radius">Reapply RADIUS</button>
      <button type="button" class="secondary" data-access-action="reactivate">Reactivate</button>
      <button type="button" class="danger" data-access-action="suspend">Suspend</button>
      <button type="button" class="danger" data-access-action="expire">Expire now</button>
      <span id="access-action-status" class="inline-status"></span>
    </div>
    <div class="access-actions limit-actions">
      <label class="field compact" for="access-download"><span>Download Mbps</span><input id="access-download" type="number" min="0" step="0.5" value="${escapeHtml(currentRate.download)}" placeholder="blank = no limit" /></label>
      <label class="field compact" for="access-upload"><span>Upload Mbps</span><input id="access-upload" type="number" min="0" step="0.5" value="${escapeHtml(currentRate.upload)}" placeholder="blank = no limit" /></label>
      <label class="field compact" for="access-devices"><span>Devices</span><input id="access-devices" type="number" min="1" max="50" value="${escapeHtml(entitlement.deviceLimit || 1)}" /></label>
      <button type="button" data-access-action="update_limits">Save custom limits</button>
    </div>
    <div class="access-technical">
      <details open><summary>RADIUS reply rows</summary><div class="table-wrap"><table><thead><tr><th>Attribute</th><th>Op</th><th>Value</th></tr></thead><tbody>${renderAttributeRows(detail.radreply)}</tbody></table></div></details>
      <details><summary>RADIUS check rows</summary><div class="table-wrap"><table><thead><tr><th>Attribute</th><th>Op</th><th>Value</th></tr></thead><tbody>${renderAttributeRows(detail.radcheck)}</tbody></table></div></details>
      <details><summary>Recent accounting</summary><div class="table-wrap"><table><thead><tr><th>Session</th><th>Device</th><th>IP</th><th>Seconds</th><th>Traffic</th><th>Updated</th></tr></thead><tbody>${renderAccountingRows(detail.accounting)}</tbody></table></div></details>
    </div>
  `;
}

function renderAccessRows(id, rows, compact = false) {
  renderRows(id, rows, (item) => compact ? [
    `<span class="mono">${escapeHtml(item.username)}</span>`,
    escapeHtml(item.plan?.name),
    status(item.status),
    fmtDate(item.expiresAt)
  ] : [
    `<span class="mono">${escapeHtml(item.username)}</span>`,
    escapeHtml(item.site?.name),
    escapeHtml(item.plan?.name),
    status(item.status),
    fmtDate(item.startsAt),
    fmtDate(item.expiresAt),
    escapeHtml(item.deviceLimit),
    status(item.projection?.status || "missing")
  ], compact ? 4 : 8, accessRowAttrs);
}

function planCategory(plan) {
  return plan?.category === "limited" || Number(plan?.priceKsh || 0) === 0 ? "limited" : "standard";
}
function isWelcomePlan(plan) {
  return String(plan.name || "").toLowerCase() === "captyn welcome";
}
function promotedBadge(plan) {
  if (isWelcomePlan(plan)) return "Welcome";
  const name = String(plan.name || "").toLowerCase();
  if (name === "cruise 4 hr") return "Popular";
  if (name === "highspeed 6 hr") return "Fast";
  if (name === "cruise day") return "Recommended";
  if (name === "cruise weekly") return "Best value";
  if (name === "gulfstream hour") return "Gulfstream";
  return "";
}
function packageTone(plan) {
  const name = String(plan.name || "").toLowerCase();
  const badge = promotedBadge(plan);
  if (isWelcomePlan(plan)) return { badge, pitch: "Free welcome access while CAPTYN WiFi monitors real usage, failures, and demand." };
  if (planCategory(plan) === "limited") return { badge, pitch: "Entry access for quick checks, urgent chats, and light browsing." };
  if (name.includes("gulfstream")) return { badge, pitch: "Top-speed burst for heavy downloads, uploads, and urgent high-bandwidth work." };
  if (name.includes("highspeed")) return { badge, pitch: "Higher speed access for calls, uploads, and heavier browsing." };
  if (name.includes("cruise")) return { badge, pitch: "Balanced speed and time for everyday browsing." };
  if (name.includes("starter")) return { badge, pitch: "Low-cost access for simple browsing and messaging." };
  if (name.includes("monthly")) return { badge, pitch: "Resident-friendly access for steady everyday use." };
  return { badge, pitch: "Clear speed and time trade-off for everyday browsing." };
}
function rateCard(plan, withAction = false) {
  const tone = packageTone(plan);
  const badgeHtml = tone.badge ? '<span class="rate-badge">' + escapeHtml(tone.badge) + '</span>' : "";
  const merchandisingBadges = [
    plan.featured ? '<span class="rate-badge featured">Featured</span>' : "",
    plan.manualPricing ? '<span class="rate-badge manual-pricing">Manual price</span>' : ""
  ].join("");
  const imageHtml = plan.imageFile
    ? `<img class="rate-card-image" src="${basePath}/uploads/plan-images/${encodeURIComponent(plan.imageFile)}" alt="" loading="lazy" />`
    : "";
  return `<article class="rate-card ${planCategory(plan) === "limited" ? "limited" : "standard"} ${isWelcomePlan(plan) ? "welcome" : ""}">
    ${imageHtml}
    <div>
      <div class="site">${escapeHtml(plan.site?.name)}</div>
      <h3>${escapeHtml(plan.name)}</h3>
    </div>
    ${badgeHtml}${merchandisingBadges}
    <strong>${fmtMoney(plan.priceKsh)}</strong>
    <p class="rate-pitch">${escapeHtml(tone.pitch)}</p>
    <div class="rate-meta">
      <span>${durationLabel(plan.durationSeconds)}</span>
      <span class="rate-speed ${speedTierClass(plan)}">Speed ${friendlyRate(plan.rateLimit)}</span>
      <span>${escapeHtml(plan.deviceLimit)} device${Number(plan.deviceLimit) === 1 ? "" : "s"}</span>
    </div>
    ${withAction ? `<span class="action-row"><button class="secondary" type="button" data-edit-plan="${escapeHtml(plan.id)}">Edit package</button><a class="button-link secondary" href="/wifi/" target="_blank" rel="noreferrer">Preview</a><button class="danger" type="button" data-delete-plan="${escapeHtml(plan.id)}">Delete</button></span>` : ""}
  </article>`;
}

function renderPlanCards() {
  const published = publiclyVisiblePlans();
  const preview = document.getElementById("client-preview");
  const cards = document.getElementById("package-cards");
  document.getElementById("preview-count").textContent = `${published.length} published`;
  document.getElementById("package-card-count").textContent = `${published.length} visible to clients`;
  const empty = '<div class="empty-state">No published packages.</div>';
  preview.innerHTML = published.length ? published.map((plan) => rateCard(plan)).join("") : empty;
  cards.innerHTML = published.length ? published.map((plan) => rateCard(plan, true)).join("") : empty;
}



function governorNumber(value, decimals = 2) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) return "0";
  return numeric.toLocaleString(undefined, { maximumFractionDigits: decimals });
}

function governorStateClass(stateName) {
  return String(stateName || "idle").toLowerCase();
}

function renderGovernorStatus() {
  const governor = state.cache.governorStatus || {};
  const latest = governor.latest || {};
  const totals = governor.totals || {};
  const config = governor.config || {};
  const currentState = latest.state || "NO DATA";
  const mode = config.dryRun ? "Dry run" : config.applyRadiusSql ? "Applying" : "Observing";
  const generated = document.getElementById("governor-generated");
  if (generated) generated.textContent = governor.generatedAt ? `Checked ${fmtDate(governor.generatedAt)}` : mode;
  const modeLabel = document.getElementById("governor-mode");
  if (modeLabel) modeLabel.textContent = mode;

  const summary = document.getElementById("governor-summary");
  if (summary) {
    summary.innerHTML = `
      <div class="governor-card state-card ${governorStateClass(currentState)}"><span>Current state</span><strong>${escapeHtml(currentState)}</strong><em>${fmtDate(latest.createdAt)}</em></div>
      <div class="governor-card"><span>Active now</span><strong>${escapeHtml(latest.activeSessionCount ?? 0)}</strong><em>Peak ${escapeHtml(totals.maxActive ?? 0)} in 24h</em></div>
      <div class="governor-card"><span>Demand now</span><strong>${governorNumber(latest.activeDemandMbps)} Mbps</strong><em>Peak ${governorNumber(totals.maxDemandMbps)} Mbps</em></div>
      <div class="governor-card"><span>Utilization</span><strong>${governorNumber(Number(latest.utilizationScore || 0) * 100, 1)}%</strong><em>Peak ${governorNumber(Number(totals.maxUtilization || 0) * 100, 1)}%</em></div>
    `;
  }

  const settings = document.getElementById("governor-settings");
  if (settings) {
    settings.innerHTML = `
      <div class="governor-setting"><span>Enabled</span>${status(config.enabled ? "enabled" : "disabled")}</div>
      <div class="governor-setting"><span>Dry run</span>${status(config.dryRun ? "on" : "off")}</div>
      <div class="governor-setting"><span>RADIUS writes</span>${status(config.applyRadiusSql ? "enabled" : "disabled")}</div>
      <div class="governor-setting"><span>Kick on change</span>${status(config.kickOnChange ? "enabled" : "disabled")}</div>
      <div class="governor-setting"><span>WAN cap</span><strong>${governorNumber(config.wanDownloadMbps, 0)} / ${governorNumber(config.wanUploadMbps, 0)} Mbps</strong></div>
      <div class="governor-setting"><span>Poll</span><strong>${governorNumber(Number(config.pollIntervalMs || 0) / 1000, 0)}s</strong></div>
    `;
  }

  renderRows("governor-states", governor.stateRows || [], (item) => [
    status(item.state),
    escapeHtml(item.events || 0),
    escapeHtml(item.maxActive || 0),
    `${governorNumber(item.maxDemandMbps)} Mbps`,
    `${governorNumber(Number(item.maxUtilization || 0) * 100, 1)}%`,
    fmtDate(item.lastSeen)
  ], 6);

  renderRows("governor-events", governor.recentEvents || [], (item) => [
    fmtDate(item.createdAt),
    status(item.state),
    escapeHtml(item.activeSessionCount || 0),
    `${governorNumber(item.activeDemandMbps)} Mbps`,
    `${governorNumber(Number(item.utilizationScore || 0) * 100, 1)}%`,
    item.username ? `<span class="mono">${escapeHtml(item.username)}</span>` : "-",
    item.targetRateLimit ? `<span class="mono">${escapeHtml(item.previousRateLimit || "-")} -> ${escapeHtml(item.targetRateLimit)}</span>` : "-",
    escapeHtml(item.reason)
  ], 8);
}

function durationMinutes(ms) {
  return governorNumber(Number(ms || 0) / 60000, 0);
}

function renderDynamicPlanStatus() {
  const data = state.cache.dynamicPlanStatus || {};
  const latest = data.latest || {};
  const config = data.config || {};
  const currentState = latest.state || "NO DATA";
  const mode = config.dryRun ? "Dry run" : "Live";
  const generated = document.getElementById("dynamic-plan-generated");
  if (generated) generated.textContent = data.generatedAt ? `Checked ${fmtDate(data.generatedAt)}` : mode;
  const modeLabel = document.getElementById("dynamic-plan-mode");
  if (modeLabel) modeLabel.textContent = mode;

  const summary = document.getElementById("dynamic-plan-summary");
  if (summary) {
    summary.innerHTML = `
      <div class="governor-card state-card ${governorStateClass(currentState)}"><span>Current tier</span><strong>${escapeHtml(currentState)}</strong><em>${fmtDate(latest.createdAt)}</em></div>
      <div class="governor-card"><span>Avg utilization</span><strong>${governorNumber(Number(latest.avgUtilizationScore || 0) * 100, 1)}%</strong><em>${escapeHtml(latest.sampleCount || 0)} samples</em></div>
      <div class="governor-card"><span>Last package</span><strong>${latest.priceKsh != null ? fmtMoney(latest.priceKsh) : "-"}</strong><em>${latest.rateLimit ? escapeHtml(latest.rateLimit) : "-"}</em></div>
      <div class="governor-card"><span>Published</span><strong>${latest.published ? "Yes" : "No"}</strong><em>${latest.durationSeconds ? shortDuration(latest.durationSeconds) : "-"}</em></div>
    `;
  }

  const settings = document.getElementById("dynamic-plan-settings");
  if (settings) {
    settings.innerHTML = `
      <div class="governor-setting"><span>Enabled</span>${status(config.enabled ? "enabled" : "disabled")}</div>
      <div class="governor-setting"><span>Dry run</span>${status(config.dryRun ? "on" : "off")}</div>
      <div class="governor-setting"><span>Rotation</span><strong>${durationMinutes(config.rotationMs)} min</strong></div>
    `;
  }

  renderRows("dynamic-plan-live", data.dynamicPlans || [], (item) => [
    escapeHtml(item.site?.name),
    escapeHtml(item.name),
    shortDuration(item.durationSeconds),
    fmtMoney(item.priceKsh),
    friendlyRate(item.rateLimit),
    item.enabled ? status("published") : status("disabled")
  ], 6);

  renderRows("dynamic-plan-events", data.recentEvents || [], (item) => [
    fmtDate(item.createdAt),
    status(item.state),
    `${governorNumber(Number(item.avgUtilizationScore || 0) * 100, 1)}%`,
    escapeHtml(item.sampleCount || 0),
    item.durationSeconds ? shortDuration(item.durationSeconds) : "-",
    item.priceKsh != null ? fmtMoney(item.priceKsh) : "-",
    item.rateLimit ? friendlyRate(item.rateLimit) : "-",
    item.published ? status("published") : status("disabled")
  ], 8);
}

function renderOutageCredits() {
  const data = state.cache.outageCredits || {};
  const config = data.config || {};
  const paused = data.currentlyPaused || [];
  const credits = data.recentCredits || [];
  const generated = document.getElementById("outage-credits-generated");
  if (generated) generated.textContent = data.generatedAt ? `Checked ${fmtDate(data.generatedAt)}` : "";
  const modeLabel = document.getElementById("outage-credits-mode");
  if (modeLabel) modeLabel.textContent = config.enabled ? "Watching" : "Off";

  const last24h = credits.filter((item) => Date.now() - new Date(item.createdAt).getTime() < 24 * 60 * 60 * 1000);
  const totalCreditedSeconds24h = last24h.reduce((sum, item) => sum + Number(item.creditedSeconds || 0), 0);

  const summary = document.getElementById("outage-credits-summary");
  if (summary) {
    summary.innerHTML = `
      <div class="governor-card ${paused.length ? "state-card red" : ""}"><span>Currently paused</span><strong>${paused.length}</strong><em>waiting to reconnect</em></div>
      <div class="governor-card"><span>Credits (24h)</span><strong>${last24h.length}</strong><em>${durationMinutes(totalCreditedSeconds24h * 1000)} min credited</em></div>
      <div class="governor-card"><span>Grace (self)</span><strong>${governorNumber(config.graceSeconds, 0)}s</strong><em>worker-down detection</em></div>
      <div class="governor-card"><span>Grace (network)</span><strong>${governorNumber(config.accountingGraceSeconds, 0)}s</strong><em>silent-RADIUS detection</em></div>
    `;
  }

  const settings = document.getElementById("outage-credits-settings");
  if (settings) {
    settings.innerHTML = `
      <div class="governor-setting"><span>Enabled</span>${status(config.enabled ? "enabled" : "disabled")}</div>
      <div class="governor-setting"><span>Max credit cap</span><strong>${durationMinutes(Number(config.maxCreditSeconds || 0) * 1000)} min</strong></div>
      ${(data.heartbeats || []).map((hb) => `<div class="governor-setting"><span>${escapeHtml(hb.service)}</span><strong>${fmtDate(hb.lastSeenAt)}</strong></div>`).join("")}
    `;
  }

  renderRows("outage-paused", paused, (item) => [
    `<span class="mono">${escapeHtml(item.username)}</span>`,
    escapeHtml(item.customerPhone),
    escapeHtml(item.outagePauseCause),
    fmtDate(item.outagePausedAt),
    fmtDate(item.expiresAt)
  ], 5);

  renderRows("outage-credits", credits, (item) => [
    fmtDate(item.createdAt),
    escapeHtml(item.service),
    fmtDate(item.outageStartedAt),
    fmtDate(item.outageEndedAt),
    `${durationMinutes(Number(item.creditedSeconds || 0) * 1000)} min`,
    item.entitlementId ? `<span class="mono">${escapeHtml(item.entitlementId.slice(0, 8))}</span>` : "-"
  ], 6);
}

function renderPromo() {
  const promo = state.cache.promo;
  const pill = document.getElementById("promo-status-pill");
  const summary = document.getElementById("promo-summary");
  const endBtn = document.getElementById("promo-end-btn");
  if (!pill || !summary || !endBtn) return;

  if (promo && promo.active) {
    pill.className = "pill ok";
    pill.textContent = "Live";
    summary.innerHTML = `
      <div class="governor-card"><span>Heading</span><strong>${escapeHtml(promo.heading || "—")}</strong></div>
      <div class="governor-card"><span>Valid till</span><strong>${fmtDate(promo.endsAt)}</strong></div>
      <div class="governor-card"><span>Rate limit</span><strong>${escapeHtml(promo.rateLimit || "plan default")}</strong></div>
      <div class="governor-card"><span>Pausing existing</span>${status(promo.pauseExisting ? "yes" : "no")}</div>
    `;
    endBtn.classList.remove("hidden");
  } else {
    pill.className = "pill muted";
    pill.textContent = "Off";
    summary.innerHTML = '<div class="empty-state">No promo running. Fill in the form to launch one.</div>';
    endBtn.classList.add("hidden");
  }
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
  renderGovernorStatus();
  renderDynamicPlanStatus();
  renderOutageCredits();
  renderPromo();
  renderVouchers();

  const payments = state.cache.payments || [];
  const entitlements = state.cache.entitlements || [];

  renderRows("overview-payments", payments.slice(0, 5), (item) => [
    `<span class="mono">${escapeHtml(item.sourceReference)}</span>`,
    escapeHtml(item.plan?.name),
    status(item.status),
    fmtMoney(item.amountKsh)
  ], 4);

  renderAccessRows("overview-access", entitlements.slice(0, 5), true);

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
    planCategory(item) === "limited" ? status("limited") : status("standard"),
    friendlyRate(item.rateLimit),
    escapeHtml(item.deviceLimit),
    item.enabled ? status("published") : status("disabled"),
    `<span class="action-row"><button class="secondary" type="button" data-edit-plan="${escapeHtml(item.id)}">Edit</button>${item.enabled ? '<a class="button-link secondary" href="/wifi/" target="_blank" rel="noreferrer">View</a>' : ""}</span>`
  ], 9);

  renderRows("payments", payments, (item) => [
    `<span class="mono">${escapeHtml(item.sourceReference)}</span>`,
    escapeHtml(item.site?.name),
    escapeHtml(item.plan?.name),
    escapeHtml(item.customerPhone),
    status(item.status),
    fmtMoney(item.amountKsh),
    fmtDate(item.createdAt)
  ], 7);

  renderAccessRows("entitlements", entitlements);
  renderAccessDetail();

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
    const [summary, sites, plans, payments, entitlements, projections, accounting, networkStatus, governorStatus, dynamicPlanStatus, outageCredits, promo] = await Promise.all([
      api(adminApi("/summary")),
      api(endpoints.sites),
      api(endpoints.plans),
      api(endpoints.payments),
      api(endpoints.entitlements),
      api(endpoints.projections),
      api(endpoints.accounting),
      api(endpoints.networkStatus),
      api(endpoints.governorStatus),
      api(endpoints.dynamicPlanStatus),
      api(endpoints.outageCredits),
      api(endpoints.promo)
    ]);
    state.cache = { sites, plans, payments, entitlements, projections, accounting, networkStatus, governorStatus, dynamicPlanStatus, outageCredits, promo };
    renderSummary(summary);
    renderAll();
    authPanel.classList.add("hidden");
    dashboard.classList.remove("hidden");
    finishBoot();
    setPage(state.activePage);
  } catch (error) {
    dashboard.classList.add("hidden");
    authPanel.classList.remove("hidden");
    finishBoot();
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
  planCategorySelect.value = "standard";
  planDownloadInput.value = "";
  planUploadInput.value = "";
  planEnabledInput.checked = true;
  planFeaturedInput.checked = false;
  planManualPricingInput.checked = false;
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
  planCategorySelect.value = planCategory(plan);
  const rate = parseRateLimit(plan.rateLimit);
  planDownloadInput.value = rate.download;
  planUploadInput.value = rate.upload;
  planDevicesInput.value = String(plan.deviceLimit || 1);
  planEnabledInput.checked = Boolean(plan.enabled);
  planFeaturedInput.checked = Boolean(plan.featured);
  planManualPricingInput.checked = Boolean(plan.manualPricing);
  planSubmit.textContent = "Update package";
  planCancel.classList.remove("hidden");
  setInlineStatus(planStatus, "Editing", "warn");
  setPage("setup");
  window.scrollTo({ top: dashboard.offsetTop, behavior: "smooth" });
}

function newPlan() {
  resetPlanForm();
  setPage("setup");
  window.scrollTo({ top: dashboard.offsetTop, behavior: "smooth" });
  planNameInput.focus();
}

async function deletePlan(planId) {
  const plan = (state.cache.plans || []).find((item) => item.id === planId);
  if (!plan) return;
  if (!window.confirm(`Delete "${plan.name}"? This can't be undone.`)) return;
  try {
    await api(adminApi(`/plans/${encodeURIComponent(planId)}`), { method: "DELETE" });
    if (state.editingPlanId === planId) resetPlanForm();
    await loadDashboard();
  } catch (error) {
    // The API returns a 409 with a clear message when a package has real
    // payment/access history (WifiPaymentIntent/WifiEntitlement are
    // onDelete: Restrict, on purpose -- deleting it out from under real
    // history would be a correctness bug). Surface that instead of a
    // generic failure.
    window.alert(error instanceof Error ? error.message : "Unable to delete package.");
  }
}

async function selectAccess(entitlementId, preserveMessage = false) {
  if (!entitlementId) return;
  if (state.selectedEntitlementId !== entitlementId || !preserveMessage) state.accessActionMessage = "";
  state.selectedEntitlementId = entitlementId;
  state.accessDetail = null;
  renderAll();
  setPage("access");
  try {
    state.accessDetail = await api(adminApi(`/entitlements/${encodeURIComponent(entitlementId)}`));
    renderAll();
    accessDetailPanel?.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    accessDetailPanel?.classList.remove("hidden");
    accessDetailBody.innerHTML = `<div class="empty-state">${escapeHtml(error instanceof Error ? error.message : "Unable to load access detail.")}</div>`;
  }
}

function routerActionMessage(router) {
  if (!router) return "Saved. Router session was not checked.";
  if (router.error) return `Saved, but router kick failed: ${router.error}`;
  if (router.skippedReason) return `Saved. ${router.skippedReason}`;
  if (router.attempted && router.removed > 0) return `Saved. Router session kicked (${router.removed}). Customer will reauthenticate with new settings.`;
  if (router.attempted) return "Saved. No active router session was found to kick.";
  return "Saved.";
}

async function runAccessAction(action) {
  if (!state.selectedEntitlementId) return;
  if (action === "expire" && !window.confirm("Expire this access now and remove its RADIUS login rows?")) return;
  if (action === "suspend" && !window.confirm("Suspend this access and remove its RADIUS login rows?")) return;
  const statusEl = document.getElementById("access-action-status");
  if (statusEl) {
    statusEl.textContent = "Working";
    statusEl.className = "inline-status";
  }
  const body = { action };
  if (action === "extend") {
    const seconds = Number(document.getElementById("access-extension-seconds")?.value || 0);
    if (!seconds) return;
    body.extensionSeconds = seconds;
  }
  if (action === "update_limits") {
    const rateLimit = composeRateLimit(
      document.getElementById("access-download")?.value,
      document.getElementById("access-upload")?.value
    );
    body.rateLimit = rateLimit || null;
    body.deviceLimit = Number(document.getElementById("access-devices")?.value || 1);
  }
  try {
    const result = await writeApi(adminApi(`/entitlements/${encodeURIComponent(state.selectedEntitlementId)}/actions`), "POST", body);
    state.accessActionMessage = routerActionMessage(result?.router);
    if (statusEl) {
      statusEl.textContent = state.accessActionMessage;
      statusEl.className = result?.router?.error ? "inline-status bad" : "inline-status ok";
    }
    await loadDashboard();
    await selectAccess(state.selectedEntitlementId, true);
  } catch (error) {
    if (statusEl) {
      statusEl.textContent = error instanceof Error ? error.message : "Action failed";
      statusEl.className = "inline-status bad";
    }
  }
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
    storeAdminSession(result);
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
  // Grab the selected file now -- resetPlanForm() calls planForm.reset(),
  // which clears the file input, so reading it after the save would always
  // see nothing.
  const imageFile = planImageInput.files && planImageInput.files[0] ? planImageInput.files[0] : null;
  try {
    const body = {
      siteId: planSiteSelect.value,
      name: planNameInput.value.trim(),
      durationSeconds: durationSeconds(planDurationValueInput.value, planDurationUnitSelect.value),
      priceKsh: Number(planPriceInput.value || 0),
      category: planCategorySelect.value,
      rateLimit: composeRateLimit(planDownloadInput.value, planUploadInput.value),
      deviceLimit: Number(planDevicesInput.value || 1),
      enabled: planEnabledInput.checked,
      featured: planFeaturedInput.checked,
      manualPricing: planManualPricingInput.checked
    };
    let planId = state.editingPlanId;
    if (planId) {
      await writeApi(adminApi(`/plans/${encodeURIComponent(planId)}`), "PATCH", body);
    } else {
      const created = await writeApi(adminApi("/plans"), "POST", body);
      planId = created.id;
    }
    if (imageFile) {
      const formData = new FormData();
      formData.append("image", imageFile);
      // api() only injects the auth header, it doesn't force a JSON
      // Content-Type -- fetch sets the multipart boundary itself as long as
      // we don't set Content-Type manually here.
      await api(adminApi(`/plans/${encodeURIComponent(planId)}/image`), { method: "POST", body: formData });
    }
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

const promoForm = document.getElementById("promo-form");
const promoFormStatus = document.getElementById("promo-form-status");
const promoSubmit = document.getElementById("promo-submit");
const promoEndBtn = document.getElementById("promo-end-btn");

promoForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const siteId = (state.cache.sites || [])[0]?.id;
  if (!siteId) {
    setInlineStatus(promoFormStatus, "Create a site first", "bad");
    return;
  }
  const endsAtValue = document.getElementById("promo-ends-at").value;
  const endsAt = endsAtValue ? new Date(endsAtValue) : null;
  if (!endsAt || Number.isNaN(endsAt.getTime())) {
    setInlineStatus(promoFormStatus, "Pick a valid \"Valid till\" time", "bad");
    return;
  }
  promoSubmit.disabled = true;
  setInlineStatus(promoFormStatus, "Starting");
  try {
    await writeApi(adminApi("/promo/start"), "POST", {
      siteId,
      heading: document.getElementById("promo-heading").value.trim() || undefined,
      message: document.getElementById("promo-message").value.trim() || undefined,
      endsAt: endsAt.toISOString(),
      rateLimit: document.getElementById("promo-rate-limit").value.trim() || undefined,
      deviceLimit: Number(document.getElementById("promo-device-limit").value) || 1,
      pauseExisting: document.getElementById("promo-pause-existing").checked
    });
    setInlineStatus(promoFormStatus, "Live", "ok");
    promoForm.reset();
    document.getElementById("promo-device-limit").value = "1";
    document.getElementById("promo-pause-existing").checked = true;
    await loadDashboard();
    setPage("promo");
  } catch (error) {
    setInlineStatus(promoFormStatus, error instanceof Error ? error.message : "Failed", "bad");
  } finally {
    promoSubmit.disabled = false;
  }
});

promoEndBtn?.addEventListener("click", async () => {
  if (!window.confirm("End the promo now? Everyone's free access stops and paused packages resume immediately.")) return;
  promoEndBtn.disabled = true;
  try {
    await writeApi(adminApi("/promo/end"), "POST", {});
    await loadDashboard();
    setPage("promo");
  } catch (error) {
    window.alert(error instanceof Error ? error.message : "Failed to end promo");
  } finally {
    promoEndBtn.disabled = false;
  }
});

refreshBtn.addEventListener("click", () => { void checkHealth(); if (state.sessionToken) void loadDashboard(); });
logoutBtn.addEventListener("click", () => clearSession({ forgetTrusted: true }));
planCancel.addEventListener("click", resetPlanForm);
document.getElementById("new-package-btn")?.addEventListener("click", newPlan);
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
  const deleteId = target.dataset.deletePlan;
  if (deleteId) void deletePlan(deleteId);
  const action = target.dataset.accessAction;
  if (action) void runAccessAction(action);
  const row = target.closest("[data-entitlement-id]");
  if (row instanceof HTMLElement && !target.closest("button, a, select, input")) void selectAccess(row.dataset.entitlementId || "");
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const row = target.closest("[data-entitlement-id]");
  if (row instanceof HTMLElement) void selectAccess(row.dataset.entitlementId || "");
});
document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => setPage(button.dataset.page)));

async function bootstrapAdmin() {
  void checkHealth();
  if (state.sessionToken) {
    await loadDashboard();
    if (state.sessionToken) return;
  }
  if (state.trustedDeviceToken) await restoreTrustedSession();
}
void bootstrapAdmin();
