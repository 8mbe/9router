"use client";

import { useEffect, useState } from "react";
import { Button, Card, Input } from "@/shared/components";
import { AI_PROVIDERS } from "@/shared/constants/providers";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text-main";

export function useComboStatus() {
  const [model, setModel] = useState("claude-opus-5");
  const [refreshKey, setRefreshKey] = useState(0);
  const [state, setState] = useState({ data: null, loading: true, error: "", updatedAt: null });

  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;

    const readStatus = async (initial = false) => {
      if (inFlight) return;
      inFlight = true;
      if (initial) {
        setState((previous) => ({
          ...previous,
          data: previous.data?.model === model ? previous.data : null,
          loading: true,
          error: "",
        }));
      }
      try {
        const response = await fetch(`/api/auto-combo?model=${encodeURIComponent(model)}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Could not load routing status.");
        const data = await response.json();
        if (!controller.signal.aborted) {
          setState({ data, loading: false, error: "", updatedAt: new Date() });
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setState((previous) => ({ ...previous, loading: false, error: "Could not load routing status. Refresh to try again." }));
        }
      } finally {
        inFlight = false;
      }
    };

    readStatus(true);
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") readStatus();
    };
    const interval = setInterval(refreshWhenVisible, 15000);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      controller.abort();
      clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [model, refreshKey]);

  const refresh = () => setRefreshKey((previous) => previous + 1);
  const inspect = (value) => {
    const next = value.trim();
    if (!next) return;
    if (next === model) refresh();
    else setModel(next);
    document.getElementById("model-combo-status")?.scrollIntoView({ block: "start" });
  };
  const healthByMember = Object.fromEntries((state.data?.health || []).map((entry) => [entry.member.toLowerCase(), entry]));
  for (const entry of state.data?.resolved?.members || []) healthByMember[entry.member.toLowerCase()] = entry;

  return { ...state, model, inspect, refresh, healthByMember };
}

function statusOf(entry) {
  if (entry?.status) return entry.status;
  if (entry?.failures > 0) return "not_working";
  return entry?.lastSuccessAt ? "working" : "untested";
}

function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

export function providerLabel(member, entry) {
  const prefix = member.split("/")[0];
  const provider = entry?.providerId
    ? AI_PROVIDERS[entry.providerId]
    : Object.values(AI_PROVIDERS).find((candidate) => candidate.alias === prefix || candidate.id === prefix);
  return provider?.name || entry?.providerName || prefix;
}

export function MemberStatus({ entry, loading = false, unavailable = false, details = true }) {
  if (loading) return <span className="text-xs font-sans text-text-muted">Loading status...</span>;
  if (unavailable) return <span className="text-xs font-sans text-text-muted">Status unavailable</span>;
  const status = statusOf(entry);
  const label = status === "working" ? "Working" : status === "not_working" ? "Not working" : "Untested";
  const color = status === "working"
    ? "text-[#166534] dark:text-[#86efac]"
    : status === "not_working" ? "text-[#991b1b] dark:text-[#fca5a5]" : "text-text-muted";
  const lastSeen = status === "not_working" ? entry?.lastFailureAt : entry?.lastSuccessAt;

  return (
    <div className="min-w-0 font-sans text-xs">
      <span className={`font-medium ${color}`}>{label}</span>
      {entry?.disabled && <span className="ml-2 text-text-muted">In cooldown</span>}
      {details && status === "untested" && <p className="mt-0.5 text-text-muted">No recorded request</p>}
      {details && lastSeen && <p className="mt-0.5 text-text-muted">Last {status === "not_working" ? "failure" : "success"} {formatTime(lastSeen)}</p>}
      {details && status === "not_working" && (entry?.lastStatus || entry?.lastError) && (
        <p className="mt-0.5 break-words text-text-muted">
          {entry.lastStatus ? `HTTP ${entry.lastStatus}` : "Request failed"}{entry.lastError ? `: ${entry.lastError}` : ""}
        </p>
      )}
      {details && entry?.disabledUntil && <p className="mt-0.5 text-text-muted">Cooldown until {formatTime(entry.disabledUntil)}</p>}
    </div>
  );
}

function MemberList({ models, status, comboByName = {} }) {
  return (
    <ol className="divide-y divide-border">
      {models.map((member, index) => {
        const entry = status.healthByMember[member.toLowerCase()];
        const bare = !member.includes("/");
        return (
          <li key={`${member}-${index}`} className="grid min-w-0 grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 py-3 sm:grid-cols-[1.5rem_minmax(0,1fr)_minmax(10rem,1fr)]">
            <span className="text-xs text-text-muted" aria-hidden="true">{index + 1}.</span>
            <div className="min-w-0">
              <p className="break-words text-xs font-medium text-text-main">{bare ? comboByName[member] ? "Nested combo" : "Automatic model or alias" : providerLabel(member, entry)}</p>
              <code className="block break-all text-xs text-text-main">{member}</code>
            </div>
            <div className="col-start-2 min-w-0 sm:col-start-auto">
              {bare ? (
                <button type="button" onClick={() => status.inspect(member)} className={`rounded text-xs text-text-main underline underline-offset-4 ${FOCUS}`}>
                  Inspect provider routes
                </button>
              ) : (
                <MemberStatus entry={entry} loading={status.loading && !status.data} unavailable={!!status.error && !status.data} />
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function ComboStatusSection({ status }) {
  const [draft, setDraft] = useState(status.model);
  const resolved = status.data?.resolved;
  const models = [...(resolved?.models || [])];
  for (const member of resolved?.benched || []) {
    if (!models.some((existing) => existing.toLowerCase() === member.toLowerCase())) models.push(member);
  }
  const source = { combo: "Saved combo", alias: "Model alias", automatic: "Automatic combo" }[status.data?.source] || "No match";
  const strategy = { fallback: "Fallback", "round-robin": "Round robin", fusion: "Fusion" }[status.data?.strategy] || "Fallback";
  const automaticDisabled = status.data?.enabled === false && !["combo", "alias"].includes(status.data?.source);

  return (
    <Card padding="sm" id="model-combo-status" className="scroll-mt-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold text-text-main">Model combo status</h2>
          <p id="model-combo-status-description" className="mt-1 text-xs text-text-muted">
            Inspect a model name to see its providers and routing order. This sends no model request.
          </p>
        </div>
        <Button type="button" variant="secondary" onClick={status.refresh} disabled={status.loading} className={`shrink-0 ${FOCUS}`}>
          Refresh status
        </Button>
      </div>
      <form onSubmit={(event) => { event.preventDefault(); status.inspect(draft); }} className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <label htmlFor="combo-status-model" className="mb-1.5 block text-xs font-medium text-text-main">Model or combo name</label>
          <Input
            id="combo-status-model"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-describedby="model-combo-status-description"
            placeholder="claude-opus-5"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
            inputClassName="border-[#737373] dark:border-[#a3a3a3] focus:outline-2 focus:outline-offset-2 focus:outline-text-main focus:ring-0"
          />
        </div>
        <Button type="submit" variant="secondary" disabled={!draft.trim()} className={FOCUS}>Inspect combo</Button>
      </form>
      <div className="mt-4" aria-live="polite" aria-busy={status.loading}>
        {status.loading && <p className="text-xs text-text-muted">Loading provider routes...</p>}
        {status.error && <p role="alert" className="text-xs text-[#991b1b] dark:text-[#fca5a5]">{status.error}{status.data ? " Showing the last loaded status." : ""}</p>}
        {automaticDisabled && <p className="text-xs text-text-main">Automatic combos are disabled in Settings.</p>}
        {status.data && (
          <>
            <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
              <code className="break-all font-medium text-text-main">{status.data.model}</code>
              <span className="text-text-muted">{source} · {strategy} · {models.length} provider route{models.length === 1 ? "" : "s"}</span>
            </div>
            {models.length > 0 ? (
              <>
                <p className="mt-2 text-xs text-text-muted">
                  {status.data.source === "automatic"
                    ? "Fallback order. Working routes are preferred first. Failed routes stay in the pool."
                    : status.data.source === "alias" ? "This alias routes to the provider below."
                      : status.data.strategy === "fallback" ? "Configured fallback order. Failed routes stay visible."
                        : "Configured model order. Requests use the selected strategy."}
                </p>
                <MemberList models={models} status={status} />
              </>
            ) : !status.loading && !automaticDisabled && (
              <p className="mt-3 text-xs text-text-muted">
                {status.data.source === "combo"
                  ? "This combo has no configured models. Edit it to add provider routes."
                  : "No available provider routes match this name. Check the model name and connected providers."}
              </p>
            )}
          </>
        )}
      </div>
      <p className="mt-2 text-xs text-text-muted">
        Status reflects recorded model requests and model tests. Untested routes have no recorded result. Refreshes every 15 seconds while this tab is visible.
        {status.updatedAt && ` Last refreshed ${formatTime(status.updatedAt)}.`}
      </p>
    </Card>
  );
}

export function ComboMemberStatus({ combo, comboByName, status }) {
  const counts = { working: 0, not_working: 0, untested: 0 };
  for (const member of combo.models) {
    if (member.includes("/")) counts[statusOf(status.healthByMember[member.toLowerCase()])] += 1;
  }
  const summary = status.loading && !status.data ? "Loading status..."
    : status.error && !status.data ? "Status unavailable"
    : [counts.working && `${counts.working} working`, counts.not_working && `${counts.not_working} not working`, counts.untested && `${counts.untested} untested`].filter(Boolean).join(" · ");

  return (
    <details className="mt-3 border-t border-border pt-3">
      <summary className={`cursor-pointer rounded text-xs text-text-main ${FOCUS}`}>
        Provider status{summary ? ` · ${summary}` : ""}
      </summary>
      <MemberList models={combo.models} status={status} comboByName={comboByName} />
      <button type="button" onClick={() => status.inspect(combo.name)} className={`rounded text-xs font-medium text-text-main underline underline-offset-4 ${FOCUS}`}>
        Inspect {combo.name} routing
      </button>
    </details>
  );
}
