'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import Image from 'next/image'
import Link from 'next/link'

// Local dev: docs runs on :3002 (see packages/docs' package.json script) —
// `pnpm dev` at the repo root runs marketing/docs/app together via turbo.
// Production falls back to the real subdomain.
// NOTE: literal dot form — Next.js only inlines `process.env.NEXT_PUBLIC_X`
// member expressions into browser bundles; bracket form reads as undefined.
const DOCS_URL = process.env.NEXT_PUBLIC_DOCS_URL ?? 'http://localhost:3002'
// The merchant dashboard (packages/app). Local dev: app runs on :3000.
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'

// ─────────────────────────────────────────────────────────────────────────────
// NAV
// ─────────────────────────────────────────────────────────────────────────────

function Nav() {
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const fn = () => setScrolled(window.scrollY > 30)
    window.addEventListener('scroll', fn, { passive: true })
    return () => window.removeEventListener('scroll', fn)
  }, [])

  return (
    <header
      className="fixed top-0 left-0 right-0 z-50 transition-colors duration-300"
      style={{
        borderBottom: `1px solid ${scrolled ? 'var(--border)' : 'transparent'}`,
        background: scrolled ? 'var(--bg)' : 'transparent',
      }}
    >
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <Link href="/" className="flex items-center">
          <Image src="/CONDUIT-MAIN.png" alt="Conduit" height={44} width={140} style={{ height: 44, width: 'auto' }} priority />
        </Link>

        <nav className="hidden md:flex items-center gap-8">
          {[
            { label: 'Docs', href: DOCS_URL },
            { label: 'Arc Ecosystem', href: 'https://arc.network' },
          ].map(({ label, href }) => (
            <a
              key={href}
              href={href}
              className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-dim hover:text-signal transition-colors duration-200"
            >
              {label}
            </a>
          ))}
          {/* The one action that matters: straight into the product. */}
          <a
            href={`${APP_URL}/dashboard`}
            className="font-mono text-[10px] uppercase tracking-widest font-bold bg-signal text-signal-ink px-3 py-1.5 hover:bg-signal/90 transition-colors"
          >
            Dashboard →
          </a>
        </nav>

        {/* Mobile: dashboard pill */}
        <a
          href={`${APP_URL}/dashboard`}
          className="md:hidden font-mono text-[10px] uppercase tracking-widest bg-signal text-signal-ink px-3 py-1.5"
        >
          Dashboard →
        </a>
      </div>
    </header>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// WAITLIST FORM
// ─────────────────────────────────────────────────────────────────────────────

// To collect emails, replace YOUR_FORM_ID with your Formspree form ID.
// Sign up free at formspree.io — create a form and paste the ID here.
// Replace with your Formspree form ID from formspree.io/f/{id}
const FORMSPREE_ID = 'mzdwlelo'

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

function StatPill({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5 px-6 py-3 border-r border-border last:border-0 first:pl-0">
      <span className="font-display font-black text-2xl text-signal leading-none">{value}</span>
      <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-dim">{label}</span>
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

function Hero() {
  return (
    <section className="relative min-h-screen flex flex-col items-center justify-center text-center px-4 pt-24 pb-20">
      <motion.div
        className="flex flex-col items-center gap-0"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.4 }}
      >
        {/* Eyebrow */}
        <p className="font-mono text-[11px] text-signal uppercase tracking-[0.22em] mb-8">
          Arc-native · B2B Settlement · Testnet 2026
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
          Accept any stablecoin, settle in yours. Direct payments settle on Arc in about a
          second; cross-currency payments route through Circle StableFX with real, live
          progress — never a fake spinner.
        </p>

        {/* Two doors, one product: payers send/scan, merchants run a dashboard. */}
        <div className="flex flex-wrap items-center justify-center gap-3 mb-8">
          <a
            href={APP_URL}
            className="px-6 py-3 font-mono font-bold text-[12px] uppercase tracking-widest bg-signal text-signal-ink hover:bg-signal/90 transition-colors"
          >
            Send money →
          </a>
          <a
            href={`${APP_URL}/dashboard`}
            className="px-6 py-3 font-mono text-[12px] uppercase tracking-widest border border-border text-ink-dim hover:text-ink hover:border-ink-dim transition-colors"
          >
            Merchant dashboard →
          </a>
        </div>

        {/* Waitlist form */}
        <div className="flex flex-col items-center gap-4 mb-16 w-full">
          <WaitlistForm />
          <a
            href={DOCS_URL}
            className="font-mono text-[11px] text-ink-dim hover:text-signal transition-colors uppercase tracking-widest"
          >
            Read the docs →
          </a>
        </div>

        {/* Stats */}
        <div className="flex items-stretch flex-wrap justify-center">
          {[
            { value: '<1s', label: 'Direct Settlement' },
            { value: '2', label: 'Surfaces, One Engine' },
            { value: '9', label: 'Currencies' },
            { value: '0', label: 'Stuck Funds' },
          ].map(s => <StatPill key={s.value} {...s} />)}
        </div>
      </motion.div>

      {/* Scroll indicator — static, no ambient loop */}
      <div className="absolute bottom-10 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2">
        <span className="font-mono text-[9px] uppercase tracking-widest text-ink-dim">scroll</span>
        <div className="w-px h-10" style={{ background: 'linear-gradient(to bottom, var(--signal), transparent)' }} />
      </div>
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
  return (
    <PanelShell>
      <div className="space-y-2">
        <PanelLabel>For Payers</PanelLabel>
        <PanelTitle>Send &amp; Scan to Pay</PanelTitle>
        <PanelDesc>
          Connect a wallet — or just sign in with Google and get one. Paste an address or scan a
          merchant&apos;s QR, and pay from whatever stablecoin you actually hold; Conduit routes the
          conversion so the other side receives exactly the currency they asked for.
        </PanelDesc>
      </div>

      <div className="border border-border bg-bg p-5 space-y-2.5 font-mono text-[11px]">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-2 h-2 bg-danger" />
          <div className="w-2 h-2 bg-ink-dim" />
          <div className="w-2 h-2 bg-signal" />
          <span className="text-ink-dim text-[9px] ml-1">conduit.xyz</span>
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
  const qr = [1,1,1,1,1,1,1,1,0,0,0,0,0,1,1,0,1,0,1,0,1,1,0,0,1,0,0,1,1,0,1,0,1,0,1,1,0,0,0,0,0,1,1,1,1,1,1,1,1]

  return (
    <PanelShell>
      <div className="space-y-2">
        <PanelLabel>For Merchants</PanelLabel>
        <PanelTitle>Dashboard, Links &amp; QR Codes</PanelTitle>
        <PanelDesc>
          Sign in, set your settle currency once, and issue payment links and print-ready QR codes
          with real policy — fixed or open amounts, expiry, single-use or reusable, voidable.
          Payers need no account; you receive exactly what you asked for.
        </PanelDesc>
      </div>

      <div className="flex gap-4 items-start">
        <div className="flex-1 border border-border bg-bg p-4 overflow-hidden">
          <div className="h-[2px] w-8 bg-signal mb-3" />
          <p className="font-display font-black text-base text-ink">10.00 USDC</p>
          <p className="font-mono text-[9px] text-ink-dim mt-1.5 truncate">
            app.conduit.xyz/pay/0x9f4a…
          </p>
          <p className="font-mono text-[8px] text-ink-dim mt-3 uppercase tracking-widest">Digital</p>
        </div>

        <div className="flex-shrink-0 flex flex-col items-center gap-2">
          <div
            className="bg-signal p-2"
            style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 8px)', gap: '1px' }}
          >
            {qr.map((cell, i) => (
              <div key={i} style={{ width: 8, height: 8, background: cell ? 'var(--bg)' : 'var(--signal)' }} />
            ))}
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
          Create a settlement intent in whatever currency you want to receive. Your counterparty
          pays in whatever they hold. Conduit routes the FX and settles atomically on-chain.
        </PanelDesc>
      </div>

      <div className="border border-border bg-bg overflow-hidden">
        <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-border">
          <div className="w-2 h-2 bg-danger" />
          <div className="w-2 h-2 bg-ink-dim" />
          <div className="w-2 h-2 bg-signal" />
          <span className="font-mono text-[9px] text-ink-dim ml-1">conduit-node</span>
        </div>

        <div className="p-5 font-mono text-[11px] leading-[1.9] space-y-0">
          <div className="text-ink-dim">{'// Request payment in EUR, get paid in whatever they hold'}</div>
          <div>
            <span className="text-signal">const </span>
            <span className="text-ink">intent </span>
            <span className="text-ink-dim">= await </span>
            <span className="text-signal">conduit</span>
            <span className="text-ink">.settlementIntents.create({'{'}</span>
          </div>
          <div className="text-ink-dim pl-4">{'amount: 1_000_00, settle_currency: "EUR",'}</div>
          <div className="text-ink-dim pl-4">{'accept_currencies: ["USDC", "BRLA", "GBPA"],'}</div>
          <div className="text-ink">{'})'}</div>
          <div className="text-signal">{'// -> hosted_url, qr_payload — send either one'}</div>
        </div>
      </div>

      <a href={DOCS_URL} className="font-mono text-[11px] text-signal hover:underline mt-auto">
        Read the docs →
      </a>
    </PanelShell>
  )
}

function Features() {
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

function HowItWorks() {
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
            Every Conduit feature — direct send, payment links, QR codes, the settlement API — is
            an expression of the same underlying primitive: a payment declaration.
          </p>
          <p>
            A declaration says what the recipient wants. Conduit&apos;s routing engine figures out how to
            get there from whatever the sender holds. Conversion, route selection, settlement —
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

function WaitlistSection() {
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

function EcosystemBadge() {
  return (
    <section className="relative z-10 py-16 px-4 border-t border-border text-center">
      <div className="flex flex-col items-center gap-5">
        <p className="font-mono text-[10px] text-ink-dim uppercase tracking-[0.18em]">
          Built on Arc · Circle StableFX · Chain ID 5042002
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

function Footer() {
  return (
    <footer className="relative z-10 border-t border-border bg-bg px-6 py-14">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between gap-10">
        <div>
          <span className="font-display font-black text-2xl tracking-tight select-none leading-none">
            <span className="text-signal">CON</span>
            <span className="text-ink">DUIT</span>
          </span>
          <p className="font-mono text-[9px] text-ink-dim mt-3 leading-[1.8]">
            Accept any stablecoin, settle in yours
            <br />
            Chain ID 5042002 · Testnet 2026
          </p>
        </div>

        <div className="flex flex-col gap-2.5">
          {[
            { label: 'Docs', href: DOCS_URL },
            { label: 'X / Twitter', href: 'https://x.com/conduit' },
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
// ─────────────────────────────────────────────────────────────────────────────

export default function Page() {
  return (
    <>
      {/* The grid is the only background layer — no orbs, no particles, no scanline. */}
      <div className="conduit-grid" aria-hidden="true" />

      <div className="relative z-10">
        <Nav />
        <Hero />
        <Features />
        <HowItWorks />
        <WaitlistSection />
        <EcosystemBadge />
        <Footer />
      </div>
    </>
  )
}
