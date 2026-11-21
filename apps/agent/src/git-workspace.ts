import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { PublicCheck } from "@caldero/domain";
import { Effect, Schema, Semaphore } from "effect";
import { Base64, Hex } from "effect/encoding";
import {
  errorMessage,
  type Checkpoint,
  FileChange,
  type WorkspaceRecovery,
  WorkspaceStore,
  GitHub,
  Patch,
  Workspace,
  WorkspaceError,
} from "./ports.ts";

const background = BACKGROUND_CONTEXT;
const neverAborted = new AbortController().signal;
const author = ["-c", "user.name=caldero", "-c", "user.email=caldero@localhost"];
const decodePatch = Schema.decodeUnknownEffect(Schema.fromJsonString(Patch));
const filesJson = Schema.fromJsonString(Schema.Array(FileChange));
const decodeFiles = Schema.decodeUnknownEffect(filesJson);
const encodeFiles = Schema.encodeEffect(filesJson);
const encodePatch = Schema.encodeEffect(Schema.fromJsonString(Patch));

const failure = (error: unknown) => new WorkspaceError({ message: errorMessage(error) });

/** A change set's identity: the SHA-256 of its files, in path order. */
const digestOf = Effect.fn("digestOf")(function* (files: ReadonlyArray<FileChange>) {
  const bytes = yield* Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(files))),
    catch: (error) =>
      new WorkspaceError({
        message: `Could not fingerprint the change set: ${errorMessage(error)}`,
      }),
  });
  return Hex.encode(new Uint8Array(bytes));
});

/**
 * A git-tracked workspace over any Pi `ExecutionEnv`: the repository at its base commit lives in `<root>/work`, and
 * validated candidates are frozen under `<root>/candidates` and stored outside the workspace disk.
 * The environment adapters (local process, container) differ only in the `ExecutionEnv` they pass.
 */
