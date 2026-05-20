import { NextRequest, NextResponse } from "next/server";

// Proxy for Circle stablecoinKits API calls.
// The browser cannot call api.circle.com directly due to CORS.
// This route forwards requests server-side with the Kit Key attached.
//
// Usage: POST /api/circle-proxy?path=v1/stablecoinKits/swap
//        GET  /api/circle-proxy?path=v1/stablecoinKits/swap/status?...

const CIRCLE_BASE = "https://api.circle.com";

function getKitKey(): string {
  const key = process.env.NEXT_PUBLIC_KIT_KEY ?? "";
  if (!key) throw new Error("NEXT_PUBLIC_KIT_KEY is not set");
  return key; // Pass full value as Bearer — Circle expects "KIT_KEY:id:secret"
}

export async function POST(req: NextRequest) {
  const path = req.nextUrl.searchParams.get("path") ?? "";
  const body = await req.text();

  const res = await fetch(`${CIRCLE_BASE}/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getKitKey()}`,
    },
    body,
  });

  const data = await res.text();
  return new NextResponse(data, {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function GET(req: NextRequest) {
  const path = req.nextUrl.searchParams.get("path") ?? "";

  const res = await fetch(`${CIRCLE_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${getKitKey()}` },
  });

  const data = await res.text();
  return new NextResponse(data, {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}
