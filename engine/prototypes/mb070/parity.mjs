import assert from 'node:assert/strict';
import {readFileSync, readdirSync, mkdirSync, writeFileSync, statSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
const dir=fileURLToPath(new URL('.',import.meta.url));
const hash=s=>{let h=2166136261; for(const c of Buffer.from(s)) h=Math.imul(h^c,16777619)>>>0; return h;};
const load=async path=>(await WebAssembly.instantiate(readFileSync(path))).instance.exports;
const rust=await load(dir+'target/wasm32-unknown-unknown/release/mb070_physics.wasm');
const cpp=await load(dir+'target/reference.wasm');
const measurements=[];
let frames=0, cases=0;
function native(name,input) {
 const start=performance.now();
 const r=spawnSync(dir+'target/'+name,[],{input,encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);
 measurements.push({backend:name,processWallMs:performance.now()-start});
 return r.stdout.trim().split('\n').map(s=>s.split(' ').map(Number));
}
function wasm(e,fixture,isRust) {
 const {w,h,count,commands,voxels}=fixture;
 new Int32Array(e.memory.buffer,e.voxel_buffer(),count*5).set(voxels);
 const trace=[];
 for(const d of commands) {
  if(!isRust) e.reset_command();
  for(let guard=0;guard<100;guard++) {
   const result=isRust?e.step_tick(count,w,h,+d):e.step_command_tick(count,w,h,+d);
   const data=Array.from(new Int32Array(e.memory.buffer,e.voxel_buffer(),count*5));
   for(let i=3;i<data.length;i+=5)data[i]>>>=0;
   trace.push([result,isRust?1:e.command_tick(),...data]);
   if(result===0) break;
   assert.equal(result,1); assert.ok(guard<99,'unbounded command');
  }
 }
 return trace;
}
for(const name of readdirSync(dir+'fixtures').filter(s=>s.endsWith('.txt')).sort()) {
 const input=readFileSync(dir+'fixtures/'+name,'utf8');
 const t=input.trim().split(/\s+/); const [w,h,count]=t.splice(0,3).map(Number); const commands=t.shift();
 const voxels=[]; while(t.length) { const [x,y,z,r,id]=t.splice(0,5); voxels.push(+x,+y,+z,hash(r),+id); }
 const fixture={w,h,count,commands,voxels};
 const reference=native('reference',input);
 assert.deepEqual(native('release/mb070-native',input),reference,`${name}: Rust native`);
 assert.deepEqual(wasm(cpp,fixture,false),reference,`${name}: C++ WASM`);
 assert.deepEqual(wasm(rust,fixture,true),reference,`${name}: Rust WASM`);
 // Storage-order permutation guards against positional assumptions.
 const permuted={...fixture,voxels: Array.from({length:count},(_,i)=>voxels.slice(i*5,i*5+5)).reverse().flat()};
 assert.deepEqual(wasm(rust,permuted,true),wasm(cpp,permuted,false),`${name}: reversed storage`);
 for(const [backend,e,isRust] of [['cpp-wasm',cpp,false],['rust-wasm',rust,true]]) {
  for(let i=0;i<100;i++)wasm(e,fixture,isRust);
  const start=performance.now();
  for(let i=0;i<1000;i++)wasm(e,fixture,isRust);
  measurements.push({fixture:name,backend,iterations:1000,commands:1000*commands.length,elapsedMs:performance.now()-start,linearMemoryBytes:e.memory.buffer.byteLength});
 }
 frames+=reference.length; cases++;
}
// Deterministic differential coverage beyond the four hand-authored fixtures.
let seed=70;
const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return (seed>>>8)%n;};
for(let trial=0;trial<200;trial++) {
 const w=6,h=3, cells=Array.from({length:18},(_,i)=>i);
 for(let i=cells.length-1;i>0;i--){const j=random(i+1);[cells[i],cells[j]]=[cells[j],cells[i]];}
 const voxels=[];
 for(let i=0;i<7;i++) {const cell=cells[i];voxels.push(cell%w,Math.floor(cell/w),0,hash(i===0?'player':i<4?'pushable':'wall'),-1);}
 const goal=cells[7];voxels.push(goal%w,Math.floor(goal/w),0,hash('goal'),-1);
 for(let y=0;y<h;y++)for(let x=0;x<w;x++)voxels.push(x,y,-1,hash('floor'),-1);
 const commands=Array.from({length:32},()=>String(random(4))).join('');
 const fixture={w,h,count:voxels.length/5,commands,voxels};
 assert.deepEqual(wasm(rust,fixture,true),wasm(cpp,fixture,false),`generated case ${trial}`);
}
// Unsupported uploads must fail without mutation, including overflow capacity.
const before=new Int32Array(rust.memory.buffer,rust.voxel_buffer(),5); before.set([0,0,0,hash('ice'),-1]);
const saved=Array.from(before); assert.equal(rust.step_tick(1,1,1,0),-3); assert.deepEqual(Array.from(before),saved);
assert.equal(rust.step_tick(129,1,1,0),-3);
const report={baseline:"f38f4d38b86d23fb9013ce6409d02e88915a4dc2",timestamp:new Date().toISOString(),platform:os.platform(),arch:os.arch(),generatedCases:200,generatedCommands:6400,cpu:os.cpus()[0].model,node:process.version,cases,frames,measurements,notes:'WASM timing includes upload, reset, trace allocation/readback and JS loop after 100 warmups. Native process timings include startup and text I/O. These are harness baselines, not kernel-only comparisons or final performance targets.',wasmBytes:{rust:statSync(dir+'target/wasm32-unknown-unknown/release/mb070_physics.wasm').size,cpp:statSync(dir+'target/reference.wasm').size}};
mkdirSync(dir+'results',{recursive:true}); writeFileSync(dir+'results/baseline.json',JSON.stringify(report,null,2)+'\n');
console.log(`PASS ${cases} shared fixtures, ${frames} frames across C++ native/WASM and Rust native/WASM; reversed-storage WASM parity and rejection checks passed.`);
console.log(JSON.stringify(report,null,2));
