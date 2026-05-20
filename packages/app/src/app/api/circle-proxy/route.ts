import { NextRequest, NextResponse } from "next/server";

const CIRCLE_BASE = "https://api.circle.com";

export async function POST(req: NextRequest) {
  const path = req.nextUrl.searchParams.get("path") ?? "";
  const kitKey = process.env.NEXT_PUBLIC_KIT_KEY ?? "";
  const apiKey = kitKey.startsWith("KIT_KEY:") ? kitKey.slice("KIT_KEY:".length) : kitKey;

  const body = await req.text();

  const res = await fetch(`${CIRCLE_BASE}/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
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
  const kitKey = process.env.NEXT_PUBLIC_KIT_KEY ?? "";
  const apiKey = kitKey.startsWith("KIT_KEY:") ? kitKey.slice("KIT_KEY:".length) : kitKey;

  const res = await fetch(`${CIRCLE_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  const data = await res.text();
  return new NextResponse(data, {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}
