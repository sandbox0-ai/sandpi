"use client";

import {
  BadgeCheck,
  Boxes,
  Check,
  Clock3,
  CreditCard,
  Database,
  KeyRound,
  UserPlus,
  UsersRound,
} from "lucide-react";
import { type ComponentType, useMemo, useState } from "react";

import {
  AppFrame,
  AppSidebar,
  SidebarBackAction,
} from "@/components/app-frame";
import { StaticSidebarAccount } from "@/components/sidebar-primitives";
import { apiFetch, type ApiEnvelope } from "@/lib/api-client";
import {
  membershipPlanCounts,
  planForAssignment,
  quotaPercent,
} from "@/lib/team";
import type {
  SandpiPlan,
  SandpiPlanId,
  SandpiUser,
  Team,
  TeamMembership,
} from "@/lib/types";

import styles from "./team-settings-page.module.css";

type TeamTab = "overview" | "members" | "plan";

interface TeamSettingsPageProps {
  team: Team;
  viewer: SandpiUser;
  memberships: TeamMembership[];
  plans: SandpiPlan[];
  environmentCount: number;
}

const tabs: Array<{
  id: TeamTab;
  label: string;
  icon: ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
}> = [
  { id: "overview", label: "Overview", icon: Boxes },
  { id: "members", label: "Members", icon: UsersRound },
  { id: "plan", label: "Billing & plans", icon: CreditCard },
];

function formatHours(minutes: number) {
  const hours = minutes / 60;
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

function formatDate(timestamp: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(timestamp));
}

