import { NextResponse } from "next/server";

import { getMockBootstrap } from "@/lib/mock-data";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const teamId = new URL(request.url).searchParams.get("team") ?? undefined;
  return NextResponse.json({
    data: getMockBootstrap(teamId),
    meta: { mode: "mock" },
  });
}
