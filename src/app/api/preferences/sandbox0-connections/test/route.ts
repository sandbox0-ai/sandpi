import { NextResponse } from "next/server";

import {
  normalizeSandbox0ApiHost,
  requireSandbox0ApiKey,
  Sandbox0ConnectionInputError,
} from "@/lib/sandbox0-connection";

interface TestSandbox0ConnectionRequest {
  apiHost?: string;
  apiKey?: string;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as TestSandbox0ConnectionRequest;
    const apiHost = normalizeSandbox0ApiHost(body.apiHost ?? "");
    requireSandbox0ApiKey(body.apiKey ?? "");

    if ((process.env.SANDPI_DATA_MODE ?? "mock") !== "mock") {
      return NextResponse.json(
        {
          error: {
            code: "connection_probe_not_configured",
            message:
              "Live connection probes require the protected server-side probe service.",
          },
        },
        { status: 501 },
      );
    }

    return NextResponse.json({
      data: {
        apiHost,
        status: "reachable",
        latencyMs: 38,
        checkedAt: new Date().toISOString(),
        message: "Mock validation passed. No network request was performed.",
      },
      meta: {
        mode: "mock",
        networkRequestPerformed: false,
        secretReturned: false,
      },
    });
  } catch (error) {
    if (error instanceof Sandbox0ConnectionInputError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: 400 },
      );
    }
    return NextResponse.json(
      {
        error: {
          code: "invalid_request",
          message: "Could not test the Sandbox0 connection.",
        },
      },
      { status: 400 },
    );
  }
}
