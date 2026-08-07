/*!
 * Conduit Inline Checkout — the drop-in popup (Conduit's answer to
 * PaystackPop.setup / Stripe Checkout).
 *
 * The merchant's SERVER creates the charge (a settlement intent) with its
 * secret key and gets back a `hosted_url`. This script opens that hosted
 * checkout in a NEW TAB and calls back when it settles — so the amount is
 * fixed server-side and the browser can never tamper with it. The public key
 * never has to touch this file; the security lives in who created the intent.
 *
 * Why a new tab and not an iframe or a chrome-less popup: the checkout needs a
 * real wallet — Google/Privy sign-in (OAuth), browser wallet extensions, and
 * cross-chain signing. A cross-origin iframe blocks all of those (third-party
 * cookies, OAuth popups, extension injection). A chrome-less popup window
 * (window.open with a width/height features string) is nearly as bad: wallet
 * extensions route their approval UI and OAuth redirects differently there, so
 * Solflare/Phantom connect() promises hang forever and the injected-wallet path
 * renders blank. A plain tab is an ordinary top-level page — identical to
 * opening the hosted checkout directly — so every wallet path just works.
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

  function checkout(opts) {
    opts = opts || {};

    // Open the tab NOW, inside the user's click, before any async work — a
    // window.open that runs after an await is blocked as an unsolicited popup.
    // We don't have the URL yet (the server still has to create the charge), so
    // open blank and navigate once we do.
    //
    // Deliberately NO features string and target "_blank": that opens a real
    // browser TAB rather than a chrome-less popup window. Wallet extensions
    // (Solflare/Phantom/MetaMask) and OAuth redirects route their approval UI
    // differently in a chrome-less popup — connect() promises never resolve and
    // the injected-wallet path renders blank. A tab is an ordinary top-level
    // page, identical to opening the hosted checkout directly, so every wallet
    // path behaves exactly as it does there.
    var win = window.open("about:blank", "_blank");

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
