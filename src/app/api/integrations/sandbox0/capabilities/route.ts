import { NextResponse } from "next/server";

import { getSandbox0IntegrationSummary } from "@/lib/sandbox0-sdk";

export async function GET() {
  return NextResponse.json({ data: getSandbox0IntegrationSummary() });
}
