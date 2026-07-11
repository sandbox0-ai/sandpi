import { NextResponse } from "next/server";

import { getMockBootstrap } from "@/lib/mock-data";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    data: getMockBootstrap(),
    meta: { mode: "mock" },
  });
}
