import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, stripVTControlCharacters } from "node:util";
import { LocalStatus } from "@caldero/contracts/local-status";
import { automaticRepairGuidance, type AutomaticRepairGuidance, Repo } from "@caldero/domain";
import { Effect, Schema } from "effect";
import { noPullRequestCi, readPullRequestCi } from "./local-ci-status.ts";
import { collectLocalStatus, LocalStatusError } from "./local-status.ts";

const decodeRepoConfig = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ repo: Repo })),
);
const decodeStatus = Schema.decodeUnknownEffect(LocalStatus);
const terminalText = (value: string) =>
  stripVTControlCharacters(value)
    .split("")
    .filter(
      (character) =>
        character === "\n" ||
        character === "\t" ||
        (character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127),
    )
    .join("");
const terminalLine = (value: string) => terminalText(value).replace(/\s+/g, " ");
const help = `Read saved local Caldero status without starting an agent.

pnpm --filter @caldero/agent status [--issue NUMBER [--ci]] [--json]

--repo OWNER/REPO      Repository identity instead of reading GitHub config
--github-config PATH  Read only repo identity (default ~/.config/caldero/github-app.json)
--state-root PATH     State root (default ~/.local/state/caldero/OWNER/REPO)
--issue NUMBER        Inspect one issue, including saved validation evidence
--ci                  Read the saved PR's current GitHub checks with gh (requires --issue)
--json                Emit the full structured snapshot and saved evidence
--help                Show this help

Watch lock ownership is not a heartbeat. Saved session phases do not prove a worker is alive.
Status never resumes tasks or initializes/migrates session storage. SQLite may create WAL/SHM sidecars.`;

const excerpt = (value: string, limit = 2000) => {
  const plain = terminalText(value);
  return plain.length <= limit
    ? plain
    : `${plain.slice(0, limit)}\n… truncated; --json contains the saved value`;
};

const repairStatusLabels: Record<AutomaticRepairGuidance["status"], string> = {
  available: "available (watch eligibility and a failed Actions job are required)",
  running: "in progress in saved session",
  used: "used for this PR",
  unavailable: "unavailable in this session phase",
};

/** Text is a compact view; JSON retains the authoritative saved fields and opaque check output. */
const formatStatus = (snapshot: LocalStatus, detail: boolean) => {
  const lines = [
    `Repository: ${snapshot.repo.owner}/${snapshot.repo.name}`,
    `State root: ${snapshot.stateRoot}`,
    `Watcher lock: ${snapshot.watcher.lock}${snapshot.watcher.pid === null ? "" : ` (owner PID ${snapshot.watcher.pid})`}`,
    "Lock ownership is not a health check; phases below are saved state.",
  ];
  if (snapshot.watcher.error) lines.push(snapshot.watcher.error);
  snapshot.warnings.forEach((warning) => lines.push(`Warning: ${warning}`));
  if (snapshot.sessions.length === 0) lines.push("No saved sessions or queued issues.");
  for (const item of snapshot.sessions) {
    const state = item.state;
    lines.push("", `#${item.issue} ${state?.status ?? item.source}`);
    if (item.error) lines.push(item.error);
    if (item.ci?.status === "no-pr") lines.push("GitHub CI: no saved pull request");
    if (!state) continue;
    lines.push(
      `Run ${state.runId}; candidate ${state.version}; phase attempts ${state.attempts}; queued follow-ups ${state.queued.length}`,
    );
    const updated = new Date(state.updatedAt);
    lines.push(
      `Updated: ${Number.isNaN(updated.getTime()) ? "unavailable" : updated.toISOString()}`,
    );
    if (state.pullRequest) lines.push(`PR: ${state.pullRequest.url}`);
    if (item.ci && item.ci.status !== "no-pr") {
      const { status, headSha, error, checks, totalChecks, checksUrl, detailsTruncated } = item.ci;
      lines.push(
        `GitHub CI: ${status === "none" ? "no checks reported" : status}${headSha ? ` (${headSha.slice(0, 12)})` : ""}`,
      );
      if (error) lines.push(terminalLine(error));
      for (const check of checks) {
        if (check.status !== "failing") continue;
        const name = check.workflow ? `${check.workflow} / ${check.name}` : check.name;
        if (!detailsTruncated)
          lines.push(
            `  Failed: ${terminalLine(name)}${check.url ? ` — ${check.url.replace(/\s/g, "")}` : ""}`,
          );
      }
      if (detailsTruncated)
        lines.push(
          `GitHub returned a partial detail list (${totalChecks} total contexts). See the full checks page.`,
        );
      if (checksUrl) lines.push(`  PR checks: ${checksUrl}`);
    }
    if (item.automaticRepair) {
      const { status, nextAction } = item.automaticRepair;
      lines.push(`Automatic repair: ${repairStatusLabels[status]}`);
      if (nextAction)
        lines.push(
          `Next: pnpm ${nextAction} --issue ${item.issue} (use the same state directory and checks)`,
        );
    }
    if (state.failure) lines.push(`Failure: ${excerpt(state.failure, detail ? 2000 : 250)}`);
    if (state.candidate) {
      const candidate = state.candidate;
      lines.push(
        `Validation evidence saved for candidate ${candidate.binding.version}, run ${candidate.binding.runId}`,
      );
      if (detail) lines.push(excerpt(candidate.evidence));
    }
  }
  return lines.map(terminalText).join("\n");
};

