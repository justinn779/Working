// PayPal's JS SDK has no first-party TypeScript types shipped for this
// use case, so it's accessed via `window.paypal` with narrow local types
// rather than pulling in a third-party @types package for one integration
// point.

/** Live Client ID — safe to be public (that's how PayPal's own SDK is
 * designed to be embedded), unlike PAYPAL_CLIENT_SECRET which never leaves
 * Firebase Secret Manager. This project went live 2026-07-31; the backend's
 * PAYPAL_ENV (functions/.env) was flipped to "live" in the same change. */
const PAYPAL_CLIENT_ID = "BAAo1Vd2GnWUjFs2JGdHdRKY295nAN-_yDR1ZEw8B9no_Eh5CdxI_KT0CMoj1jXqONKqM7z6ANTertHMac";

interface PaypalButtonsActions {
  order: { capture: () => Promise<unknown> };
}

interface PaypalNamespace {
  Buttons: (config: {
    createOrder: () => Promise<string>;
    onApprove: (data: unknown, actions: PaypalButtonsActions) => Promise<void>;
    onCancel?: () => void;
    onError?: (err: unknown) => void;
    style?: Record<string, string>;
  }) => { render: (selector: string) => void };
}

declare global {
  interface Window {
    paypal?: PaypalNamespace;
  }
}

let sdkLoadPromise: Promise<void> | null = null;

/** Lazily injects the PayPal SDK `<script>` tag once; concurrent callers
 * share the same load promise instead of injecting the script twice. */
export function loadPaypalSdk(): Promise<void> {
  if (window.paypal) return Promise.resolve();
  if (sdkLoadPromise) return sdkLoadPromise;

  sdkLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://www.paypal.com/sdk/js?client-id=${PAYPAL_CLIENT_ID}&currency=TWD&intent=capture`;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("PayPal SDK 載入失敗"));
    document.head.appendChild(script);
  });
  return sdkLoadPromise;
}

/**
 * Renders the PayPal payment button into an existing container element.
 * `getOrderId` returns the PayPal order id our own backend already created
 * (see createTopupOrder) — the button never creates its own order, it only
 * drives the buyer through approving the one we snapshotted a price for.
 * `onApprove` is only told the approval happened; it's the caller's job to
 * then call our own captureTopupOrder callable — this module knows nothing
 * about our order model at all, on purpose.
 */
export function renderPaypalButtons(
  containerId: string,
  opts: {
    paypalOrderId: string;
    onApprove: () => void | Promise<void>;
    onCancel: () => void;
    onError: (err: unknown) => void;
  }
): void {
  const paypal = window.paypal;
  if (!paypal) {
    opts.onError(new Error("PayPal SDK 尚未載入"));
    return;
  }
  paypal
    .Buttons({
      createOrder: () => Promise.resolve(opts.paypalOrderId),
      onApprove: () => Promise.resolve(opts.onApprove()),
      onCancel: () => opts.onCancel(),
      onError: (err) => opts.onError(err),
      style: { layout: "vertical", label: "pay" },
    })
    .render(`#${containerId}`);
}
