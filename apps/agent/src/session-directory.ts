import type { SessionView } from "@puchero/contracts/inbox";
import { InboxUnavailable, SessionFault } from "@puchero/contracts/inbox";
import type { DecisionResult, Repo, SessionEvent } from "@puchero/domain";
import { type Context, Cause, Effect } from "effect";
import { RpcCallError } from "alchemy/Rpc";
import { sessionIssue } from "./session-identity.ts";
import { Sessions } from "./inbox-http.ts";

/** The RPC boundary, including unknown transport outcomes, without the Cloudflare resource declaration. */
export interface SessionPeer<R> {
  view(): Effect.Effect<SessionView | null, SessionFault | RpcCallError, R>;
  deliver(
    event: SessionEvent,
    eventId: string,
  ): Effect.Effect<
    { readonly result: DecisionResult; readonly view: SessionView } | null,
    SessionFault | RpcCallError,
    R
  >;
  start(
    issue: number,
    event: SessionEvent,
    eventId: string,
  ): Effect.Effect<void, SessionFault | RpcCallError, R>;
}

/** Runtime flags describe transport availability, not whether a mutation committed. Never infer from text or .remote. */
const transportReason = (error: unknown): "temporary" | "overloaded" | "unknown" => {
  const transport = error instanceof RpcCallError ? error.cause : error;
  if (typeof transport !== "object" || transport === null) return "unknown";
  if ("overloaded" in transport && transport.overloaded === true) return "overloaded";
  if ("retryable" in transport && transport.retryable === true) return "temporary";
  return "unknown";
};
const rpcFailure =
  (message: string) =>
  (
    cause: Cause.Cause<SessionFault | RpcCallError | InboxUnavailable>,
  ): Effect.Effect<never, SessionFault | InboxUnavailable> => {
    const error = Cause.squash(cause);
    return error instanceof SessionFault || error instanceof InboxUnavailable
      ? Effect.fail(error)
      : Effect.fail(new InboxUnavailable({ message, reason: transportReason(error) }));
  };

/** Reject foreign/malformed IDs before opening a DO. RPC faults do not prove whether admission committed. */
export const makeSessionDirectory = <R>(
  repo: Repo,
  lookup: (name: string) => SessionPeer<R>,
  context: Context.Context<R>,
) => {
  const prefix = `${repo.owner}/${repo.name}#`;
  const peer = (id: string) => (sessionIssue(repo, id) === undefined ? undefined : lookup(id));
  return Sessions.of({
    read: Effect.fn("Sessions.read")(
      function* (id) {
        const session = peer(id);
        return session === undefined ? null : yield* session.view();
      },
      Effect.provide(context),
      Effect.catchCause(rpcFailure("Session is unavailable")),
    ),
    deliver: Effect.fn("Sessions.deliver")(
      function* (id, event, eventId) {
        const session = peer(id);
        return session === undefined ? null : yield* session.deliver(event, eventId);
      },
      Effect.provide(context),
      Effect.catchCause(
        rpcFailure("Decision outcome is unknown; refresh the session before retrying"),
      ),
    ),
    start: Effect.fn("Sessions.start")(
      function* (issue, event, deliveryId) {
        if (!Number.isSafeInteger(issue) || issue < 1)
          return yield* new InboxUnavailable({
            message: "Issue identity is invalid",
            reason: "unknown",
          });
        yield* lookup(`${prefix}${issue}`).start(issue, event, deliveryId);
        return undefined;
      },
      Effect.provide(context),
      Effect.catchCause(
        rpcFailure("Admission outcome is unknown; refresh the session before retrying"),
      ),
    ),
  });
};
