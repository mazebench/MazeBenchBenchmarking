import { sampleAgentCamera, applyAgentCamera } from './replay-camera.mjs';
const icon = path => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
const playIcon = 'm8 5 11 7-11 7z', pauseIcon = 'M6 5h4v14H6zM14 5h4v14h-4z';
const clock = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

export class RunReplayPlayer {
  constructor(board, id, onPosition) {
    Object.assign(this,{board,id,onPosition,time:0,speed:1,generation:0,playing:false,mode:'3d',following:true,asciiCache:new Map()});
    this.origin = `http://${location.hostname}:8085/api/benchmark/playback/runs/${encodeURIComponent(id)}/movie`;
    this.container = document.createElement('div');this.container.className='run-replay-player';this.container.tabIndex=-1;
    this.container.innerHTML=`
      <div class="run-replay-toolbar"><div class="run-replay-views" role="group" aria-label="Replay view"><button data-view="3d" aria-pressed="true">3D</button><button data-view="ascii" aria-pressed="false">ASCII</button></div><span class="run-replay-source"></span><button data-command="live" aria-pressed="true" title="Follow new moves automatically">Live</button></div>
      <div class="run-replay-stage" data-view="3d"><canvas tabindex="0" aria-label="Animated run replay. Following the agent camera."></canvas><div class="run-replay-ascii" hidden aria-label="ASCII replay"></div>
        <div class="run-replay-loading" role="status"><i aria-hidden="true"></i><span>Preparing replay…</span></div>
        <div class="run-replay-camera"><label class="run-replay-camera-toggle"><input type="checkbox" data-setting="agent-camera" checked> Agent camera</label><label class="run-replay-camera-toggle"><input type="checkbox" data-setting="neighbors"> Show neighboring rooms</label><div class="run-replay-free-camera" hidden><button data-command="zoom-in" aria-label="Zoom in">+</button><button data-command="zoom-out" aria-label="Zoom out">−</button><button data-command="center" aria-label="Center camera">${icon('M12 3v4m0 10v4M3 12h4m10 0h4M8 8h8v8H8z')}</button></div></div>
      </div>
      <div class="run-replay-transport"><input class="run-replay-seek" type="range" min="0" max="1" step="1" value="0" aria-label="Replay position" disabled>
        <div class="run-replay-controls"><div><button data-command="play" aria-label="Play" disabled>${icon(playIcon)}</button><button data-command="previous" aria-label="Previous move" disabled>${icon('M5 5h2v14H5zm14 0L8 12l11 7z')}</button><button data-command="next" aria-label="Next move" disabled>${icon('M17 5h2v14h-2zM5 5l11 7-11 7z')}</button><output class="run-replay-time">0:00 / 0:00</output></div>
          <div class="run-replay-rates" role="group" aria-label="Playback speed">${[.5,1,2,4,10].map(rate=>`<button data-rate="${rate}" aria-pressed="${rate===1}">${rate}×</button>`).join('')}</div>
          <button data-command="fullscreen" aria-label="Fullscreen">${icon('M9 3H3v6m12-6h6v6M3 15v6h6m6 0h6v-6')}</button>
        </div>
      </div>`;
    board.replaceChildren(this.container);board.removeAttribute('role');board.removeAttribute('aria-label');board.closest('.board-panel').classList.add('tween-replay');
    this.canvas=this.container.querySelector('canvas');this.stage=this.container.querySelector('.run-replay-stage');this.seek=this.container.querySelector('.run-replay-seek');
    this.ascii=this.container.querySelector('.run-replay-ascii');this.agentCamera=this.container.querySelector('[data-setting=agent-camera]');this.neighbors=this.container.querySelector('[data-setting=neighbors]');
    this.agentCamera.addEventListener('change',()=>this.syncCameraMode());this.neighbors.addEventListener('change',()=>this.draw(this.time));
    this.notice=this.container.querySelector('[role=status]');this.playButton=this.button('play');
    this.seek.addEventListener('input',()=>{const time=Number(this.seek.value);this.setFollowing(false);this.pause();this.draw(time);});
    this.container.addEventListener('click',event=>{
      const button=event.target.closest('button');if(!button)return;
      if(button.dataset.view){void this.setMode(button.dataset.view).catch(error=>this.fail(error));return;}
      if(button.dataset.rate){this.speed=Number(button.dataset.rate);this.lastFrame=performance.now();for(const b of this.container.querySelectorAll('[data-rate]'))b.setAttribute('aria-pressed',String(b===button));}
      const command=button.dataset.command;
      if(command==='play')this.togglePlay();
      if(command==='previous'||command==='next')this.step(command==='previous'?-1:1);
      if(command==='live'){this.setFollowing(this.updateError||!this.following);if(this.following){this.pause();this.draw(this.movie?.duration||0);void this.refresh({background:Boolean(this.movie)}).catch(error=>this.fail(error));}}
      if(!this.agentCamera.checked&&command==='center')this.view?.center();
      if(!this.agentCamera.checked&&(command==='zoom-in'||command==='zoom-out'))this.view?.renderer.zoomBy(command==='zoom-in'?.8:1.25);
      if(command==='fullscreen')void(document.fullscreenElement?document.exitFullscreen():this.container.requestFullscreen()).catch(error=>this.fail(error));
    });
    this.container.addEventListener('keydown',event=>{
      if(event.target.closest('input')||event.metaKey||event.ctrlKey||event.altKey||!this.movie)return;
      const key=event.key.toLowerCase();if(!['k',' ','j','l',',','.','home','end'].includes(key))return;
      if(key===' '&&event.target.closest('button')&&event.target!==this.playButton)return;
      event.preventDefault();event.stopPropagation();this.setFollowing(false);
      if(['k',' '].includes(key)){if(!event.repeat)this.togglePlay();}else if([',','.'].includes(key))this.step(key===','?-1:1);
      else{this.pause();this.draw(key==='home'?0:key==='end'?this.movie.duration:this.time+(key==='j'?-5000:5000));}
    });
    this.resize=new ResizeObserver(()=>{if(this.mode==='3d'){this.view?.renderer.resize();if(this.agentCamera.checked)this.draw(this.time);}else this.fitAscii();});this.resize.observe(this.stage);
  }
  button(command){return this.container.querySelector(`[data-command="${command}"]`);}
  setFollowing(value){this.following=value;this.button('live').setAttribute('aria-pressed',String(value));}
  async update(run){
    const changed=this.run&&run.history_epoch!==this.run.history_epoch;this.run=run;
    this.container.querySelector('.run-replay-source').textContent=`Agent · ${run.observation_mode==='vision'?'Vision':'ASCII'}`;
    if(!this.started){this.started=true;this.mode=run.observation_mode==='vision'?'3d':'ascii';this.setFollowing(Boolean(run.runner_active));this.updateModeUI();await this.refresh();}
    else if(!this.movie||changed||run.action_count>this.actionCount)await this.refresh({background:Boolean(this.movie)});
  }
  refresh(options={}){
    if(this.refreshing)return this.refreshing;
    this.refreshing=this.load(options).finally(()=>{this.refreshing=null;this.button('live').removeAttribute('data-loading');});return this.refreshing;
  }
  async load({background=false}={}){
    const generation=this.generation;
    if(!background){this.busy=true;this.notice.hidden=false;this.notice.classList.remove('replay-error');this.notice.querySelector('span').textContent='Preparing replay…';this.playButton.disabled=true;}
    this.button('live').dataset.loading='true';
    const [response,{locateReplay},{replayAscii,asciiFrameAt}]=await Promise.all([fetch(this.origin),import('../../replays/v1/movie.mjs'),import('./replay-ascii.mjs')]);
    const data=await response.json();if(!response.ok)throw new Error(data.error||'Could not load replay.');if(generation!==this.generation)return;
    this.locate=locateReplay;this.replayAscii=replayAscii;this.asciiFrameAt=asciiFrameAt;
    const append=this.movie&&data.epoch===this.epoch&&data.action_count>=this.actionCount,oldDuration=this.movie?.duration||0;
    const world=data.world;world.blocks=world.blocks.map(block=>({...block,visual:{...block.visual,...(block.visual?.modelUrl?{modelUrl:new URL(block.visual.modelUrl,new URL('/level-data/v2/main-world/world.json',location.href)).href}:{})}}));
    world.blockDefinitions=new Map(world.blocks.map(block=>[block.id,block]));this.world=world;
    this.movie=data.movie;this.actionCount=data.action_count;this.epoch=data.epoch;
    this.roomLabels=new Map(world.rooms.map(room=>[room.fileName,room.position.join('x')]));
    if(!append){this.asciiCache.clear();this.asciiKey=null;this.pause();this.time=this.following?this.movie.duration:0;}
    if(this.view){if(append){this.view.movie=this.movie;this.view.gemState.gems=this.movie.gems;}else this.view.setMovie(this.movie);}
    if(this.mode==='3d')await this.ensureView();if(generation!==this.generation)return;
    this.seek.max=String(this.movie.duration);this.seek.disabled=false;this.playButton.disabled=false;this.busy=false;this.notice.hidden=true;
    this.updateError=false;this.button('live').title='Follow new moves automatically';
    this.draw(this.time);
    if(append&&this.following&&this.movie.duration>oldDuration&&!this.playing)this.startPlayback();
  }
  async ensureView(){
    if(this.view)return;if(this.creatingView)return this.creatingView;
    this.creatingView=(async()=>{
      const [{ReplayView},{prepareBrowserModels,paintLoadProgress},{installFlyoverControls},{ReplayRoomVisibility}]=await Promise.all([
        import('../../replays/v1/view.mjs'),import('../../ui/browser-world.mjs'),import('../../ui/flyover-controls.mjs'),import('./replay-room-visibility.mjs')]);
      await prepareBrowserModels(new Set(this.world.blocks.map(block=>block.visual?.modelUrl).filter(Boolean)));await paintLoadProgress();
      if(this.disposed)return;
      this.installCameraControls=installFlyoverControls;this.view=new ReplayView(this.canvas,this.world,this.movie);
      this.view.renderer.disposeFlyoverControls();this.view.renderer.disposeFlyoverControls=null;this.roomVisibility=new ReplayRoomVisibility(this.view.renderer);this.syncCameraMode(false);this.view.renderer.resize();
    })().finally(()=>this.creatingView=null);return this.creatingView;
  }
  updateModeUI(){
    for(const button of this.container.querySelectorAll('[data-view]'))if(button.tagName==='BUTTON')button.setAttribute('aria-pressed',String(button.dataset.view===this.mode));
    this.stage.dataset.view=this.mode;this.ascii.hidden=this.mode!=='ascii';this.container.querySelector('.run-replay-camera').hidden=this.mode!=='3d';
  }
  async setMode(mode){
    if(this.mode===mode)return;this.mode=mode;this.updateModeUI();
    if(this.movie&&mode==='3d')await this.ensureView();this.syncCameraMode(false);this.view?.renderer.resize();this.asciiKey=null;this.draw(this.time);
  }
  syncCameraMode(redraw=true){
    const locked=this.agentCamera.checked;this.container.querySelector('.run-replay-free-camera').hidden=locked;
    this.canvas.setAttribute('aria-label',locked?'Animated run replay. Following the agent camera.':'Animated run replay. Drag to orbit; Q and E zoom.');this.canvas.dataset.agentCamera=String(locked);
    if(!this.view)return;const renderer=this.view.renderer;renderer.disposeFlyoverControls?.();renderer.disposeFlyoverControls=null;renderer.cancelCameraMotion();
    if(!locked&&this.mode==='3d')renderer.disposeFlyoverControls=this.installCameraControls(renderer,{window:this.container,document});if(redraw)this.draw(this.time);
  }
  fail(error){
    this.updateError=true;
    if(this.movie){this.button('live').title=`Update failed: ${error.message} Click Live to retry.`;return;}
    this.pause();this.busy=false;this.notice.hidden=false;this.notice.classList.add('replay-error');this.notice.querySelector('span').textContent=`${error.message} Click Live to retry.`;
    if(this.mode==='ascii'&&this.run?.display?.level){this.ascii.textContent=this.run.display.level;this.ascii.style.fontSize='7px';}
  }
  draw(time){
    if(!this.movie)return;let location=this.locate(this.movie,time);this.time=location.time;
    if(this.mode==='ascii')void this.drawAscii(location).catch(error=>this.fail(error));
    else if(this.view){
      const renderer=this.view.renderer;
      if(this.agentCamera.checked){applyAgentCamera(renderer,sampleAgentCamera(location.clip,location.local));if(this.view.lastCamera){renderer.target.x=this.view.lastCamera[0];renderer.target.z=this.view.lastCamera[1];}}
      renderer.renderSuspended=(renderer.renderSuspended||0)+1;
      try{location=this.view.show(time);this.roomVisibility.update(this.neighbors.checked,this.view.scene,location);}finally{renderer.renderSuspended--;}
      renderer.render();
    }
    this.transport(location);
  }
  async drawAscii({clip,local}){
    const frame=this.asciiFrameAt(clip,local),key=`${this.epoch}:${clip.move}:${frame.at}`;if(this.asciiKey===key)return;this.asciiKey=key;
    let rendered=this.asciiCache.get(key);if(!rendered){rendered=await this.replayAscii(this.movie,this.world,clip,local);this.asciiCache.set(key,rendered);while(this.asciiCache.size>100)this.asciiCache.delete(this.asciiCache.keys().next().value);}
    if(this.asciiKey!==key||this.mode!=='ascii')return;
    const pre=document.createElement('pre');
    for(const pixels of rendered.pixels){const row=document.createElement('div');let span,color;
      for(const pixel of pixels){if(!span||color!==pixel.color){span=document.createElement('span');color=pixel.color;span.style.color=color;row.append(span);}span.textContent+=pixel.glyph;}pre.append(row);}
    this.ascii.replaceChildren(pre);this.asciiDimensions=[rendered.width,rendered.height];this.ascii.dataset.replayMove=String(clip.move);this.fitAscii();
  }
  fitAscii(){if(!this.asciiDimensions)return;const [width,height]=this.asciiDimensions;this.ascii.style.fontSize=`${Math.max(3,Math.min(13,(this.stage.clientWidth-28)/(width*.61),(this.stage.clientHeight-28)/height))}px`;}
  transport(location=this.movie&&this.locate(this.movie,this.time)){
    if(!location)return;const{clip,local,index}=location;
    this.seek.value=String(this.time);this.seek.style.setProperty('--played',`${100*this.time/this.movie.duration}%`);this.seek.setAttribute('aria-valuetext',`${clock(this.time)} of ${clock(this.movie.duration)}, move ${clip.move} of ${this.actionCount}`);
    this.container.querySelector('output').textContent=`${clock(this.time)} / ${clock(this.movie.duration)}`;this.playButton.setAttribute('aria-label',this.playing?'Pause':'Play');this.playButton.querySelector('path').setAttribute('d',this.playing?pauseIcon:playIcon);
    this.button('previous').disabled=this.time<=0;this.button('next').disabled=this.time>=this.movie.duration;
    this.onPosition({move:clip.move,room:this.roomLabels.get(local>=clip.settledAt?clip.to:clip.room),index,mode:this.mode});
  }
  togglePlay(){if(!this.movie||this.busy)return;this.setFollowing(false);if(this.playing){this.pause();return;}if(this.time>=this.movie.duration)this.draw(0);this.startPlayback();}
  startPlayback(){
    if(this.playing||!this.movie||this.time>=this.movie.duration||document.hidden||!this.container.getClientRects().length)return;this.playing=true;this.lastFrame=performance.now();this.transport();
    const tick=now=>{if(!this.playing)return;const time=this.time+Math.max(0,now-this.lastFrame)*this.speed;this.lastFrame=now;this.draw(time);if(this.time>=this.movie.duration)this.pause();else this.frame=requestAnimationFrame(tick);};this.frame=requestAnimationFrame(tick);
  }
  pause(){this.playing=false;cancelAnimationFrame(this.frame);this.view?.renderer.cancelCameraMotion();this.transport();}
  step(direction){if(!this.movie)return;this.setFollowing(false);this.pause();const{index,clip}=this.locate(this.movie,this.time);this.draw(direction<0?this.time>clip.start?clip.start:this.movie.clips[Math.max(0,index-1)].start:this.movie.clips[index+1]?.start??this.movie.duration);}
  seekMove(move){if(this.movie){this.setFollowing(false);this.pause();this.draw(this.movie.clips.find(clip=>clip.move===move)?.start??this.movie.duration);}}
  dispose(){this.disposed=true;this.generation++;this.pause();this.resize.disconnect();this.view?.renderer.disposeFlyoverControls?.();this.view?.scene?.dispose();this.view?.sceneCache?.clear();}
}
