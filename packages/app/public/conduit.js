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

  // Mobile browsers — and above all the in-app browsers inside wallet apps
  // (MetaMask, Solflare, Phantom, Trust, Coinbase Wallet) — either can't open a
  // second tab at all or open one that never navigates and just shows white.
  // On those, the checkout must REPLACE the current page and hand the buyer
  // back afterwards (the merchant's return_url), which is what every mobile
  // payment flow does. Desktop keeps the new tab.
  function mustRedirect() {
    var ua = navigator.userAgent || "";
    if (/MetaMask|Solflare|Phantom|Trust|CoinbaseWallet|imToken|Rainbow|Backpack/i.test(ua)) return true;
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true;
    return false;
  }

  function checkout(opts) {
    opts = opts || {};

    // Redirect mode: no tab is opened at all, so there's nothing to be blocked
    // and nothing to render white. Navigate this page once the charge exists.
    if (mustRedirect()) {
      return redirectCheckout(opts);
    }

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

    // A tab sitting on about:blank renders as a blank white page. The charge
    // still has to be created (a server round-trip, which can be seconds on a
    // cold start), so without this the payer stares at white and assumes it
    // broke. Paint something immediately, and keep this tab as the place any
    // failure is reported — never leave it blank.
    paint(
      '<div class="c-sp"></div><p>Starting secure checkout…</p>',
      "Conduit Checkout"
    );

    function paint(bodyHtml, title) {
      if (!win || win.closed) return;
      try {
        win.document.open();
        win.document.write(
          '<!doctype html><html><head><meta charset="utf-8">' +
            '<meta name="viewport" content="width=device-width,initial-scale=1">' +
            "<title>" + (title || "Conduit") + "</title><style>" +
            "html,body{height:100%;margin:0}" +
            "body{background:#050505;color:#e7ede3;display:flex;align-items:center;" +
            "justify-content:center;font:15px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;" +
            "text-align:center;padding:24px}" +
            ".c-sp{width:34px;height:34px;margin:0 auto 18px;border:2px solid #B2F55A;" +
            "border-top-color:transparent;border-radius:50%;animation:c-r .8s linear infinite}" +
            "@keyframes c-r{to{transform:rotate(360deg)}}" +
            ".c-err{color:#ff8f8f}" +
            "</style></head><body><div>" + bodyHtml + "</div></body></html>"
        );
        win.document.close();
      } catch (e) {
        /* cross-origin already (we navigated) — nothing to paint into */
      }
    }

    var origin = null;
    var settled = false;
    var closeTimer = null;

    function fail(err) {
      cleanup();
      // Report the failure IN the tab rather than closing it. A tab that opens
      // and vanishes (or worse, sits blank) is indistinguishable from a broken
      // integration; the payer should be able to read what went wrong.
      var msg = err && err.message ? err.message : String(err);
      paint(
        '<p class="c-err">Checkout could not start.</p>' +
          "<p>" + escapeHtml(msg) + "</p>" +
          "<p>You can close this tab and try again.</p>",
        "Conduit Checkout — error"
      );
      if (typeof opts.onError === "function") opts.onError(err);
      else throw err instanceof Error ? err : new Error(String(err));
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"]/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
      });
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

  // The mobile / wallet-in-app-browser path: replace this page with the hosted
  // checkout. No embed=1 — there is no opener to message. The checkout returns
  // the buyer to the merchant's return_url (set server-side on the charge) with
  // ?conduit_intent=si_…&conduit_status=settled once it settles.
  function redirectCheckout(opts) {
    function go(rawUrl) {
      var url = typeof rawUrl === "string" ? rawUrl : (rawUrl && rawUrl.hosted_url);
      if (!url) throw new Error("Conduit.checkout: no hosted_url to open.");
      window.location.href = url;
    }
    function onErr(err) {
      if (typeof opts.onError === "function") opts.onError(err);
      else throw err instanceof Error ? err : new Error(String(err));
    }
    if (typeof opts.createCharge === "function") {
      Promise.resolve().then(opts.createCharge).then(go).catch(onErr);
    } else if (opts.url) {
      try { go(opts.url); } catch (e) { onErr(e); }
    } else {
      onErr(new Error("Conduit.checkout: pass `createCharge` (recommended) or `url`."));
    }
    return { close: function () {} };
  }

  window.Conduit = { checkout: checkout };
})();