export const makeGitWorkspace = Effect.fn("makeGitWorkspace")(function* (options: {
  readonly env: ExecutionEnv;
  readonly root: string;
  /** Shell commands that must all pass for a candidate to be proposed. */
  readonly checks: ReadonlyArray<string>;
  readonly publicChecks?: ReadonlyArray<PublicCheck>;
}) {
  const github = yield* GitHub;
  const store = yield* WorkspaceStore;
  // oxlint-disable-next-line caldero/runtime-boundary -- Pi ExecutionEnv is a Promise adapter
  const run = Effect.runPromiseWith(yield* Effect.context());
  const guarding = yield* Semaphore.make(1);
  const { env, root, checks } = options;
  let recoveryJournal: WorkspaceRecovery | undefined;
  // One validation at a time: each stages the whole index.
  const validating = yield* Semaphore.make(1);
  const work = `${root}/work`;
  const marker = `${work}/.git/caldero-base`;

  const call = <A>(
    operation: (
      context: typeof BACKGROUND_CONTEXT,
    ) => Promise<{ ok: true; value: A } | { ok: false; error: Error }>,
  ) =>
    Effect.tryPromise({
      try: async (signal) => {
        const result = await operation(withAbortSignal(signal, background));
        if (!result.ok) throw result.error;
        return result.value;
      },
      catch: failure,
    });

  /** Runs `command` and returns its exit code and stdout; stderr is kept apart so parsing stays exact. */
  const exec = Effect.fn("GitWorkspace.exec")(function* (
    command: string | ReadonlyArray<string>,
    cwd: string,
    allowFailure = false,
  ) {
    let stdout = "";
    let stderr = "";
    const result = yield* call((context) =>
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
    if (!allowFailure && result.exitCode !== 0)
      return yield* new WorkspaceError({
        message: `Workspace command failed (${result.exitCode}): ${stderr.trim()}`,
      });
    return { exitCode: result.exitCode, stdout, stderr };
  });

  const git = Effect.fn("git")(function* (args: ReadonlyArray<string>, cwd = work) {
    const result = yield* exec(["git", ...author, ...args], cwd);
    return result.stdout;
  });

  const readText = (path: string) => call((context) => env.readTextFile(path, context));
  const exists = (path: string) => call((context) => env.exists(path, context));

  const prepare = Effect.fn("GitWorkspace.prepare")(function* (
    repo: { readonly owner: string; readonly name: string },
    baseSha: string,
    reset = false,
  ) {
    if (!reset && (yield* exists(marker)) && (yield* readText(marker)).trim() === baseSha) return;
    const files = yield* github
      .fetchSource(repo, baseSha)
      .pipe(Effect.mapError((error) => new WorkspaceError({ message: error.message })));
    // Invalidate the old receipt before touching the worktree, including a same-base reset.
    yield* exec(["rm", "-f", marker], root);
    yield* exec(["rm", "-rf", work], root);
    yield* exec(["mkdir", "-p", work], root);
    for (const file of files) {
      const path = `${work}/${file.path}`;
      yield* exec(["mkdir", "-p", path.slice(0, path.lastIndexOf("/"))], root);
      yield* call((context) => env.writeFile(path, file.content, context));
      if (file.executable) yield* exec(["chmod", "+x", path], root);
    }
    yield* git(["init", "-q"]);
    yield* git(["add", "-A"]);
    yield* git(["commit", "-q", "--allow-empty", "-m", `base ${baseSha}`]);
    // Written last: a prepare cut off before this point starts over.
    yield* call((context) => env.writeFile(marker, baseSha, context));
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
      const content = yield* call((context) => env.readBinaryFile(`${work}/${path}`, context));
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

    // Checks run against a frozen copy, so later edits cannot change what was validated.
    const frozen = `${root}/candidates/${patch.digest}`;
    yield* exec(["rm", "-rf", frozen], root);
    yield* git(["checkout-index", "-a", "-f", `--prefix=${frozen}/`]);
    const json = yield* encodePatch(patch).pipe(Effect.mapError(failure));
    yield* store.put(`patches/${patch.digest}`, json);

    let passed = true;
    const evidence: Array<string> = [];
    const publicChecks = options.publicChecks ?? [];
    for (const check of [...checks, ...publicChecks.map(({ command }) => command)]) {
      const result = yield* exec(check, frozen, true);
      passed &&= result.exitCode === 0;
      evidence.push(`$ ${check}\n${result.stdout}${result.stderr}(exit ${result.exitCode})`);
    }
    return {
      passed,
      patch,
      evidence: evidence.join("\n\n") || "No checks are configured.",
      ...(passed && publicChecks.length > 0 ? { publicChecks } : {}),
    };
  });

  const patch = Effect.fn("GitWorkspace.patch")(function* (digest: string) {
    const stored = yield* decodePatch(yield* store.get(`patches/${digest}`)).pipe(
      Effect.mapError(failure),
    );
    // Verify the immutable store receipt before publication.
    if (stored.digest !== digest || (yield* digestOf(stored.files)) !== digest)
      return yield* new WorkspaceError({ message: `patch ${digest} was changed after validation` });
    return stored;
  });

  const checkpoint = Effect.fn("GitWorkspace.checkpoint")(function* (number: number) {
    const files = yield* changes();
    const digest = yield* digestOf(files);
    yield* store.put(
      `checkpoints/${digest}`,
      yield* encodeFiles(files).pipe(Effect.mapError(failure)),
    );
    return { number, digest } satisfies Checkpoint;
  });

  const restore = Effect.fn("GitWorkspace.restore")(function* (pointer: Checkpoint) {
    const files = yield* decodeFiles(yield* store.get(`checkpoints/${pointer.digest}`)).pipe(
      Effect.mapError(failure),
    );
    if ((yield* digestOf(files)) !== pointer.digest)
      return yield* new WorkspaceError({ message: "Checkpoint digest mismatch" });
    yield* git(["reset", "--hard", "HEAD"]);
    yield* git(["clean", "-fdx"]);
    // Remove old paths first, including directory/file replacements.
    const ordered = [
      ...files.filter((file) => file.change === "delete"),
      ...files.filter((file) => file.change === "write"),
    ];
    for (const file of ordered) {
      const path = `${work}/${file.path}`;
      if (file.change === "delete") yield* exec(["rm", "-f", path], root);
      else {
        const bytes = yield* Effect.fromResult(Base64.decode(file.content)).pipe(
          Effect.mapError(failure),
        );
        yield* exec(["rm", "-rf", path], root);
        yield* exec(["mkdir", "-p", path.slice(0, path.lastIndexOf("/"))], root);
        yield* call((context) => env.writeFile(path, bytes, context));
        yield* exec(["chmod", file.executable ? "755" : "644", path], root);
      }
    }
    return undefined;
  });

  const guard = Effect.fn("GitWorkspace.guard")(function* (
    recovery: WorkspaceRecovery,
    signal: AbortSignal = background.abortSignal ?? neverAborted,
  ) {
    const saved = yield* recovery.read(signal);
    yield* call((context) => env.createDir(root, { recursive: true }, context));
    const bootPath = `${root}/.boot`;
    if (!(yield* exists(bootPath)))
      yield* call((context) => env.writeFile(bootPath, crypto.randomUUID(), context));
    const bootId = (yield* readText(bootPath)).trim();
    if (saved.bootId === bootId) return;
    yield* prepare(saved.repo, saved.baseSha);
    if (saved.checkpoint !== null) yield* restore(saved.checkpoint);
    const notice =
      saved.bootId === null
        ? undefined
        : `Your workspace was restored to checkpoint ${saved.checkpoint?.number ?? 0}; re-check files before continuing.`;
    yield* recovery.restored(bootId, notice, signal);
  });

  /** Every environment operation checks the boot; internal snapshot/restore operations use the raw environment. */
  const guardedEnv = (recovery?: WorkspaceRecovery): ExecutionEnv => {
    recoveryJournal = recovery;
    return recovery === undefined
      ? env
      : new Proxy(env, {
          get(target, property, receiver) {
            const value: unknown = Reflect.get(target, property, receiver);
            if (typeof value !== "function" || property === "cleanup") return value;
            return async (...args: Array<unknown>) => {
              const invocation = args.at(-1);
              const signal =
                typeof invocation === "object" &&
                invocation !== null &&
                "abortSignal" in invocation &&
                invocation.abortSignal instanceof AbortSignal
                  ? invocation.abortSignal
                  : undefined;
              await run(guarding.withPermits(1)(guard(recovery, signal)), { signal });
              return Reflect.apply(value, target, args);
            };
          },
        });
  };

  return Workspace.of({
    env: guardedEnv,
    checkpoint: Effect.fn("GitWorkspace.checkpointGuarded")(function* (number: number) {
      if (recoveryJournal !== undefined) yield* guarding.withPermits(1)(guard(recoveryJournal));
      return yield* checkpoint(number);
    }),
    prepare,
    validate: Effect.fn("GitWorkspace.validateOneAtATime")(function* () {
      if (recoveryJournal !== undefined) yield* guarding.withPermits(1)(guard(recoveryJournal));
      return yield* validating.withPermits(1)(validate());
    }),
    patch,
    quiesce: Effect.fn("GitWorkspace.quiesce")(function* () {
      yield* Effect.tryPromise({
        try: (signal) => env.cleanup(withAbortSignal(signal, background)),
        catch: failure,
      });
    }),
  });
});
