"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import jsQR from "jsqr";

// Scan-to-pay: opens the camera, decodes a QR, and routes to the payment it
// encodes. Today that means merchant /pay/[id] links (payment links and
// settlement intents). The decode step is deliberately isolated in
// resolveScan() so future code formats (P2P handles, bank-account payout
// codes) plug in without touching the camera plumbing.
function resolveScan(text: string): string | null {
  // A conduit payment URL, on any host (QR from prod, staging, localhost).
  const payMatch = text.match(/\/pay\/([A-Za-z0-9_-]+)/);
  if (payMatch) return `/pay/${payMatch[1]}`;
  return null;
}

export function ScanToPay() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [unrecognized, setUnrecognized] = useState("");
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
        const code = jsQR(img.data, img.width, img.height, {
          inversionAttempts: "dontInvert",
        });
        if (code?.data) {
          const dest = resolveScan(code.data);
          if (dest) {
            stop();
            router.push(dest);
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
        <div className="fixed inset-0 z-50 bg-bg/95 flex flex-col items-center justify-center p-6">
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
