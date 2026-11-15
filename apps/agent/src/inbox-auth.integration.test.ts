import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SignJWT } from "jose";
import { makeInboxAuth } from "./inbox-auth.ts";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...keys.publicKey.export({ format: "jwk" }), kid: "test", alg: "RS256", use: "sig" };

describe("Inbox authentication", () => {
  it.effect(
    "verifies Access signature and claims, then maps only the verified email to a GitHub login",
    () =>
      Effect.gen(function* () {
        const server = yield* Effect.acquireRelease(
          Effect.promise(
            () =>
              new Promise<ReturnType<typeof createServer>>((resolve) => {
                const peer = createServer((_request, response) => {
                  response.setHeader("Content-Type", "application/json");
                  response.end(JSON.stringify({ keys: [jwk] }));
                });
                peer.listen(0, "127.0.0.1", () => resolve(peer));
              }),
          ),
          (peer) =>
            Effect.promise(() => new Promise<void>((resolve) => peer.close(() => resolve()))),
        );
        const address = server.address();
        if (address === null || typeof address === "string")
          return yield* Effect.die(new Error("Missing port"));
        const issuer = `http://127.0.0.1:${address.port}`;
        const auth = yield* makeInboxAuth({
          mode: "access",
          issuer,
          audience: "inbox",
          approvers: { "ann@example.com": "ann" },
        });
        const token = (
          options: {
            email?: string;
            audience?: string;
            expires?: number;
            issuer?: string;
            nbf?: number;
          } = {},
        ) =>
          Effect.promise(() =>
            new SignJWT({ email: options.email ?? "ann@example.com" })
              .setProtectedHeader({ alg: "RS256", kid: "test" })
              .setSubject("subject-ann")
              .setIssuer(options.issuer ?? issuer)
              .setAudience(options.audience ?? "inbox")
              .setIssuedAt(0)
              .setNotBefore(options.nbf ?? 0)
              .setExpirationTime(options.expires ?? 1000)
              .sign(keys.privateKey),
          );
        expect(yield* auth.authenticate({ "cf-access-jwt-assertion": yield* token() })).toEqual({
          login: "ann",
        });
        for (const invalid of [
          "",
          "broken",
          yield* token({ audience: "another-app" }),
          yield* token({ issuer: "https://attacker.test" }),
          yield* token({ expires: -1000 }),
          yield* token({ nbf: 1000 }),
        ]) {
          expect(
            yield* auth
              .authenticate({
                "cf-access-jwt-assertion": invalid,
                "cf-access-authenticated-user-email": "ann@example.com",
              })
              .pipe(Effect.flip),
          ).toMatchObject({ _tag: "InboxUnauthorized" });
        }
        expect(
          yield* auth
            .authenticate({ "cf-access-jwt-assertion": yield* token({ email: "eve@example.com" }) })
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "InboxForbidden" });
        const valid = yield* token();
        expect(
          yield* auth
            .authenticate({
              "cf-access-jwt-assertion":
                valid.slice(0, valid.lastIndexOf(".") + 1) + "invalid-signature",
            })
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "InboxUnauthorized" });
        yield* Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve())));
        const offline = yield* makeInboxAuth({
          mode: "access",
          issuer,
          audience: "inbox",
          approvers: { "ann@example.com": "ann" },
        });
        expect(
          yield* offline.authenticate({ "cf-access-jwt-assertion": valid }).pipe(Effect.flip),
        ).toMatchObject({ _tag: "InboxUnauthorized" });
        return undefined;
      }),
  );

  it.effect("requires explicit local credentials or a nonempty production approver mapping", () =>
    Effect.gen(function* () {
      expect(
        yield* makeInboxAuth({
          mode: "access",
          issuer: "https://team.cloudflareaccess.com",
          audience: "inbox",
          approvers: {},
        }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "InboxUnavailable" });
      const dev = yield* makeInboxAuth({ mode: "dev", token: "local-only", login: "ann" });
      expect(yield* dev.authenticate({ authorization: "Bearer local-only" })).toEqual({
        login: "ann",
      });
      expect(
        yield* dev.authenticate({ authorization: "Bearer wrong" }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "InboxUnauthorized" });
    }),
  );
});
