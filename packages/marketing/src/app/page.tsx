'use client'

import { useEffect, useRef, useState } from 'react'
import { motion, useInView, useScroll, useTransform } from 'framer-motion'
import Image from 'next/image'
import Link from 'next/link'

// ─────────────────────────────────────────────────────────────────────────────
// AMBIENT BACKGROUND
// ─────────────────────────────────────────────────────────────────────────────

function Orbs() {
  return (
    <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
      <motion.div
        className="absolute rounded-full"
        style={{
          width: 1000, height: 1000,
          top: '-30%', left: '5%',
          background: 'radial-gradient(circle, rgba(178,245,90,0.065) 0%, transparent 60%)',
        }}
        animate={{ x: [0, 90, -60, 0], y: [0, -60, 80, 0], scale: [1, 1.1, 0.93, 1] }}
        transition={{ duration: 22, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="absolute rounded-full"
        style={{
          width: 800, height: 800,
          bottom: '-10%', right: '-5%',
          background: 'radial-gradient(circle, rgba(178,245,90,0.045) 0%, transparent 60%)',
        }}
        animate={{ x: [0, -80, 50, 0], y: [0, 60, -70, 0], scale: [1, 0.9, 1.08, 1] }}
        transition={{ duration: 28, repeat: Infinity, ease: 'easeInOut', delay: 6 }}
      />
      <motion.div
        className="absolute rounded-full"
        style={{
          width: 500, height: 500,
          top: '35%', right: '15%',
          background: 'radial-gradient(circle, rgba(178,245,90,0.03) 0%, transparent 60%)',
        }}
        animate={{ x: [0, 40, -30, 0], y: [0, -40, 50, 0] }}
        transition={{ duration: 17, repeat: Infinity, ease: 'easeInOut', delay: 3 }}
      />
    </div>
  )
}

function Particles() {
  const [items, setItems] = useState<
    { id: number; x: number; startY: number; dur: number; delay: number; size: number; op: number }[]
  >([])

  useEffect(() => {
    setItems(
      Array.from({ length: 28 }, (_, i) => ({
        id: i,
        x: Math.random() * 100,
        startY: 55 + Math.random() * 45,
        dur: 14 + Math.random() * 16,
        delay: -(Math.random() * 30),
        size: 1 + Math.random() * 1.5,
        op: 0.08 + Math.random() * 0.18,
      }))
    )
  }, [])

  return (
    <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
      {items.map(p => (
        <motion.div
          key={p.id}
          className="absolute rounded-full"
          style={{
            width: p.size, height: p.size,
            left: `${p.x}%`,
            top: `${p.startY}%`,
            background: '#B2F55A',
          }}
          animate={{ y: ['0%', '-140vh'], opacity: [0, p.op, 0] }}
          transition={{ duration: p.dur, repeat: Infinity, delay: p.delay, ease: 'linear' }}
        />
      ))}
    </div>
  )
}

function Scanline() {
  return (
    <motion.div
      className="fixed left-0 right-0 pointer-events-none z-[9998]"
      style={{
        height: 1,
        background: 'linear-gradient(90deg, transparent, rgba(178,245,90,0.12) 40%, rgba(178,245,90,0.12) 60%, transparent)',
        top: 0,
      }}
      animate={{ top: ['0vh', '100vh'] }}
      transition={{ duration: 9, repeat: Infinity, ease: 'linear', repeatDelay: 5 }}
    />
  )
}

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
    <motion.header
      className="fixed top-0 left-0 right-0 z-50 transition-all duration-500"
      style={{
        borderBottom: `1px solid ${scrolled ? '#1F1F1F' : 'transparent'}`,
        background: scrolled ? 'rgba(0,0,0,0.88)' : 'transparent',
        backdropFilter: scrolled ? 'blur(16px)' : 'none',
      }}
    >
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <Link href="/" className="flex items-center group">
          <motion.div whileHover={{ scale: 1.05 }} transition={{ type: 'spring', stiffness: 400 }}>
            <Image src="/CONDUIT-MAIN.png" alt="Conduit" height={44} width={140} style={{ height: 44, width: 'auto' }} priority />
          </motion.div>
        </Link>

        <nav className="hidden md:flex items-center gap-8">
          {[
            { label: 'Docs', href: 'https://docs.conduit.xyz' },
            { label: 'Arc Ecosystem', href: 'https://arc.network' },
          ].map(({ label, href }) => (
            <a
              key={href}
              href={href}
              className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#555] hover:text-[#B2F55A] transition-colors duration-200"
            >
              {label}
            </a>
          ))}
        </nav>

        {/* Mobile: waitlist pill */}
        <a
          href="#waitlist"
          onClick={e => { e.preventDefault(); document.getElementById('waitlist-input')?.focus() }}
          className="md:hidden font-mono text-[10px] uppercase tracking-widest text-[#B2F55A] border border-[#B2F55A]/30 px-3 py-1.5 rounded"
        >
          Waitlist
        </a>
      </div>
    </motion.header>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// WAITLIST FORM
// ─────────────────────────────────────────────────────────────────────────────

// To collect emails, replace YOUR_FORM_ID with your Formspree form ID.
// Sign up free at formspree.io — create a form and paste the ID here.
const FORMSPREE_ID = 'YOUR_FORM_ID'

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
      <motion.div
        className="flex items-center gap-3 px-5 py-3 rounded-xl border border-[#B2F55A]/30 bg-[#B2F55A]/5"
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
      >
        <span className="w-2 h-2 rounded-full bg-[#B2F55A] animate-pulse" />
        <span className="font-mono text-[12px] text-[#B2F55A]">You&apos;re on the list. We&apos;ll reach out.</span>
      </motion.div>
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
        className="flex-1 px-4 py-3 rounded-xl bg-[#0A0A0A] border border-[#1F1F1F]
                   font-mono text-[12px] text-white placeholder-[#333]
                   focus:outline-none focus:border-[#B2F55A]/40 transition-colors"
      />
      <motion.button
        type="submit"
        disabled={status === 'loading'}
        className="px-5 py-3 rounded-xl font-mono font-bold text-[12px] bg-[#B2F55A] text-black
                   disabled:opacity-60 whitespace-nowrap"
        whileHover={{ scale: 1.04, boxShadow: '0 0 28px rgba(178,245,90,0.3)' }}
        whileTap={{ scale: 0.97 }}
        transition={{ type: 'spring', stiffness: 500, damping: 20 }}
      >
        {status === 'loading' ? '...' : 'Join Waitlist'}
      </motion.button>
    </form>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// HERO
// ─────────────────────────────────────────────────────────────────────────────

function StatPill({ value, label, delay }: { value: string; label: string; delay: number }) {
  const ref = useRef(null)
  const inView = useInView(ref, { once: true })
  return (
    <motion.div
      ref={ref}
      className="flex flex-col items-center gap-1.5 px-6 py-3 border-r border-[#1A1A1A] last:border-0 first:pl-0"
      initial={{ opacity: 0, y: 12 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.5, delay }}
    >
      <span className="font-display font-black text-2xl text-[#B2F55A] leading-none">{value}</span>
      <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-[#444]">{label}</span>
    </motion.div>
  )
}

const wordVariant = {
  hidden: { opacity: 0, y: 44, skewY: 3 },
  show: {
    opacity: 1, y: 0, skewY: 0,
    transition: { duration: 0.65, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] },
  },
}

function Hero() {
  const { scrollY } = useScroll()
  const y = useTransform(scrollY, [0, 600], [0, -80])
  const opacity = useTransform(scrollY, [0, 400], [1, 0])

  return (
    <section className="relative min-h-screen flex flex-col items-center justify-center text-center px-4 pt-24 pb-20 overflow-hidden">
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: 'radial-gradient(ellipse 80% 60% at 50% 40%, transparent 40%, rgba(0,0,0,0.6) 100%)',
        }}
      />

      <motion.div style={{ y, opacity }} className="flex flex-col items-center gap-0">
        {/* Eyebrow */}
        <motion.p
          className="font-mono text-[11px] text-[#B2F55A] uppercase tracking-[0.22em] mb-8"
          initial={{ opacity: 0, letterSpacing: '0.35em' }}
          animate={{ opacity: 1, letterSpacing: '0.22em' }}
          transition={{ duration: 1.2, delay: 0.1 }}
        >
          Arc-native · Agent Payment Protocol · Testnet 2026
        </motion.p>

        {/* Headline */}
        <motion.h1
          className="font-display font-black uppercase leading-[0.92] tracking-tight mb-8 overflow-hidden"
          style={{ fontSize: 'clamp(3.2rem, 9.5vw, 8.5rem)' }}
          variants={{ hidden: {}, show: { transition: { staggerChildren: 0.09, delayChildren: 0.3 } } }}
          initial="hidden"
          animate="show"
        >
          <div className="overflow-hidden">
            <motion.span variants={wordVariant} className="inline-block" style={{ color: '#B2F55A' }}>SEND.</motion.span>
            {' '}
            <motion.span variants={wordVariant} className="inline-block text-white">RECEIVE.</motion.span>
          </div>
          <div className="overflow-hidden">
            <motion.span variants={wordVariant} className="inline-block text-white">LET AGENTS</motion.span>
            {' '}
            <motion.span variants={wordVariant} className="inline-block" style={{ color: '#B2F55A' }}>PAY.</motion.span>
          </div>
        </motion.h1>

        {/* Sub */}
        <motion.p
          className="font-body text-[1rem] text-[#555] max-w-[520px] leading-[1.75] mb-10"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.9 }}
        >
          Paste an address. Share a link. Add one header.{' '}
          Conduit converts, routes, and settles — in any currency, in under a second.
        </motion.p>

        {/* Waitlist form */}
        <motion.div
          className="flex flex-col items-center gap-4 mb-16 w-full"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 1.1 }}
        >
          <WaitlistForm />
          <a
            href="https://docs.conduit.xyz"
            className="font-mono text-[11px] text-[#444] hover:text-[#B2F55A] transition-colors uppercase tracking-widest"
          >
            Read the docs →
          </a>
        </motion.div>

        {/* Stats */}
        <motion.div
          className="flex items-stretch flex-wrap justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: 1.3 }}
        >
          {[
            { value: '<1s', label: 'Settlement Time', delay: 1.4 },
            { value: '1', label: 'Instruction', delay: 1.5 },
            { value: '∞', label: 'Currencies', delay: 1.6 },
            { value: '0', label: 'Stuck Funds', delay: 1.7 },
          ].map(s => <StatPill key={s.value} {...s} />)}
        </motion.div>
      </motion.div>

      {/* Scroll indicator */}
      <motion.div
        className="absolute bottom-10 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 2 }}
      >
        <span className="font-mono text-[9px] uppercase tracking-widest text-[#333]">scroll</span>
        <motion.div
          className="w-px h-10 origin-top"
          style={{ background: 'linear-gradient(to bottom, #B2F55A, transparent)' }}
          animate={{ scaleY: [1, 0.4, 1] }}
          transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
        />
      </motion.div>
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE PANELS
// ─────────────────────────────────────────────────────────────────────────────

function PanelShell({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  return (
    <motion.div
      className="bg-black flex flex-col gap-6 p-8 group cursor-default transition-all duration-500 hover:bg-[#030303]"
      style={{ borderTop: '2px solid #B2F55A' }}
      initial={{ opacity: 0, y: 40 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.6, delay }}
      whileHover={{ boxShadow: '0 0 60px rgba(178,245,90,0.07), inset 0 0 60px rgba(178,245,90,0.02)' }}
    >
      {children}
    </motion.div>
  )
}

function PanelLabel({ children }: { children: React.ReactNode }) {
  return <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-[#444]">{children}</p>
}

function PanelTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="font-display font-bold text-[1.35rem] uppercase text-white tracking-wide leading-tight">
      {children}
    </h3>
  )
}

function PanelDesc({ children }: { children: React.ReactNode }) {
  return <p className="font-body text-[0.85rem] text-[#555] leading-[1.75]">{children}</p>
}

function SendPanel() {
  const ref = useRef(null)
  const inView = useInView(ref, { once: true, margin: '-80px' })

  return (
    <PanelShell delay={0}>
      <div className="space-y-2">
        <PanelLabel>For Senders</PanelLabel>
        <PanelTitle>Direct Send</PanelTitle>
        <PanelDesc>
          Paste any wallet address. Pick the currency they should receive. Conduit finds the best
          route and settles atomically — even if you&apos;re holding a completely different stablecoin.
        </PanelDesc>
      </div>

      <div
        ref={ref}
        className="rounded-xl border border-[#1A1A1A] bg-[#050505] p-5 space-y-2.5 font-mono text-[11px]"
      >
        <div className="flex items-center gap-2 mb-3">
          <div className="w-2 h-2 rounded-full bg-[#FF5F57]" />
          <div className="w-2 h-2 rounded-full bg-[#FEBC2E]" />
          <div className="w-2 h-2 rounded-full bg-[#28C840]" />
          <span className="text-[#333] text-[9px] ml-1">conduit.xyz</span>
        </div>
        {[
          { text: '0xABC...def  ', check: '✓', delay: 0.4 },
          { text: '10.00 USDC   ', check: '✓', delay: 1.2 },
          { text: 'Settled in 0.74s  ', check: '✓', delay: 2.0 },
        ].map(({ text, check, delay }) => (
          <motion.div
            key={text}
            className="flex items-center gap-1"
            initial={{ opacity: 0, x: -8 }}
            animate={inView ? { opacity: 1, x: 0 } : {}}
            transition={{ duration: 0.4, delay }}
          >
            <span className="text-[#666]">{text}</span>
            <motion.span
              className="text-[#B2F55A]"
              initial={{ scale: 0 }}
              animate={inView ? { scale: 1 } : {}}
              transition={{ duration: 0.25, delay: delay + 0.35, type: 'spring' }}
            >
              {check}
            </motion.span>
          </motion.div>
        ))}
      </div>
    </PanelShell>
  )
}

function ReceivePanel() {
  const qr = [1,1,1,1,1,1,1,1,0,0,0,0,0,1,1,0,1,0,1,0,1,1,0,0,1,0,0,1,1,0,1,0,1,0,1,1,0,0,0,0,0,1,1,1,1,1,1,1,1]

  return (
    <PanelShell delay={0.1}>
      <div className="space-y-2">
        <PanelLabel>For Creators &amp; Businesses</PanelLabel>
        <PanelTitle>Links &amp; QR Codes</PanelTitle>
        <PanelDesc>
          Create a payment link or print-ready QR code. Share it anywhere. Anyone pays in whatever
          stablecoin they hold — you receive exactly what you asked for.
        </PanelDesc>
      </div>

      <div className="flex gap-4 items-start">
        <div className="flex-1 rounded-xl border border-[#1A1A1A] bg-[#050505] p-4 overflow-hidden">
          <div className="h-[2px] w-8 bg-[#B2F55A] rounded-full mb-3" />
          <p className="font-display font-black text-base text-white">10.00 USDC</p>
          <p className="font-mono text-[9px] text-[#333] mt-1.5 truncate">
            app.conduit.xyz/pay/0x9f4a…
          </p>
          <p className="font-mono text-[8px] text-[#222] mt-3 uppercase tracking-widest">Digital</p>
        </div>

        <div className="flex-shrink-0 flex flex-col items-center gap-2">
          <div
            className="bg-[#B2F55A] p-2 rounded-md"
            style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 8px)', gap: '1px' }}
          >
            {qr.map((cell, i) => (
              <div key={i} style={{ width: 8, height: 8, background: cell ? '#000' : '#B2F55A' }} />
            ))}
          </div>
          <p className="font-mono text-[8px] text-[#333] uppercase tracking-widest">Physical</p>
        </div>
      </div>

      <p className="font-mono text-[9px] text-[#333]">
        Restaurant tables · Freelance invoices · Creator pages
      </p>
    </PanelShell>
  )
}

function BuildPanel() {
  const ref = useRef(null)
  const inView = useInView(ref, { once: true, margin: '-80px' })

  return (
    <PanelShell delay={0.2}>
      <div className="space-y-2">
        <PanelLabel>For Developers &amp; Agents</PanelLabel>
        <PanelTitle>Conduit Relay</PanelTitle>
        <PanelDesc>
          Add one header to your service. Any agent with the Conduit SDK discovers your payment
          requirement and fulfills it automatically — in any currency, without human input.
        </PanelDesc>
      </div>

      <div ref={ref} className="rounded-xl border border-[#1A1A1A] bg-[#030303] overflow-hidden">
        <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-[#1A1A1A]">
          <div className="w-2 h-2 rounded-full bg-[#FF5F57]" />
          <div className="w-2 h-2 rounded-full bg-[#FEBC2E]" />
          <div className="w-2 h-2 rounded-full bg-[#28C840]" />
          <span className="font-mono text-[9px] text-[#333] ml-1">conduit-sdk</span>
        </div>

        <div className="p-5 font-mono text-[11px] leading-[1.9] space-y-0">
          {[
            { delay: 0.3, content: <span key="c0" className="text-[#444]">{'// Agent discovers and pays automatically'}</span> },
            { delay: 0.6, content: <>
              <span className="text-[#B2F55A]">const </span>
              <span className="text-white">req </span>
              <span className="text-[#555]">= await </span>
              <span className="text-[#B2F55A]">conduit</span>
              <span className="text-white">.discover(endpoint)</span>
            </> },
            { delay: 0.9, content: <>
              <span className="text-[#555]">await </span>
              <span className="text-[#B2F55A]">conduit</span>
              <span className="text-white">.fulfill(req)</span>
            </> },
            { delay: 1.3, content: <span key="c3" className="text-[#B2F55A]">{'// ✓ Settled. No human involved.'}</span> },
          ].map(({ delay, content }, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, x: -6 }}
              animate={inView ? { opacity: 1, x: 0 } : {}}
              transition={{ duration: 0.35, delay }}
            >
              {content}
            </motion.div>
          ))}

          <div className="mt-4 pt-4 border-t border-[#111]">
            {[
              { delay: 1.6, content: <span key="d0" className="text-[#333]">{'// Or direct'}</span> },
              { delay: 1.8, content: <>
                <span className="text-[#555]">await </span>
                <span className="text-[#B2F55A]">conduit</span>
                <span className="text-white">.pay{'({ recipient, amount, currency })'}</span>
              </> },
            ].map(({ delay, content }, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0 }}
                animate={inView ? { opacity: 1 } : {}}
                transition={{ duration: 0.35, delay }}
              >
                {content}
              </motion.div>
            ))}
          </div>
        </div>
      </div>

      <a href="https://docs.conduit.xyz" className="font-mono text-[11px] text-[#B2F55A] hover:underline mt-auto transition-opacity group-hover:opacity-100 opacity-60">
        Read the docs →
      </a>
    </PanelShell>
  )
}

function Features() {
  return (
    <section className="relative z-10 w-full border-t border-b border-[#1F1F1F]">
      <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-[#1F1F1F]">
        <SendPanel />
        <ReceivePanel />
        <BuildPanel />
      </div>
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// HOW IT WORKS — THE PIPE
// ─────────────────────────────────────────────────────────────────────────────

function HowItWorks() {
  const ref = useRef(null)
  const inView = useInView(ref, { once: true, margin: '-100px' })
  const [active, setActive] = useState(-1)

  const nodes = ['Declaration', 'Quote', 'Route', 'Settle', 'Receipt']

  useEffect(() => {
    if (!inView) return
    setActive(0)
    const id = setInterval(() => setActive(prev => (prev + 1) % nodes.length), 1000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inView])

  return (
    <section className="relative z-10 py-32 px-4">
      <div className="max-w-4xl mx-auto">
        <motion.p
          className="font-mono text-[10px] text-[#B2F55A] uppercase tracking-[0.18em] mb-4"
          initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} viewport={{ once: true }}
        >
          The Pipe
        </motion.p>

        <motion.h2
          className="font-display font-bold text-white mb-6 leading-tight"
          style={{ fontSize: 'clamp(1.8rem, 4vw, 2.8rem)' }}
          initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }} transition={{ delay: 0.1 }}
        >
          One primitive underneath everything.
        </motion.h2>

        <motion.div
          className="font-body text-[0.95rem] text-[#444] max-w-[600px] leading-[1.8] space-y-4 mb-16"
          initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }} transition={{ delay: 0.2 }}
        >
          <p>
            Every Conduit feature — direct send, payment links, QR codes, agent relay — is an
            expression of the same underlying primitive: a payment declaration.
          </p>
          <p>
            A declaration says what the recipient wants. Conduit&apos;s routing engine figures out how to
            get there from whatever the sender holds. The conversion, the route selection, the atomic
            settlement — all happen inside the pipe.
          </p>
          <p className="text-[#333]">Built on Arc. Powered by Circle StableFX and CCTP.</p>
        </motion.div>

        <div ref={ref} className="flex items-center overflow-x-auto pb-4">
          {nodes.map((node, i) => (
            <div key={node} className="flex items-center flex-shrink-0">
              <motion.div
                className="px-5 py-2.5 border font-mono text-[10px] uppercase tracking-widest transition-all duration-500 rounded-sm"
                style={{
                  background: active === i ? 'rgba(178,245,90,0.07)' : '#0A0A0A',
                  borderColor: active === i ? '#B2F55A' : '#1A1A1A',
                  boxShadow: active === i ? '0 0 24px rgba(178,245,90,0.18)' : 'none',
                  color: active === i ? '#B2F55A' : '#444',
                }}
                initial={{ opacity: 0, y: 10 }}
                animate={inView ? { opacity: 1, y: 0 } : {}}
                transition={{ duration: 0.4, delay: i * 0.1 }}
              >
                {node}
              </motion.div>
              {i < nodes.length - 1 && (
                <motion.span
                  className="font-mono px-2 text-sm flex-shrink-0 transition-all duration-300"
                  style={{ color: active === i ? '#B2F55A' : '#222' }}
                >
                  →
                </motion.span>
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
    <section className="relative z-10 py-32 px-4 border-t border-[#1F1F1F] text-center">
      <motion.div
        className="max-w-xl mx-auto flex flex-col items-center gap-6"
        initial={{ opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.6 }}
      >
        <p className="font-mono text-[10px] text-[#B2F55A] uppercase tracking-[0.18em]">Early Access</p>
        <h2
          className="font-display font-bold text-white leading-tight"
          style={{ fontSize: 'clamp(1.8rem, 4vw, 2.6rem)' }}
        >
          Be first on Arc.
        </h2>
        <p className="font-body text-[0.9rem] text-[#444] leading-[1.75]">
          Conduit is live on Arc Testnet. Mainnet access is invite-only. Drop your email and we&apos;ll
          reach out when it&apos;s your turn.
        </p>
        <WaitlistForm />
      </motion.div>
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// ECOSYSTEM BADGE
// ─────────────────────────────────────────────────────────────────────────────

function EcosystemBadge() {
  return (
    <section className="relative z-10 py-16 px-4 border-t border-[#1F1F1F] text-center">
      <motion.div
        className="flex flex-col items-center gap-5"
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
      >
        <p className="font-mono text-[10px] text-[#333] uppercase tracking-[0.18em]">
          Built on Arc · Circle StableFX + CCTP · Chain ID 5042002
        </p>

        <div className="flex items-center gap-8">
          {['Arc', 'Circle'].map(name => (
            <div
              key={name}
              className="px-4 py-2 border border-[#1A1A1A] rounded-lg font-mono text-[10px] text-[#333] uppercase tracking-widest"
            >
              {name}
            </div>
          ))}
        </div>

        <a
          href="https://arc.network"
          className="font-mono text-[10px] text-[#B2F55A] hover:underline uppercase tracking-widest"
        >
          Learn about Arc →
        </a>
      </motion.div>
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// FOOTER
// ─────────────────────────────────────────────────────────────────────────────

function Footer() {
  return (
    <footer className="relative z-10 border-t border-[#1F1F1F] bg-black px-6 py-14">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between gap-10">
        <div>
          <span className="font-display font-black text-2xl tracking-tight select-none leading-none">
            <span style={{ color: '#B2F55A' }}>CON</span>
            <span style={{ color: '#FFFFFF' }}>DUIT</span>
          </span>
          <p className="font-mono text-[9px] text-[#333] mt-3 leading-[1.8]">
            Arc&apos;s native agent payment protocol
            <br />
            Chain ID 5042002 · Testnet 2026
          </p>
        </div>

        <div className="flex flex-col gap-2.5">
          {[
            { label: 'Docs', href: 'https://docs.conduit.xyz' },
            { label: 'X / Twitter', href: 'https://x.com/conduit' },
            { label: 'Arc', href: 'https://arc.network' },
          ].map(({ label, href }) => (
            <a
              key={href}
              href={href}
              className="font-mono text-[10px] text-[#333] hover:text-[#B2F55A] transition-colors duration-200"
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
      <div className="fixed inset-0 z-0 grid-bg pointer-events-none" />
      <Orbs />
      <Particles />
      <Scanline />

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
