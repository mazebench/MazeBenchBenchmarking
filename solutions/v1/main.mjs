import { loadMainWorldV2 } from '../../render/v1/voxel-world-v2.mjs';
import { ThreeMazeRendererV1 } from '../../render/v1/three-renderer.mjs';
import { installCutawayControls } from '../../render/v1/cutaway-controls.mjs';
import { roomContextWorld } from '../../render/v1/room-context.mjs';
import { roomFromEngineStateV1 } from '../../engine/v1/adapter.mjs';
import { bindCameraHold } from '../../render/v1/camera-controls.mjs';
import { cameraRelativeMoveDirection } from '../../play/v1/camera-relative-input.mjs';
import { readProject, saveProject } from './storage.mjs';
import { playSolutionFrames } from './animation.mjs';

const $=id=>document.getElementById(id), label=r=>r.position.join('×'), number=n=>Number(n).toLocaleString();
let world, renderer, snapshot, inspected, target=null, fingerprint, busy=false, sequence=0, replayGeneration=0, routeLimit=30;
const jobs=new Map(), mapButtons=new Map();
const moves=n=>`${number(n)} move${n===1?'':'s'}`;
const duration=ms=>ms<1000?`${Math.max(1,Math.round(ms))} ms`:`${(ms/1000).toFixed(1)}s`;
let shownMoves=null,pendingImport=null;
const worker=new Worker(new URL('./worker.mjs',import.meta.url),{type:'module',name:'mazebench-solutions'});
worker.onmessage=async({data})=>{
  const job=jobs.get(data.id);if(!job)return;
  if(data.type==='progress'){job.progress?.(data.value);return;}
  jobs.delete(data.id);
  if(data.type==='error'){job.reject(Object.assign(new Error(data.error),{code:data.code}));return;}
  if(data.saved&&fingerprint){
    $('save-state').textContent='Saving…';
    try{await saveProject(fingerprint,data.saved);$('save-state').textContent='Saved on this device';}
    catch{ $('save-state').textContent='Not saved · export a copy'; $('save-state').title='Browser storage is unavailable. Export your routes to keep a copy.'; }
  }
  job.resolve(data.value);
};
worker.onerror=event=>{for(const job of jobs.values())job.reject(new Error(event.message||'The solver stopped. Reload to restore saved routes.'));jobs.clear();setBusy(false);};
function request(type,payload={},progress){return new Promise((resolve,reject)=>{const id=++sequence;jobs.set(id,{resolve,reject,progress});worker.postMessage({id,type,payload});});}
function message(text){$('status').textContent=text;}
function importNotice(warnings){
  const notice=$('import-notice'),count=warnings?.count||0;
  notice.hidden=!count;
  notice.textContent=count?`Import repaired · ${number(count)} invalid action${count===1?' or saved spawn':'s or saved spawns'} skipped. Valid progress kept.`:'';
  notice.title=warnings?.examples?.join('\n')||'';
}
function setBusy(value){busy=value;document.querySelectorAll('[data-direction],#search-time,#find-gem,#find-room,#find-target,#export,#full-solution,.spot,.spawn-setup,.route-row button').forEach(b=>b.disabled=value);$('undo').disabled=value||!snapshot?.canUndo;for(const [id,button]of mapButtons)button.disabled=value||!snapshot?.visitedRooms.includes(id);$('clear-runs').disabled=value||!(snapshot?.routes.length||snapshot?.pending.length);$('import').disabled=value||!snapshot||Boolean(snapshot.routes.length||snapshot.pending.length);$('import').title=snapshot&&(snapshot.routes.length||snapshot.pending.length)?'Clear all runs to import a solution':'Import a saved solution JSON';$('cancel').hidden=!value;}
async function action(type,payload={},success){
  if(busy)return;
  setBusy(true);
  $('cancel').hidden=!['search','full-solution','export'].includes(type);
  try{
    const result=await request(type,payload,progress=>{
      if(progress.restoring)message(`Verifying saved routes · ${progress.done} / ${progress.total}`);
      else if(progress.compiling)message(`Verifying full solution · ${progress.done} / ${progress.total} runs · ${number(progress.commands)} commands`);
      else message(`Finding a route… ${number(progress.expanded)} states explored · ${(progress.elapsedMs/1000).toFixed(1)}s`);
    });
    if(result.frames?.length)await animateFrames(result.frames);
    if(result.snapshot){snapshot=result.snapshot;inspected=snapshot.room;render();}
    if(type==='import')importNotice(result.warnings);
    if(type==='clear-runs')importNotice(null);
    if(success)success(result);else message(result.message||'Resume spot saved.');
  }catch(error){
    message(error.message);
    if(type==='import'&&['WORLD_MISMATCH','ENGINE_MISMATCH'].includes(error.code)){
      pendingImport=payload.file;$('import-world-file').textContent=payload.file.name;
      $('import-world-title').textContent=error.code==='ENGINE_MISMATCH'?'Recheck with the current engine?':'Recheck with the current world?';
      $('import-world-description').textContent=`${error.code==='ENGINE_MISMATCH'?'The engine has':'The rooms or engine have'} changed since this file was saved. Replay the saved moves with the current engine and rooms to rebuild visited rooms, entrances, and collected gems. Invalid moves or saved spawns will be skipped, and replay will continue from the last valid position. A small notice will show what was removed.`;
      $('import-world-dialog').showModal();
    }
  }
  finally{setBusy(false);}
}

