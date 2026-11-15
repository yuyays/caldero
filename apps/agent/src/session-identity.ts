import type { Repo } from "@puchero/domain";

/** The issue encoded in the canonical named DO; stored metadata never supplies this expectation. */
export const sessionIssue = (repo: Repo, name: string | undefined): number | undefined => {
  const prefix = `${repo.owner}/${repo.name}#`;
  if (name === undefined || !name.startsWith(prefix)) return undefined;
  const suffix = name.slice(prefix.length);
  const issue = Number(suffix);
  return /^[1-9]\d*$/.test(suffix) && Number.isSafeInteger(issue) ? issue : undefined;
};
