import { defineDoc, type TaskId } from "@earendil-works/pi-durable";

/** Current session state and its atomic instruction/admission receipts. Always persist a complete base. */
export const SessionDoc = defineDoc<{
  state: string;
  seen: Record<string, string>;
  runs: Record<string, number>;
  tasks?: Array<TaskId>;
}>({
  kind: "puchero.session",
  version: 1,
  scope: "session",
  initial: () => ({ state: "", seen: {}, runs: {}, tasks: [] }),
  checkpointWhen: () => true,
});
