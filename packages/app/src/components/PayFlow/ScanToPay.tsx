"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import jsQR from "jsqr";

// Scan-to-pay: opens the camera and decodes a QR into one of two things a
// merchant might have printed:
//
//   - a /pay/[id] link (a payment link or settlement intent, with its own
//     amount policy — fixed/open/min/max) -> we navigate there, since /send's
//     blunt "any amount, any address" form can't express that policy;
//   - a bare 0x wallet address (a Storefront QR from the dashboard's
//     Storefronts page, which prints the settle_address directly, no
//     payment-link wrapper) -> there's no intent to navigate to, so this
//     hands the address back to the caller instead. On /send, that's exactly
//     "fill in the recipient field" -- storefront QRs exist FOR /send.
//
// Every consumer decides for itself: only /send uses this component today,
// via onAddress.
type ScanResult = { kind: "pay-link"; path: string } | { kind: "address"; address: string };

function resolveScan(text: string): ScanResult | null {
  // A conduit payment URL, on any host (QR from prod, staging, localhost).
  const payMatch = text.match(/\/pay\/([A-Za-z0-9_-]+)/);
  if (payMatch) return { kind: "pay-link", path: `/pay/${payMatch[1]}` };

  const trimmed = text.trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(trimmed)) return { kind: "address", address: trimmed };

  return null;
}

interface ScanToPayProps {
  // When set, a scanned bare address is handed here instead of falling
  // through to "not recognized" -- see the component doc comment above.
  onAddress?: (address: string) => void;
}

export function ScanToPay({ onAddress }: ScanToPayProps = {}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [unrecognized, setUnrecognized] = useState("");
  // A successful scan looked like a crash.
  //
  // stop() halts the render loop, which leaves the last decoded frame frozen on
  // screen while the client navigation resolves -- so the payer's experience of
  // a scan that WORKED was a camera that appeared to hang, followed by a new
  // page. The freeze is unavoidable (the loop has to stop), so it is made
  // deliberate instead: confirm the read, hold it briefly, then navigate.
  const [scanned, setScanned] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);

  const stop = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setOpen(false);
    setError("");
    setUnrecognized("");
  }, []);

  // While the scanner owns the screen, the page behind it must not scroll —
  // on mobile the overlay is fixed but the body underneath still moved under
  // the finger, dragging content past the viewfinder.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    const tick = () => {
      const video = videoRef.current;
      if (video && ctx && video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        // Every QR Conduit prints (Request payment, Storefronts, the landing
        // page) is drawn signal-green-on-near-black -- LIGHT modules on a
        // DARK background, the opposite polarity of a standard dark-on-light
        // QR. "dontInvert" only ever looks for standard polarity, so the
        // scanner could decode a stranger's QR but never one of Conduit's
        // own -- which is exactly the QR this feature exists to read.
        // "attemptBoth" costs one extra binarization pass per frame but
        // detects either polarity.
        const code = jsQR(img.data, img.width, img.height, {
          inversionAttempts: "attemptBoth",
        });
        if (code?.data) {
          const result = resolveScan(code.data);
          if (result?.kind === "pay-link") {
            stop();
            setScanned(true);
            // Long enough to read as confirmation, short enough not to feel
            // like a wait. Prefetched first so the hold is spent on the
            // navigation rather than in front of it.
            router.prefetch?.(result.path);
            setTimeout(() => router.push(result.path), 400);
            return;
          }
          if (result?.kind === "address" && onAddress) {
            stop();
            setScanned(true);
            setTimeout(() => onAddress(result.address), 400);
            return;
          }
          setUnrecognized(code.data);
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        rafRef.current = requestAnimationFrame(tick);
      } catch {
        setError(
          window.isSecureContext
            ? "Camera unavailable. Allow camera access and try again."
            : "Camera needs HTTPS (or localhost)."
        );
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 px-4 py-2 text-scale-2 font-mono
                   border border-signal text-signal hover:bg-signal hover:text-signal-ink
                   transition-colors"
      >
        {/* viewfinder glyph */}
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M1 4V1h3M10 1h3v3M13 10v3h-3M4 13H1v-3" stroke="currentColor" strokeWidth="1.5" />
          <rect x="4.5" y="4.5" width="5" height="5" fill="currentColor" />
        </svg>
        Scan to pay
      </button>

      {open && (
        // backdrop-blur, not just an opaque wash: at 95% opacity the page
        // behind still read through as ghosted text competing with the
        // viewfinder. The blur also survives themes where --bg is translucent.
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center p-6
                     bg-bg/80 backdrop-blur-xl backdrop-saturate-150"
        >
          <div className="w-full max-w-sm space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono text-ink-dim uppercase tracking-widest">
                Scan a payment QR
              </span>
              <button
                onClick={stop}
                className="text-ink-dim hover:text-ink font-mono text-sm"
              >
                ✕ Close
              </button>
            </div>

            {error ? (
              <div className="border border-danger/40 bg-surface p-4 text-sm text-danger font-mono">
                {error}
              </div>
            ) : (
              <div className="relative border border-border bg-surface aspect-square overflow-hidden">
                <video
                  ref={videoRef}
                  className="absolute inset-0 w-full h-full object-cover"
                  muted
                  playsInline
                />
                {/* corner marks */}
                <div className="absolute inset-6 pointer-events-none">
                  <div className="absolute top-0 left-0 w-6 h-6 border-t-2 border-l-2 border-signal" />
                  <div className="absolute top-0 right-0 w-6 h-6 border-t-2 border-r-2 border-signal" />
                  <div className="absolute bottom-0 left-0 w-6 h-6 border-b-2 border-l-2 border-signal" />
                  <div className="absolute bottom-0 right-0 w-6 h-6 border-b-2 border-r-2 border-signal" />
                </div>
                {/* The frozen frame, claimed. Without this the halted camera
                    reads as a failure at the exact moment the thing succeeded. */}
                {scanned && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-bg/80">
                    <div className="w-10 h-10 border-2 border-signal flex items-center justify-center">
                      <span className="text-signal text-xl leading-none">✓</span>
                    </div>
                    <p className="font-mono text-scale-2 text-signal">Code read</p>
                  </div>
                )}
              </div>
            )}

            {unrecognized && !error && (
              <p className="text-xs font-mono text-ink-dim break-all">
                Not a Conduit payment code: {unrecognized.slice(0, 80)}
              </p>
            )}
            <p className="text-xs text-ink-dim font-mono text-center">
              Point at a merchant&apos;s payment QR — you&apos;ll be taken straight to checkout.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
