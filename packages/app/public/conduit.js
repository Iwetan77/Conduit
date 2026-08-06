/*!
 * Conduit Inline Checkout — the drop-in popup (Conduit's answer to
 * PaystackPop.setup / Stripe Checkout).
 *
 * The merchant's SERVER creates the charge (a settlement intent) with its
 * secret key and gets back a `hosted_url`. This script opens that hosted
 * checkout in a modal iframe and calls back when it settles — so the amount is
 * fixed server-side and the browser can never tamper with it. The public key
 * never has to touch this file; the security lives in who created the intent.
 *
 * Usage (in the merchant's page):
 *   <script src="https://useconduit-app.vercel.app/conduit.js"></script>
 *   <script>
 *     Conduit.checkout({
 *       url: HOSTED_URL,           // the `hosted_url` your server got back
 *       onSuccess: function (r) {  // r.intent = "si_..."
 *         window.location = "/thank-you?ref=" + r.intent;
 *       },
 *       onClose: function () {},   // buyer dismissed the popup
 *     });
 *   </script>
 *
 * The iframe and this script talk over window.postMessage, strictly scoped to
 * the hosted_url's own origin — a page embedding this can't spoof a "settled".
 */
(function () {
  "use strict";

  function el(tag, css) {
    var e = document.createElement(tag);
    if (css) e.style.cssText = css;
    return e;
  }

  function checkout(opts) {
    opts = opts || {};
    var url = opts.url;
    if (!url) {
      throw new Error(
        "Conduit.checkout: `url` is required — pass the hosted_url your server " +
          "received from POST /v1/settlement_intents."
      );
    }

    // Every message we trust must come from the checkout's own origin.
    var origin;
    try {
      origin = new URL(url).origin;
    } catch (e) {
      throw new Error("Conduit.checkout: `url` is not a valid URL.");
    }
    var src = url + (url.indexOf("?") === -1 ? "?" : "&") + "embed=1";

    var overlay = el(
      "div",
      "position:fixed;inset:0;z-index:2147483647;background:rgba(2,6,4,.72);" +
        "-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);display:flex;" +
        "align-items:center;justify-content:center;padding:16px;opacity:0;transition:opacity .18s ease;"
    );
    var frame = el(
      "div",
      "position:relative;width:100%;max-width:420px;height:92vh;max-height:760px;" +
        "background:#050505;border:1px solid #1f291b;border-radius:16px;overflow:hidden;" +
        "box-shadow:0 24px 80px rgba(0,0,0,.6);transform:translateY(8px);transition:transform .18s ease;"
    );
    var iframe = el("iframe", "width:100%;height:100%;border:0;display:block;background:#050505;");
    iframe.setAttribute("allow", "clipboard-write; camera; publickey-credentials-get");
    iframe.setAttribute("title", "Conduit Checkout");
    iframe.src = src;

    var close = el(
      "button",
      "position:absolute;top:10px;right:12px;z-index:2;width:30px;height:30px;border:0;" +
        "border-radius:9px;background:rgba(255,255,255,.07);color:#cbd5c0;font-size:19px;" +
        "line-height:1;cursor:pointer;"
    );
    close.setAttribute("aria-label", "Close checkout");
    close.innerHTML = "&times;";

    var settled = false;
    var loaded = false;

    function teardown() {
      window.removeEventListener("message", onMessage);
      document.removeEventListener("keydown", onKey);
      overlay.style.opacity = "0";
      setTimeout(function () {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      }, 180);
    }
    function dismiss() {
      teardown();
      if (!settled && typeof opts.onClose === "function") opts.onClose();
    }
    function onKey(e) {
      if (e.key === "Escape") dismiss();
    }
    function onMessage(e) {
      if (e.origin !== origin) return;
      var d = e.data || {};
      if (d.type !== "conduit:checkout") return;
      if (d.status === "loaded") {
        loaded = true;
        if (typeof opts.onLoad === "function") opts.onLoad({ intent: d.intent });
      } else if (d.status === "settled") {
        settled = true;
        teardown();
        if (typeof opts.onSuccess === "function") opts.onSuccess({ intent: d.intent });
      }
    }

    close.addEventListener("click", dismiss);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) dismiss();
    });
    document.addEventListener("keydown", onKey);
    window.addEventListener("message", onMessage);

    frame.appendChild(iframe);
    frame.appendChild(close);
    overlay.appendChild(frame);
    document.body.appendChild(overlay);
    // next frame → animate in
    requestAnimationFrame(function () {
      overlay.style.opacity = "1";
      frame.style.transform = "translateY(0)";
    });

    return { close: dismiss };
  }

  window.Conduit = { checkout: checkout };
})();