function formatReset(timestamp: string) {
  return new Intl.DateTimeFormat("en", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function requireViewerMembership(
  memberships: TeamMembership[],
  viewerId: string,
) {
  const membership = memberships.find(
    (candidate) => candidate.user.id === viewerId,
  );
  if (!membership) {
    throw new Error("Team settings require an active viewer Membership.");
  }
  return membership;
}

export function TeamSettingsPage({
  team,
  viewer,
  memberships,
  plans,
  environmentCount,
}: TeamSettingsPageProps) {
  const [activeTab, setActiveTab] = useState<TeamTab>("overview");
  const [teamMemberships, setTeamMemberships] = useState(memberships);
  const [planNotice, setPlanNotice] = useState("");
  const [updatingMembershipId, setUpdatingMembershipId] = useState<
    string | null
  >(null);
  const viewerMembership = requireViewerMembership(
    teamMemberships,
    viewer.id,
  );
  const viewerPlan = planForAssignment(
    plans,
    viewerMembership.planAssignment,
  );
  const weeklyQuota = viewerMembership.planAssignment.quotas.weeklyExecution;
  const weeklyPercent = quotaPercent(weeklyQuota.used, weeklyQuota.limit);
  const activeMembers = useMemo(
    () =>
      teamMemberships.filter((membership) => membership.status === "active"),
    [teamMemberships],
  );
  const planCounts = useMemo(
    () => membershipPlanCounts(teamMemberships),
    [teamMemberships],
  );
  const canManagePlans =
    viewerMembership.role === "owner" || viewerMembership.role === "admin";

  async function updateMembershipPlan(
    membership: TeamMembership,
    planId: SandpiPlanId,
  ) {
    setUpdatingMembershipId(membership.id);
    setPlanNotice("");
    try {
      const response = await apiFetch<ApiEnvelope<TeamMembership>>(
        `/api/v1/teams/${encodeURIComponent(team.id)}/members/${encodeURIComponent(
          membership.id,
        )}/plan`,
        {
          method: "PUT",
          body: JSON.stringify({ planId }),
        },
      );
      const updatedMembership = response.data;
      setTeamMemberships((current) =>
        current.map((candidate) =>
          candidate.id === updatedMembership.id ? updatedMembership : candidate,
        ),
      );
      const plan = plans.find((candidate) => candidate.id === planId);
      setPlanNotice(
        `${membership.user.name} now uses the ${plan?.name ?? planId} Plan in ${team.name}.`,
      );
    } catch (cause) {
      setPlanNotice(
        cause instanceof Error ? cause.message : "Unable to assign the Plan.",
      );
    } finally {
      setUpdatingMembershipId(null);
    }
  }

  return (
    <AppFrame className={styles.page}>
      <a className={styles.skipLink} href="#team-settings-content">
        Skip to team settings
      </a>
      <AppSidebar
        className={styles.sidebar}
        bodyClassName={styles.sidebarBody}
        footerClassName={styles.sidebarFooter}
        label="Team settings"
        headerAction={
          <SidebarBackAction
            href={`/?team=${encodeURIComponent(team.id)}`}
            label="Back to workspace"
          />
        }
        footer={
          <StaticSidebarAccount viewer={viewer} context={team.name} />
        }
      >
        <div className={styles.teamIdentity}>
          <span style={{ backgroundColor: team.color }} aria-hidden="true">
            {team.name.slice(0, 1)}
          </span>
          <div>
            <small>Team settings</small>
            <h1>{team.name}</h1>
            <p>{viewerMembership.role}</p>
          </div>
        </div>
        <nav className={styles.navigation} aria-label="Team settings sections">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                type="button"
                key={tab.id}
                className={activeTab === tab.id ? styles.active : undefined}
                aria-current={activeTab === tab.id ? "page" : undefined}
                onClick={() => setActiveTab(tab.id)}
              >
                <Icon size={16} aria-hidden />
                {tab.label}
                {tab.id === "members" ? <span>{team.memberCount}</span> : null}
              </button>
            );
          })}
        </nav>
      </AppSidebar>

      <main className={styles.content} id="team-settings-content">
        {activeTab === "overview" ? (
          <SettingsSection
            eyebrow="Sandpi tenant"
            title="Overview"
            description="Every Environment and Session belongs to one Team. Member Plans and quotas belong to Memberships, while this Team remains their resource and billing owner."
          >
            <div className={styles.statGrid}>
              <StatCard
                label="Members"
                value={String(activeMembers.length)}
                detail="Active memberships"
              />
              <StatCard label="Environments" value={String(environmentCount)} detail="Team owned" />
              <StatCard label="Your role" value={viewerMembership.role} detail="Team access" />
            </div>
            <article className={styles.panel}>
              <div className={styles.panelHeader}>
                <div>
                  <small>Team identity</small>
                  <h3>{team.name}</h3>
                </div>
                <BadgeCheck size={19} aria-label="Active Team" />
              </div>
              <dl className={styles.definitionList}>
                <div>
                  <dt>Slug</dt>
                  <dd>{team.slug}</dd>
                </div>
                <div>
                  <dt>Created</dt>
                  <dd>{formatDate(team.createdAt)}</dd>
                </div>
                <div>
                  <dt>Ownership</dt>
                  <dd>Sandpi control plane</dd>
                </div>
              </dl>
            </article>
            <BoundaryNote icon={<Database size={17} aria-hidden="true" />}>
              Sandpi authorizes the Team before using its deployment-scoped Sandbox0 API key.
              Sandbox0 credentials never identify a Team and are never sent to a client.
            </BoundaryNote>
          </SettingsSection>
        ) : null}

        {activeTab === "members" ? (
          <SettingsSection
            eyebrow="Access"
            title="Members"
            description="Owners and admins assign a separate Free, Pro or Max Plan to each Membership. Roles control access; Plans independently control Sandpi usage."
            action={
              <button
                type="button"
                className={styles.primaryAction}
                disabled
                title="Team invitations require the future membership invitation API."
              >
                <UserPlus size={15} aria-hidden="true" />
                Invite member
              </button>
            }
          >
            {planNotice ? (
              <div className={styles.inlineNotice} role="status">
                <Check size={15} aria-hidden="true" />
                {planNotice}
              </div>
            ) : null}
            <div className={styles.memberList}>
              {teamMemberships.map((member) => (
                <article className={styles.memberRow} key={member.id}>
                  <span className={styles.memberAvatar}>{member.user.avatarInitials}</span>
                  <div className={styles.memberCopy}>
                    <strong>{member.user.name}</strong>
                    <small>{member.user.email}</small>
                  </div>
                  <span
                    className={`${styles.memberStatus} ${
                      member.status === "invited" ? styles.invited : ""
                    }`}
                  >
                    {member.status}
                  </span>
                  <span className={styles.roleBadge}>{member.role}</span>
                  <select
                    className={styles.memberPlanSelect}
                    aria-label={`Plan for ${member.user.name}`}
                    value={member.planAssignment.planId}
                    disabled={!canManagePlans || updatingMembershipId === member.id}
                    onChange={(event) =>
                      void updateMembershipPlan(
                        member,
                        event.target.value as SandpiPlanId,
                      )
                    }
                  >
                    {plans.map((plan) => (
                      <option value={plan.id} key={plan.id}>
                        {plan.name}
                      </option>
                    ))}
                  </select>
                </article>
              ))}
            </div>
          </SettingsSection>
        ) : null}

        {activeTab === "plan" ? (
          <SettingsSection
            eyebrow="Team billing"
            title="Billing & member plans"
            description="The billing account will consolidate the Plans sponsored for this Team's members; public beta remains uncharged. The Team itself never has a Free, Pro or Max Plan."
          >
            <article className={`${styles.panel} ${styles.planPanel}`}>
              <div className={styles.planHeading}>
                <div>
                  <small>Team billing account</small>
                  <h3>Consolidated member billing</h3>
                  <p>
                    Monthly billing · {team.billingAccount.status.replace("-", " ")}
                  </p>
                </div>
                <span>{activeMembers.length} active assignments</span>
              </div>
              <dl className={styles.definitionList}>
                <div>
                  <dt>Billing email</dt>
                  <dd>{team.billingAccount.billingEmail}</dd>
                </div>
                <div>
                  <dt>Billing period</dt>
                  <dd>
                    {formatDate(team.billingAccount.currentPeriodStartsAt)} –{" "}
                    {formatDate(team.billingAccount.currentPeriodEndsAt)}
                  </dd>
                </div>
                <div>
                  <dt>Entitlement owner</dt>
                  <dd>Individual Team Memberships</dd>
                </div>
              </dl>
            </article>

            <div className={styles.planMixGrid} aria-label="Active member Plans">
              {plans.map((plan) => (
                <PlanCountCard
                  key={plan.id}
                  plan={plan}
                  count={planCounts[plan.id]}
                />
              ))}
            </div>

            <article className={`${styles.panel} ${styles.planPanel}`}>
              <div className={styles.planHeading}>
                <div>
                  <small>Your Plan in {team.name}</small>
                  <h3>{viewerPlan?.name ?? viewerMembership.planAssignment.planId}</h3>
                  <p>
                    Sponsored by {team.name} · {viewerMembership.planAssignment.status}
                  </p>
                </div>
                <span>{weeklyPercent}% used</span>
              </div>
              <div className={styles.quotaTitle}>
                <strong>Weekly execution</strong>
                <span>
                  {formatHours(weeklyQuota.used)} / {formatHours(weeklyQuota.limit)} hours
                </span>
              </div>
              <div
                className={styles.progressTrack}
                role="progressbar"
                aria-label="Your weekly execution quota in this Team"
                aria-valuemin={0}
                aria-valuemax={weeklyQuota.limit}
                aria-valuenow={weeklyQuota.used}
              >
                <span style={{ width: `${weeklyPercent}%` }} />
              </div>
              <p className={styles.resetCopy}>
                <Clock3 size={14} aria-hidden="true" /> Resets {formatReset(weeklyQuota.resetsAt)}
              </p>
            </article>
            <div className={`${styles.quotaGrid} ${styles.twoColumnGrid}`}>
              <QuotaCard
                label="Your concurrent Sessions"
                used={viewerMembership.planAssignment.quotas.concurrentSessions.used}
                limit={viewerMembership.planAssignment.quotas.concurrentSessions.limit}
                suffix="running"
              />
              <QuotaCard
                label="Your attributed snapshots"
                used={viewerMembership.planAssignment.quotas.snapshotStorage.used}
                limit={viewerMembership.planAssignment.quotas.snapshotStorage.limit}
                suffix="GiB"
              />
            </div>
            <BoundaryNote icon={<KeyRound size={17} aria-hidden="true" />}>
              Each Membership has an independent Sandpi Plan and weekly quota, while the Team
              consolidates their cost. Coding-agent authentication remains Environment-scoped;
              model tokens, requests and provider-plan limits are never included.
            </BoundaryNote>
          </SettingsSection>
        ) : null}

      </main>
    </AppFrame>
  );
}

