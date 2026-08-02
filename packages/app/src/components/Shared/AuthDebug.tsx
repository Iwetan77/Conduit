"use client";

import { useEffect, useState } from "react";
import { AUTH_LOG_EVENT, authDebugEnabled, readAuthLog, type AuthLogEntry } from "@/lib/auth-debug";

// Renders the sign-in trace on the page itself. Phones have no usable
// devtools, so a hang is otherwise unreadable — this is how we find out
// which step stopped without needing a desktop browser attached.
export function AuthDebug() {
  const [on, setOn] = useState(false);
  const [entries, setEntries] = useState<AuthLogEntry[]>([]);

  useEffect(() => {
    if (!authDebugEnabled()) return;
    setOn(true);
    const sync = () => setEntries([...readAuthLog()]);
    sync();
    window.addEventListener(AUTH_LOG_EVENT, sync);
    return () => window.removeEventListener(AUTH_LOG_EVENT, sync);
  }, []);

  if (!on) return null;

  const t0 = entries[0]?.t ?? 0;

  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-50 max-h-[45vh] overflow-y-auto
                 bg-black/95 border-t border-signal/40 p-3 font-mono text-[11px] leading-relaxed"
    >
      <p className="text-signal mb-1">auth trace — ?debug=auth</p>
      {entries.length === 0 ? (
        <p className="text-ink-dim">nothing yet — tap Sign in with Google</p>
      ) : (
        entries.map((e, i) => (
          <div key={i} className="text-ink-dim break-words">
            <span className="text-signal">+{String(e.t - t0).padStart(5, " ")}ms</span> {e.msg}
          </div>
        ))
      )}
    </div>
  );
}
