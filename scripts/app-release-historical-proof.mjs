// Matching-authority replay of retained ordinary proofs, never new adjudication.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {cp,mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
if(process.argv.length!==5)throw Error('Usage: node scripts/app-release-historical-proof.mjs APP_PROOF_REPORT ORIGINAL_LIFECYCLE_ROOT NEW_OUTPUT_DIRECTORY');
const checkout=resolve(dirname(fileURLToPath(import.meta.url)),'..'),app=JSON.parse(await readFile(resolve(process.argv[2]),'utf8')),lifecycle=resolve(process.argv[3]),output=resolve(process.argv[4]);await mkdir(output);
assert.equal(app.failed,0);const original=JSON.parse(await readFile(join(lifecycle,'report.json'),'utf8')),independent=JSON.parse(await readFile(join(lifecycle,'independent-verification.json'),'utf8')),isolated=await mkdtemp(join(tmpdir(),'jevyr-historical-app-proof-')),attempts=[];
assert.equal(independent.valid,true);
for(const name of ['clean','defect','unsupported']){
  const baseline=independent.results.find(a=>a.fixture===name),fixture={...original.attempts.find(a=>a.fixture===name),recordDigest:baseline?.recordDigest};assert.ok(baseline);assert.equal(baseline.caseId,fixture.caseId);assert.equal(baseline.valid,true);assert.match(fixture.recordDigest,/^sha256:[a-f0-9]{64}$/);assert.match(fixture.signerKeyId,/^sha256:[a-f0-9]{64}$/);
  const proof=join(isolated,name);await cp(join(lifecycle,name,'proof'),proof,{recursive:true,errorOnExist:true,force:false});
  const code=`import assert from 'node:assert/strict';import fs from 'node:fs';
assert.throws(()=>fs.readFileSync(${JSON.stringify(join(checkout,'package.json'))}),e=>e.code==='ERR_ACCESS_DENIED');assert.equal(process.permission.has('child'),false);assert.equal(process.permission.has('worker'),false);assert.equal(process.permission.has('fs.write'),false);
const {verifyAppRelease}=await import(${JSON.stringify(pathToFileURL(join(app.application,'start.mjs')).href)});await verifyAppRelease(${JSON.stringify(app.application)},${JSON.stringify(app.releaseDigest)});
const {verifyLocalProof}=await import(${JSON.stringify(pathToFileURL(join(app.application,'apps/cli/dist/local-proof.js')).href)});
const result=await verifyLocalProof(${JSON.stringify(proof)},${JSON.stringify(fixture.signerKeyId)});assert.equal(result.valid,true,JSON.stringify(result.problems));assert.equal(result.recordDigest,${JSON.stringify(fixture.recordDigest)});assert.equal(result.verdict.judgment,${JSON.stringify(baseline.judgment)});
process.stdout.write(JSON.stringify({result,checkoutRead:'denied',child:'denied',worker:'denied',write:'denied'})+'\\n');`;
  const result=await new Promise((done,reject)=>{const p=spawn(process.execPath,['--permission',`--allow-fs-read=${app.application}`,`--allow-fs-read=${proof}`,'--input-type=module','-e',code],{cwd:isolated,env:{SystemRoot:process.env.SystemRoot??'',TEMP:isolated,TMP:isolated},windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';const timer=setTimeout(()=>p.kill(),90000);p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.once('error',reject);p.once('close',(exitCode,signal)=>{clearTimeout(timer);done({exitCode,signal,stdout,stderr});});});
  await writeFile(join(output,`${name}.stdout.json`),result.stdout);await writeFile(join(output,`${name}.stderr.log`),result.stderr);
  let parsed;try{parsed=JSON.parse(result.stdout);}catch{}
  attempts.push({fixture:name,passed:result.exitCode===0&&parsed?.result?.valid===true,exitCode:result.exitCode,caseId:parsed?.result?.caseId??fixture.caseId,expectedRecordDigest:fixture.recordDigest,recordDigest:parsed?.result?.recordDigest??null,judgment:parsed?.result?.verdict?.judgment??null,signerKeyId:fixture.signerKeyId,isolatedProof:proof});
  await writeFile(join(output,'report.json'),JSON.stringify({protocol:'jevyr.final-application-historical-replay/1',node:process.version,application:app.application,releaseDigest:app.releaseDigest,sourceLifecycle:lifecycle,attempts,passed:attempts.filter(a=>a.passed).length,failed:attempts.filter(a=>!a.passed).length,scope:'Fresh Node24 processes using final archive compiled CLI and retained ordinary proofs. Exact original Record digests and separate fixture signer pins. Node filesystem permissions deny checkout reads and deny child/worker/write. No daemon, models, Docker, source compilation or new adjudication. Valid only while required producer/kernel/certificate-checker identities remain supported; this is not universal legacy dispatch.'},null,2)+'\n');
  process.stdout.write(JSON.stringify(attempts.at(-1))+'\n');
}
process.exitCode=attempts.every(a=>a.passed)?0:1;