const command = Effect.gen(function* () {
  const { values } = yield* Effect.try({
    try: () =>
      parseArgs({
        options: {
          repo: { type: "string" },
          "github-config": { type: "string" },
          "state-root": { type: "string" },
          issue: { type: "string" },
          ci: { type: "boolean" },
          json: { type: "boolean" },
          help: { type: "boolean" },
        },
      }),
    catch: () => new LocalStatusError({ message: "Invalid status arguments; use --help" }),
  });
  if (values.help) return yield* Effect.sync(() => console.log(help));
  if (values.ci && values.issue === undefined)
    return yield* new LocalStatusError({ message: "--ci requires --issue NUMBER" });
  if (values.repo !== undefined && values["github-config"] !== undefined)
    return yield* new LocalStatusError({ message: "Use either --repo or --github-config" });
  let repo: Repo;
  if (values.repo !== undefined) {
    const parts = values.repo.split("/");
    if (parts.length !== 2 || !parts[0]?.trim() || !parts[1]?.trim())
      return yield* new LocalStatusError({ message: "Use --repo OWNER/REPO" });
    repo = { owner: parts[0], name: parts[1] };
  } else {
    const configPath = resolve(
      values["github-config"] ?? join(homedir(), ".config/caldero/github-app.json"),
    );
    const text = yield* Effect.tryPromise({
      try: () => readFile(configPath, "utf8"),
      catch: () =>
        new LocalStatusError({
          message:
            "Could not read repository identity; provide --repo OWNER/REPO or --github-config PATH",
        }),
    });
    repo = (yield* decodeRepoConfig(text).pipe(
      Effect.mapError(
        () =>
          new LocalStatusError({ message: "GitHub config must contain repo.owner and repo.name" }),
      ),
    )).repo;
  }
  const issue = values.issue === undefined ? undefined : Number(values.issue);
  const snapshot = yield* collectLocalStatus({
    repo,
    stateRoot: resolve(
      values["state-root"] ?? join(homedir(), ".local/state/caldero", repo.owner, repo.name),
    ),
    ...(issue === undefined ? {} : { issue }),
  }).pipe(
    Effect.flatMap((local) =>
      Effect.forEach(local.sessions, (item) => {
        const state = item.state;
        const pr = state?.pullRequest;
        if (!values.ci) return Effect.succeed(item);
        return state && pr
          ? readPullRequestCi(repo, pr.number).pipe(
              Effect.map((ci) => {
                const automaticRepair = automaticRepairGuidance(
                  state,
                  !ci.detailsTruncated && ci.checks.some((check) => check.status === "failing"),
                );
                return { ...item, ci, ...(automaticRepair ? { automaticRepair } : {}) };
              }),
            )
          : Effect.succeed({ ...item, ci: noPullRequestCi });
      }).pipe(Effect.map((sessions) => ({ ...local, sessions }))),
    ),
    Effect.flatMap(decodeStatus),
    Effect.mapError((error) =>
      error instanceof LocalStatusError
        ? error
        : new LocalStatusError({ message: "Could not collect a valid status snapshot" }),
    ),
  );
  return yield* Effect.sync(() => {
    console.log(
      values.json ? JSON.stringify(snapshot) : formatStatus(snapshot, issue !== undefined),
    );
    if (
      snapshot.warnings.length > 0 ||
      snapshot.sessions.some(
        (item) =>
          item.source === "unavailable" || (issue !== undefined && item.source === "missing"),
      )
    )
      process.exitCode = 1;
  });
});

// Node status entrypoint owns its single Effect runtime.
await Effect.runPromise(
  command.pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        console.error(error.message);
        process.exitCode = 1;
      }),
    ),
  ),
);
