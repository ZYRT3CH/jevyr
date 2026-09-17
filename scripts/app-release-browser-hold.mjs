// Restart only the owned extracted application for separate read-only DOM QA.
import {readFile,access} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
if(process.argv.length!==4)throw Error('Usage: node scripts/app-release-browser-hold.mjs APP_PROOF_REPORT PROOF_OWNED_STOP_FILE');
const report=JSON.parse(await readFile(resolve(process.argv[2]),'utf8')),stop=resolve(process.argv[3]);
if(report.failed!==0)throw Error('A completed successful package proof is required');
const retained=Object.fromEntries(['SystemRoot','WINDIR','TEMP','TMP'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
for(const key of Object.keys(process.env))delete process.env[key];Object.assign(process.env,retained,{PATH:dirname(process.execPath),NODE_ENV:'production'});
const {main}=await import(pathToFileURL(join(report.application,'start.mjs')).href);
const deadline=Date.now()+300000;
const interval=setInterval(async()=>{if(Date.now()>=deadline||await access(stop).then(()=>true,()=>false)){clearInterval(interval);process.emit('SIGTERM');}},500);
try{await main(['--project',report.project,'--release-digest',report.releaseDigest,'--','up','--no-open','--json']);}finally{clearInterval(interval);}
