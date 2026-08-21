// Deliberately small: this exists to catch ONE class of bug.
//
// Twice in two days a hook was placed where a plain calculation used to sit --
// `connectors.find(...)` became `useMemo(...)` in WalletConnect, and a route
// calculation became `useRouteDecision(...)` in PaymentLinkPay -- each of them
// underneath the early returns those components use while data loads. A
// calculation does not care what returns above it. A hook does: React counts
// hooks per render and a guard that fires on the first render and not the
// second changes that count, which is fatal ("Rendered more hooks than during
// the previous render", React #310).
//
// Both shipped. `tsc --noEmit` passes on them, `next build` passes on them, and
// a server-render check passes on them, because it is a runtime rule about call
// ORDER that no type or build step can see. One of them took down every page in
// the app, because the component was in the nav.
//
// `rules-of-hooks` catches it at the exact line, instantly. That is the whole
// reason this file exists.
//
// It is not a style config on purpose. A large ruleset landing on a codebase
// this size produces hundreds of findings, which get ignored, which means the
// one rule that matters gets ignored with them. Add rules deliberately, one at
// a time, when there is a bug that justifies each.
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
// Registered but NOT enabled. The codebase carries `eslint-disable-next-line`
// comments naming rules from these plugins, and ESLint errors on a disable
// comment for a rule it does not know about -- so leaving them unregistered
// produced eight failures that were not findings at all, just unresolvable
// references. Registering them makes those comments resolve while adding no
// rules of their own.
import next from "@next/eslint-plugin-next";

export default [
  {
    ignores: [".next/**", "node_modules/**", "out/**", "public/**"],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "@next/next": next,
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      // The one that matters. Never downgrade this to a warning.
      "react-hooks/rules-of-hooks": "error",
      // Genuinely useful, but noisy on an existing codebase and its findings
      // are usually stale-closure smells rather than crashes. A warning, so it
      // informs without burying the error above.
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];
