// PROTOTYPE, throwaway stack. Run locally with `pnpm dev` (workerd + Docker).
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Api from "./src/worker.ts";

export default Alchemy.Stack(
  "PucheroSpikePiDoContainer",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const api = yield* Api;
    return { url: api.url.as<string>() };
  }),
);
