import { PageSkeleton } from "@/components/Shared/Skeleton";

// Streamed instantly by Next while this route's client bundle and data load.
export default function Loading() {
  return <PageSkeleton />;
}
