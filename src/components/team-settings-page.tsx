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
import {
  StaticSidebarAccount,
} from "@/components/sidebar-primitives";
import { quotaPercent } from "@/lib/team";
import type { SandpiUser, Team, TeamMember } from "@/lib/types";

import styles from "./team-settings-page.module.css";

type TeamTab = "overview" | "members" | "plan";

interface TeamSettingsPageProps {
  team: Team;
  viewer: SandpiUser;
  members: TeamMember[];
  environmentCount: number;
}

const tabs: Array<{
  id: TeamTab;
  label: string;
  icon: ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
}> = [
  { id: "overview", label: "Overview", icon: Boxes },
  { id: "members", label: "Members", icon: UsersRound },
  { id: "plan", label: "Plan & usage", icon: CreditCard },
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

export function TeamSettingsPage({
  team,
  viewer,
  members,
  environmentCount,
}: TeamSettingsPageProps) {
  const [activeTab, setActiveTab] = useState<TeamTab>("overview");
  const [inviteNotice, setInviteNotice] = useState(false);
  const weeklyQuota = team.subscription.quotas.weeklyExecution;
  const weeklyPercent = quotaPercent(weeklyQuota.used, weeklyQuota.limit);
  const activeMembers = useMemo(
    () => members.filter((member) => member.status === "active"),
    [members],
  );

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
            <p>{team.currentUserRole}</p>
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
            description="Every Environment, Session, subscription and quota belongs to exactly one Team. A one-person account uses the same model."
          >
            <div className={styles.statGrid}>
              <StatCard label="Members" value={String(activeMembers.length)} detail="Active seats" />
              <StatCard label="Environments" value={String(environmentCount)} detail="Team owned" />
              <StatCard label="Your role" value={team.currentUserRole} detail="Team access" />
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
            description="Owners manage billing and Team deletion, admins manage membership and Environments, and members create and run Sessions."
            action={
              <button
                type="button"
                className={styles.primaryAction}
                onClick={() => setInviteNotice(true)}
              >
                <UserPlus size={15} aria-hidden="true" />
                Invite member
              </button>
            }
          >
            {inviteNotice ? (
              <div className={styles.inlineNotice} role="status">
                <Check size={15} aria-hidden="true" />
                Invitation delivery is mocked in this frontend preview.
              </div>
            ) : null}
            <div className={styles.memberList}>
              {members.map((member) => (
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
            eyebrow="Sandpi subscription"
            title="Plan & usage"
            description="The Team is billed monthly. Its Sandpi execution allowance resets every week and does not include coding-agent model usage."
          >
            <article className={`${styles.panel} ${styles.planPanel}`}>
              <div className={styles.planHeading}>
                <div>
                  <small>Current plan</small>
                  <h3>{team.subscription.planName}</h3>
                  <p>
                    Monthly billing · {team.subscription.status.replace("-", " ")}
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
                aria-label="Weekly execution quota"
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
            <div className={styles.quotaGrid}>
              <QuotaCard
                label="Concurrent Sessions"
                used={team.subscription.quotas.concurrentSessions.used}
                limit={team.subscription.quotas.concurrentSessions.limit}
                suffix="running"
              />
              <QuotaCard
                label="Snapshot storage"
                used={team.subscription.quotas.snapshotStorage.used}
                limit={team.subscription.quotas.snapshotStorage.limit}
                suffix="GiB"
              />
              <QuotaCard
                label="Seats"
                used={team.subscription.seats.used}
                limit={team.subscription.seats.included}
                suffix="active"
              />
            </div>
            <BoundaryNote icon={<KeyRound size={17} aria-hidden="true" />}>
              Codex and future harnesses use each member&apos;s official provider account. Model
              tokens, requests and coding-plan limits are never part of this Sandpi quota.
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
