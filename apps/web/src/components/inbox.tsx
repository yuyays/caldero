import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SessionDetail, SessionSummary } from "@puchero/contracts/inbox";
import { Check, RefreshCw, ExternalLink, GitPullRequest } from "lucide-react";
import { Button } from "./ui/button.js";
import {
  decideSession,
  detailQuery,
  inboxError,
  sessionsQuery,
  setLocalToken,
  staleDecision,
  viewerQuery,
  type Action,
  type Decision,
} from "../lib/inbox.js";

export const statusLabel: Record<SessionSummary["status"], string> = {
  idle: "Waiting to start",
  running: "Working",
  validating: "Checking changes",
  awaitingApproval: "Needs review",
  publishing: "Opening pull request",
  published: "Pull request opened",
  rejected: "Rejected",
  cancelled: "Stopped",
  failed: "Needs attention",
};
const time = (value: number) => (value === 0 ? "Not started" : new Date(value).toLocaleString());

/** The index helps navigation; only the current session view enables decisions. */
export function Inbox() {
  const [selected, select] = useState<string | null>(null);
  const [token, tokenInput] = useState("");
  const cache = useQueryClient();
  const list = useQuery(sessionsQuery);
  const viewer = useQuery(viewerQuery);
  const sessionId = selected ?? list.data?.[0]?.sessionId;
  const refresh = () => {
    void cache.invalidateQueries();
  };
  return (
    <main className="mx-auto max-w-[1600px] px-4 py-6 text-stone-950 sm:px-8 sm:py-10">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4 border-b border-stone-300 pb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Puchero <span className="font-normal text-stone-600">/ Review inbox</span>
          </h1>
          <p className="mt-2 text-sm text-stone-600">Agent work, ready for your decision.</p>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <span>{viewer.data ? `Reviewing as ${viewer.data.login}` : "Sign-in required"}</span>
          <Button variant="outline" disabled={list.isFetching} onClick={refresh}>
            <RefreshCw size={16} aria-hidden="true" />
            Refresh
          </Button>
        </div>
      </header>
      {list.error && (
        <section
          className="mb-6 space-y-4 rounded-xl bg-amber-50 p-5 text-amber-950"
          aria-label="Inbox connection"
        >
          <p role="alert">{inboxError(list.error)}</p>
          <details>
            <summary className="cursor-pointer text-sm underline underline-offset-4">
              Local development token
            </summary>
            <form
              className="mt-3 flex flex-wrap gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                setLocalToken(token);
                tokenInput("");
                refresh();
              }}
            >
              <label className="sr-only" htmlFor="local-token">
                Local token
              </label>
              <input
                id="local-token"
                type="password"
                value={token}
                onChange={(e) => tokenInput(e.target.value)}
                autoComplete="off"
                className="rounded-md border border-amber-400 bg-white px-3 py-2"
              />
              <Button type="submit">Connect locally</Button>
            </form>
          </details>
        </section>
      )}
      <div className="grid items-start gap-8 lg:grid-cols-[290px_minmax(0,1fr)]">
        <nav aria-label="Sessions" className="min-w-0">
          <h2 className="mb-3 text-sm font-semibold">
            Sessions{" "}
            <span className="ml-2 font-normal text-stone-600">{list.data?.length ?? 0}</span>
          </h2>
          <p className="mb-5 text-xs leading-5 text-stone-600">
            Needs review first. This list may briefly lag behind a session.
          </p>
          {list.isPending && <output className="text-sm text-stone-600">Loading sessions…</output>}
          {list.data?.length === 0 && (
            <p className="text-sm leading-6 text-stone-600">
              No sessions yet. Add the <code>agent</code> label to a GitHub issue in your configured
              repository.
            </p>
          )}
          <ul className="divide-y divide-stone-200">
            {list.data?.map((session) => (
              <li key={session.sessionId}>
                <button
                  type="button"
                  aria-current={sessionId === session.sessionId ? "page" : undefined}
                  onClick={() => select(session.sessionId)}
                  className="w-full rounded-lg px-3 py-4 text-left transition-colors hover:bg-stone-100 aria-[current=page]:bg-cyan-50"
                >
                  <span className="block break-words text-sm font-medium">
                    {session.repo.owner}/{session.repo.name}{" "}
                    <span className="text-stone-600">#{session.issue}</span>
                  </span>
                  <span
                    className={`mt-2 block text-sm ${session.status === "awaitingApproval" ? "font-medium text-cyan-800" : "text-stone-600"}`}
                  >
                    {statusLabel[session.status]}
                  </span>
                  <span className="mt-1 block text-xs tabular-nums text-stone-600">
                    {time(session.updatedAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        {sessionId ? (
          <SessionReview key={sessionId} sessionId={sessionId} />
        ) : (
          <section className="flex min-h-80 flex-col items-center justify-center border-y border-stone-200 px-6 text-center">
            <GitPullRequest className="mb-4 text-stone-500" size={28} aria-hidden="true" />
            <h2 className="text-xl font-medium">A place to review agent work</h2>
            <p className="mt-2 max-w-md text-sm leading-6 text-stone-600">
              When an agent finishes its checks, select the session to inspect its changes and
              decide whether to open a pull request.
            </p>
          </section>
        )}
      </div>
    </main>
  );
}

export function SessionReview({ sessionId }: { sessionId: string }) {
  const cache = useQueryClient();
  const detail = useQuery(detailQuery(sessionId));
  const [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState<Action | null>(null);
  const [input, setInput] = useState("");
  const decision = useMutation({
    mutationFn: decideSession,
    onSuccess: (result) => {
      cache.setQueryData(detailQuery(sessionId).queryKey, (old: SessionDetail | undefined) => ({
        view: result.view,
        audit: old?.audit ?? [],
        auditUnavailable: old?.auditUnavailable ?? false,
      }));
      setNotice(
        result.result === "duplicate"
          ? "This decision was already received."
          : "Decision received.",
      );
      setConfirm(null);
      setInput("");
      void cache.invalidateQueries({ queryKey: ["sessions"] });
      void cache.invalidateQueries({ queryKey: ["session", sessionId] });
    },
    onError: (error) => {
      if (staleDecision(error)) {
        cache.setQueryData(detailQuery(sessionId).queryKey, (old: SessionDetail | undefined) => ({
          view: error.view,
          audit: old?.audit ?? [],
          auditUnavailable: old?.auditUnavailable ?? false,
        }));
        setNotice(
          "The candidate changed. Review the current patch and evidence before deciding again.",
        );
        setConfirm(null);
      } else setNotice(inboxError(error));
    },
  });
  if (detail.isPending) return <output className="block p-6">Loading session…</output>;
  if (detail.error)
    return (
      <section role="alert" className="rounded-xl bg-amber-50 p-6 text-amber-950">
        {inboxError(detail.error)}{" "}
        <Button className="ml-2" variant="outline" onClick={() => void detail.refetch()}>
          Retry session
        </Button>
      </section>
    );
  const { view, audit, auditUnavailable } = detail.data;
  const { state, patch } = view;
  const candidate = state.candidate;
  const pending = decision.isPending || detail.isFetching;
  const reviewable =
    state.status === "awaitingApproval" &&
    candidate !== null &&
    patch !== null &&
    candidate.binding.patchDigest === patch.digest;
  const cancellable = ["idle", "running", "validating", "awaitingApproval"].includes(state.status);
  const canInput = ["running", "validating", "awaitingApproval", "publishing"].includes(
    state.status,
  );
  const act = (action: Action) => {
    const request: Decision = { action, view, requestId: crypto.randomUUID(), text: input };
    decision.mutate(request);
  };
  return (
    <article className="min-w-0" aria-label={`Review issue ${state.issue}`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Issue #{state.issue}</h2>
          <a
            href={`https://github.com/${encodeURIComponent(state.repo.owner)}/${encodeURIComponent(state.repo.name)}/issues/${state.issue}`}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex items-center gap-2 break-all text-sm text-cyan-800 underline underline-offset-4"
          >
            {state.repo.owner}/{state.repo.name}
            <ExternalLink size={14} aria-hidden="true" />
          </a>
        </div>
        <span
          className={`rounded-md px-3 py-2 text-sm font-medium ${reviewable ? "bg-cyan-100 text-cyan-950" : "bg-stone-100 text-stone-800"}`}
        >
          {statusLabel[state.status]}
        </span>
      </div>
      <div aria-live="polite" className="mt-5">
        {notice && (
          <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-950">{notice}</p>
        )}
      </div>
      {auditUnavailable && (
        <p className="mt-4 text-sm text-amber-900">
          Activity history is unavailable. You can still review and decide on this session.
        </p>
      )}
      {state.failure && (
        <p role="alert" className="mt-4 break-words rounded-lg bg-red-50 p-4 text-sm text-red-900">
          {state.failure}
        </p>
      )}
      {state.pullRequest && (
        <a
          className="mt-5 inline-flex items-center gap-2 font-medium text-cyan-800 underline underline-offset-4"
          href={state.pullRequest.url}
          target="_blank"
          rel="noreferrer"
        >
          <GitPullRequest size={18} aria-hidden="true" />
          Open pull request #{state.pullRequest.number}
          <ExternalLink size={14} aria-hidden="true" />
        </a>
      )}
      <dl className="my-6 grid gap-4 border-y border-stone-200 py-5 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-stone-600">Candidate / run</dt>
          <dd className="mt-1 tabular-nums">
            Version {state.version} / Run {state.runId}
          </dd>
        </div>
        <div>
          <dt className="text-stone-600">Base</dt>
          <dd className="mt-1 break-all font-mono text-xs">
            {state.baseRef ?? "Pending"} {state.baseSha}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-stone-600">Patch digest</dt>
          <dd className="mt-1 break-all font-mono text-xs">
            {candidate?.binding.patchDigest ?? "Available after validation"}
          </dd>
        </div>
      </dl>
      {candidate && (
        <section className="mb-6">
          <h3 className="mb-3 flex items-center gap-2 font-semibold">
            <Check size={18} className="text-cyan-800" aria-hidden="true" />
            Validation evidence
          </h3>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-stone-100 p-4 text-xs leading-6">
            {candidate.evidence}
          </pre>
        </section>
      )}
      <section>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="font-semibold">Proposed changes</h3>
          {patch && (
            <span className="text-sm text-stone-600">
              {patch.files.length} {patch.files.length === 1 ? "file" : "files"}
            </span>
          )}
        </div>
        {patch ? (
          <pre
            aria-label="Proposed diff"
            className="max-h-[38rem] overflow-auto rounded-xl border border-stone-300 bg-white p-4 font-mono text-xs leading-6"
          >
            {patch.diff || "No textual diff."}
          </pre>
        ) : (
          <p className="rounded-xl bg-stone-100 p-5 text-sm leading-6 text-stone-600">
            {view.patchUnavailable
              ? "The validated patch could not be loaded. Refresh to retry. Approval is disabled; you can still stop this session."
              : state.status === "running" || state.status === "validating"
                ? "The agent is still working. Changes and check results appear here when a candidate is ready."
                : "No validated patch is available for this session."}
          </p>
        )}
      </section>
      <section className="my-6 border-y border-stone-300 py-5" aria-label="Review actions">
        <p className="mb-4 text-sm text-stone-600">
          Approving opens a pull request with the exact candidate shown above.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button disabled={!reviewable || pending} onClick={() => act("approve")}>
            {decision.isPending && decision.variables.action === "approve"
              ? "Approving…"
              : "Approve & open PR"}
          </Button>
          <Button
            variant="outline"
            disabled={!reviewable || pending}
            onClick={() => setConfirm("reject")}
          >
            Reject candidate
          </Button>
          <Button
            variant="outline"
            disabled={!cancellable || pending}
            onClick={() => setConfirm("cancel")}
          >
            Stop session
          </Button>
        </div>
        {(confirm === "reject" || confirm === "cancel") && (
          <div className="mt-4 space-y-3">
            <p className="text-sm">
              {confirm === "reject"
                ? "Reject this candidate? It will not be published."
                : "Stop this session and discard its pending work?"}
            </p>
            <Button disabled={pending} onClick={() => act(confirm)}>
              Confirm {confirm === "reject" ? "rejection" : "stop"}
            </Button>
            <Button
              className="ml-2"
              variant="outline"
              disabled={pending}
              onClick={() => setConfirm(null)}
            >
              Keep reviewing
            </Button>
          </div>
        )}
      </section>
      {canInput && (
        <form
          className="mb-8"
          onSubmit={(event) => {
            event.preventDefault();
            if (state.status === "awaitingApproval" && confirm !== "input") setConfirm("input");
            else act("input");
          }}
        >
          <label htmlFor="instructions" className="mb-2 block font-semibold">
            Send instructions
          </label>
          <p className="mb-3 text-sm text-stone-600">
            {state.status === "publishing"
              ? "Instructions wait until publishing finishes."
              : "Tell the agent what to change or investigate next."}
          </p>
          <textarea
            id="instructions"
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
              if (confirm === "input") setConfirm(null);
            }}
            maxLength={20000}
            required
            rows={3}
            className="w-full rounded-lg border border-stone-300 bg-white p-3 text-sm"
          />
          {confirm === "input" && (
            <p role="alert" className="my-3 text-sm text-amber-900">
              Sending this replaces version {state.version}. The agent will create a new candidate
              for you to review.
            </p>
          )}
          <Button
            type="submit"
            variant="outline"
            className="mt-3"
            disabled={pending || !input.trim()}
          >
            {confirm === "input" ? "Replace candidate & send" : "Send instructions"}
          </Button>
        </form>
      )}
      <details className="border-t border-stone-200 py-4">
        <summary className="cursor-pointer text-sm font-medium">Activity history</summary>
        <ol className="mt-4 space-y-3 text-sm">
          {audit.map((entry) => (
            <li
              key={entry.instructionId}
              className="flex flex-wrap justify-between gap-x-4 gap-y-1"
            >
              <span>
                {statusLabel[entry.status]}
                {entry.actor ? ` · ${entry.actor}` : ""}
              </span>
              <span className="tabular-nums text-stone-600">
                Revision {entry.revision} · {time(entry.updatedAt)}
              </span>
            </li>
          ))}
        </ol>
        {audit.length === 0 && (
          <p className="mt-3 text-sm text-stone-600">Activity is still being indexed.</p>
        )}
      </details>
    </article>
  );
}