const roomById=id=>world.rooms.find(r=>r.fileName===id);
function showBoard(roomId,state=null){
  const room=roomById(roomId);if(!room)return;
  const collected=new Set(snapshot?.collectedGems||[]);
  const rendered=state?roomFromEngineStateV1(state,room):{...room,objects:room.objects.filter((o,i)=>!collected.has(`${room.fileName}:${i}`))};
  const context=roomContextWorld(world,room,rendered,{omitDimmedRoleIds:['player']});
  if(!renderer){
    renderer=new ThreeMazeRendererV1($('room-canvas'),context,{mode:'play',pickVoxels:true,onSelect:chooseTile});
    installCutawayControls($('cutaway-controls'),renderer,{ghosts:true});
    new ResizeObserver(()=>renderer.resize()).observe($('stage'));
  }
  else renderer.setWorld(context,{preserveCamera:true});
  const active=renderer.world.rooms.find(r=>r.fileName===target?.room);
  renderer.selectCell(active||null,target?.x,target?.y,target?.z??undefined);
}
function chooseTile(hit){
  if(!hit||busy||!snapshot.visitedRooms.includes(hit.room.fileName))return;
  const role=hit.block?.roleId, body=['player','goal'].includes(role);
  target={kind:'location',room:hit.room.fileName,x:body?hit.sourceX:hit.paintX,y:body?hit.sourceY:hit.paintY,z:body?hit.sourceZ:hit.paintZ};
  if(target.x<0||target.y<0||target.x>=hit.room.width||target.y>=hit.room.height){target=null;return;}
  showTarget();
  find({...target});
}
function showTarget(){
  $('target-panel').hidden=!target;$('clear-target').hidden=!target;
  if(!target){renderer?.selectCell(null);$('view-note').textContent='Tap a tile to move there';return;}
  const room=roomById(target.room);
  $('target-room').textContent=`Room ${label(room)} · from ${label(roomById(snapshot.room))}`;
  $('target-x').value=target.x;$('target-y').value=target.y;$('target-z').value=target.z??'';
  $('view-note').textContent=`Target ${label(room)} · (${target.x}, ${target.y}${target.z==null?'':`, ${target.z}`})`;
  renderer?.selectCell(renderer.world.rooms.find(r=>r.fileName===target.room)||null,target.x,target.y,target.z??undefined);
}
function inspect(id){if(busy||!snapshot?.visitedRooms.includes(id))return;target=null;inspected=id;render();}
function render(){
  $('undo').disabled=busy||!snapshot.canUndo;
  const room=roomById(inspected), current=inspected===snapshot.room;
  $('room-name').textContent=label(room);
  $('source-label').textContent=current?`Visited room · (${snapshot.position.x}, ${snapshot.position.y}, ${snapshot.position.z})`:`Inspecting room · route begins in ${label(roomById(snapshot.room))}`;
  $('return-current').hidden=current;
  $('path-length').textContent=`${moves(snapshot.pending.length)} in current segment`;
  $('rooms-count').replaceChildren(document.createTextNode(`${snapshot.visitedRooms.length} `),Object.assign(document.createElement('small'),{textContent:`/ ${snapshot.roomCount}`}));
  $('gems-count').replaceChildren(document.createTextNode(`${snapshot.collectedGems.length} `),Object.assign(document.createElement('small'),{textContent:`/ ${snapshot.gemCount}`}));
  $('coverage').max=snapshot.roomCount;$('coverage').value=snapshot.visitedRooms.length;
  $('map-room').textContent=label(room);
  const roomProgress=new Map(snapshot.roomProgress.map(p=>[p.room,p]));
  const roomGems=roomProgress.get(inspected);
  $('map-gems').textContent=roomGems.total?`${roomGems.collected} / ${roomGems.total} gems collected · ${roomGems.remaining} left`:'No gems in this room';
  for(const [id,button] of mapButtons){
    const progress=roomProgress.get(id);
    button.disabled=busy||!progress.visited;
    button.classList.toggle('visited',progress.visited);
    button.classList.toggle('gems-remaining',progress.remaining>0);
    button.classList.toggle('gems-collected',progress.collected>0);
    button.classList.toggle('current',id===snapshot.room);button.classList.toggle('inspected',id===inspected);
    button.setAttribute('aria-pressed',String(id===inspected));
    button.title=`Room ${label(roomById(id))} · ${progress.visited?'Visited':'Not visited'} · ${progress.total?`${progress.collected} / ${progress.total} gems collected, ${progress.remaining} left`:'No gems'}`;
    button.setAttribute('aria-label',button.title);
  }
  const spots=snapshot.spots.filter(s=>s.room===inspected&&s.accessible);
  $('spot-count').textContent=spots.length;$('spots').replaceChildren();
  if(!spots.length)$('spots').append(Object.assign(document.createElement('p'),{className:'empty',textContent:'No authored start or discovered entrance yet. Find a route into this room.'}));
  for(const spot of spots){
    const button=document.createElement('button');button.className=`spot${spot.id===snapshot.source?' active':''}`;button.disabled=busy;
    const title=document.createElement('strong');title.textContent=`${spot.kind==='start'?'Room start':'Room entrance'} · (${spot.position.x}, ${spot.position.y}, ${spot.position.z})`;
    const subtitle=document.createElement('span');subtitle.textContent=`${spot.setupBase==='game'?'Game start':`Go to room ${label(roomById(spot.setupRoom))}`}${spot.setupMoves?` + ${moves(spot.setupMoves)}`:''}`;
    button.append(title,subtitle);
    if(spot.entry&&JSON.stringify(spot.entry)!==JSON.stringify(spot.position)){const note=document.createElement('span');note.textContent=`Entered at (${spot.entry.x}, ${spot.entry.y}, ${spot.entry.z}); resumes after the move settles.`;button.append(note);}
    button.addEventListener('click',()=>action('resume',{id:spot.id},()=>{target=null;showTarget();message('Room reset to this spot. Collected gems stay collected.');}));
    const row=document.createElement('div');row.className='spawn-row';row.append(button);
    if(spot.kind!=='start'){const setup=document.createElement('button');setup.className='spawn-setup';setup.textContent='Setup';setup.disabled=busy;setup.setAttribute('aria-label',`View setup for ${title.textContent}, ${subtitle.textContent}`);setup.onclick=()=>openMoves(spot.id,true);row.append(setup);}
    $('spots').append(row);
  }
  $('route-count').textContent=snapshot.routes.length;
  $('clear-runs').disabled=busy||!(snapshot.routes.length||snapshot.pending.length);
  $('routes').replaceChildren();
  if(!snapshot.routes.length)$('routes').append(Object.assign(document.createElement('p'),{className:'empty',textContent:'Runs appear here when you reach a gem, enter another room, or finish a planned route.'}));
  for(const route of snapshot.routes.slice(-routeLimit).reverse()){
    const from=snapshot.spots.find(s=>s.id===route.from),to=snapshot.spots.find(s=>s.id===route.to),row=document.createElement('div');row.className='route-row';
    const copy=document.createElement('div'),title=document.createElement('strong'),detail=document.createElement('p');title.textContent=`${label(roomById(from.room))} → ${label(roomById(to.room))}`;
    detail.textContent=`${route.label} · ${moves(route.moves)}${route.gems.length?` · ${route.gems.length} gem${route.gems.length===1?'':'s'}`:''}${route.accessible?'':' · Starting room not visited'}`;copy.append(title,detail);
    const replay=document.createElement('button');replay.textContent='Replay';replay.disabled=busy;replay.addEventListener('click',()=>replayRoute(route.id));
    const showMoves=document.createElement('button');showMoves.textContent='Moves';showMoves.disabled=busy;showMoves.onclick=()=>openMoves(route.id);
    row.append(copy,showMoves,replay);$('routes').append(row);
  }
  if(snapshot.routes.length>routeLimit){const more=document.createElement('button');more.textContent='Show earlier routes';more.onclick=()=>{routeLimit+=30;render();};$('routes').append(more);}
  showBoard(inspected,current?snapshot.state:null);showTarget();
}
async function find(goal){
  if(busy)return;
  message('Finding a route…');
  await action('search',{goal,maximumMs:Number($('search-time').value),maximumNodes:20000},result=>{
    const r=result.search;
    message(r.status==='found'?r.actions.length?`Route saved · ${moves(r.actions.length)} · ${duration(r.elapsedMs)}`:'Already at that location.'
      :r.status==='cancelled'?'Search cancelled. Your routes are saved.'
      :r.status==='no-targets'?'No new targets remain for this search.'
      :r.status==='limit'?r.limitReason==='memory'?'Search ran out of memory. Try a closer tile or another entrance.'
        :r.limitReason==='states'?'The connected-room search reached its capacity. Try a closer tile or another entrance.'
        :'No route found within the search time. Choose a longer Search time above and try again.'
      :'No route found after exploring the available states from this spot.');
  });
}
async function replayRoute(id){
  if(busy)return;setBusy(true);$('cancel').hidden=true;let outcome='Replay finished. Your current spot is unchanged.';
  try{const result=await request('replay',{id});if(!await animateFrames(result.frames,{replay:true,total:result.actions.length}))outcome='Replay stopped. Your current spot is unchanged.';}
  catch(error){outcome=error.message;}finally{inspected=snapshot.room;render();setBusy(false);message(outcome);}
}
async function animateFrames(frames,{replay=false,total=0}={}){
  const generation=++replayGeneration;
  $('cancel').textContent=replay?'Stop replay':'Skip animation';$('cancel').hidden=frames.length<2;
  try{return await playSolutionFrames(frames,frame=>{
    showBoard(frame.room,frame.state);$('room-name').textContent=label(roomById(frame.room));
    $('source-label').textContent=replay?`Saved route replay · ${frame.command} / ${total}`:'Playing move…';
    message(replay?`Replaying saved route · ${frame.command} / ${total}`:'Playing moves…');
  },{cancelled:()=>generation!==replayGeneration});}
  finally{$('cancel').textContent='Cancel search';$('cancel').hidden=true;}
}