function SettingsSection({
  eyebrow,
  title,
  description,
  action,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className={styles.section} aria-labelledby={`team-${title}`}>
      <header className={styles.sectionHeader}>
        <div>
          <span>{eyebrow}</span>
          <h2 id={`team-${title}`}>{title}</h2>
          <p>{description}</p>
        </div>
        {action}
      </header>
      <div className={styles.sectionBody}>{children}</div>
    </section>
  );
}

function StatCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <article className={styles.statCard}>
      <small>{label}</small>
      <strong>{value}</strong>
      <span>{detail}</span>
    </article>
  );
}

function PlanCountCard({ plan, count }: { plan: SandpiPlan; count: number }) {
  return (
    <article className={styles.planCountCard}>
      <small>{plan.name}</small>
      <strong>{count}</strong>
      <p>{count === 1 ? "active member" : "active members"}</p>
    </article>
  );
}

function QuotaCard({
  label,
  used,
  limit,
  suffix,
}: {
  label: string;
  used: number;
  limit: number;
  suffix: string;
}) {
  return (
    <article className={styles.quotaCard}>
      <small>{label}</small>
      <strong>
        {used} <span>/ {limit}</span>
      </strong>
      <p>{suffix}</p>
    </article>
  );
}

function BoundaryNote({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className={styles.boundaryNote}>
      {icon}
      <p>{children}</p>
    </div>
  );
}
