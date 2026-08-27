import { execFileSync } from "node:child_process";

export interface EvaluationSourceSnapshot {
  readonly sourceCommit: string;
  readonly allowedResultChanges: readonly string[];
}

export interface EvaluationSourceRequirements {
  readonly expectedSourceCommit?: string;
  readonly operation?: string;
  readonly publicRemoteTrackingRef?: string;
}

export function assertCommittedEvaluationSource(
  allowedResultDirectories: readonly string[],
  requirements: EvaluationSourceRequirements = {},
): EvaluationSourceSnapshot {
  const sourceCommit = git("rev-parse", "HEAD");
  if (requirements.publicRemoteTrackingRef !== undefined) {
    assertSourceCommitReachableFromPublicRef(sourceCommit, requirements.publicRemoteTrackingRef);
  }
  if (requirements.expectedSourceCommit !== undefined) {
    assertEvaluationSourceCommit(
      sourceCommit,
      requirements.expectedSourceCommit,
      requirements.operation ?? "Evaluation operation",
    );
  }
  const stagedPaths = gitLines("diff", "--cached", "--name-only", "--relative");
  const changedPaths = unstagedWorktreePaths();
  const allowedResultChanges = assertEvaluationSourceState(
    stagedPaths,
    changedPaths,
    allowedResultDirectories,
  );
  return {
    sourceCommit,
    allowedResultChanges,
  };
}

export function assertSourceCommitReachableFromPublicRef(
  sourceCommit: string,
  publicRemoteTrackingRef: string,
  isAncestor: (commit: string, remoteTrackingRef: string) => boolean = gitIsAncestor,
): void {
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) {
    throw new Error("Evaluation source commit is not a full Git commit hash");
  }
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+$/u.test(publicRemoteTrackingRef)) {
    throw new Error("Evaluation public remote-tracking reference is invalid");
  }
  if (!isAncestor(sourceCommit, publicRemoteTrackingRef)) {
    throw new Error(
      `Evaluation source commit ${sourceCommit} is not reachable from ${publicRemoteTrackingRef}; publish the exact source commit before collecting final evidence`,
    );
  }
}

export function assertEvaluationSourceState(
  stagedPaths: readonly string[],
  changedPaths: readonly string[],
  allowedResultDirectories: readonly string[],
): string[] {
  if (stagedPaths.length > 0) {
    throw new Error(
      `Evaluation operation requires a clean index; staged paths: ${stagedPaths.join(", ")}`,
    );
  }
  const unexpected = unexpectedEvaluationSourcePaths(changedPaths, allowedResultDirectories);
  if (unexpected.length > 0) {
    throw new Error(
      `Evaluation operation found source changes outside the result directories: ${unexpected.join(", ")}`,
    );
  }
  return changedPaths.filter((path) => !unexpected.includes(path));
}

export function assertEvaluationSourceCommit(
  currentSourceCommit: string,
  collectionSourceCommit: string,
  operation: string,
): void {
  if (currentSourceCommit !== collectionSourceCommit) {
    throw new Error(
      `${operation} requires the checked-out source commit ${collectionSourceCommit} recorded by the collection manifest; current HEAD is ${currentSourceCommit}`,
    );
  }
}

export function unexpectedEvaluationSourcePaths(
  changedPaths: readonly string[],
  allowedResultDirectories: readonly string[],
): string[] {
  const allowed = allowedResultDirectories
    .map(normalizePath)
    .map((path) => path.replace(/\/$/u, ""));
  return [...new Set(changedPaths.map(normalizePath))]
    .filter(
      (path) =>
        !allowed.some((directory) => path === directory || path.startsWith(`${directory}/`)),
    )
    .sort();
}

function unstagedWorktreePaths(): string[] {
  return [
    ...gitLines("diff", "--name-only", "--relative"),
    ...gitLines("ls-files", "--others", "--exclude-standard"),
  ];
}

function gitLines(...arguments_: string[]): string[] {
  const output = git(...arguments_);
  return output.length === 0 ? [] : output.split(/\r?\n/u).filter((path) => path.length > 0);
}

function git(...arguments_: string[]): string {
  return execFileSync("git", arguments_, { encoding: "utf8" }).trim();
}

function gitIsAncestor(commit: string, remoteTrackingRef: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commit, remoteTrackingRef], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function normalizePath(path: string): string {
  return path.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
}
