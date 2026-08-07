/*!
 * Conduit Inline Checkout — the drop-in popup (Conduit's answer to
 * PaystackPop.setup / Stripe Checkout).
 *
 * The merchant's SERVER creates the charge (a settlement intent) with its
 * secret key and gets back a `hosted_url`. This script opens that hosted
 * checkout in a POPUP WINDOW and calls back when it settles — so the amount is
 * fixed server-side and the browser can never tamper with it. The public key
 * never has to touch this file; the security lives in who created the intent.
 *
 * Why a popup window and not an iframe: the checkout needs a real wallet —
 * Google/Privy sign-in (OAuth), browser wallet extensions, and cross-chain
 * signing. Browsers block all of those inside a cross-origin iframe (third-party
 * cookies, popup OAuth, extension injection). A popup is a genuine top-level
 * browsing context, so everything the payer needs actually works there.
 *
 * Usage (in the merchant's page). Prefer `createCharge` so the window opens
 * synchronously inside the click — a window.open that happens AFTER an
 * `await` is treated as an unsolicited popup and blocked:
 *
 *   <script src="https://useconduit-app.vercel.app/conduit.js"></script>
 *   <script>
 *     Conduit.checkout({
 *       createCharge: async function () {   // your server creates the charge
 *         var r = await fetch("/api/checkout", { method: "POST" });
 *         var d = await r.json();
 *         return d.hosted_url;              // (or return the whole {hosted_url})
 *       },
 *       onSuccess: function (r) {           // r.intent = "si_..."
 *         window.location = "/thank-you?ref=" + r.intent;
 *       },
 *       onClose: function () {},            // buyer closed the window unpaid
 *       onError: function (e) {},           // charge creation failed
 *     });
 *   </script>
 *
 * A `url` (a hosted_url you already have) is still accepted instead of
 * `createCharge`, but may be popup-blocked if you obtained it via an await
 * before calling checkout.
 *
 * The popup and this script talk over window.postMessage, strictly scoped to
 * the hosted_url's own origin — a page can't forge a "settled".
 */
(function () {
  "use strict";

  function popupFeatures() {
    var w = 460, h = 760;
    var dualLeft = window.screenLeft !== undefined ? window.screenLeft : (screen.left || 0);
    var dualTop = window.screenTop !== undefined ? window.screenTop : (screen.top || 0);
    var vw = window.innerWidth || document.documentElement.clientWidth || screen.width;
    var vh = window.innerHeight || document.documentElement.clientHeight || screen.height;
    var left = Math.max(0, vw / 2 - w / 2 + dualLeft);
    var top = Math.max(0, vh / 2 - h / 2 + dualTop);
    return "scrollbars=yes,resizable=yes,width=" + w + ",height=" + h + ",top=" + top + ",left=" + left;
  }

  function checkout(opts) {
    opts = opts || {};

    // Open the window NOW, inside the user's click, before any async work — a
    // window.open that runs after an await is blocked as an unsolicited popup.
    // We don't have the URL yet (the server still has to create the charge), so
    // open blank and navigate once we do.
    var win = window.open("about:blank", "conduit_checkout", popupFeatures());

    var origin = null;
    var settled = false;
    var closeTimer = null;

    function fail(err) {
      cleanup();
      if (win && !win.closed) win.close();
      if (typeof opts.onError === "function") opts.onError(err);
      else throw err instanceof Error ? err : new Error(String(err));
    }

    function cleanup() {
      window.removeEventListener("message", onMessage);
      if (closeTimer) { clearInterval(closeTimer); closeTimer = null; }
    }

    function onMessage(e) {
      if (!origin || e.origin !== origin) return;
      var d = e.data || {};
      if (d.type !== "conduit:checkout") return;
      if (d.status === "loaded") {
        if (typeof opts.onLoad === "function") opts.onLoad({ intent: d.intent });
      } else if (d.status === "settled") {
        settled = true;
        cleanup();
        if (win && !win.closed) win.close();
        if (typeof opts.onSuccess === "function") opts.onSuccess({ intent: d.intent });
      }
    }

    function navigate(rawUrl) {
      var url = typeof rawUrl === "string" ? rawUrl : (rawUrl && rawUrl.hosted_url);
      if (!url) { fail(new Error("Conduit.checkout: no hosted_url to open.")); return; }
      try {
        origin = new URL(url, window.location.href).origin;
      } catch (e) {
        fail(new Error("Conduit.checkout: `url` is not a valid URL."));
        return;
      }
      var src = url + (url.indexOf("?") === -1 ? "?" : "&") + "embed=1";
      if (win && !win.closed) {
        win.location = src;
      } else {
        // Popup was blocked — fall back to navigating this tab to the full
        // checkout. Payment still completes; the merchant just loses the
        // in-page onSuccess callback (the checkout is a normal page from here).
        window.location = src;
        return;
      }

      window.addEventListener("message", onMessage);
      // Detect the buyer closing the window without paying.
      closeTimer = setInterval(function () {
        if (win && win.closed) {
          cleanup();
          if (!settled && typeof opts.onClose === "function") opts.onClose();
        }
      }, 500);
    }

    if (typeof opts.createCharge === "function") {
      Promise.resolve()
        .then(opts.createCharge)
        .then(navigate)
        .catch(fail);
    } else if (opts.url) {
      navigate(opts.url);
    } else {
      fail(new Error("Conduit.checkout: pass `createCharge` (recommended) or `url`."));
    }

    return {
      close: function () {
        cleanup();
        if (win && !win.closed) win.close();
      },
    };
  }

  window.Conduit = { checkout: checkout };
})();
