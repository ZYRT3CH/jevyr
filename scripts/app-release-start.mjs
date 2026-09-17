// Authenticate this bootstrap through a trusted ZIP digest before executing it.
// The unsigned local manifest is an integrity inventory, not a publisher identity.
import {createHash} from 'node:crypto';
import {lstat,readFile,readdir,realpath} from 'node:fs/promises';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const hash=b=>`sha256:${createHash('sha256').update(b).digest('hex')}`;
const sha=x=>typeof x==='string'&&/^sha256:[a-f0-9]{64}$/.test(x);
const safe=x=>typeof x==='string'&&/^[A-Za-z0-9@_./+~-]+$/.test(x)&&x.split('/').every(v=>v&&v!=='.'&&v!=='..');
const fail=code=>{throw new Error(code);};
const inside=(base,target)=>{const r=relative(base,target);return r===''||(!r.startsWith('..')&&!isAbsolute(r));};
async function physicalDestination(path){let cursor=resolve(path),suffix=[];for(;;){try{return resolve(await realpath(cursor),...suffix);}catch(e){if(e.code!=='ENOENT')throw e;const parent=dirname(cursor);if(parent===cursor)throw e;suffix.unshift(cursor.slice(parent.length).replace(/^[/\\]+/,''));cursor=parent;}}}
async function file(path,maximum){const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>maximum)fail('APP_RELEASE_FILE_REFUSED');const b=await readFile(path),a=await lstat(path);if(b.length!==s.size||a.dev!==s.dev||a.ino!==s.ino||a.size!==s.size||a.isSymbolicLink())fail('APP_RELEASE_FILE_CHANGED');return b;}
export async function verifyAppRelease(root,expectedDigest){
  if(!sha(expectedDigest))fail('EXTERNAL_APP_RELEASE_DIGEST_REQUIRED');
  const s=await lstat(root),physical=await realpath(root);if(!s.isDirectory()||s.isSymbolicLink()||physical.toLowerCase()!==resolve(root).toLowerCase())fail('APP_RELEASE_ROOT_ALIAS');
  const raw=await file(join(root,'release.json'),16_000_000);if(hash(raw)!==expectedDigest)fail('APP_RELEASE_MANIFEST_MISMATCH');const m=JSON.parse(raw.toString('utf8'));
  const keys=['protocol','node','platform','architecture','entry','freezeDigest','packages','files','totalBytes','omissions','calibration','scope'];
  if(!m||Object.keys(m).sort().join()!==keys.sort().join()||m.protocol!=='jevyr.local-application-release/1'||m.node!=='24.x'||m.entry!=='apps/cli/dist/main.js'
    ||!sha(m.freezeDigest)||!Array.isArray(m.files)||!m.files.length||m.files.length>50_000||!Array.isArray(m.packages)||m.packages.length>512
    ||!Array.isArray(m.omissions)||m.omissions.length>512||!Number.isSafeInteger(m.totalBytes)||m.totalBytes>768_000_000
    ||!['win32','linux','darwin'].includes(m.platform)||!['x64','arm64'].includes(m.architecture)||typeof m.scope!=='string'||m.scope.length>2048
    ||!raw.equals(Buffer.from(JSON.stringify(m,null,2)+'\n')))fail('APP_RELEASE_MANIFEST_SHAPE');
  const files=new Map(),directories=new Set();let previous='',total=0;
  for(const f of m.files){if(!f||Object.keys(f).sort().join()!=='byteLength,digest,path'||!safe(f.path)||f.path==='release.json'||f.path<=previous||!sha(f.digest)||!Number.isSafeInteger(f.byteLength)||f.byteLength<0||f.byteLength>128_000_000)fail('APP_RELEASE_MANIFEST_ENTRY');files.set(f.path,f);previous=f.path;total+=f.byteLength;const parts=f.path.split('/');parts.pop();while(parts.length){directories.add(parts.join('/'));parts.pop();}}
  if(total!==m.totalBytes||!files.has('start.mjs')||!files.has(m.entry))fail('APP_RELEASE_MANIFEST_TOTAL');
  if(m.calibration!==null){const c=m.calibration;if(!c||Object.keys(c).sort().join()!=='files,implementationDigest,independentVerificationDigest,path,protocol,scope,totalBytes'||c.protocol!=='jevyr.app-calibration-resource/1'||c.path!=='resources/metabolic-calibration'||!sha(c.implementationDigest)||!sha(c.independentVerificationDigest)||!Number.isSafeInteger(c.files)||c.files<6||c.files>20_000||!Number.isSafeInteger(c.totalBytes)||c.totalBytes<1||c.totalBytes>128*1024*1024||typeof c.scope!=='string'||c.scope.length>1024)fail('APP_CALIBRATION_DESCRIPTOR');}
  const found=new Set();async function walk(rel=''){for(const name of await readdir(join(root,rel))){const p=rel?`${rel}/${name}`:name;if(!safe(p))fail('APP_RELEASE_PATH');const info=await lstat(join(root,p));if(info.isSymbolicLink())fail('APP_RELEASE_LINK');if(info.isDirectory()){if(!directories.has(p))fail('APP_RELEASE_EXTRA_DIRECTORY');await walk(p);continue;}if(p==='release.json')continue;const f=files.get(p);if(!f)fail('APP_RELEASE_EXTRA_FILE');const bytes=await file(join(root,p),128_000_000);if(bytes.length!==f.byteLength||hash(bytes)!==f.digest)fail(`APP_RELEASE_FILE_MISMATCH:${p}`);found.add(p);}}
  await walk();if(found.size!==files.size)fail('APP_RELEASE_FILE_MISSING');return m;
}
export async function main(args=process.argv.slice(2)){
  if(args.length<6||args[0]!=='--project'||args[2]!=='--release-digest'||args[4]!=='--')fail('Usage: start.mjs --project ABSOLUTE_DIRECTORY --release-digest sha256:... -- COMMAND [OPTIONS]');
  if(Number(process.versions.node.split('.')[0])!==24)fail('NODE_24_REQUIRED');
  if(process.env.NODE_OPTIONS||process.env.NODE_PATH||process.execArgv.some(v=>/^--(?:conditions|loader|experimental-loader|import|require)(?:=|$)/.test(v)))fail('DEFAULT_NODE_LOADER_REQUIRED');
  if(!isAbsolute(args[1]))fail('ABSOLUTE_PROJECT_REQUIRED');
  const root=dirname(fileURLToPath(import.meta.url)),project=await realpath(args[1]),stat=await lstat(project);
  if(!stat.isDirectory()||inside(root,project)||inside(project,root))fail('APPLICATION_AND_PROJECT_MUST_BE_SEPARATE');
  const store=await physicalDestination(process.env.JEVYR_DATA_DIR?resolve(project,process.env.JEVYR_DATA_DIR):join(project,'.jevyr'));
  if(inside(root,store)||inside(store,root))fail('APPLICATION_AND_STORE_MUST_BE_SEPARATE');
  const release=await verifyAppRelease(root,args[3]);
  if(release.platform!==process.platform||release.architecture!==process.arch)fail('APP_RELEASE_PLATFORM_MISMATCH');
  // Config, Cases, signing keys and operator choices belong to the project.
  // INIT_CWD would otherwise override the explicit caller-chosen directory.
  delete process.env.INIT_CWD;process.chdir(project);
  if(args[5]==='install-calibration'){
    if(args.length!==6)fail('INSTALL_CALIBRATION_TAKES_NO_OPTIONS');
    const {installAppCalibration}=await import(pathToFileURL(join(root,'calibration.mjs')).href);
    process.stdout.write(JSON.stringify(await installAppCalibration(root,release,project))+'\n');return;
  }
  const cli=await import(pathToFileURL(join(root,release.entry)).href);
  process.exitCode=await cli.main(args.slice(5));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{process.stderr.write(JSON.stringify({protocol:'jevyr.app-release-refusal/1',error:e.message})+'\n');process.exitCode=1;});
