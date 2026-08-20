import bundleAnalyzer from "@next/bundle-analyzer";

const withBundleAnalyzer = bundleAnalyzer({ enabled: process.env.ANALYZE === "true" });

// What this origin holds, and therefore what these headers are protecting.
//
// The Circle session lives in localStorage: a user token and an encryption key
// (see lib/circle/browser.ts, which reasons about that choice honestly). Any
// script that runs on this origin can read both. So the value of a strict
// policy here is not theoretical -- it is the difference between an injected
// script being noisy and it being able to lift a signing session.
//
// Two headers, deliberately:
//
//   - an ENFORCED policy containing only frame-ancestors, which is safe to turn
//     on today. Nothing legitimately frames this app: the hosted checkout opens
//     a new tab specifically because a cross-origin iframe breaks wallet
//     extensions and third-party storage (see public/conduit.js). Blocking
//     framing outright costs nothing and removes clickjacking from a payment
//     page, where the click being hijacked authorises a transfer.
//
//   - a REPORT-ONLY policy carrying the real rules. Enforcing script-src and
//     connect-src on a page that talks to Arc, Circle, Solana RPCs, WalletConnect
//     relays and whatever endpoint a given wallet extension uses is exactly the
//     kind of change that looks fine and then silently breaks one wallet on one
//     chain. Report-only collects the violations first. Shipping a policy that
//     blocks a real payment would be worse than the exposure it closes.
//
// Promoting the report-only policy to enforced is the follow-up, once its
// reports are quiet. It is written strictly here so those reports are useful.
const CONNECT_SRC = [
  "'self'",
  "https://*.circle.com", // Circle Wallets, Gateway, StableFX
  "https://*.arc.network", // Arc RPC
  "https://*.solana.com", // Solana RPC
  "https://*.walletconnect.com",
  "https://*.walletconnect.org",
  "wss://*.walletconnect.com",
  "wss://*.walletconnect.org",
  "wss://*.solana.com",
].join(" ");

const REPORT_ONLY_CSP = [
  "default-src 'self'",
  // 'unsafe-inline'/'unsafe-eval' are what Next's runtime needs without a
  // nonce pipeline. They weaken this considerably against injected inline
  // script -- noted rather than hidden. Even so it still stops a remote script
  // being pulled in from an attacker's host, which is the common shape.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  `connect-src ${CONNECT_SRC}`,
  // Circle's authentication iframe.
  "frame-src 'self' https://*.circle.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@conduit/sdk"],

  // The share card's fonts and wordmark, kept in the serverless bundle.
  //
  // opengraph-image.tsx reads these three files at request time. Webpack does
  // not know that -- an fs.readFile path is just a string to it -- so without
  // this they are simply absent from the deployed function, satori gets no
  // fonts, and it treats that as fatal rather than falling back: every payment
  // link's card 500s in production while building and running fine locally,
  // because locally the repo is right there on disk.
  //
  // Two things here are easy to get wrong, and both fail SILENTLY -- a
  // non-matching glob is not an error, it just includes nothing, and the damage
  // only shows up as a 500 from the deployed card:
  //
  //   - the key is a glob, so "/pay/[declarationId]/opengraph-image" does not
  //     match. Those brackets are a character class standing for ONE character,
  //     not a literal path segment.
  //   - the values are resolved from the traced ROOT, which in this workspace is
  //     the monorepo, not this directory -- hence the packages/app prefix. Both
  //     prefixes are listed on purpose: pinning outputFileTracingRoot to make
  //     that base deterministic made the globs match NEITHER, so it is not
  //     something to reason about from the docs. A glob that matches nothing
  //     costs nothing, and one of these two is always right.
  //
  // Verify after changing -- this must print 3, not 0:
  //   node -e 'console.log(require("./.next/server/app/pay/[declarationId]/opengraph-image/route.js.nft.json").files.filter(x=>/woff|wordmark/.test(x)).length)'
  outputFileTracingIncludes: {
    "/pay/**": [
      "./packages/app/src/app/pay/**/*.woff",
      "./packages/app/src/app/pay/**/conduit-wordmark.png",
      "./src/app/pay/**/*.woff",
      "./src/app/pay/**/conduit-wordmark.png",
    ],
  },

  // Barrel-file imports (`import { X } from "pkg"`) pull a package's whole
  // index into the module graph before tree-shaking can trim it, costing
  // both bundle size and compile time. This rewrites them to direct
  // per-module imports for the heaviest packages in this app.
  experimental: {
    optimizePackageImports: [
      "@web3icons/react",
      "framer-motion",
      "country-flag-icons",
      "wagmi",
      "viem",
    ],
  },

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "Content-Security-Policy-Report-Only", value: REPORT_ONLY_CSP },
          // For browsers that predate frame-ancestors.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Send the origin cross-site, never the path: a /pay/si_... URL in a
          // Referer header hands the intent id to every third party the page
          // touches.
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(self), microphone=(), geolocation=(), payment=()",
          },
        ],
      },
    ];
  },
};

export default withBundleAnalyzer(nextConfig);
