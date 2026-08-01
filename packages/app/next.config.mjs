import bundleAnalyzer from "@next/bundle-analyzer";

const withBundleAnalyzer = bundleAnalyzer({ enabled: process.env.ANALYZE === "true" });

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@conduit/sdk"],

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
};

export default withBundleAnalyzer(nextConfig);
