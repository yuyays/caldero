import { timingSafeEqual } from "node:crypto";
import { InboxForbidden, InboxUnauthorized, InboxUnavailable } from "@puchero/contracts/inbox";
import { Context, DateTime, Effect } from "effect";
import { createRemoteJWKSet, jwtVerify } from "jose";

export type AuthOptions =
  | { readonly mode: "dev"; readonly token: string; readonly login: string }
  | {
      readonly mode: "access";
      readonly issuer: string;
      readonly audience: string;
      readonly approvers: Readonly<Record<string, string>>;
    };

export class InboxAuth extends Context.Service<
  InboxAuth,
  {
    readonly authenticate: (
      headers: Readonly<Record<string, string>>,
    ) => Effect.Effect<{ readonly login: string }, InboxUnauthorized | InboxForbidden>;
  }
>()("puchero/InboxAuth") {}

/** Explicit dev mode is the only path accepting a static token. Access identity comes only from verified claims. */
export const makeInboxAuth = Effect.fn("makeInboxAuth")(function* (options: AuthOptions) {
  if (options.mode === "dev") {
    if (options.token.length < 1 || options.login.length < 1)
      return yield* new InboxUnavailable({
        message: "Development authentication is not configured",
      });
    const expected = Buffer.from(`Bearer ${options.token}`);
    return InboxAuth.of({
      authenticate: Effect.fn("DevAuth.authenticate")(function* (headers) {
        const actual = Buffer.from(headers.authorization ?? "");
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
          return yield* new InboxUnauthorized({ message: "A local access token is required" });
        return { login: options.login };
      }),
    });
  }
  const approvers = new Map(
    Object.entries(options.approvers).map(([email, login]) => [email.toLowerCase(), login]),
  );
  if (
    approvers.size === 0 ||
    !options.issuer ||
    !options.audience ||
    [...approvers].some(([email, login]) => !email.includes("@") || !login)
  )
    return yield* new InboxUnavailable({
      message: "Cloudflare Access and its approver mapping must be configured",
    });
  // The deployment fixes the issuer and cert endpoint. Token-supplied jku/x5u values are never used.
  const jwks = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", options.issuer), {
    timeoutDuration: 5000,
    cacheMaxAge: 300_000,
    cooldownDuration: 30_000,
  });
  return InboxAuth.of({
    authenticate: Effect.fn("AccessAuth.authenticate")(function* (headers) {
      const token = headers["cf-access-jwt-assertion"];
      if (!token)
        return yield* new InboxUnauthorized({ message: "Sign in through Cloudflare Access" });
      const currentDate = DateTime.toDateUtc(yield* DateTime.now);
      const verified = yield* Effect.tryPromise({
        try: () =>
          jwtVerify(token, jwks, {
            issuer: options.issuer,
            audience: options.audience,
            algorithms: ["RS256"],
            requiredClaims: ["exp", "iat", "sub", "email"],
            clockTolerance: 60,
            currentDate,
          }),
        catch: () => new InboxUnauthorized({ message: "The Access session could not be verified" }),
      });
      const email = verified.payload.email;
      const login = typeof email === "string" ? approvers.get(email.toLowerCase()) : undefined;
      if (login === undefined)
        return yield* new InboxForbidden({ message: "This identity is not an allowed reviewer" });
      return { login };
    }),
  });
});
