import * as Cloudflare from "@alchemy.run/cloudflare";

/** The Worker and session objects project into the same D1 resource. */
export const inboxDatabase = Cloudflare.D1.Database("Sessions", {
  migrations: new URL("../migrations", import.meta.url).pathname,
});
