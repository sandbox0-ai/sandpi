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
import type { OperationLanguage } from "@/lib/operation-ui";
import { formatUnixTimestamp, type UnixTimestamp } from "@/lib/time";
import {
  planForTeam,
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
  language: OperationLanguage;
  timeZone: string;
}

const tabs: Array<{
  id: TeamTab;
  label: string;
  icon: ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
}> = [
  { id: "overview", label: "Overview", icon: Boxes },
  { id: "members", label: "Members", icon: UsersRound },
  { id: "plan", label: "Billing & plan", icon: CreditCard },
];

function formatHours(minutes: number) {
  const hours = minutes / 60;
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

function formatDate(
  timestamp: UnixTimestamp,
  language: OperationLanguage,
  timeZone: string,
) {
  return formatUnixTimestamp(timestamp, language, timeZone, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatReset(
  timestamp: UnixTimestamp,
  language: OperationLanguage,
  timeZone: string,
) {
  return formatUnixTimestamp(timestamp, language, timeZone, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
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
  language,
  timeZone,
}: TeamSettingsPageProps) {
  const [activeTab, setActiveTab] = useState<TeamTab>("overview");
  const [teamState, setTeamState] = useState(team);
  const teamMemberships = memberships;
  const [planNotice, setPlanNotice] = useState("");
  const [updatingPlan, setUpdatingPlan] = useState(false);
  const viewerMembership = requireViewerMembership(
    teamMemberships,
    viewer.id,
  );
  const viewerPlan = planForTeam(plans, teamState);
  const weeklyQuota = teamState.plan.quotas.weeklyExecution;
  const weeklyPercent = quotaPercent(weeklyQuota.used, weeklyQuota.limit);
  const activeMembers = useMemo(
    () =>
      teamMemberships.filter((membership) => membership.status === "active"),
    [teamMemberships],
  );
  const canManagePlans =
    viewerMembership.role === "owner" || viewerMembership.role === "admin";

  async function updateTeamPlan(planId: SandpiPlanId) {
    setUpdatingPlan(true);
    setPlanNotice("");
    try {
      const response = await apiFetch<ApiEnvelope<Team>>(
        `/api/v1/teams/${encodeURIComponent(teamState.id)}/plan`,
        {
          method: "PUT",
          body: JSON.stringify({ planId }),
        },
      );
      setTeamState(response.data);
      const plan = plans.find((candidate) => candidate.id === planId);
      setPlanNotice(
        `${teamState.name} now uses the ${plan?.name ?? planId} Plan.`,
      );
    } catch (cause) {
      setPlanNotice(
        cause instanceof Error ? cause.message : "Unable to assign the Plan.",
      );
    } finally {
      setUpdatingPlan(false);
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
            description="Every shared Environment, Session, Plan and quota belongs to this Team. Private Environments remain visible only to their creator."
          >
            <div className={styles.statGrid}>
              <StatCard
                label="Members"
                value={String(activeMembers.length)}
                detail="Active memberships"
              />
              <StatCard
                label="Environments"
                value={String(environmentCount)}
                detail="Visible in this Team"
              />
              <StatCard
                label="Your role"
                value={viewerMembership.role}
                detail="Team access"
              />
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
                  <dd>{formatDate(team.createdAt, language, timeZone)}</dd>
                </div>
                <div>
                  <dt>Ownership</dt>
                  <dd>Sandpi control plane</dd>
                </div>
              </dl>
            </article>
            <BoundaryNote icon={<Database size={17} aria-hidden="true" />}>
              Sandpi authorizes the Team before using its deployment-scoped Sandbox0
              API key. Sandbox0 credentials never identify a Team and are never sent
              to a client.
            </BoundaryNote>
          </SettingsSection>
        ) : null}

        {activeTab === "members" ? (
          <SettingsSection
            eyebrow="Access"
            title="Members"
            description="Memberships grant access to Team Environments. The Team has one shared Plan and quota pool for all active members."
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
                </article>
              ))}
            </div>
          </SettingsSection>
        ) : null}

        {activeTab === "plan" ? (
          <SettingsSection
            eyebrow="Team billing"
            title="Billing & plan"
            description="The Team has one Plan and one shared quota pool. Every active member consumes from the same limits."
          >
            {planNotice ? (
              <div className={styles.inlineNotice} role="status">
                <Check size={15} aria-hidden="true" />
                {planNotice}
              </div>
            ) : null}
            <article className={`${styles.panel} ${styles.planPanel}`}>
              <div className={styles.planHeading}>
                <div>
                  <small>Team billing account</small>
                  <h3>{teamState.name} billing</h3>
                  <p>
                    Monthly billing · {team.billingAccount.status.replace("-", " ")}
                  </p>
                </div>
                <span>{activeMembers.length} active members</span>
              </div>
              <dl className={styles.definitionList}>
                <div>
                  <dt>Billing email</dt>
                  <dd>{team.billingAccount.billingEmail}</dd>
                </div>
                <div>
                  <dt>Billing period</dt>
                  <dd>
                    {formatDate(
                      team.billingAccount.currentPeriodStartsAt,
                      language,
                      timeZone,
                    )} –{" "}
                    {formatDate(
                      team.billingAccount.currentPeriodEndsAt,
                      language,
                      timeZone,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Entitlement owner</dt>
                  <dd>{teamState.name}</dd>
                </div>
              </dl>
            </article>

            <article className={`${styles.panel} ${styles.planPanel}`}>
              <div className={styles.planHeading}>
                <div>
                  <small>Team Plan</small>
                  <h3>{viewerPlan?.name ?? teamState.plan.planId}</h3>
                  <p>
                    Shared by every member · {teamState.plan.status}
                  </p>
                </div>
                {canManagePlans ? (
                  <select
                    className={styles.teamPlanSelect}
                    aria-label={`Plan for ${teamState.name}`}
                    value={teamState.plan.planId}
                    disabled={updatingPlan}
                    onChange={(event) =>
                      void updateTeamPlan(event.target.value as SandpiPlanId)
                    }
                  >
                    {plans.map((plan) => (
                      <option value={plan.id} key={plan.id}>
                        {plan.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span>{weeklyPercent}% used</span>
                )}
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
                aria-label="Team weekly execution quota"
                aria-valuemin={0}
                aria-valuemax={weeklyQuota.limit}
                aria-valuenow={weeklyQuota.used}
              >
                <span style={{ width: `${weeklyPercent}%` }} />
              </div>
              <p className={styles.resetCopy}>
                <Clock3 size={14} aria-hidden="true" /> Resets{" "}
                {formatReset(weeklyQuota.resetsAt, language, timeZone)}
              </p>
            </article>
            <div className={`${styles.quotaGrid} ${styles.twoColumnGrid}`}>
              <QuotaCard
                label="Team concurrent Sessions"
                used={teamState.plan.quotas.concurrentSessions.used}
                limit={teamState.plan.quotas.concurrentSessions.limit}
                suffix="running"
              />
              <QuotaCard
                label="Team snapshot storage"
                used={teamState.plan.quotas.snapshotStorage.used}
                limit={teamState.plan.quotas.snapshotStorage.limit}
                suffix="GiB"
              />
            </div>
            <BoundaryNote icon={<KeyRound size={17} aria-hidden="true" />}>
              Sandpi runtime, storage and Session usage is attributed to this Team
              Plan. Coding-agent authentication remains Environment-scoped; model
              tokens, requests and provider-plan limits are never included.
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
