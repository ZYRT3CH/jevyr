// One authorized Windows browser-opener request. Never saves or seals a Case.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,readdir,access} from 'node:fs/promises';
import {delimiter,dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

if(process.argv.length!==4)throw Error('Usage: node scripts/app-release-cold-proof.mjs SUCCESSFUL_OUTSIDE_CHECKOUT_PROOF_REPORT NEW_OUTPUT_DIRECTORY');
if(process.platform!=='win32')throw Error('This measured opener probe is Windows-only');
const prior=JSON.parse(await readFile(resolve(process.argv[2]),'utf8')),output=resolve(process.argv[3]);await mkdir(output);
assert.equal(prior.failed,0);const {application,project,releaseDigest}=prior,config=JSON.parse(await readFile(join(project,'.jevyr/config.json'),'utf8'));
const target=join(project,'editable-source');await mkdir(target);await writeFile(join(target,'README.md'),'Generated packaging fixture for editable Airlock prefill. No Case is authorized by opening the editor.\n');
const expected=new URL('/airlock',config.chamberUrl);expected.searchParams.set('api',new URL(config.daemonUrl).toString());expected.searchParams.set('subject-kind','directory');expected.searchParams.set('subject-locator',target);
const caseDirectory=join(project,'.jevyr/cases'),before=(await readdir(caseDirectory)).sort(),checks=[];
let child,stdout='',stderr='',error;
const record=prior.checks.find(c=>c.name==='fresh-signed-http-record-and-offline-replay')?.detail;
async function save(state){await writeFile(join(output,'report.json'),JSON.stringify({protocol:'jevyr.standalone-cold-airlock-proof/1',state,node:process.version,application,project,releaseDigest,expectedUrl:expected.toString(),recordUrl:record?.recordUrl??null,checks,passed:checks.filter(c=>c.passed).length,failed:checks.filter(c=>!c.passed).length,browserScope:'Production CLI issued the real local opener request. DOM observation is separate evidence, if an independent browser report is provided. No browser registration changes; no automatic Draft save or Case Seal.',scope:'Cold production application launch from retained standalone extraction; generated subject prefill only, no models/Docker/Case execution.'},null,2)+'\n');}
async function check(name,fn){try{const detail=await fn();checks.push({name,passed:true,...(detail?{detail}:{})});}catch(e){checks.push({name,passed:false,error:e.message});throw e;}finally{await save('running');}}
const exists=path=>access(path).then(()=>true,()=>false);
try{
  const {verifyAppRelease}=await import(pathToFileURL(join(application,'start.mjs')).href);
  await check('initial-exact-inventory',async()=>{await verifyAppRelease(application,releaseDigest);});
  await check('both-services-cold',async()=>{for(const origin of [config.daemonUrl,config.chamberUrl]){let available=false;try{available=(await fetch(origin,{signal:AbortSignal.timeout(1000)})).ok;}catch{}assert.equal(available,false,`Unexpected service already present at ${origin}`);}});
  const args=['--project',project,'--release-digest',releaseDigest,'--','airlock',target,'--json'];
  const code=`import {main} from ${JSON.stringify(pathToFileURL(join(application,'start.mjs')).href)};process.stdin.once('data',()=>{process.emit('SIGTERM');process.stdin.destroy();});await main(${JSON.stringify(args)});`;
  const system=process.env.SystemRoot??'C:\\Windows',env=Object.fromEntries(['SystemRoot','WINDIR','TEMP','TMP','HOME','USERPROFILE','LOCALAPPDATA'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
  env.PATH=[dirname(process.execPath),join(system,'System32'),join(system,'System32/WindowsPowerShell/v1.0')].join(delimiter);env.NODE_ENV='production';
  child=spawn(process.execPath,['--input-type=module','-e',code],{cwd:project,env,windowsHide:true,stdio:['pipe','pipe','pipe']});child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  await check('exact-editor-url-announced-before-service-shutdown',async()=>{
    const deadline=Date.now()+90000;let launch;
    while(Date.now()<deadline){assert.equal(child.exitCode,null,stderr);for(const line of stdout.split(/\r?\n/)){try{const row=JSON.parse(line);if(row.protocol==='jevyr.airlock-launch/1')launch=row;}catch{}}
      if(launch)break;await new Promise(r=>setTimeout(r,200));}
    assert.ok(launch,'No Airlock announcement while owned services remain alive');assert.equal(launch.url,expected.toString());assert.equal(launch.sealed,false);assert.equal(child.exitCode,null);
    const [health,page]=await Promise.all([fetch(`${config.daemonUrl}/health`),fetch(expected)]);assert.equal(health.status,200);assert.equal(page.status,200);await writeFile(join(output,'airlock.html'),await page.text());
    return {announcement:launch,launcherAlive:true,daemonStatus:health.status,editorStatus:page.status};
  });
  await save('ready-for-independent-browser');process.stdout.write(JSON.stringify({state:'ready-for-independent-browser',url:expected.toString(),recordUrl:record?.recordUrl??null,report:join(output,'report.json'),stopFile:join(output,'stop')})+'\n');
  // A bounded external observer may inspect DOM; it can release this hold by
  // creating this proof-owned stop file. The CLI and its children stay intact.
  const deadline=Date.now()+180000;while(Date.now()<deadline&&!await exists(join(output,'stop')))await new Promise(r=>setTimeout(r,500));
  await check('opening-editor-did-not-seal',async()=>{assert.deepEqual((await readdir(caseDirectory)).sort(),before);});
  child.stdin.write('stop');await new Promise((done,reject)=>{const timer=setTimeout(()=>reject(Error('Owned application did not stop')),20000);child.once('close',()=>{clearTimeout(timer);done();});});child=undefined;
  await check('application-bytes-unchanged',async()=>{await verifyAppRelease(application,releaseDigest);});
}catch(e){error=e;process.stderr.write(e.stack+'\n');}
finally{if(child){child.stdin.write('stop');await new Promise(r=>setTimeout(r,1000));if(child.exitCode===null)child.kill();}await writeFile(join(output,'launcher.stdout.log'),stdout);await writeFile(join(output,'launcher.stderr.log'),stderr);await save(error?'failed':'complete');}
process.exitCode=error?1:0;
