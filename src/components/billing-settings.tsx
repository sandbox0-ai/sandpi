"use client";

import {
  ArrowUpRight,
  Check,
  CreditCard,
  Gauge,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch, type ApiEnvelope } from "@/lib/api-client";
import type {
  SandpiAccountPlan,
  SandpiBillingSummary,
  SandpiCheckoutResult,
} from "@/lib/billing";
import { createId } from "@/lib/id";
import { formatUnixTimestamp } from "@/lib/time";
import type { SandpiPreferences } from "@/lib/types";

import styles from "./billing-settings.module.css";

interface BillingSettingsProps {
  language: SandpiPreferences["general"]["language"];
  timeZone: string;
}

export function BillingSettings({
  language,
  timeZone,
}: BillingSettingsProps) {
  const [summary, setSummary] = useState<SandpiBillingSummary>();
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState("");
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const checkoutKeys = useRef<Partial<Record<"plus" | "pro", string>>>({});
  const isZh = language === "zh-CN";
  const text = useCallback(
    (english: string, chinese: string) => (isZh ? chinese : english),
    [isZh],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void apiFetch<ApiEnvelope<SandpiBillingSummary>>(
      "/api/v1/billing/summary",
      { signal: controller.signal },
    )
      .then((response) => {
        if (!controller.signal.aborted) setSummary(response.data);
      })
      .catch((loadError) => {
        if (!controller.signal.aborted) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : text(
                  "Billing details could not be loaded.",
                  "无法加载订阅与用量信息。",
                ),
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reload, text]);

  async function selectPlan(planId: "plus" | "pro") {
    if (busyAction) return;
    setBusyAction(planId);
    setError("");
    checkoutKeys.current[planId] ??= createId("billing", 32);
    try {
      const response = await apiFetch<ApiEnvelope<SandpiCheckoutResult>>(
        "/api/v1/billing/checkout",
        {
          method: "POST",
          body: JSON.stringify({
            planId,
            idempotencyKey: checkoutKeys.current[planId],
          }),
        },
      );
      checkoutKeys.current[planId] = undefined;
      if (response.data.kind === "checkout" && response.data.url) {
        window.location.assign(response.data.url);
        return;
      }
      setReload((current) => current + 1);
    } catch (actionError) {
      setError(
        actionError instanceof Error
          ? actionError.message
          : text(
              "The subscription could not be changed.",
              "无法更改订阅。",
            ),
      );
    } finally {
      setBusyAction("");
    }
  }

  async function openPortal() {
    if (busyAction) return;
    setBusyAction("portal");
    setError("");
    try {
      const response = await apiFetch<ApiEnvelope<{ url: string }>>(
        "/api/v1/billing/portal",
        { method: "POST" },
      );
      window.location.assign(response.data.url);
    } catch (actionError) {
      setError(
        actionError instanceof Error
          ? actionError.message
          : text(
              "The billing portal could not be opened.",
              "无法打开账单管理页面。",
            ),
      );
      setBusyAction("");
    }
  }

  if (loading && !summary) {
    return (
      <div className={styles.loading} aria-live="polite">
        <LoaderCircle size={18} aria-hidden="true" />
        {text("Loading subscription and usage…", "正在加载订阅与用量…")}
      </div>
    );
  }

  if (!summary) {
    return (
      <div className={styles.errorCard} role="alert">
        <TriangleAlert size={17} aria-hidden="true" />
        <div>
          <strong>{text("Billing unavailable", "订阅信息不可用")}</strong>
          <p>{error}</p>
          <button
            type="button"
            onClick={() => setReload((current) => current + 1)}
          >
            <RefreshCw size={13} aria-hidden="true" />
            {text("Try again", "重试")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <section className={styles.overview}>
        <div className={styles.planIdentity}>
          <span>
            <CreditCard size={14} aria-hidden="true" />
            {text("Current plan", "当前套餐")}
          </span>
          <strong>{summary.plan.name}</strong>
          <small>
            {summary.plan.monthlyPriceUsd == null
              ? text(
                  "Managed by this deployment",
                  "由当前部署自行管理",
                )
              : summary.plan.monthlyPriceUsd === 0
                ? text("No monthly charge", "无月费")
                : `$${summary.plan.monthlyPriceUsd} USD / ${text("month", "月")}`}
          </small>
        </div>
        <div className={styles.usage}>
          <div className={styles.usageHeading}>
            <span>
              <Gauge size={14} aria-hidden="true" />
              {text("Sandbox runtime", "Sandbox 运行额度")}
            </span>
            <strong>
              {formatGiBHours(summary.usage.usedGiBHours)}
              {summary.usage.limitGiBHours == null
                ? ` ${text("GiB-hours used", "GiB 小时已用")}`
                : ` / ${formatGiBHours(summary.usage.limitGiBHours)} ${text("GiB-hours", "GiB 小时")}`}
            </strong>
          </div>
          {summary.usage.percentUsed != null ? (
            <div
              className={styles.progress}
              role="progressbar"
              aria-label={text(
                "Sandbox runtime usage",
                "Sandbox 运行用量",
              )}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(summary.usage.percentUsed)}
            >
              <span
                className={
                  summary.usage.exhausted ? styles.exhausted : undefined
                }
                style={{ width: `${summary.usage.percentUsed}%` }}
              />
            </div>
          ) : (
            <div className={styles.unlimitedLine} />
          )}
          <small>
            {summary.usage.limitGiBHours == null
              ? text(
                  "This deployment does not enforce a runtime allowance.",
                  "当前部署不限制运行额度。",
                )
              : text("Resets ", "重置时间：")}
            {summary.usage.limitGiBHours == null
              ? null
              : formatUnixTimestamp(
                  summary.usage.periodEndsAt,
                  language,
                  timeZone,
                  { dateStyle: "medium", timeStyle: "short" },
                )}
          </small>
        </div>
      </section>

      <div className={styles.entitlements}>
        <Entitlement
          label={text("Environments", "Environment 数量")}
          value={`${summary.environmentCount} / ${
            summary.plan.environmentLimit ??
            text("Unlimited", "不限")
          }`}
          warning={summary.overEnvironmentLimit}
        />
        <Entitlement
          label={text("Sandbox memory", "Sandbox 内存")}
          value={
            summary.plan.memoryConfigurable
              ? text("Configurable", "可配置")
              : text("Fixed", "不可修改")
          }
        />
        <Entitlement
          label={text("Usage source", "用量来源")}
          value={
            summary.usageSource === "sandbox0-sdk"
              ? "Sandbox0 SDK"
              : text("Local runtime projection", "本地运行投影")
          }
        />
      </div>

      {!summary.billingEnabled ? (
        <div className={styles.deploymentNotice}>
          <Check size={16} aria-hidden="true" />
          <div>
            <strong>
              {text(
                "Self-hosted entitlement",
                "自托管部署额度",
              )}
            </strong>
            <p>
              {text(
                "Stripe billing is disabled. This deployment keeps Environment count, memory and runtime unlimited.",
                "Stripe 订阅未启用，当前部署不限制 Environment 数量、内存和运行额度。",
              )}
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className={styles.planHeader}>
            <div>
              <strong>{text("Plans", "套餐")}</strong>
              <p>
                {text(
                  "Sandpi enforces allowances from usage returned by the official Sandbox0 SDK.",
                  "Sandpi 根据 Sandbox0 官方 SDK 返回的用量执行额度限制。",
                )}
              </p>
            </div>
            {summary.customerPortalAvailable ? (
              <button
                type="button"
                className={styles.portalButton}
                disabled={Boolean(busyAction)}
                onClick={() => void openPortal()}
              >
                {busyAction === "portal" ? (
                  <LoaderCircle size={13} aria-hidden="true" />
                ) : (
                  <ArrowUpRight size={13} aria-hidden="true" />
                )}
                {text("Manage billing", "管理订阅")}
              </button>
            ) : null}
          </div>
          <div className={styles.planGrid}>
            {summary.availablePlans.map((plan) => {
              const paidPlanId =
                plan.id === "plus" || plan.id === "pro"
                  ? plan.id
                  : undefined;
              return (
                <PlanCard
                  key={plan.id}
                  plan={plan}
                  current={plan.id === summary.plan.id}
                  busy={busyAction === plan.id}
                  disabled={Boolean(busyAction)}
                  text={text}
                  onSelect={
                    paidPlanId
                      ? () => void selectPlan(paidPlanId)
                      : undefined
                  }
                />
              );
            })}
          </div>
        </>
      )}

      {summary.subscription ? (
        <p className={styles.subscriptionNote}>
          {text("Subscription status", "订阅状态")}:{" "}
          <strong>{summary.subscription.status}</strong>
          {summary.subscription.cancelAtPeriodEnd
            ? text(
                " · Cancels at the end of the billing period",
                " · 将在当前账期结束时取消",
              )
            : null}
          {summary.subscription.pendingPlanId &&
          summary.subscription.pendingEffectiveAt
            ? ` · ${text("Changes to", "将变更为")} ${
                summary.availablePlans.find(
                  (plan) =>
                    plan.id === summary.subscription?.pendingPlanId,
                )?.name ?? summary.subscription.pendingPlanId
              } ${text("on", "，生效时间")} ${formatUnixTimestamp(
                summary.subscription.pendingEffectiveAt,
                language,
                timeZone,
                { dateStyle: "medium", timeStyle: "short" },
              )}`
            : null}
        </p>
      ) : null}
      {error ? (
        <p className={styles.inlineError} role="alert">
          <TriangleAlert size={14} aria-hidden="true" />
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Entitlement({
  label,
  value,
  warning = false,
}: {
  label: string;
  value: string;
  warning?: boolean;
}) {
  return (
    <div className={warning ? styles.entitlementWarning : undefined}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function PlanCard({
  plan,
  current,
  busy,
  disabled,
  text,
  onSelect,
}: {
  plan: SandpiAccountPlan;
  current: boolean;
  busy: boolean;
  disabled: boolean;
  text: (english: string, chinese: string) => string;
  onSelect?: () => void;
}) {
  return (
    <article className={`${styles.planCard} ${current ? styles.current : ""}`}>
      <header>
        <span>{plan.name}</span>
        <strong>
          {plan.monthlyPriceUsd === 0
            ? text("Free", "免费")
            : `$${plan.monthlyPriceUsd}`}
        </strong>
        {plan.monthlyPriceUsd ? (
          <small>{text("USD per month", "美元 / 月")}</small>
        ) : null}
      </header>
      <ul>
        <li>
          {plan.environmentLimit == null
            ? text("Unlimited Environments", "Environment 数量不限")
            : text(
                `${plan.environmentLimit} ${
                  plan.environmentLimit === 1
                    ? "Environment"
                    : "Environments"
                }`,
                `${plan.environmentLimit} 个 Environment`,
              )}
        </li>
        <li>
          {plan.runtimeQuotaGiBHours == null
            ? text("Unlimited runtime", "运行额度不限")
            : `${formatGiBHours(plan.runtimeQuotaGiBHours)} ${text(
                "GiB-hours",
                "GiB 小时",
              )} / ${
                plan.quotaPeriod === "fixed-week"
                  ? text("week", "周")
                  : text("month", "月")
              }`}
        </li>
        <li>
          {plan.memoryConfigurable
            ? text("Configurable memory", "可配置内存")
            : text("Fixed memory", "内存不可修改")}
        </li>
      </ul>
      <button
        type="button"
        disabled={current || disabled || !onSelect}
        onClick={onSelect}
      >
        {busy ? (
          <LoaderCircle size={13} aria-hidden="true" />
        ) : current ? (
          <Check size={13} aria-hidden="true" />
        ) : null}
        {current
          ? text("Current plan", "当前套餐")
          : onSelect
            ? text("Choose plan", "选择套餐")
            : text("Manage in portal", "在订阅页面管理")}
      </button>
    </article>
  );
}

function formatGiBHours(value: number) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: value < 10 ? 2 : 1,
  }).format(value);
}
