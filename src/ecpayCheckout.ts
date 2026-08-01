/**
 * ECPay has no client SDK and no embeddable payment widget — unlike
 * PayPal's JS SDK + Buttons (see the removed paypalSdk.ts), the backend
 * (functions/src/topupHandlers.ts) hands back a plain action URL and a
 * signed field set, and the only job here is to POST that to ECPay's
 * hosted checkout page. The buyer's browser leaves this site entirely for
 * that page; there is no inline/iframe payment step to render.
 */
export function redirectToEcpayCheckout(actionUrl: string, fields: Record<string, string>): void {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = actionUrl;
  form.style.display = "none";
  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}
