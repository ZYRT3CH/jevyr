import {createHash} from 'node:crypto';
import {lstat,readFile,readdir,realpath,mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {releaseZip} from './app-release-zip.mjs';
import {verifyAppRelease} from './app-release-start.mjs';
import {validateAppCalibration} from './app-release-calibration.mjs';
import {captureCalibrationSnapshot} from './calibration-snapshot.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const hash=b=>`sha256:${createHash('sha256').update(b).digest('hex')}`;
const safe=x=>/^[A-Za-z0-9@_./+~-]+$/.test(x)&&x.split('/').every(v=>v&&v!=='.'&&v!=='..');
const fail=code=>{throw new Error(code);};
const own={core:'packages/core',protocol:'packages/protocol',runtime:'packages/runtime',sdk:'packages/sdk',growth:'packages/growth',memory:'packages/memory',daemon:'apps/daemon'};
const compilerPeers=new Set(['vite','@vitejs/plugin-react','@vitejs/plugin-rsc','@mdx-js/rollup','webpack','@types/react','react-devtools-core']);
async function read(path,max=128_000_000){const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.size>max)fail('APP_BUILD_INPUT_REFUSED');const b=await readFile(path),a=await lstat(path);if(b.length!==s.size||a.size!==s.size||a.ino!==s.ino||a.dev!==s.dev)fail('APP_BUILD_INPUT_CHANGED');return b;}
async function walk(directory,filter){const out=[];async function visit(rel=''){for(const name of(await readdir(join(directory,rel))).sort()){const p=rel?`${rel}/${name}`:name;if(!safe(p))fail(`APP_BUILD_PATH:${p}`);const s=await lstat(join(directory,p));if(s.isSymbolicLink())fail('APP_BUILD_NESTED_LINK');if(s.isDirectory()){if(filter(p,true))await visit(p);}else if(s.isFile()&&filter(p,false))out.push(p);}}await visit();return out;}
export async function sourcePackage(owner,name){
  if(!safe(name))fail('APP_DEPENDENCY_NAME');const r=createRequire(join(owner,'package.json'));
  // Package exports may be import-only (vinext). Resolve the same ordered
  // physical package roots without requiring a forbidden CommonJS export.
  for(const search of r.resolve.paths(name)??[]){const path=join(search,name);try{const directory=await realpath(path),m=JSON.parse((await read(join(directory,'package.json'))).toString());if(m.name!==name)fail('APP_DEPENDENCY_IDENTITY');return directory;}catch(e){if(e.code==='ENOENT'||e.code==='ENOTDIR')continue;throw e;}}
  fail(`APP_DEPENDENCY_UNAVAILABLE:${name}`);
}
async function checkFreeze(f){for(const e of f.files)if(!safe(e.path))fail(`APP_FREEZE_PATH_REFUSED:${e.path}`);else if(hash(await read(join(root,e.path)))!==e.digest)fail(`APP_FREEZE_CHANGED:${e.path}`);}
function packageFilter(name,p,dir){
  if(p.split('/').some(x=>['node_modules','.git','test','tests','__tests__','examples','benchmark','benchmarks'].includes(x)))return false;
  if(name==='tree-sitter-wasms')return dir?p==='out':['package.json','out/tree-sitter-javascript.wasm','out/tree-sitter-typescript.wasm','out/tree-sitter-python.wasm','out/tree-sitter-tsx.wasm'].includes(p);
  return dir||/\.(?:js|mjs|cjs|json|wasm|node|ttf|otf|woff2?|bin|exe|dll|so|dylib)$/.test(p)||/^licen[cs]e(?:\.|$)/i.test(p)||!p.split('/').at(-1).includes('.');
}
export async function buildAppRelease(destination,freezePath,calibrationPath){
  const target=resolve(destination),freezeRaw=await read(resolve(freezePath)),freeze=JSON.parse(freezeRaw.toString());
  if(freeze.protocol!=='jevyr.installed-method-freeze/1'||!Array.isArray(freeze.files)||freeze.files.length>10_000)fail('APP_FREEZE_REQUIRED');
  await checkFreeze(freeze);
  // Refuse pre-production CLI output rather than packaging its dev fallback.
  for(const p of ['apps/cli/dist/chamber-launch.js','apps/cli/dist/chamber-server.js','apps/chamber/dist/server/index.js','apps/chamber/dist/server/ssr/index.js','apps/chamber/dist/client/vinext-client-entry-manifest.json'])await read(join(root,p));
  if(!(await read(join(root,'apps/cli/dist/chamber-server.js'))).toString().includes('startProdServer'))fail('PRODUCTION_CHAMBER_REQUIRED');
  await mkdir(target);const files=new Map(),origins=new Map(),packages=[],omissions=[],placements=new Map(),queue=[];let total=0;
  async function add(p,from){if(!safe(p)||files.has(p))fail(`APP_DUPLICATE_PATH:${p}`);const b=await read(from);total+=b.length;if(files.size>=50_000||total>768_000_000)fail('APP_RELEASE_SIZE_LIMIT');files.set(p,Buffer.from(b));origins.set(p,{from,digest:hash(b)});}
  const enqueue=(manifest,from,to)=>{
    for(const name of Object.keys(manifest.dependencies??{}))if(!name.startsWith('@jevyr/'))queue.push({name,owner:from,ownerTarget:to});
    for(const name of Object.keys(manifest.peerDependencies??{})){
      if(name.startsWith('@jevyr/')||Object.hasOwn(manifest.dependencies??{},name))continue;
      if(compilerPeers.has(name)){omissions.push({owner:manifest.name,name,reason:'build-only-or-optional-peer-not-required-by-production-entry'});continue;}
      queue.push({name,owner:from,ownerTarget:to,optional:manifest.peerDependenciesMeta?.[name]?.optional===true});
    }
    for(const name of Object.keys(manifest.optionalDependencies??{})){
      if(name==='@anthropic-ai/claude-agent-sdk'){omissions.push({owner:manifest.name,name,reason:'optional-native-agent-inference-sdk-not-bundled-in-local-http-profile'});continue;}
      queue.push({name,owner:from,ownerTarget:to,optional:true});
    }
  };
  await add('start.mjs',join(root,'scripts/app-release-start.mjs'));
  await add('calibration.mjs',join(root,'scripts/app-release-calibration.mjs'));
  await add('calibration-snapshot.mjs',join(root,'scripts/calibration-snapshot.mjs'));
  files.set('package.json',Buffer.from('{"name":"jevyr-local-application-release","private":true,"type":"module","engines":{"node":"24.x"}}\n'));
  for(const [name,source]of Object.entries({...own,cli:'apps/cli',chamber:'apps/chamber'})){
    const from=join(root,source),to=['cli','chamber'].includes(name)?`apps/${name}`:`node_modules/@jevyr/${name}`,m=JSON.parse((await read(join(from,'package.json'))).toString());
    await add(`${to}/package.json`,join(from,'package.json'));packages.push({name:m.name,version:m.version,path:to,scope:'exact-workspace-compiled'});
    for(const p of await walk(join(from,'dist'),(p,dir)=>{
      if(['src','test','tests','.openai'].includes(p.split('/')[0]))return false;
      if(name==='chamber')return dir?['client','server'].includes(p.split('/')[0]):!/(?:\.map|wrangler\.json)$/.test(p);
      return dir||/\.(?:js|mjs|json|wasm|bin)$/.test(p);
    }))await add(`${to}/dist/${p}`,join(from,'dist',p));
    if(name==='core')for(const p of await walk(join(from,'policy'),(p,d)=>d||/\.(?:wasm|rego|json)$/.test(p)))await add(`${to}/policy/${p}`,join(from,'policy',p));
    if(name==='chamber')for(const p of await walk(join(from,'public'),()=>true))await add(`${to}/public/${p}`,join(from,'public',p));
    if(name==='chamber'){for(const dep of Object.keys(m.dependencies??{}))if(!dep.startsWith('@jevyr/'))queue.push({name:dep,owner:from,ownerTarget:to,...(dep==='vinext'?{forced:`${to}/node_modules/vinext`}:{})});}
    else enqueue(m,from,to);
  }
  function resolution(ownerTarget,name){let cursor=ownerTarget;for(;;){const candidate=`${cursor?`${cursor}/`:''}node_modules/${name}`;if(placements.has(candidate))return candidate;const upper=cursor.includes('/')?cursor.slice(0,cursor.lastIndexOf('/')):'';if(cursor==='')return undefined;cursor=upper;}}
  for(let i=0;i<queue.length;i++){
    const task=queue[i];if(!safe(task.name))fail('APP_DEPENDENCY_NAME');let from;
    try{from=await sourcePackage(task.owner,task.name);}catch(e){if(task.optional){omissions.push({owner:task.ownerTarget,name:task.name,reason:'optional-dependency-unavailable-on-builder-platform'});continue;}throw e;}
    const raw=await read(join(from,'package.json')),m=JSON.parse(raw.toString());if(m.name!==task.name)fail('APP_DEPENDENCY_IDENTITY');
    const accepts=(items,value)=>!Array.isArray(items)||(!items.includes(`!${value}`)&&(items.every(x=>x.startsWith('!'))||items.includes(value)));
    if(!accepts(m.os,process.platform)||!accepts(m.cpu,process.arch)){if(!task.optional)fail(`APP_REQUIRED_PLATFORM_DEPENDENCY:${m.name}`);omissions.push({owner:task.ownerTarget,name:m.name,reason:'optional-dependency-for-another-platform'});continue;}
    const id=hash(raw),prior=resolution(task.ownerTarget,task.name);
    if(!task.forced&&prior&&placements.get(prior)===id)continue;
    const global=`node_modules/${task.name}`;
    const to=task.forced??(placements.has(global)?`${task.ownerTarget}/node_modules/${task.name}`:global);
    if(placements.has(to)){if(placements.get(to)!==id)fail('APP_DEPENDENCY_PLACEMENT_CONFLICT');continue;}
    placements.set(to,id);if(placements.size>512)fail('APP_DEPENDENCY_COUNT');
    packages.push({name:m.name,version:m.version,path:to,scope:'production-dependency',...(m.os?{os:m.os}:{}),...(m.cpu?{cpu:m.cpu}:{})});
    for(const p of await walk(from,(p,d)=>packageFilter(m.name,p,d)))await add(`${to}/${p}`,join(from,p));enqueue(m,from,to);
  }
  let calibration=null,capturedCalibration;
  if(calibrationPath){
    const from=await realpath(resolve(calibrationPath)),rel=relative(join(root,'artifacts'),from);if(rel.startsWith('..')||isAbsolute(rel))fail('CONTROLLED_ARTIFACT_CALIBRATION_REQUIRED');
    capturedCalibration=await captureCalibrationSnapshot(from);
    capturedCalibration=new Map([...capturedCalibration].filter(([p])=>/^(?:Mass|Refraction|Polarity|Fission|Inertia)\.json$/.test(p)||p==='independent-verification.json'||/^artifacts\/[a-f0-9]{64}\.json$/.test(p)));
    const R=await import('../packages/runtime/dist/index.js'),checked=validateAppCalibration(capturedCalibration,R.metabolicImplementationDigest(),R.verifyMetabolicCalibration);
    calibration={protocol:'jevyr.app-calibration-resource/1',path:'resources/metabolic-calibration',implementationDigest:checked.implementationDigest,independentVerificationDigest:checked.independentVerificationDigest,files:capturedCalibration.size,totalBytes:[...capturedCalibration.values()].reduce((n,b)=>n+b.length,0),scope:checked.consumerVerification};
    for(const [p,b]of capturedCalibration){const to=`${calibration.path}/${p}`;if(!safe(to)||files.has(to))fail('APP_CALIBRATION_PATH');files.set(to,Buffer.from(b));}
  }
  const inventory=[...files].sort(([a],[b])=>a<b?-1:1).map(([path,b])=>({path,digest:hash(b),byteLength:b.length}));
  const manifest={protocol:'jevyr.local-application-release/1',node:'24.x',platform:process.platform,architecture:process.arch,entry:'apps/cli/dist/main.js',freezeDigest:hash(freezeRaw),packages:packages.sort((a,b)=>a.path<b.path?-1:1),files:inventory,totalBytes:inventory.reduce((n,f)=>n+f.byteLength,0),omissions,calibration,scope:'Local Node24 production application; exact compiled bytes, separate caller-owned project and state. External/native inference substrates, Docker/Podman engines, model weights, private project/governance state and signing keys are not bundled. Optional finite calibration resources are explicitly listed. Local build evidence is unsigned; obtain trusted ZIP and manifest digests independently.'};
  const manifestBytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n'),digest=hash(manifestBytes);files.set('release.json',manifestBytes);
  for(const [p,b]of files){await mkdir(dirname(join(target,p)),{recursive:true});await writeFile(join(target,p),b,{flag:'wx'});}
  if(calibration){const {verifyMetabolicExperiment}=await import('../benchmarks/verify-metabolic-calibration.mjs');const actual=await verifyMetabolicExperiment(join(target,calibration.path));const prior=JSON.parse(capturedCalibration.get('independent-verification.json').toString());if(!actual.valid||actual.diagnostic||actual.independentlyExecutedTrustedSources!==320||JSON.stringify(actual.reports)!==JSON.stringify(prior.reports)||actual.verifiedArtifacts!==prior.verifiedArtifacts)fail('APP_CALIBRATION_DESTINATION_VERIFICATION');}
  for(const v of origins.values())if(hash(await read(v.from))!==v.digest)fail('APP_SOURCE_RACED');await checkFreeze(freeze);await verifyAppRelease(target,digest);
  const zip=releaseZip(files);await writeFile(`${target}.zip`,zip,{flag:'wx'});
  const receipt={protocol:'jevyr.app-release-build/1',directory:target,releaseDigest:digest,zipDigest:hash(zip),zipBytes:zip.length,files:inventory.length,totalBytes:manifest.totalBytes,packages:packages.length,frozenFiles:freeze.files.length,frozenUnchanged:true,platform:process.platform,architecture:process.arch,omissions};
  await writeFile(`${target}.build.json`,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});return receipt;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length<4||process.argv.length>5)throw Error('Usage: node scripts/app-release-build.mjs NEW_DIRECTORY APPROVED_COMPILED_FREEZE_JSON [VERIFIED_CONTROLLED_CALIBRATION_ARTIFACT_DIRECTORY]');
  buildAppRelease(process.argv[2],process.argv[3],process.argv[4]).then(r=>process.stdout.write(JSON.stringify(r)+'\n')).catch(e=>{process.stderr.write(e.stack+'\n');process.exitCode=1;});
}
