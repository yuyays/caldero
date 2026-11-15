import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { Schema } from "effect";
import {
  CancelRequest,
  DecisionRequest,
  DecisionResponse,
  InboxForbidden,
  InboxMediaType,
  InboxNotFound,
  InboxUnauthorized,
  InboxUnavailable,
  InputRequest,
  SessionDetail,
  SessionSummary,
  StaleDecision,
} from "../schemas/session.ts";

export * from "../schemas/session.ts";
const errors = [
  InboxUnauthorized.pipe(HttpApiSchema.status(401)),
  InboxForbidden.pipe(HttpApiSchema.status(403)),
  InboxNotFound.pipe(HttpApiSchema.status(404)),
  InboxUnavailable.pipe(HttpApiSchema.status(503)),
  StaleDecision.pipe(HttpApiSchema.status(409)),
  InboxMediaType.pipe(HttpApiSchema.status(415)),
];
const params = { sessionId: Schema.String };
export class SessionsApi extends HttpApiGroup.make("sessions")
  .add(
    HttpApiEndpoint.get("list", "/sessions", {
      success: Schema.Array(SessionSummary),
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("get", "/sessions/:sessionId", {
      params,
      success: SessionDetail,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("approve", "/sessions/:sessionId/approve", {
      params,
      payload: DecisionRequest,
      success: DecisionResponse,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("reject", "/sessions/:sessionId/reject", {
      params,
      payload: DecisionRequest,
      success: DecisionResponse,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("cancel", "/sessions/:sessionId/cancel", {
      params,
      payload: CancelRequest,
      success: DecisionResponse,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("input", "/sessions/:sessionId/input", {
      params,
      payload: InputRequest,
      success: DecisionResponse,
      error: errors,
    }),
  ) {}

export class ViewerApi extends HttpApiGroup.make("viewer").add(
  HttpApiEndpoint.get("get", "/viewer", {
    success: Schema.Struct({ login: Schema.String }),
    error: errors,
  }),
) {}
export class InboxApi extends HttpApi.make("inbox-api")
  .add(SessionsApi)
  .add(ViewerApi)
  .prefix("/api") {}
