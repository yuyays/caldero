import type { SessionView } from "@puchero/contracts/inbox";
import { InboxUnavailable } from "@puchero/contracts/inbox";
import type { DecisionResult, Repo, SessionEvent } from "@puchero/domain";
import { type Context, Effect } from "effect";
import { Sessions } from "./inbox-http.ts";

/** The RPC boundary, including unknown transport outcomes, without the Cloudflare resource declaration. */
export interface SessionPeer<R> {
  view(): Effect.Effect<SessionView | null, never, R>;
  deliver(
    event: SessionEvent,
    eventId: string,
  ): Effect.Effect<
    { readonly result: DecisionResult; readonly view: SessionView } | null,
    never,
    R
  >;
  start(issue: number, event: SessionEvent, eventId: string): Effect.Effect<void, never, R>;
}

/** Reject foreign/malformed IDs before opening a DO. RPC faults do not prove whether admission committed. */
export const makeSessionDirectory = <R>(
  repo: Repo,
  lookup: (name: string) => SessionPeer<R>,
  context: Context.Context<R>,
) => {
  const prefix = `${repo.owner}/${repo.name}#`;
  const peer = (id: string) => {
    if (!id.startsWith(prefix)) return undefined;
    const suffix = id.slice(prefix.length);
    const issue = Number(suffix);
    return /^[1-9]\d*$/.test(suffix) && Number.isSafeInteger(issue) ? lookup(id) : undefined;
  };
  return Sessions.of({
    read: Effect.fn("Sessions.read")(
      function* (id) {
        const session = peer(id);
        return session === undefined ? null : yield* session.view();
      },
      Effect.provide(context),
      Effect.catchCause(() =>
        Effect.fail(new InboxUnavailable({ message: "Session is unavailable" })),
      ),
    ),
    deliver: Effect.fn("Sessions.deliver")(
      function* (id, event, eventId) {
        const session = peer(id);
        return session === undefined ? null : yield* session.deliver(event, eventId);
      },
      Effect.provide(context),
      Effect.catchCause(() =>
        Effect.fail(
          new InboxUnavailable({
            message: "Decision outcome is unknown; refresh the session before retrying",
          }),
        ),
      ),
    ),
    start: Effect.fn("Sessions.start")(
      function* (issue, event, deliveryId) {
        if (!Number.isSafeInteger(issue) || issue < 1)
          return yield* new InboxUnavailable({ message: "Invalid issue identity" });
        yield* lookup(`${prefix}${issue}`).start(issue, event, deliveryId);
        return undefined;
      },
      Effect.provide(context),
      Effect.catchCause(() =>
        Effect.fail(new InboxUnavailable({ message: "Session admission is unavailable" })),
      ),
    ),
  });
};
