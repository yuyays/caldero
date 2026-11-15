import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SessionView } from "@puchero/contracts/inbox";
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
    policy: "observe",
    status: "awaitingApproval",
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
  it("disables approval for a missing patch while preserving stop controls and explaining audit failure", async () => {
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
    expect(screen.getByRole("button", { name: "Approve & open PR" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: "Stop session" })).toHaveProperty("disabled", false);
    expect(screen.getByText(/validated patch could not be loaded/)).toBeTruthy();
    expect(screen.getByText(/Activity history is unavailable/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Stop session" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm stop" }));
    await waitFor(() => expect(screen.getByText("Stopped")).toBeTruthy());
    cache.clear();
  });

  it("sends the displayed binding once and blocks duplicate clicks while approval is pending", async () => {
    let complete: (response: Response) => void = () => {};
    const fetcher = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const cache = mount();
    expect(screen.getByText(/24 tests passed/)).toBeTruthy();
    expect(screen.getByLabelText("Proposed diff").textContent).toContain(
      "Write down the next step.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Approve & open PR" }));
    await userEvent.click(screen.getByRole("button", { name: "Approving…" }));
    expect(fetcher).toHaveBeenCalledOnce();
    const init = fetcher.mock.calls[0]?.[1];
    expect(await new Response(init?.body).json()).toMatchObject({ binding });
    complete(
      Response.json({
        result: "applied",
        view: { ...view, state: { ...view.state, status: "publishing" } },
      }),
    );
    await waitFor(() => expect(screen.getByText("Opening pull request")).toBeTruthy());
    cache.clear();
  });
  it("shows the fresh candidate after a stale decision and requires a new click with the new binding", async () => {
    const newer = {
      ...view,
      state: {
        ...view.state,
        version: 2,
        candidate: {
          binding: { ...binding, version: 2, patchDigest: "digest-v2" },
          evidence: "New checks passed",
        },
      },
      patch: { ...view.patch!, digest: "digest-v2", diff: "+Updated candidate\n" },
    };
    const fetcher = vi.fn<typeof fetch>((_request, init) =>
      Promise.resolve(
        init?.method === "POST"
          ? Response.json(
              { _tag: "StaleDecision", message: "Changed", view: newer },
              { status: 409 },
            )
          : Response.json({ view: newer, audit: [] }),
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const cache = mount();
    await userEvent.click(screen.getByRole("button", { name: "Approve & open PR" }));
    await waitFor(() => expect(screen.getByText("digest-v2")).toBeTruthy());
    expect(screen.getByText(/The candidate changed/)).toBeTruthy();
    expect(screen.getByLabelText("Proposed diff").textContent).toContain("Updated candidate");
    expect(fetcher.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Approve & open PR" }));
    const posts = fetcher.mock.calls.filter((call) => call[1]?.method === "POST");
    expect(await new Response(posts[1]?.[1]?.body).json()).toMatchObject({
      binding: newer.state.candidate.binding,
    });
    cache.clear();
  });
  it("warns before additional instructions replace the reviewed candidate", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ result: "applied", view })),
    );
    vi.stubGlobal("fetch", fetcher);
    const cache = mount();
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
