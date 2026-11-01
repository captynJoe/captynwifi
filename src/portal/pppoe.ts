type Plan = { id: string; name: string; priceKsh: number; durationSeconds: number; rateLimit: string | null; site?: { name: string } };
type Account = { username: string; password: string; startsAt: string; expiresAt: string; rateLimit?: string | null; planName?: string | null };
const plansEl = document.querySelector<HTMLDivElement>("#pppoe-plans")!;
const form = document.querySelector<HTMLFormElement>("#pppoe-form")!;
const phoneEl = document.querySelector<HTMLInputElement>("#pppoe-phone")!;
const payButton = document.querySelector<HTMLButtonElement>("#pppoe-pay")!;
const statusEl = document.querySelector<HTMLParagraphElement>("#pppoe-status")!;
const resultEl = document.querySelector<HTMLDivElement>("#pppoe-result")!;
const receiptForm = document.querySelector<HTMLFormElement>("#pppoe-receipt-form")!;
const receiptEl = document.querySelector<HTMLInputElement>("#pppoe-receipt")!;
const receiptStatus = document.querySelector<HTMLParagraphElement>("#pppoe-receipt-status")!;
const basePath = window.location.pathname.startsWith("/wifi") ? "/wifi" : "";
const api = (path: string) => `${basePath}/api/public${path}`;
let plans: Plan[] = [];
let selectedPlan: Plan | null = null;
let waiting = false;
const money = (amount: number) => `KSh ${new Intl.NumberFormat("en-KE").format(amount)}`;
const duration = (seconds: number) => `${Math.round(seconds / 86400)} days`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
function renderPlans() {
  plansEl.innerHTML = plans.map((plan) => `<button class="pppoe-plan${selectedPlan?.id === plan.id ? " selected" : ""}" type="button" data-plan="${esc(plan.id)}"><span><strong>${esc(plan.name)}</strong><small>${duration(plan.durationSeconds)}${plan.rateLimit ? ` · ${esc(plan.rateLimit)} speed` : ""}</small></span><span class="pppoe-price">${money(plan.priceKsh)}</span></button>`).join("") || '<p class="pppoe-muted">Monthly plans are temporarily unavailable.</p>';
  payButton.disabled = !selectedPlan || waiting;
  payButton.textContent = selectedPlan ? `Pay ${money(selectedPlan.priceKsh)} with M-PESA` : "Choose a monthly plan";
}
function showAccount(account: Account) {
  resultEl.classList.remove("hidden");
  resultEl.innerHTML = `<h3>Router login</h3><p class="pppoe-muted">${account.planName ? esc(account.planName) + " · " : ""}Active until ${new Date(account.expiresAt).toLocaleString("en-KE", { timeZone: "Africa/Nairobi" })} EAT</p><p>Username</p><p class="pppoe-credentials">${esc(account.username)}</p><p>Password</p><p class="pppoe-credentials">${esc(account.password)}</p><button id="pppoe-copy" class="pppoe-button" type="button">Copy login details</button><p class="pppoe-muted">Save these credentials. Enter them in the Tenda WAN settings under PPPoE.</p>`;
  document.querySelector<HTMLButtonElement>("#pppoe-copy")?.addEventListener("click", async () => {
    await navigator.clipboard.writeText(`Username: ${account.username}\nPassword: ${account.password}`);
    statusEl.textContent = "Login details copied.";
  });
}
async function loadPlans() {
  try {
    const response = await fetch(api("/pppoe/plans"));
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Unable to load monthly plans.");
    plans = payload.data || [];
    selectedPlan = plans[0] || null;
    renderPlans();
  } catch (error) {
    plansEl.innerHTML = `<p class="pppoe-muted">${esc(error instanceof Error ? error.message : "Unable to load monthly plans.")}</p>`;
  }
}
plansEl.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-plan]");
  if (!button) return;
  selectedPlan = plans.find((plan) => plan.id === button.dataset.plan) || null;
  renderPlans();
});
async function pollPayment(paymentId: string) {
  for (let attempt = 0; attempt < 90; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const response = await fetch(api(`/payments/${encodeURIComponent(paymentId)}`));
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Unable to check payment status.");
    const payment = payload.data;
    if (payment.status === "activated" && payment.pppoeAccount) {
      showAccount(payment.pppoeAccount);
      statusEl.textContent = "Payment received. Your PPPoE login is ready.";
      return;
    }
    if (payment.status === "activated" && payment.pppoeExpired) {
      throw new Error("That subscription has expired. Buy a monthly plan to renew the router login.");
    }
    if (payment.status === "failed") throw new Error(payment.failureReason || "Payment failed or was cancelled. You can try again.");
    statusEl.textContent = "Waiting for M-PESA confirmation…";
  }
  statusEl.textContent = "Payment is still processing. This page will keep your request; use the receipt code below to restore your login once confirmed.";
}
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedPlan || waiting) return;
  waiting = true;
  resultEl.classList.add("hidden");
  renderPlans();
  statusEl.textContent = "Sending M-PESA prompt…";
  try {
    const response = await fetch(api("/payments/mpesa/stk"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accessType: "pppoe", planId: selectedPlan.id, phone: phoneEl.value.trim() }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Unable to start M-PESA payment.");
    statusEl.textContent = payload.data.customerMessage || "Enter your M-PESA PIN to complete payment.";
    await pollPayment(payload.data.id);
  } catch (error) {
    statusEl.textContent = error instanceof Error ? error.message : "Unable to complete payment.";
  } finally {
    waiting = false;
    renderPlans();
  }
});
receiptForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  receiptStatus.textContent = "Looking up your payment…";
  try {
    const response = await fetch(api("/payments/lookup-by-receipt"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ receipt: receiptEl.value.trim(), phone: phoneEl.value.trim() }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not restore this PPPoE login.");
    showAccount(payload.data);
    receiptStatus.textContent = "Your active PPPoE login has been restored.";
  } catch (error) {
    receiptStatus.textContent = error instanceof Error ? error.message : "Could not restore this PPPoE login.";
  }
});
void loadPlans();

export {};