function renderMoves(){
  const actions=$('full-path').checked&&shownMoves.path?shownMoves.path:shownMoves.actions;
  const full=shownMoves.fullSolution;
  $('moves-title').textContent=full?'Full solution':shownMoves.spawn?'Spawn setup':'Move sequence';
  $('moves-summary').textContent=full?`${moves(full.moves)} · ${number(full.roomCommands)} room command${full.roomCommands===1?'':'s'} · ${full.rooms.length} room${full.rooms.length===1?'':'s'} · ${full.gems.length} gem${full.gems.length===1?'':'s'}`
    :`${number(actions.length)} commands · ${$('full-path').checked||shownMoves.spawn?shownMoves.anchor:'This run'}`;
  $('moves-note').hidden=!full;
  if(full)$('moves-note').textContent=full.complete?'All saved runs included. Begins at H×I; saved spawns are expanded into their setup moves.':`${full.blockedRuns.length} run${full.blockedRuns.length===1?' is':'s are'} not yet included. ${full.blockedRuns.slice(0,3).map(run=>run.reason).join(' ')}`;
  $('moves-text').value=actions.join(', ');$('copy-moves').textContent='Copy moves';
}
async function openMoves(id,spawn=false){
  try{shownMoves=await request(spawn?'spawn-moves':'moves',{id});$('full-path-label').hidden=!shownMoves.path;$('full-path').checked=false;renderMoves();$('moves-dialog').showModal();}
  catch(error){message(error.message);}
}
$('clear-runs').onclick=()=>{
  if(busy||!(snapshot?.routes.length||snapshot?.pending.length))return;
  const count=snapshot.routes.length;
  $('clear-description').textContent=`Clear all ${count} saved run${count===1?'':'s'}, their saved spawn points, and your current moves? This resets Solutions to H×I and cannot be undone.`;
  $('clear-dialog').showModal();
};
$('cancel-clear').onclick=()=>$('clear-dialog').close();
$('confirm-clear').onclick=()=>{
  $('clear-dialog').close();
  action('clear-runs',{},result=>{target=null;shownMoves=null;routeLimit=30;showTarget();message(result.message);});
};
$('full-solution').onclick=()=>action('full-solution',{},full=>{
  shownMoves={actions:full.commands,path:null,fullSolution:full};$('full-path-label').hidden=true;$('full-path').checked=false;renderMoves();$('moves-dialog').showModal();message(full.complete?'Full solution verified.':`${full.blockedRuns.length} runs could not be included. See the details in Full solution.`);
});
$('full-path').onchange=renderMoves;
$('close-moves').onclick=()=>$('moves-dialog').close();
$('copy-moves').onclick=async()=>{try{await navigator.clipboard.writeText($('moves-text').value);$('copy-moves').textContent='Copied';}catch{$('moves-text').select();$('copy-moves').textContent='Select and copy the moves above';}};

