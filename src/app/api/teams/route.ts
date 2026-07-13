import { NextResponse } from "next/server";

import { mockTeams, mockViewer } from "@/lib/mock-data";

export async function GET() {
  return NextResponse.json({
    data: structuredClone(mockTeams),
    meta: {
      mode: "mock",
      viewerId: mockViewer.id,
      ownership: "sandpi",
    },
  });
}
