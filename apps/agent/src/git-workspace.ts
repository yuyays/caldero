import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Effect, Layer, Schema, Semaphore } from "effect";
import { Base64, Hex } from "effect/encoding";
import {
  errorMessage,
  type FileChange,
  GitHub,
  Patch,
  Workspace,
  WorkspaceError,
} from "./ports.ts";

const context = BACKGROUND_CONTEXT;
const author = ["-c", "user.name=puchero", "-c", "user.email=puchero@localhost"];
const decodePatch = Schema.decodeUnknownEffect(Schema.fromJsonString(Patch));
const encodePatch = Schema.encodeEffect(Schema.fromJsonString(Patch));

const failure = (error: unknown) => new WorkspaceError({ message: errorMessage(error) });

/** A change set's identity: the SHA-256 of its files, in path order. */
const digestOf = Effect.fn("digestOf")(function* (files: ReadonlyArray<FileChange>) {
  const bytes = yield* Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(files))),
  );
  return Hex.encode(new Uint8Array(bytes));
});

/**
 * A git-tracked workspace over any Pi `ExecutionEnv`: the repository at its base commit lives in `<root>/work`, and
 * every validated candidate is frozen as `<root>/candidates/<digest>` and `<root>/patches/<digest>.json`.
 * The environment adapters (local process, container) differ only in the `ExecutionEnv` they pass.
 */
