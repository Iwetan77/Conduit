"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePathname } from "next/navigation";
import { DashboardSkeleton, PageSkeleton } from "@/components/Shared/Skeleton";

interface RouteTransitionState {
  pending: boolean;
  targetPath: string | null;
  beginNavigation: (href: string) => void;
}

const RouteTransitionContext = createContext<RouteTransitionState>({
  pending: false,
  targetPath: null,
  beginNavigation: () => {},
});

const TRANSITION_TIMEOUT_MS = 15_000;

export function RouteTransitionProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [targetPath, setTargetPath] = useState<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTransition = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
    setTargetPath(null);
  }, []);

  const showTransition = useCallback((path: string) => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setTargetPath(path);
    timeoutRef.current = setTimeout(clearTransition, TRANSITION_TIMEOUT_MS);
  }, [clearTransition]);

  const beginNavigation = useCallback((href: string) => {
    let target: URL;
    try {
      target = new URL(href, window.location.href);
    } catch {
      return;
    }

    if (target.origin !== window.location.origin) return;
    // Search-only updates keep the same page mounted and do not need a cover.
    // usePathname intentionally clears transitions, so covering one here would
    // have no pathname commit to release it.
    if (target.pathname === window.location.pathname) return;

    showTransition(target.pathname);
  }, [showTransition]);

  useEffect(() => {
    clearTransition();
  }, [pathname, clearTransition]);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      const element = event.target instanceof Element ? event.target : null;
      const anchor = element?.closest<HTMLAnchorElement>("a[href]");
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      beginNavigation(anchor.href);
    };

    const onPopState = () => {
      if (window.location.pathname !== pathname) showTransition(window.location.pathname);
    };

    // Start before Next begins its asynchronous route fetch. The cover remains
    // until usePathname confirms that React committed the destination.
    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", onPopState);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", onPopState);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [beginNavigation, pathname, showTransition]);

  const value = useMemo<RouteTransitionState>(
    () => ({ pending: targetPath !== null, targetPath, beginNavigation }),
    [beginNavigation, targetPath],
  );

  return (
    <RouteTransitionContext.Provider value={value}>
      {children}
      {targetPath && <RouteTransitionCover targetPath={targetPath} />}
    </RouteTransitionContext.Provider>
  );
}

export function useRouteTransition() {
  return useContext(RouteTransitionContext);
}

function RouteTransitionCover({ targetPath }: { targetPath: string }) {
  const dashboard = targetPath === "/dashboard" || targetPath.startsWith("/dashboard/");

  return (
    <div
      className="fixed inset-0 z-[100] overflow-hidden bg-bg text-ink"
      data-route-transition
      data-target-path={targetPath}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="sr-only">Loading page</span>
      {dashboard ? (
        <div className="min-h-screen flex">
          <aside className="hidden md:block w-60 shrink-0 border-r border-border p-4">
            <div className="space-y-5">
              <div className="h-8 w-24 bg-surface border border-border animate-pulse" />
              <div className="h-14 bg-surface border border-border animate-pulse" />
              {Array.from({ length: 8 }).map((_, index) => (
                <div key={index} className="h-8 bg-surface border border-border animate-pulse" />
              ))}
            </div>
          </aside>
          <main className="flex-1 p-4 md:p-8 max-w-6xl mx-auto w-full">
            <DashboardSkeleton />
          </main>
        </div>
      ) : (
        <PageSkeleton />
      )}
    </div>
  );
}
