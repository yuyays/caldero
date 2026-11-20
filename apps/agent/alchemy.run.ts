import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { Effect } from "effect";
import Agent from "./src/worker.ts";

export default Alchemy.Stack(
  "CalderoAgent",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const agent = yield* Agent;
    return { url: agent.url.as<string>() };
  }),
);
