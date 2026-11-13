// PROTOTYPE, throwaway: the per-session sandbox container (Docker locally under `alchemy dev`).
import * as Cloudflare from "@alchemy.run/cloudflare";

export class Sandbox extends Cloudflare.Container<Sandbox>()("Sandbox", {
  schedulingPolicy: "durable_object",
  context: `${import.meta.dirname}/../sandbox-image`,
}) {}
