'use client'

import Link from 'next/link'

// Landing-page sections, moved from the former packages/marketing app when
// the three Next apps were folded into one. Only the links changed: docs and
// dashboard are in-app routes now, not cross-origin URLs.
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { QRCodeSVG } from 'qrcode.react'
import { DEFAULT_APP_URL } from '@conduit/sdk/lite'

const FORMSPREE_ID = 'mzdwlelo'

// The panels used to print "app.conduit.xyz" and "conduit.xyz" as though they
// were ours. They aren't — that placeholder is the same one that sent scanned
// QRs to a stranger's site.
//
// DEFAULT_APP_URL prefers window.location.origin, which is correct but differs
// between the server render and the client one when NEXT_PUBLIC_APP_URL isn't
// set to the deployed host. Baking that straight into a QR would hydrate a
// different image than it rendered, so the origin is adopted after mount and
// the configured URL is what SSR emits.
const CONFIGURED_APP_URL =
  process.env.NEXT_PUBLIC_APP_URL || 'https://useconduit-app.vercel.app'

function useAppUrl() {
  const [url, setUrl] = useState(CONFIGURED_APP_URL)
  useEffect(() => setUrl(DEFAULT_APP_URL), [])
  return url
}

function WaitlistForm() {
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email || status === 'loading' || status === 'done') return
    setStatus('loading')
    try {
      const res = await fetch(`https://formspree.io/f/${FORMSPREE_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email }),
      })
      setStatus(res.ok ? 'done' : 'error')
    } catch {
      setStatus('error')
    }
  }

  if (status === 'done') {
    return (
      <div className="flex items-center gap-3 px-5 py-3 border border-signal/30 bg-signal/5">
        <span className="w-2 h-2 bg-signal" />
        <span className="font-mono text-[12px] text-signal">You&apos;re on the list. We&apos;ll reach out.</span>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-2 w-full max-w-sm">
      <input
        id="waitlist-input"
        type="email"
        required
        value={email}
        onChange={e => setEmail(e.target.value)}
        placeholder="your@email.com"
        className="flex-1 px-4 py-3 bg-surface border border-border
                   font-mono text-[12px] text-ink placeholder-ink-dim
                   focus:outline-none focus:border-signal transition-colors"
      />
      <button
        type="submit"
        disabled={status === 'loading'}
        className="px-5 py-3 font-mono font-bold text-[12px] bg-signal text-signal-ink
                   disabled:opacity-60 whitespace-nowrap hover:bg-signal/90 transition-colors"
      >
        {status === 'loading' ? '...' : 'Join Waitlist'}
      </button>
    </form>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// HERO — the one signature moment on this page
// ─────────────────────────────────────────────────────────────────────────────

// Laid out by the grid below, not by its own margins. The previous version
// used `border-r ... last:border-0 first:pl-0` inside a flex-wrap row, which
// only lines up while everything sits on ONE line. On a phone the four pills
// wrapped to two rows and the rules went with them: a dangling right border
// mid-row, no border under the wrap, and `first:pl-0` indenting row two
// differently from row one. Labels are also four different lengths, so
// content-width columns came out ragged.
function StatPill({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col items-center justify-start gap-1.5 px-4 py-4 text-center">
      <span className="font-display font-black text-2xl text-signal leading-none">{value}</span>
      {/* Fixed two-line box: "Surfaces, One Engine" wraps and "Currencies"
          doesn't, which pushed the pills to different heights side by side. */}
      <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-dim leading-[1.5] min-h-[2.1em] flex items-start justify-center">
        {label}
      </span>
    </div>
  )
}

const wordVariant = {
  hidden: { opacity: 0, y: 44 },
  show: {
    opacity: 1, y: 0,
    transition: { duration: 0.65, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] },
  },
}

export function Hero() {
  return (
    // Deliberately NOT min-h-screen: the send card sits directly below and
    // paying is the primary action, so the hero must not push it a full
    // viewport down the page.
    <section className="relative flex flex-col items-center justify-center text-center px-4 pt-28 pb-12">
      <motion.div
        className="flex flex-col items-center gap-0"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.4 }}
      >
        {/* Eyebrow */}
        <p className="font-mono text-[11px] text-signal uppercase tracking-[0.22em] mb-8">
          B2B Stablecoin Settlement · Built on Arc · Testnet 2026
        </p>

        {/* Headline — the signature entrance, per-word stagger, once */}
        <motion.h1
          className="font-display font-black uppercase leading-[0.92] tracking-tight mb-8 overflow-hidden"
          style={{ fontSize: 'clamp(3.2rem, 9.5vw, 8.5rem)' }}
          variants={{ hidden: {}, show: { transition: { staggerChildren: 0.09, delayChildren: 0.15 } } }}
          initial="hidden"
          animate="show"
        >
          <div className="overflow-hidden">
            <motion.span variants={wordVariant} className="inline-block text-signal">SEND.</motion.span>
            {' '}
            <motion.span variants={wordVariant} className="inline-block text-ink">RECEIVE.</motion.span>
          </div>
          <div className="overflow-hidden">
            <motion.span variants={wordVariant} className="inline-block text-ink">SETTLE IN</motion.span>
            {' '}
            <motion.span variants={wordVariant} className="inline-block text-signal">YOURS.</motion.span>
          </div>
        </motion.h1>

        {/* Sub — honest: "atomic, sub-second" is the DIRECT path only. */}
        <p className="font-body text-[1rem] text-ink-dim max-w-[560px] leading-[1.75] mb-10">
          Settlement infrastructure for businesses. Invoice in the currency you keep your
          books in, and let customers and suppliers pay in whatever stablecoin they hold.
          Direct payments settle on Arc in about a second; cross-currency payments route
          through Circle StableFX.
        </p>

        {/* Two doors, one product: payers send/scan, merchants run a dashboard. */}
        <div className="flex flex-wrap items-center justify-center gap-3 mb-8">
          <Link
            href="/send"
            className="px-6 py-3 font-mono font-bold text-[12px] uppercase tracking-widest bg-signal text-signal-ink hover:bg-signal/90 transition-colors"
          >
            Send money →
          </Link>
          <Link
            href="/dashboard"
            className="px-6 py-3 font-mono text-[12px] uppercase tracking-widest border border-border text-ink-dim hover:text-ink hover:border-ink-dim transition-colors"
          >
            Merchant dashboard →
          </Link>
        </div>

        {/* Waitlist form */}
        <div className="flex flex-col items-center gap-4 mb-16 w-full">
          <WaitlistForm />
          <Link
            href="/docs"
            className="font-mono text-[11px] text-ink-dim hover:text-signal transition-colors uppercase tracking-widest"
          >
            Read the docs →
          </Link>
        </div>

        {/* Stats — an actual grid, so the columns are equal width and the
            dividers land on the gaps rather than being carried around by
            flex-wrap. 2×2 on phones, 1×4 from sm up. */}
        {/* Dividers only from sm up. `divide-x` on a 2-column grid puts a
            left rule on child 3 -- which is the START of row two, i.e. the
            outer edge -- so on mobile the pills stand apart on whitespace
            instead. */}
        <div className="w-full max-w-lg grid grid-cols-2 sm:grid-cols-4
                        sm:divide-x divide-border">
          {[
            { value: '<1s', label: 'Direct Settlement' },
            { value: '2', label: 'Surfaces, One Engine' },
            { value: '9', label: 'Currencies' },
            { value: '0', label: 'Stuck Funds' },
          ].map(s => <StatPill key={s.value} {...s} />)}
        </div>
      </motion.div>

</section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE PANELS — static after the hero moment, no scroll-triggered reveals
// ─────────────────────────────────────────────────────────────────────────────

function PanelShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="bg-bg flex flex-col gap-6 p-8 hover:bg-surface transition-colors duration-300"
      style={{ borderTop: '1px solid var(--signal)' }}
    >
      {children}
    </div>
  )
}

function PanelLabel({ children }: { children: React.ReactNode }) {
  return <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-dim">{children}</p>
}

function PanelTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="font-display font-bold text-[1.35rem] uppercase text-ink tracking-wide leading-tight">
      {children}
    </h3>
  )
}

function PanelDesc({ children }: { children: React.ReactNode }) {
  return <p className="font-body text-[0.85rem] text-ink-dim leading-[1.75]">{children}</p>
}

function SendPanel() {
  const appHost = useAppUrl().replace(/^https?:\/\//, '')
  return (
    <PanelShell>
      <div className="space-y-2">
        <PanelLabel>For Payers</PanelLabel>
        <PanelTitle>Send &amp; Scan to Pay</PanelTitle>
        <PanelDesc>
          Connect a wallet, or just sign in with Google and get one. Paste an address or scan a
          merchant&apos;s QR, and pay from whatever stablecoin you actually hold; Conduit routes the
          conversion so the other side receives exactly the currency they asked for.
        </PanelDesc>
      </div>

      <div className="border border-border bg-bg p-5 space-y-2.5 font-mono text-[11px]">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-2 h-2 bg-danger" />
          <div className="w-2 h-2 bg-ink-dim" />
          <div className="w-2 h-2 bg-signal" />
          <span className="text-ink-dim text-[9px] ml-1 truncate max-w-[140px]">{appHost}</span>
        </div>
        {[
          { text: '0xABC...def  ', check: '✓' },
          { text: '10.00 USDC   ', check: '✓' },
          { text: 'Settled in 0.74s  ', check: '✓' },
        ].map(({ text, check }) => (
          <div key={text} className="flex items-center gap-1">
            <span className="text-ink-dim">{text}</span>
            <span className="text-signal">{check}</span>
          </div>
        ))}
      </div>
    </PanelShell>
  )
}

function ReceivePanel() {
  const appUrl = useAppUrl()
  const appHost = appUrl.replace(/^https?:\/\//, '')

  return (
    <PanelShell>
      <div className="space-y-2">
        <PanelLabel>For Merchants</PanelLabel>
        <PanelTitle>Dashboard, Links &amp; QR Codes</PanelTitle>
        <PanelDesc>
          Sign in, set your settle currency once, and issue payment links and print-ready QR codes
          with real policy: fixed or open amounts, expiry, single-use or reusable, voidable.
          Payers need no account; you receive exactly what you asked for.
        </PanelDesc>
      </div>

      <div className="flex gap-4 items-stretch">
        <div className="flex-1 min-w-0 border border-border bg-bg p-4 flex flex-col">
          <div className="h-[2px] w-8 bg-signal mb-3" />
          <p className="font-display font-black text-base text-ink">10.00 USDC</p>
          <p className="font-mono text-[9px] text-ink-dim mt-1.5 truncate">
            {appHost}/pay/pl_9f4a…
          </p>
          <p className="font-mono text-[8px] text-ink-dim mt-auto pt-3 uppercase tracking-widest">
            Digital
          </p>
        </div>

        {/* A real, scannable QR that points back to our own landing page. The
            panel used to draw a hand-written 7x7 bitmap that wasn't a QR code
            at all -- no finder patterns, no quiet zone, nothing to decode --
            so on the page advertising "print-ready QR codes" it read as
            noise. */}
        <div className="flex-shrink-0 flex flex-col items-center gap-2">
          {/* Conduit colours — signal green on the near-black bg, the same
              palette every merchant QR uses. Literal hex, not CSS vars:
              qrcode.react writes them into SVG attributes that can't resolve
              custom properties. level H so the green-on-dark still scans. */}
          <div style={{ background: "#050505", padding: 8, border: "1px solid var(--border)" }}>
            <QRCodeSVG
              value={appUrl}
              size={72}
              level="H"
              bgColor="#050505"
              fgColor="#B2F55A"
            />
          </div>
          <p className="font-mono text-[8px] text-ink-dim uppercase tracking-widest">Physical</p>
        </div>
      </div>

      <p className="font-mono text-[9px] text-ink-dim">
        Restaurant tables · Freelance invoices · Creator pages
      </p>
    </PanelShell>
  )
}

function BuildPanel() {
  return (
    <PanelShell>
      <div className="space-y-2">
        <PanelLabel>For Developers</PanelLabel>
        <PanelTitle>Conduit API</PanelTitle>
        <PanelDesc>
          Create a settlement intent in the currency you want to receive. Your counterparty pays
          in whatever they hold, and Conduit routes the FX. You get back a hosted checkout URL
          and a QR payload, so send whichever suits.
        </PanelDesc>
      </div>

      <div className="border border-border bg-bg overflow-hidden">
        <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-border">
          <div className="w-2 h-2 bg-danger" />
          <div className="w-2 h-2 bg-ink-dim" />
          <div className="w-2 h-2 bg-signal" />
          <span className="font-mono text-[9px] text-ink-dim ml-1">POST /v1/settlement_intents</span>
        </div>

        {/* The real endpoint, with the real request and response fields.
            An earlier version of this panel showed a `conduit.settlementIntents
            .create()` SDK call that does not exist in @conduit/sdk. */}
        <div className="p-5 font-mono text-[11px] leading-[1.9] space-y-0 overflow-x-auto">
          <div className="text-ink-dim">{'# Request payment in EUR, accept what they hold'}</div>
          <div>
            <span className="text-signal">curl</span>
            <span className="text-ink"> -X POST $API/v1/settlement_intents \\</span>
          </div>
          <div className="text-ink-dim pl-4">{'-H "Authorization: Bearer $SK_KEY" \\'}</div>
          <div className="text-ink-dim pl-4">{'-d \'{"amount":"100000",'}</div>
          <div className="text-ink-dim pl-8">{'"settle_currency":"EUR",'}</div>
          <div className="text-ink-dim pl-8">{'"accept_currencies":["USDC","BRLA","GBPA"]}\''}</div>
          <div className="text-signal pt-1">{'# -> { "id": "si_...", "hosted_url": ..., "qr_payload": ... }'}</div>
        </div>
      </div>

      <Link href="/docs" className="font-mono text-[11px] text-signal hover:underline mt-auto">
        Read the docs →
      </Link>
    </PanelShell>
  )
}

export function Features() {
  return (
    <section className="relative z-10 w-full border-t border-b border-border">
      <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-border">
        <SendPanel />
        <ReceivePanel />
        <BuildPanel />
      </div>
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// HOW IT WORKS — THE PIPE (static, no looping highlight cycle)
// ─────────────────────────────────────────────────────────────────────────────

export function HowItWorks() {
  const nodes = ['Declaration', 'Quote', 'Route', 'Settle', 'Receipt']

  return (
    <section className="relative z-10 py-32 px-4">
      <div className="max-w-4xl mx-auto">
        <p className="font-mono text-[10px] text-signal uppercase tracking-[0.18em] mb-4">
          The Pipe
        </p>

        <h2
          className="font-display font-bold text-ink mb-6 leading-tight"
          style={{ fontSize: 'clamp(1.8rem, 4vw, 2.8rem)' }}
        >
          One primitive underneath everything.
        </h2>

        <div className="font-body text-[0.95rem] text-ink-dim max-w-[600px] leading-[1.8] space-y-4 mb-16">
          <p>
            Every Conduit feature, from direct send to payment links, QR codes and the settlement API, is
            an expression of the same underlying primitive: a payment declaration.
          </p>
          <p>
            A declaration says what the recipient wants. Conduit&apos;s routing engine figures out how to
            get there from whatever the sender holds. Conversion, route selection and settlement
            all happen inside the pipe, with real progress shown at every step.
          </p>
          <p className="text-ink-dim">
            Built on Arc. FX by Circle StableFX. Cross-chain USDC funding by Circle Gateway.
          </p>
        </div>

        <div className="flex items-center overflow-x-auto pb-4">
          {nodes.map((node, i) => (
            <div key={node} className="flex items-center flex-shrink-0">
              <div className="px-5 py-2.5 border border-border bg-surface font-mono text-[10px] uppercase tracking-widest text-ink-dim">
                {node}
              </div>
              {i < nodes.length - 1 && (
                <span className="font-mono px-2 text-sm flex-shrink-0 text-ink-dim">→</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// WAITLIST SECTION (second CTA before footer)
// ─────────────────────────────────────────────────────────────────────────────

export function WaitlistSection() {
  return (
    <section className="relative z-10 py-32 px-4 border-t border-border text-center">
      <div className="max-w-xl mx-auto flex flex-col items-center gap-6">
        <p className="font-mono text-[10px] text-signal uppercase tracking-[0.18em]">Early Access</p>
        <h2
          className="font-display font-bold text-ink leading-tight"
          style={{ fontSize: 'clamp(1.8rem, 4vw, 2.6rem)' }}
        >
          Be first on Arc.
        </h2>
        <p className="font-body text-[0.9rem] text-ink-dim leading-[1.75]">
          Conduit is live on Arc Testnet. Mainnet access is invite-only. Drop your email and we&apos;ll
          reach out when it&apos;s your turn.
        </p>
        <WaitlistForm />
      </div>
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// ECOSYSTEM BADGE
// ─────────────────────────────────────────────────────────────────────────────

export function EcosystemBadge() {
  return (
    <section className="relative z-10 py-16 px-4 border-t border-border text-center">
      <div className="flex flex-col items-center gap-5">
        <p className="font-mono text-[10px] text-ink-dim uppercase tracking-[0.18em]">
          Built on Arc · FX by Circle StableFX
        </p>

        <div className="flex items-center gap-8">
          {['Arc', 'Circle'].map(name => (
            <div
              key={name}
              className="px-4 py-2 border border-border font-mono text-[10px] text-ink-dim uppercase tracking-widest"
            >
              {name}
            </div>
          ))}
        </div>

        <a
          href="https://arc.network"
          className="font-mono text-[10px] text-signal hover:underline uppercase tracking-widest"
        >
          Learn about Arc →
        </a>
      </div>
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// FOOTER
// ─────────────────────────────────────────────────────────────────────────────

export function Footer() {
  return (
    <footer className="relative z-10 border-t border-border bg-bg px-6 py-14">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between gap-10">
        <div>
          <span className="font-display font-black text-2xl tracking-tight select-none leading-none">
            <span className="text-signal">CON</span>
            <span className="text-ink">DUIT</span>
          </span>
          <p className="font-mono text-[9px] text-ink-dim mt-3 leading-[1.8]">
            B2B stablecoin settlement
            <br />
            Arc Testnet · 2026
          </p>
        </div>

        <div className="flex flex-col gap-2.5">
          {[
            { label: 'Docs', href: '/docs' },
            { label: 'X / Twitter', href: 'https://x.com/conduitonarc' },
            { label: 'Arc', href: 'https://arc.network' },
          ].map(({ label, href }) => (
            <a
              key={href}
              href={href}
              className="font-mono text-[10px] text-ink-dim hover:text-signal transition-colors duration-200"
            >
              {label} → {href.replace('https://', '')}
            </a>
          ))}
        </div>
      </div>
    </footer>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE
