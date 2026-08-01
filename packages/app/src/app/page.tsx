"use client";

import { Nav, MobileNav } from "@/components/Shared/Nav";
import { SendDemo } from "@/components/Landing/SendDemo";
import {
  Hero,
  Features,
  HowItWorks,
  WaitlistSection,
  EcosystemBadge,
  Footer,
} from "@/components/Landing/LandingSections";

// The landing page is its own page: it explains the product and shows a
// scripted demo of paying. It does NOT embed the real send form — that lives
// at /send, one click away via the hero's "Send money" button. Mixing a live
// wallet form into a marketing page made the two read as one confused thing.
export default function LandingPage() {
  return (
    <div className="min-h-screen">
      <Nav />

      <Hero />

      {/* Show, don't tell: the fields type themselves so a first-time
          visitor understands the flow before connecting anything. */}
      <section className="px-4 pb-20">
        <SendDemo />
      </section>

      <Features />
      <HowItWorks />
      <WaitlistSection />
      <EcosystemBadge />
      <Footer />

      <MobileNav />
    </div>
  );
}
