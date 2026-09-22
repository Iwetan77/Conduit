import CircleCallbackClient from "./CircleCallbackClient";

// Google returns here after a full-page redirect. This route must never serve
// a stale prerender from the previous deployment: its client code consumes a
// one-shot callback hash, so old HTML and fresh chunks produce Next's generic
// client-side exception before recovery can begin.
export const dynamic = "force-dynamic";

export default function CircleCallbackPage() {
  return <CircleCallbackClient />;
}
