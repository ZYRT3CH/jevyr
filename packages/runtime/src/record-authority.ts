const RECORD_COMMIT_AUTHORITY: unique symbol = Symbol("jevyr.record-commit-authority");

/** Nominal, runtime-checked capability. This module is intentionally not public-package exported. */
export interface RecordCommitAuthority {
  readonly [RECORD_COMMIT_AUTHORITY]: true;
}

const claimedRepositories = new WeakSet<object>();
const authorityOwners = new WeakMap<object, object>();

/** Claims the sole normal-Record signing capability for one repository instance. */
export function claimRecordCommitAuthority(repository: object): RecordCommitAuthority {
  if (claimedRepositories.has(repository)) {
    throw new Error("This CaseRepository already has a normal-Record authority owner");
  }
  const authority = Object.freeze(Object.create(null)) as RecordCommitAuthority;
  claimedRepositories.add(repository);
  authorityOwners.set(authority, repository);
  return authority;
}

export function assertRecordCommitAuthority(
  repository: object,
  authority: unknown,
): asserts authority is RecordCommitAuthority {
  if (typeof authority !== "object" || authority === null || authorityOwners.get(authority) !== repository) {
    throw new Error("Normal Record signing requires Bone's unforgeable repository authority");
  }
}
