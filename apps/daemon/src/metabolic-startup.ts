import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { METABOLIC_KINDS, sha256Digest } from "@jevyr/protocol";
import { verifyMetabolicCalibration, type MetabolicCalibrationReport, type VerifiedMetabolicCalibration } from "@jevyr/runtime";

/** Missing calibration disables a kind. Malformed configured evidence fails startup. */
export function loadMetabolicCalibrations(projectRoot: string): readonly VerifiedMetabolicCalibration[] {
  const directory = join(projectRoot, ".jevyr", "metabolic-calibrations");
  if (!existsSync(directory)) return Object.freeze([]);
  const root = realpathSync(directory);
  let capturedBytes = 0;
  const boundedBytes = (file: string, maximum: number): Buffer => {
    const info = lstatSync(file);
    const rel = relative(root, realpathSync(file));
    if (!info.isFile() || info.isSymbolicLink() || info.size > maximum || rel === ".." || rel.startsWith(`..${sep}`)) throw new TypeError("Metabolic calibration evidence escaped its finite local store");
    const bytes = readFileSync(file);
    if (bytes.length !== info.size) throw new TypeError("Metabolic calibration evidence changed during capture");
    capturedBytes += bytes.length;
    if (capturedBytes > 96 * 1024 * 1024) throw new TypeError("Metabolic calibration store exceeds its total capture boundary");
    return bytes;
  };
  const results: VerifiedMetabolicCalibration[] = [];
  const observed = new Set<string>();
  for (const kind of METABOLIC_KINDS) {
    const file = join(root, `${kind}.json`);
    if (!existsSync(file)) continue;
    const report = JSON.parse(boundedBytes(file, 32 * 1024 * 1024).toString("utf8")) as MetabolicCalibrationReport;
    const verified = verifyMetabolicCalibration(report);
    if (verified.kind !== kind) throw new TypeError("Metabolic calibration file names a different ball");
    for (const trial of report.trials) {
      for (const digest of [...trial.observationArtifactDigests, ...trial.trace.map((action) => action.observationDigest)]) {
        if (observed.has(digest)) continue;
        if (observed.size >= 65_536) throw new TypeError("Metabolic calibration evidence inventory is too large");
        const bytes = boundedBytes(join(root, "artifacts", `${digest.slice(7)}.json`), 1024 * 1024);
        if (sha256Digest(bytes) !== digest) throw new TypeError("Metabolic calibration observation bytes do not match the report");
        observed.add(digest);
      }
    }
    results.push(verified);
  }
  return Object.freeze(results);
}
