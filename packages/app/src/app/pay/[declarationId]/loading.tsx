import { PageSkeleton } from "@/components/Shared/Skeleton";

// The payer surface matters most here: someone who just scanned a QR should
// see the checkout's shape immediately, not a blank page while the intent
// request resolves.
export default function Loading() {
  return <PageSkeleton rows={2} />;
}
