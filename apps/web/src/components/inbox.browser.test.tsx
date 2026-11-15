import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionFault, type SessionView } from "@puchero/contracts/inbox";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { SessionReview } from "./inbox.js";
import { detailQuery } from "../lib/inbox.js";

const binding = {
  sessionId: "acme/app#7",
  repo: { owner: "acme", name: "app" },
  runId: 1,
  version: 1,
  baseSha: "abc123",
  baseRef: "main",
  patchDigest: "digest-v1",
};
const view: SessionView = {
  state: {
    sessionId: "acme/app#7",
    repo: binding.repo,
    issue: 7,
    policy: "auto",
    status: "validating",
    revision: 3,
    runId: 1,
    version: 1,
    baseSha: "abc123",
    baseRef: "main",
    candidate: { binding, evidence: "$ pnpm test\n24 tests passed" },
    attempts: 0,
    queued: [],
    pullRequest: null,
    failure: null,
    decidedBy: null,
    updatedAt: 1000,
  },
  patch: {
    digest: "digest-v1",
    diff: "diff --git a/notes.txt b/notes.txt\nnew file mode 100644\n--- /dev/null\n+++ b/notes.txt\n@@ -0,0 +1 @@\n+Write down the next step.\n",
    files: [{ change: "write", path: "notes.txt", content: "aGk=", executable: false }],
  },
};
const mount = (initialView: SessionView = view, auditUnavailable = false) => {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  cache.setQueryData(detailQuery(binding.sessionId).queryKey, {
    view: initialView,
    audit: [],
    auditUnavailable,
  });
  render(
    <QueryClientProvider client={cache}>
      <SessionReview sessionId={binding.sessionId} />
    </QueryClientProvider>,
  );
  return cache;
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("Candidate review", () => {
  it("identifies automatic publication and links the opened PR without asking for approval", () => {
    const automatic: SessionView = {
      ...view,
      state: {
        ...view.state,
        policy: "auto",
        status: "published",
        pullRequest: { number: 123, url: "https://github.com/acme/app/pull/123" },
      },
    };
    const cache = mount(automatic);
    expect(screen.getByText(/24 tests passed/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open pull request #123" })).toHaveProperty(
      "href",
      "https://github.com/acme/app/pull/123",
    );
    expect(screen.queryByRole("button", { name: "Approve & open PR" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject candidate" })).toBeNull();
    cache.clear();
  });

  it("explains permanent session faults without offering another retry or allowing another decision", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json(new SessionFault({ code: "state_unreadable", message: "Unreadable" }), {
          status: 500,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const cache = mount();
    await userEvent.click(screen.getByRole("button", { name: "Stop session" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm stop" }));
    await waitFor(() => expect(screen.getByText(/Operator repair is required/)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Stop session" })).toHaveProperty("disabled", true);
    await cache.invalidateQueries({ queryKey: ["session", binding.sessionId] });
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("retrying will not fix it"),
    );
    expect(screen.queryByRole("button", { name: "Retry session" })).toBeNull();
    cache.clear();
  });

  it("keeps stop controls available with missing patch and audit data", async () => {
    const missing = { ...view, patch: null, patchUnavailable: true };
    const stopped = { ...missing, state: { ...missing.state, status: "cancelled" } };
    const fetcher = vi.fn<typeof fetch>((_request, init) =>
      Promise.resolve(
        Response.json(
          init?.method === "POST"
            ? { result: "applied", view: stopped }
            : { view: stopped, audit: [], auditUnavailable: true },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const cache = mount(missing, true);
    expect(screen.getByRole("button", { name: "Stop session" })).toHaveProperty("disabled", false);
    expect(screen.getByText(/validated patch could not be loaded/)).toBeTruthy();
    expect(screen.getByText(/Activity history is unavailable/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Stop session" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm stop" }));
    await waitFor(() => expect(screen.getByText("Stopped")).toBeTruthy());
    cache.clear();
  });

  it("warns before restarting a legacy paused candidate with new instructions", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ result: "applied", view })),
    );
    vi.stubGlobal("fetch", fetcher);
    const cache = mount({
      ...view,
      state: { ...view.state, policy: "observe", status: "awaitingApproval" },
    });
    await userEvent.type(screen.getByLabelText("Send instructions"), "Include a test");
    await userEvent.click(screen.getByRole("button", { name: "Send instructions" }));
    expect(fetcher).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("replaces version 1");
    await userEvent.click(screen.getByRole("button", { name: "Replace candidate & send" }));
    expect(fetcher.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
    expect(await new Response(fetcher.mock.calls[0]?.[1]?.body).json()).toMatchObject({
      text: "Include a test",
    });
    cache.clear();
  });
});
