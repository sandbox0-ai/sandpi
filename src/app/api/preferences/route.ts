import { NextResponse } from "next/server";

import { mockPreferences } from "@/lib/mock-data";
import type { SandpiPreferences } from "@/lib/types";

export const dynamic = "force-dynamic";

interface UpdatePreferencesRequest {
  general?: Partial<SandpiPreferences["general"]>;
  appearance?: Partial<SandpiPreferences["appearance"]>;
  notifications?: Partial<SandpiPreferences["notifications"]>;
  sandbox0?: { defaultConnectionId?: string };
}

export async function GET() {
  return NextResponse.json({
    data: structuredClone(mockPreferences),
    meta: { mode: "mock", secretsIncluded: false },
  });
}

export async function PUT(request: Request) {
  const body = (await request.json()) as UpdatePreferencesRequest;
  const next = structuredClone(mockPreferences);

  if (body.general?.language && ["en", "zh-CN"].includes(body.general.language)) {
    next.general.language = body.general.language;
  }
  if (body.general?.timeZone) {
    next.general.timeZone = body.general.timeZone;
  }
  if (
    body.general?.sendShortcut &&
    ["enter", "mod-enter"].includes(body.general.sendShortcut)
  ) {
    next.general.sendShortcut = body.general.sendShortcut;
  }
  if (body.appearance?.theme && ["system", "light", "dark"].includes(body.appearance.theme)) {
    next.appearance.theme = body.appearance.theme;
  }
  if (
    body.appearance?.density &&
    ["comfortable", "compact"].includes(body.appearance.density)
  ) {
    next.appearance.density = body.appearance.density;
  }
  if (typeof body.notifications?.sessionCompleted === "boolean") {
    next.notifications.sessionCompleted = body.notifications.sessionCompleted;
  }
  if (typeof body.notifications?.needsAttention === "boolean") {
    next.notifications.needsAttention = body.notifications.needsAttention;
  }

  const defaultConnectionId = body.sandbox0?.defaultConnectionId;
  if (defaultConnectionId) {
    const connectionExists = mockPreferences.sandbox0.connections.some(
      (connection) => connection.id === defaultConnectionId,
    );
    if (!connectionExists) {
      return NextResponse.json(
        {
          error: {
            code: "sandbox0_connection_not_found",
            message: "Select an available Sandbox0 connection.",
          },
        },
        { status: 400 },
      );
    }
    next.sandbox0.defaultConnectionId = defaultConnectionId;
  }

  return NextResponse.json({
    data: next,
    meta: { mode: "mock", persisted: false, secretsIncluded: false },
  });
}
