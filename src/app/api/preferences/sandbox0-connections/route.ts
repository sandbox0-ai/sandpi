import { NextResponse } from "next/server";

import {
  createSandbox0ConnectionSummary,
  Sandbox0ConnectionInputError,
} from "@/lib/sandbox0-connection";

interface CreateSandbox0ConnectionRequest {
  name?: string;
  apiHost?: string;
  apiKey?: string;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as CreateSandbox0ConnectionRequest;
    const name = body.name?.trim();
    if (!name) {
      return NextResponse.json(
        {
          error: {
            code: "connection_name_required",
            message: "Give the Sandbox0 connection a name.",
          },
        },
        { status: 400 },
      );
    }

    const connection = createSandbox0ConnectionSummary({
      id: `connection-${crypto.randomUUID().slice(0, 8)}`,
      name,
      apiHost: body.apiHost ?? "",
      apiKey: body.apiKey ?? "",
    });

    return NextResponse.json(
      {
        data: connection,
        meta: {
          mode: "mock",
          persisted: false,
          secretReturned: false,
          secretStorage: "not-implemented",
        },
      },
      { status: 201 },
    );
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
          message: "Could not read the Sandbox0 connection.",
        },
      },
      { status: 400 },
    );
  }
}