$('find-gem').onclick=()=>find({kind:'gem'});
$('find-room').onclick=()=>find({kind:'room'});
$('undo').onclick=()=>action('undo');
$('cancel').onclick=()=>{worker.postMessage({type:'cancel'});replayGeneration++;message('Stopping…');};
$('return-current').onclick=()=>inspect(snapshot.room);
$('clear-target').onclick=()=>{target=null;showTarget();};
$('find-target').onclick=()=>{if(!target)return;target={...target,x:Number($('target-x').value),y:Number($('target-y').value),z:$('target-z').value===''?null:Number($('target-z').value)};showTarget();find(target);};
for(const button of document.querySelectorAll('[data-direction]'))button.onclick=()=>action('move',{direction:cameraRelativeMoveDirection(button.dataset.direction,renderer?.heading||0)});
window.addEventListener('keydown',event=>{
  if(event.defaultPrevented||event.altKey||['INPUT','SELECT','TEXTAREA'].includes(event.target.tagName)||event.target.isContentEditable||$('moves-dialog').open||$('clear-dialog').open||$('import-world-dialog').open)return;
  if(event.key.toLowerCase()==='z'&&!event.shiftKey){event.preventDefault();if(!event.repeat&&snapshot?.canUndo)action('undo');return;}
  if(event.metaKey||event.ctrlKey)return;
  const direction={ArrowUp:'up',ArrowRight:'right',ArrowDown:'down',ArrowLeft:'left'}[event.key];
  if(direction){event.preventDefault();if(!event.repeat&&snapshot)action('move',{direction:cameraRelativeMoveDirection(direction,renderer?.heading||0)});}
  if(event.key==='Escape'){target=null;showTarget();}
});
for(const [id,key,tap]of [['tilt-up','w'],['tilt-down','s'],['zoom-in','q',()=>renderer.zoomBy(.8)],['zoom-out','e',()=>renderer.zoomBy(1/.8)]])bindCameraHold($(id),{key,getRenderer:()=>renderer,tap});
$('rotate-left').onclick=()=>renderer?.rotateCardinal(-1);$('rotate-right').onclick=()=>renderer?.rotateCardinal(1);
$('import').onclick=()=>{if(!busy&&snapshot&&!snapshot.routes.length&&!snapshot.pending.length)$('import-file').click();};
$('import-file').onchange=()=>{
  const file=$('import-file').files[0];$('import-file').value='';
  if(!file)return;
  if(busy||!snapshot)return;
  if(snapshot.routes.length||snapshot.pending.length){message('Clear all runs before importing a solution.');return;}
  message('Reading and checking your solution…');
  importFile(file);
};
function importFile(file,allowChanges=false){
  action('import',{file,allowWorldChange:allowChanges,allowEngineChange:allowChanges},result=>{target=null;shownMoves=null;routeLimit=30;showTarget();message(result.message);});
}
$('cancel-import-world').onclick=()=>{pendingImport=null;$('import-world-dialog').close();};
$('confirm-import-world').onclick=()=>{
  const file=pendingImport;pendingImport=null;$('import-world-dialog').close();
  if(file){message('Rechecking your moves with the current engine and rooms…');importFile(file,true);}
};
$('import-world-dialog').addEventListener('cancel',()=>{pendingImport=null;});
$('export').onclick=()=>action('export',{},data=>{
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='mazebench-solutions.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);message(data.fullSolution.complete?'Runs and verified full solution exported.':'Runs exported with the verified solution so far. Unincluded runs are listed separately.');
});
try{
  world=await loadMainWorldV2((done,total)=>{$('load-progress').max=total;$('load-progress').value=done;});
  const initial=await request('init',{world});fingerprint=initial.fingerprint;snapshot=initial.snapshot;inspected=snapshot.room;
  for(const room of [...world.rooms].sort((a,b)=>a.rowIndex-b.rowIndex||a.columnIndex-b.columnIndex)){
    const button=document.createElement('button');button.title=`Room ${label(room)}`;button.setAttribute('aria-label',button.title);button.disabled=true;button.onclick=()=>inspect(room.fileName);mapButtons.set(room.fileName,button);$('world-map').append(button);
  }
  render();$('loading').hidden=true;
  try{const saved=await readProject(fingerprint);if(saved){setBusy(true);message('Verifying your saved routes…');const result=await request('restore',{saved},p=>message(`Verifying saved routes · ${p.done} / ${p.total}`));snapshot=result.snapshot;inspected=snapshot.room;render();message('Your saved routes are ready.');}else{message('Start in H×I. Find a gem, reach a new room, or tap a tile to move there.');$('save-state').textContent='Saves on this device';}}
  catch(error){message(`Saved routes could not be loaded: ${error.message}`);$('save-state').textContent='Export to keep your routes';}
  setBusy(false);
}catch(error){$('loading').textContent=error.message;message(error.message);console.error(error);}
