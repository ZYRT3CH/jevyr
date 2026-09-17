import { describe, expect, it } from "vitest";
import { digestJson, sha256Digest, type JsonValue, type SealedCase } from "@jevyr/protocol";
import { assertPairedTrialSealedBindings, validatePairedFixtureCorpus, type PairedBenchmarkConfiguration, type PairedGenomeTrial } from "../src/index.js";
const hash = (value: unknown) => digestJson(value as JsonValue);
function fixture() {
  const body = { protocol: "jevyr.paired-genome-fixture/1", impulse: "`node check.mjs` exits with code 0.", constraints: [], scope: "finite mechanical fixture",
    cases: [{ caseKey: "clean", clean: true, files: [{path:"check.mjs",content:"process.exit(0)"}], criticalDefectIds: [] }], predicates: [{id:"check",command:"node check.mjs",expectedExitCode:0}] };
  const corpus = validatePairedFixtureCorpus({ ...body, digest: hash(body) });
  const profile = { profileDigest: sha256Digest("profile") }, providers = [{ id:"fixture",version:sha256Digest("implementation") }];
  const sealed = { genomeDigest: sha256Digest("genome"), subjectMaterialCaptureDigest: sha256Digest("subject"), intent: { seed:"ab".repeat(32), impulse:body.impulse, constraints:[],
    subjects:[{id:"fixture-source",kind:"text",mediaType:"application/json",locator:JSON.stringify(body.cases[0]!.files)}] },
    intentContract:{criticalObligations:[{oracle:{kind:"command_exit_code",operand:"node check.mjs",expected:"0"}}]} } as unknown as SealedCase;
  const config = { genomeDigest:sealed.genomeDigest, runtimeProfile:profile } as PairedBenchmarkConfiguration;
  const trial = { caseKey:"clean",corpusDigest:corpus.digest,subjectDigest:sealed.subjectMaterialCaptureDigest,seedDigest:sha256Digest(sealed.intent.seed),providerSnapshotDigest:hash(providers),clean:true,criticalDefectIds:[] } as unknown as PairedGenomeTrial;
  const policy = {mindCapabilities:providers,genomeSelection:{runtimeCompilation:{runtimeProfile:profile}}};
  return { corpus, sealed, config, trial, policy };
}
describe("sealed paired-trial scientific identity", () => {
  it("binds operator labels to the exact fixture, raw sealed seed and startup configuration", () => {
    const f = fixture(); expect(() => assertPairedTrialSealedBindings(f.trial, f.config, f.corpus, f.sealed, f.policy)).not.toThrow();
    for (const key of ["seedDigest", "providerSnapshotDigest", "subjectDigest", "corpusDigest"] as const) expect(() => assertPairedTrialSealedBindings({...f.trial,[key]:sha256Digest("changed")},f.config,f.corpus,f.sealed,f.policy)).toThrow();
    expect(() => assertPairedTrialSealedBindings({...f.trial,clean:false},f.config,f.corpus,f.sealed,f.policy)).toThrow(/labels/u);
    expect(() => assertPairedTrialSealedBindings(f.trial,{...f.config,runtimeProfile:{...f.config.runtimeProfile,generation:99}},f.corpus,f.sealed,f.policy)).toThrow(/runtime profile/u);
    const changed = structuredClone(f.sealed); (changed.intent.subjects[0] as {locator:string}).locator = '[{"path":"check.mjs","content":"process.exit(1)"}]';
    expect(() => assertPairedTrialSealedBindings(f.trial,f.config,f.corpus,changed,f.policy)).toThrow(/source bytes/u);
  });
  it("refuses changed manifests, traversal and undeclared defect identities", () => {
    const f = fixture(), modified = structuredClone(f.corpus); (modified as {scope:string}).scope = "different";
    expect(() => validatePairedFixtureCorpus(modified)).toThrow(/digest/u);
    const {digest:ignored,...body} = f.corpus;
    for (const path of ["../escape", "C:/absolute", "dir/../escape"]) {
      const changed = {...body,cases:[{...body.cases[0]!,files:[{path,content:"x"}]}]};
      expect(() => validatePairedFixtureCorpus({...changed,digest:hash(changed)})).toThrow(/path/u);
    }
  });
});
