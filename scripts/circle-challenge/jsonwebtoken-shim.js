// Browser stand-in for jsonwebtoken, for the harness bundle only.
//
// Circle's Web SDK pulls jsonwebtoken in, which pulls jws/jwa, which require
// node's `crypto`, `stream` and `util`. Bundled for a browser that whole
// subtree fails at module-load time (`util.inherits is not a function`), before
// the SDK constructor is even reachable.
//
// Only `decode` is ever reached in the challenge path — reading the userToken's
// own claims. Signing and verification are node-side operations that a browser
// bundle has no business doing, so they throw rather than silently returning
// something wrong.
function decode(token) {
  try {
    const payload = String(token).split(".")[1];
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(decodeURIComponent(escape(atob(b64))));
  } catch {
    return null;
  }
}

module.exports = {
  decode,
  verify() {
    throw new Error("jsonwebtoken.verify is not available in the browser harness shim");
  },
  sign() {
    throw new Error("jsonwebtoken.sign is not available in the browser harness shim");
  },
};
