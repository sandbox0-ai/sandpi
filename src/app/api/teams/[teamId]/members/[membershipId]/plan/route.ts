import { NextResponse } from "next/server";

import {
  mockSandpiPlans,
  mockTeamMemberships,
  mockTeams,
  mockViewer,
} from "@/lib/mock-data";
import { assignMembershipPlan } from "@/lib/team";
import type { SandpiPlanId } from "@/lib/types";

interface AssignPlanRequest {
  planId?: SandpiPlanId;
}

/**
 * Mock contract for member-level Plan assignment. The authenticated Team is the payer, but the
 * entitlement is changed only on the target Membership; this endpoint must never mutate a Plan
 * on the global User or on the Team resource itself.
 */
export async function PUT(
  request: Request,
  context: {
    params: Promise<{ teamId: string; membershipId: string }>;
  },
) {
  const { teamId, membershipId } = await context.params;
  const body = (await request.json()) as AssignPlanRequest;
  const team = mockTeams.find((candidate) => candidate.id === teamId);
  if (!team) {
    return NextResponse.json(
      { error: { code: "team_not_found", message: "Team not found." } },
      { status: 404 },
    );
  }

  const actor = mockTeamMemberships.find(
    (membership) =>
      membership.teamId === team.id &&
      membership.user.id === mockViewer.id &&
      membership.status === "active",
  );
  if (!actor || (actor.role !== "owner" && actor.role !== "admin")) {
    return NextResponse.json(
      {
        error: {
          code: "plan_assignment_forbidden",
          message: "Only a Team owner or admin can assign member Plans.",
        },
      },
      { status: 403 },
    );
  }

  const target = mockTeamMemberships.find(
    (membership) =>
      membership.id === membershipId && membership.teamId === team.id,
  );
  if (!target) {
    return NextResponse.json(
      {
        error: {
          code: "membership_not_found",
          message: "Team Membership not found.",
        },
      },
      { status: 404 },
    );
  }

  const plan = mockSandpiPlans.find((candidate) => candidate.id === body.planId);
  if (!plan) {
    return NextResponse.json(
      { error: { code: "plan_not_found", message: "Sandpi Plan not found." } },
      { status: 400 },
    );
  }

  const updated = {
    ...structuredClone(target),
    planAssignment: assignMembershipPlan(target.planAssignment, plan),
  };
  return NextResponse.json({
    data: updated,
    meta: {
      mode: "mock",
      persisted: false,
      billingTeamId: team.id,
      billingCadence: team.billingAccount.billingCadence,
    },
  });
}
