import * as Cloudflare from "@alchemy.run/cloudflare";

/** One disk per session; a fresh boot writes a new marker before pi-env is started. */
export class Sandbox extends Cloudflare.Container<Sandbox>()("Sandbox", {
  schedulingPolicy: "durable_object",
  context: `${import.meta.dirname}/../sandbox-image`,
}) {}
