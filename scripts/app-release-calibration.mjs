import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {lstat,mkdir,open,readFile,realpath,rename,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {captureCalibrationSnapshot,publishCalibrationSnapshot} from './calibration-snapshot.mjs';

const hash=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const kinds=['Mass','Refraction','Polarity','Fission','Inertia'];
const scope='Trusted release bytes of finite paired scheduler measurements; consumer checks do not rerun an experiment and do not establish live-model efficacy.';
export function validateAppCalibration(files,method,verifyReport){
  const value=name=>{const bytes=files.get(name);assert.ok(bytes,`APP_CALIBRATION_MISSING:${name}`);return JSON.parse(bytes.toString('utf8'));};
  const independent=value('independent-verification.json');
  assert.equal(independent.protocol,'jevyr.metabolic-experiment-verification/1');assert.equal(independent.valid,true);assert.equal(independent.diagnostic,false);
  assert.equal(independent.independentlyExecutedTrustedSources,320);assert.deepEqual(independent.reports.map(r=>r.kind).sort(),[...kinds].sort());
  const calibrations=[];
  for(const kind of kinds){
    const report=value(`${kind}.json`);assert.equal(report.kind,kind);assert.equal(report.implementationDigest,method,'APP_CALIBRATION_METHOD_MISMATCH');
    const verified=verifyReport(report),measured=independent.reports.find(r=>r.kind===kind);
    assert.equal(measured.digest,report.digest);assert.deepEqual(measured.summary,verified.summary);assert.equal(verified.summary.pairedSeeds,64);assert.equal(verified.maximumDose,2);
    calibrations.push({kind,digest:verified.summary.digest,maximumDose:verified.maximumDose});
  }
  return {implementationDigest:method,calibrations,independentVerificationDigest:hash(files.get('independent-verification.json')),consumerVerification:scope};
}
async function absent(path){try{await lstat(path);return false;}catch(e){if(e.code==='ENOENT')return true;throw e;}}
async function stableParent(path,expected){const info=await lstat(path);assert.ok(info.isDirectory()&&!info.isSymbolicLink(),'APP_CALIBRATION_PARENT_ALIAS');assert.equal(await realpath(path),path,'APP_CALIBRATION_PARENT_ALIAS');if(expected){assert.equal(info.dev,expected.dev);assert.equal(info.ino,expected.ino);}return info;}

/** Internal publisher: no partial report ever becomes the daemon's configured directory. */
export async function publishAppCalibration(files,project,installation,validatePublished){
  assert.equal(await realpath(project),project,'APP_CALIBRATION_PROJECT_ALIAS');
  const parent=join(project,'.jevyr');await mkdir(parent,{recursive:true});const parentInfo=await stableParent(parent),destination=join(parent,'metabolic-calibrations');
  const lockPath=join(parent,'.metabolic-calibration-install.lock'),lock=await open(lockPath,'wx',0o600),stamp=randomUUID();
  await lock.writeFile(stamp);await lock.sync();await lock.close();
  const staging=join(parent,`.metabolic-calibration-staging-${stamp}`);
  try{
    assert.ok(await absent(destination),'APP_CALIBRATION_DESTINATION_EXISTS');await stableParent(parent,parentInfo);
    const completed=await publishCalibrationSnapshot(files,staging,installation,validatePublished);
    await stableParent(parent,parentInfo);assert.ok(await absent(destination),'APP_CALIBRATION_DESTINATION_EXISTS');
    // Same-parent publication only. Never copy/merge over another installation.
    await rename(staging,destination);await stableParent(parent,parentInfo);
    return {protocol:'jevyr.app-calibration-installation/1',destination,snapshotEntries:completed.snapshot.length,...installation};
  }finally{
    // A failed staging tree is retained for inspection; remove only our own lock.
    if((await readFile(lockPath,'utf8'))===stamp)await unlink(lockPath);
  }
}
export async function installAppCalibration(release,manifest,project){
  const descriptor=manifest.calibration;assert.ok(descriptor,'APP_CALIBRATION_NOT_BUNDLED');
  assert.equal(descriptor.protocol,'jevyr.app-calibration-resource/1');assert.equal(descriptor.path,'resources/metabolic-calibration');
  const files=new Map();
  for(const item of manifest.files){
    if(!item.path.startsWith(`${descriptor.path}/`))continue;
    const path=join(release,item.path),info=await lstat(path);assert.ok(info.isFile()&&!info.isSymbolicLink()&&info.nlink===1&&info.size===item.byteLength&&info.size<=32*1024*1024);
    const bytes=await readFile(path);assert.equal(bytes.length,item.byteLength);assert.equal(hash(bytes),item.digest,'APP_CALIBRATION_RESOURCE_CHANGED');files.set(item.path.slice(descriptor.path.length+1),Buffer.from(bytes));
  }
  assert.equal(files.size,descriptor.files);assert.equal([...files.values()].reduce((n,b)=>n+b.length,0),descriptor.totalBytes);
  const runtime=await import(pathToFileURL(join(release,'node_modules/@jevyr/runtime/dist/index.js')).href);
  const checked=validateAppCalibration(files,runtime.metabolicImplementationDigest(),runtime.verifyMetabolicCalibration);
  assert.equal(checked.implementationDigest,descriptor.implementationDigest);assert.equal(checked.independentVerificationDigest,descriptor.independentVerificationDigest);
  const installation={protocol:'jevyr.metabolic-calibration-installation/1',...checked,installedAt:new Date().toISOString(),application:'next-daemon-startup',empiricalModelCalibration:false};
  return publishAppCalibration(files,resolve(project),installation,async directory=>{
    const captured=await captureCalibrationSnapshot(directory);assert.deepEqual(validateAppCalibration(captured,runtime.metabolicImplementationDigest(),runtime.verifyMetabolicCalibration),checked);
  });
}