export const makeGitWorkspace = Effect.fn("makeGitWorkspace")(function* (options: {
  readonly env: ExecutionEnv;
  readonly root: string;
  /** Shell commands that must all pass for a candidate to be proposed. */
  readonly checks: ReadonlyArray<string>;
}) {
  const github = yield* GitHub;
  const { env, root, checks } = options;
  // One validation at a time: each stages the whole index.
  const validating = yield* Semaphore.make(1);
  const work = `${root}/work`;
  const marker = `${work}/.git/puchero-base`;

  const call = <A>(
    operation: () => Promise<{ ok: true; value: A } | { ok: false; error: Error }>,
  ) =>
    Effect.tryPromise({
      try: async () => {
        const result = await operation();
        if (!result.ok) throw result.error;
        return result.value;
      },
      catch: failure,
    });

  /** Runs `command` and returns its exit code and stdout; stderr is kept apart so parsing stays exact. */
  const exec = Effect.fn("GitWorkspace.exec")(function* (
    command: string | ReadonlyArray<string>,
    cwd: string,
  ) {
    let stdout = "";
    let stderr = "";
    const result = yield* call(() =>
      env.exec(
        command,
        {
          cwd,
          onOutput: (text, _context, info) => {
            if (info.stream === "stderr") stderr += text;
            else stdout += text;
          },
        },
        context,
      ),
    );
    return { exitCode: result.exitCode, stdout, stderr };
  });

  const git = Effect.fn("git")(function* (args: ReadonlyArray<string>, cwd = work) {
    const result = yield* exec(["git", ...author, ...args], cwd);
    if (result.exitCode !== 0)
      return yield* new WorkspaceError({
        message: `git ${args.join(" ")} failed: ${result.stderr.trim()}`,
      });
    return result.stdout;
  });

  const readText = (path: string) => call(() => env.readTextFile(path, context));
  const exists = (path: string) => call(() => env.exists(path, context));

  const prepare = Effect.fn("GitWorkspace.prepare")(function* (
    repo: { readonly owner: string; readonly name: string },
    baseSha: string,
  ) {
    if ((yield* exists(marker)) && (yield* readText(marker)).trim() === baseSha) return;
    const files = yield* github
      .fetchSource(repo, baseSha)
      .pipe(Effect.mapError((error) => new WorkspaceError({ message: error.message })));
    yield* exec(["rm", "-rf", work], root);
    yield* exec(["mkdir", "-p", work], root);
    for (const file of files) {
      const path = `${work}/${file.path}`;
      yield* exec(["mkdir", "-p", path.slice(0, path.lastIndexOf("/"))], root);
      yield* call(() => env.writeFile(path, file.content, context));
      if (file.executable) yield* exec(["chmod", "+x", path], root);
    }
    yield* git(["init", "-q"]);
    yield* git(["add", "-A"]);
    yield* git(["commit", "-q", "--allow-empty", "-m", `base ${baseSha}`]);
    // Written last: a prepare cut off before this point starts over.
    yield* call(() => env.writeFile(marker, baseSha, context));
  });

  /** The staged change set against the base commit, sorted by path. */
  const changes = Effect.fn("GitWorkspace.changes")(function* () {
    yield* git(["add", "-A"]);
    const fields = (yield* git(["diff", "--cached", "--name-status", "--no-renames", "-z", "HEAD"]))
      .split("\0")
      .filter((field) => field !== "");
    const files: Array<FileChange> = [];
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const status = fields[index];
      const path = fields[index + 1];
      if (status === undefined || path === undefined) continue;
      if (status === "D") {
        files.push({ path, change: "delete" });
        continue;
      }
      const content = yield* call(() => env.readBinaryFile(`${work}/${path}`, context));
      const mode = (yield* git(["ls-files", "-s", "--", path])).split(" ")[0];
      files.push({
        path,
        change: "write",
        content: Base64.encode(content),
        executable: mode === "100755",
      });
    }
    return files.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  });

  const validate = Effect.fn("GitWorkspace.validate")(function* () {
    const files = yield* changes();
    const diff = yield* git(["diff", "--cached", "--binary", "HEAD"]);
    const patch = Patch.make({ digest: yield* digestOf(files), diff, files });
    if (files.length === 0) return { passed: false, patch, evidence: "The run changed no files." };

    // Checks run against a frozen copy, so later edits cannot change what they approved.
    const frozen = `${root}/candidates/${patch.digest}`;
    yield* exec(["rm", "-rf", frozen], root);
    yield* git(["checkout-index", "-a", "-f", `--prefix=${frozen}/`]);
    yield* exec(["mkdir", "-p", `${root}/patches`], root);
    const json = yield* encodePatch(patch).pipe(Effect.mapError(failure));
    yield* call(() => env.writeFile(`${root}/patches/${patch.digest}.json`, json, context));

    let passed = true;
    const evidence: Array<string> = [];
    for (const check of checks) {
      const result = yield* exec(check, frozen);
      passed &&= result.exitCode === 0;
      evidence.push(`$ ${check}\n${result.stdout}${result.stderr}(exit ${result.exitCode})`);
    }
    return { passed, patch, evidence: evidence.join("\n\n") || "No checks are configured." };
  });

  const patch = Effect.fn("GitWorkspace.patch")(function* (digest: string) {
    const stored = yield* decodePatch(yield* readText(`${root}/patches/${digest}.json`)).pipe(
      Effect.mapError(failure),
    );
    // The file lives where the agent's commands can reach it, so only its digest vouches for it.
    if ((yield* digestOf(stored.files)) !== digest)
      return yield* new WorkspaceError({ message: `patch ${digest} was changed after validation` });
    return stored;
  });

  return Workspace.of({
    env: () => env,
    prepare,
    validate: Effect.fn("GitWorkspace.validateOneAtATime")(function* () {
      return yield* validating.withPermits(1)(validate());
    }),
    patch,
    quiesce: Effect.fn("GitWorkspace.quiesce")(function* () {
      yield* Effect.tryPromise({ try: () => env.cleanup(context), catch: failure });
    }),
  });
});

/** The workspace as local processes in a directory on this machine: for tests and local runs. */
export const LocalWorkspace = {
  layer: (options: { readonly root: string; readonly checks: ReadonlyArray<string> }) =>
    Layer.effect(
      Workspace,
      makeGitWorkspace({
        env: new NodeExecutionEnv({ cwd: `${options.root}/work` }),
        root: options.root,
        checks: options.checks,
      }),
    ),
};
