// This entry belongs to a separately authenticated replay release. A manifest
// digest is integrity metadata, not a signature or an independent trust source.
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import dns from 'node:dns';

const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const safe = value => typeof value === 'string' && /^[A-Za-z0-9@_./+-]+$/.test(value) && value.split('/').every(p => p && p !== '.' && p !== '..');
const shape = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const sha = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const fail = reason => { throw new Error(reason); };
async function plain(path, maximum) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maximum) fail('RELEASE_NON_ORDINARY_FILE');
  const bytes = await readFile(path), after = await lstat(path);
  if (bytes.length !== info.size || info.ino !== after.ino || info.dev !== after.dev || info.size !== after.size || after.isSymbolicLink()) fail('RELEASE_FILE_CHANGED');
  return bytes;
}
function denyNetwork() {
  const denied = () => fail('REPLAY_RELEASE_NETWORK_DISABLED');
  globalThis.fetch = denied;
  for (const [api, names] of [[net, ['connect','createConnection','createServer']], [tls, ['connect','createServer']], [http, ['request','get','createServer']], [https, ['request','get','createServer']], [dgram, ['createSocket']]]) for (const name of names) api[name] = denied;
  net.Socket.prototype.connect = denied;
  for (const name of ['lookup','resolve','resolve4','resolve6','reverse']) { dns[name] = denied; dns.promises[name] = denied; }
  syncBuiltinESMExports();
}

export async function verifyReleaseInventory(root, expectedDigest) {
  if (!sha(expectedDigest)) fail('EXTERNAL_RELEASE_DIGEST_REQUIRED');
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || resolve(await realpath(root)).toLowerCase() !== resolve(root).toLowerCase()) fail('RELEASE_ROOT_ALIAS');
  const bytes = await plain(join(root, 'release.json'), 4_000_000);
  if (digest(bytes) !== expectedDigest) fail('RELEASE_MANIFEST_DIGEST_MISMATCH');
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (!shape(manifest, ['protocol','node','entry','freeze','packages','files','totalBytes','scope']) || manifest.protocol !== 'jevyr.replay-release/1' || manifest.node !== '24.x'
    || manifest.entry !== 'cli/local-proof.js' || !sha(manifest.freeze) || !Array.isArray(manifest.packages) || manifest.packages.length > 128
    || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 20_000 || !Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes > 256_000_000
    || typeof manifest.scope !== 'string' || manifest.scope.length > 2048 || !bytes.equals(Buffer.from(JSON.stringify(manifest, null, 2)+'\n'))) fail('RELEASE_MANIFEST_SHAPE');
  const expected = new Map(); let last = '', total = 0;
  for (const item of manifest.files) {
    if (!shape(item,['path','digest','byteLength']) || !safe(item.path) || item.path === 'release.json' || item.path <= last || !sha(item.digest)
      || !Number.isSafeInteger(item.byteLength) || item.byteLength < 0 || item.byteLength > 32_000_000) fail('RELEASE_MANIFEST_ENTRY');
    expected.set(item.path,item); last=item.path; total+=item.byteLength;
  }
  if (total !== manifest.totalBytes || !expected.has('verify.mjs') || !expected.has(manifest.entry)) fail('RELEASE_MANIFEST_TOTAL');
  const directories=new Set(); for(const path of expected.keys()) { const parts=path.split('/'); parts.pop(); while(parts.length){directories.add(parts.join('/'));parts.pop();} }
  const found = new Set();
  async function walk(relative='') {
    for (const name of await readdir(join(root,relative))) {
      const path=relative?`${relative}/${name}`:name;
      if (!safe(path)) fail('RELEASE_PATH_REFUSED');
      const info=await lstat(join(root,path)); if(info.isSymbolicLink()) fail('RELEASE_LINK_REFUSED');
      if(info.isDirectory()) { if(!directories.has(path))fail('RELEASE_EXTRA_DIRECTORY');await walk(path);continue; }
      if(path==='release.json')continue;
      const expectedFile=expected.get(path);if(!expectedFile)fail('RELEASE_EXTRA_FILE');
      const content=await plain(join(root,path),32_000_000);
      if(content.length!==expectedFile.byteLength || digest(content)!==expectedFile.digest)fail(`RELEASE_FILE_MISMATCH:${path}`);
      found.add(path);
    }
  }
  await walk(); if(found.size!==expected.size)fail('RELEASE_FILE_MISSING');
  return manifest;
}

export async function main(args=process.argv.slice(2)) {
  const options={};
  if(args.length!==6)fail('Usage: verify.mjs --proof ABSOLUTE_DIRECTORY --signer-key sha256:... --release-digest sha256:...');
  for(let i=0;i<args.length;i+=2){if(!['--proof','--signer-key','--release-digest'].includes(args[i])||Object.hasOwn(options,args[i]))fail('RELEASE_ARGUMENTS');options[args[i]]=args[i+1];}
  if(!sha(options['--signer-key'])||!sha(options['--release-digest']))fail('EXTERNAL_TRUST_PINS_REQUIRED');
  if(Number(process.versions.node.split('.')[0])!==24)fail('NODE_24_REQUIRED');
  if(!process.permission || process.permission.has('child') || process.permission.has('worker') || process.permission.has('fs.write')) fail('READ_ONLY_NODE_PERMISSION_MODE_REQUIRED');
  const root=dirname(fileURLToPath(import.meta.url)), proof=resolve(options['--proof']);
  const inventory=await verifyReleaseInventory(root,options['--release-digest']);
  denyNetwork();
  const {verifyLocalProof}=await import(pathToFileURL(join(root,inventory.entry)).href);
  const result=await verifyLocalProof(proof,options['--signer-key']);
  // Recheck bytes after replay too. This is not an OS immutability claim: keep
  // release/proof directories protected from concurrent external modification.
  await verifyReleaseInventory(root,options['--release-digest']);
  const report={protocol:'jevyr.replay-release-verification/1',releaseDigest:options['--release-digest'],node:process.version,
    releaseFiles:inventory.files.length,trust:'externally-supplied-release-digest-and-proof-signer',scope:'offline retained-proof replay; no new execution or model quality claim',result};
  process.stdout.write(JSON.stringify(report)+'\n');
  if(!result.valid)process.exitCode=1;
  return report;
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(error=>{process.stderr.write(JSON.stringify({protocol:'jevyr.replay-release-refusal/1',error:error.message})+'\n');process.exitCode=1;});
