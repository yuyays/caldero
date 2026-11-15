import { queryOptions } from "@tanstack/react-query";
import {
  InboxApi,
  InboxUnauthorized,
  InboxForbidden,
  StaleDecision,
  SessionFault,
  InboxUnavailable,
  type DecisionRequest,
  type SessionView,
} from "@puchero/contracts/inbox";
import { Effect, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";

let localToken = "";
/** Local tokens live only in memory. Production uses the same-origin Access cookie. */
export const setLocalToken = (token: string) => {
  localToken = token;
};
const client = Effect.runSync(
  HttpApiClient.make(InboxApi, { baseUrl: "" }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, (input, init) => {
      const headers = new Headers(init?.headers);
      if (localToken) headers.set("authorization", `Bearer ${localToken}`);
      return fetch(input, { ...init, headers, credentials: "same-origin" });
    }),
  ),
);
export const sessionsQuery = queryOptions({
  queryKey: ["sessions"],
  queryFn: ({ signal }) => Effect.runPromise(client.sessions.list({}), { signal }),
  refetchInterval: 5000,
  retry: false,
});
export const viewerQuery = queryOptions({
  queryKey: ["viewer"],
  queryFn: ({ signal }) => Effect.runPromise(client.viewer.get({}), { signal }),
  retry: false,
});
export const detailQuery = (sessionId: string) =>
  queryOptions({
    queryKey: ["session", sessionId],
    queryFn: ({ signal }) =>
      Effect.runPromise(client.sessions.get({ params: { sessionId } }), { signal }),
    refetchInterval: (query) =>
      sessionFault(query.state.error) || overloaded(query.state.error) ? false : 3000,
    retry: false,
  });
export type Action = "approve" | "reject" | "cancel" | "input";
export interface Decision {
  action: Action;
  view: SessionView;
  requestId: string;
  text?: string;
}
/** Each click binds its request to the candidate actually displayed, never a later background result. */
export const decideSession = ({ action, view, requestId, text }: Decision) => {
  const params = { sessionId: view.state.sessionId };
  if (action === "cancel")
    return Effect.runPromise(client.sessions.cancel({ params, payload: { requestId } }));
  if (action === "input")
    return Effect.runPromise(
      client.sessions.input({ params, payload: { requestId, text: text ?? "" } }),
    );
  if (view.state.candidate === null) return Promise.reject(new Error("Review a candidate first"));
  const payload: typeof DecisionRequest.Type = { binding: view.state.candidate.binding, requestId };
  return Effect.runPromise(client.sessions[action]({ params, payload }));
};
export const staleDecision = Schema.is(StaleDecision);
export const sessionFault = Schema.is(SessionFault);
const unavailable = Schema.is(InboxUnavailable);
const overloaded = (error: unknown) => unavailable(error) && error.reason === "overloaded";
const unauthorized = Schema.is(InboxUnauthorized);
const forbidden = Schema.is(InboxForbidden);
export const inboxError = (error: unknown) => {
  if (unauthorized(error))
    return "Sign in through Cloudflare Access. For local development, enter your local token below.";
  if (forbidden(error))
    return "Your account cannot review this inbox. Check the configured reviewer mapping.";
  if (sessionFault(error))
    return "This session cannot be read. Operator repair is required; retrying will not fix it.";
  if (staleDecision(error)) return error.message;
  if (overloaded(error))
    return "The session is overloaded. Wait before refreshing; the last decision's outcome may be unknown.";
  if (unavailable(error))
    return "The inbox is unavailable. Refresh to check the session before retrying a decision.";
  return "The inbox could not be reached. Refresh to try again.";
};
