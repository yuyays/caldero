import { Repo } from "@puchero/domain";
import { Schema } from "effect";

export const LocalWatchReceipt = Schema.Struct({
  version: Schema.Literal(1),
  repo: Repo,
  pending: Schema.Array(Schema.Int.check(Schema.isGreaterThan(0))),
  settled: Schema.Array(Schema.Int.check(Schema.isGreaterThan(0))),
});
export const decodeWatchReceipt = Schema.decodeUnknownEffect(
  Schema.fromJsonString(LocalWatchReceipt),
);
