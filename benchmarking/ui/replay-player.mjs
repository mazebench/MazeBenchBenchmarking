const icon = path => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
const playIcon = 'm8 5 11 7-11 7z', pauseIcon = 'M6 5h4v14H6zM14 5h4v14h-4z';
const clock = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

export class RunReplayPlayer {
  constructor(board, id, onPosition) {
    Object.assign(this, { board, id, onPosition, time: 0, speed: 1, generation: 0, playing: false });
    this.origin = `http://${location.hostname}:8085/api/benchmark/playback/runs/${encodeURIComponent(id)}/movie`;
    this.container = document.createElement('div'); this.container.className = 'run-replay-player'; this.container.tabIndex = -1;
    this.container.innerHTML = `
      <div class="run-replay-stage"><canvas tabindex="0" aria-label="Animated run replay. Drag to orbit; Q and E zoom."></canvas>
        <div class="run-replay-loading" role="status"><i aria-hidden="true"></i><span>Preparing replay…</span></div>
        <div class="run-replay-camera"><button data-command="zoom-in" aria-label="Zoom in">+</button><button data-command="zoom-out" aria-label="Zoom out">−</button><button data-command="center" aria-label="Center camera">${icon('M12 3v4m0 10v4M3 12h4m10 0h4M8 8h8v8H8z')}</button></div>
      </div>
      <div class="run-replay-transport">
        <input class="run-replay-seek" type="range" min="0" max="1" step="1" value="0" aria-label="Replay position" disabled>
        <div class="run-replay-controls">
          <div><button data-command="play" aria-label="Play" disabled>${icon(playIcon)}</button><button data-command="previous" aria-label="Previous move" disabled>${icon('M5 5h2v14H5zm14 0L8 12l11 7z')}</button><button data-command="next" aria-label="Next move" disabled>${icon('M17 5h2v14h-2zM5 5l11 7-11 7z')}</button><output class="run-replay-time">0:00 / 0:00</output></div>
          <div class="run-replay-rates" role="group" aria-label="Playback speed">${[.5, 1, 2, 4, 10].map(rate => `<button data-rate="${rate}" aria-pressed="${rate === 1}">${rate}×</button>`).join('')}</div>
          <div><button data-command="latest">Latest</button><button data-command="fullscreen" aria-label="Fullscreen">${icon('M9 3H3v6m12-6h6v6M3 15v6h6m6 0h6v-6')}</button></div>
        </div>
      </div>`;
    board.replaceChildren(this.container); board.removeAttribute('role'); board.removeAttribute('aria-label');
    board.closest('.board-panel').classList.add('tween-replay');
    this.canvas = this.container.querySelector('canvas'); this.seek = this.container.querySelector('input');
    this.notice = this.container.querySelector('[role=status]'); this.playButton = this.button('play');
    this.seek.addEventListener('input', () => { const time = Number(this.seek.value); this.pause(); this.draw(time); });
    this.container.addEventListener('click', event => {
      const button = event.target.closest('button'); if (!button) return;
      if (button.dataset.rate) {
        this.speed = Number(button.dataset.rate); this.lastFrame = performance.now();
        for (const b of this.container.querySelectorAll('[data-rate]')) b.setAttribute('aria-pressed', String(b === button));
      }
      const command = button.dataset.command;
      if (command === 'play') this.togglePlay();
      if (command === 'previous' || command === 'next') this.step(command === 'previous' ? -1 : 1);
      if (command === 'latest') this.refresh(true).catch(error => this.fail(error));
      if (command === 'center') this.view?.center();
      if (command === 'zoom-in' || command === 'zoom-out') this.view?.renderer.zoomBy(command === 'zoom-in' ? .8 : 1.25);
      if (command === 'fullscreen') void (document.fullscreenElement ? document.exitFullscreen() : this.container.requestFullscreen()).catch(error => this.fail(error));
    });
    this.container.addEventListener('keydown', event => {
      if (event.target.closest('input') || event.metaKey || event.ctrlKey || event.altKey || !this.movie) return;
      const key = event.key.toLowerCase();
      if (!['k', ' ', 'j', 'l', ',', '.', 'home', 'end'].includes(key)) return;
      if (key === ' ' && event.target.closest('button') && event.target !== this.playButton) return;
      event.preventDefault(); event.stopPropagation();
      if (['k', ' '].includes(key)) { if (!event.repeat) this.togglePlay(); }
      else if ([',', '.'].includes(key)) this.step(key === ',' ? -1 : 1);
      else { this.pause(); this.draw(key === 'home' ? 0 : key === 'end' ? this.movie.duration : this.time + (key === 'j' ? -5000 : 5000)); }
    });
    this.resize = new ResizeObserver(() => this.view?.renderer.resize()); this.resize.observe(this.canvas);
  }
  button(command) { return this.container.querySelector(`[data-command="${command}"]`); }
  async update(run) {
    const changed = this.run && run.history_epoch !== this.run.history_epoch;
    this.run = run;
    if (!this.started || changed) { this.started = true; await this.refresh(); }
    this.button('latest').textContent = run.action_count > (this.actionCount ?? Infinity) ? 'Latest •' : 'Latest';
    this.button('latest').title = `Jump to move ${run.action_count || 0}`;
  }
  async refresh(latest = false) {
    const generation = ++this.generation; this.pause(); this.busy = true;
    this.notice.hidden = false; this.notice.classList.remove('replay-error'); this.notice.querySelector('span').textContent = 'Preparing replay…';
    this.playButton.disabled = true;
    const [response, { ReplayView }, { prepareBrowserModels, paintLoadProgress }, { locateReplay }, { installFlyoverControls }] = await Promise.all([
      fetch(this.origin), import('../../replays/v1/view.mjs'), import('../../ui/browser-world.mjs'), import('../../replays/v1/movie.mjs'), import('../../ui/flyover-controls.mjs')
    ]);
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not load replay.');
    if (generation !== this.generation) return;
    const world = data.world;
    world.blocks = world.blocks.map(block => ({ ...block, visual: { ...block.visual, ...(block.visual?.modelUrl ? {
      modelUrl: new URL(block.visual.modelUrl, new URL('/level-data/v2/main-world/world.json', location.href)).href
    } : {}) } }));
    world.blockDefinitions = new Map(world.blocks.map(block => [block.id, block]));
    await prepareBrowserModels(new Set(world.blocks.map(block => block.visual?.modelUrl).filter(Boolean)));
    await paintLoadProgress(); if (generation !== this.generation) return;
    this.locate = locateReplay;
    this.notice.querySelector('span').textContent = 'Drawing replay…';
    if (this.view) this.view.setMovie(data.movie);
    else {
      this.view = new ReplayView(this.canvas, world, data.movie);
      // Camera shortcuts belong to this player, not the rest of the run page.
      this.view.renderer.disposeFlyoverControls();
      this.view.renderer.disposeFlyoverControls = installFlyoverControls(this.view.renderer, { window: this.container, document });
    }
    this.movie = data.movie; this.actionCount = data.action_count;
    this.roomLabels = new Map(world.rooms.map(room => [room.fileName, room.position.join('x')]));
    this.seek.max = String(this.movie.duration); this.seek.disabled = false; this.playButton.disabled = false;
    this.busy = false; this.view.renderer.resize(); this.draw(latest ? this.movie.duration : 0);
    this.notice.hidden = true;
  }
  fail(error) { this.pause(); this.busy = false; this.notice.hidden = false; this.notice.classList.add('replay-error'); this.notice.querySelector('span').textContent = `${error.message} Click Latest to retry.`; }
  draw(time) {
    if (!this.movie || !this.view) return;
    const location = this.view.show(time); this.time = location.time; this.transport(location);
  }
  transport(location = this.movie && this.locate(this.movie, this.time)) {
    if (!location) return;
    const { clip, local, index } = location;
    this.seek.value = String(this.time); this.seek.style.setProperty('--played', `${100 * this.time / this.movie.duration}%`);
    this.seek.setAttribute('aria-valuetext', `${clock(this.time)} of ${clock(this.movie.duration)}, move ${clip.move} of ${this.actionCount}`);
    this.container.querySelector('output').textContent = `${clock(this.time)} / ${clock(this.movie.duration)}`;
    this.playButton.setAttribute('aria-label', this.playing ? 'Pause' : 'Play'); this.playButton.querySelector('path').setAttribute('d', this.playing ? pauseIcon : playIcon);
    this.button('previous').disabled = this.time <= 0; this.button('next').disabled = this.time >= this.movie.duration;
    this.onPosition({ move: clip.move, room: this.roomLabels.get(local >= clip.settledAt ? clip.to : clip.room), index });
  }
  togglePlay() {
    if (!this.movie || this.busy) return;
    if (this.playing) { this.pause(); return; }
    if (this.time >= this.movie.duration) this.draw(0);
    this.playing = true; this.lastFrame = performance.now(); this.transport();
    const tick = now => {
      if (!this.playing) return;
      const time = this.time + Math.max(0, now - this.lastFrame) * this.speed; this.lastFrame = now;
      this.draw(time);
      if (this.time >= this.movie.duration) this.pause(); else this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }
  pause() { this.playing = false; cancelAnimationFrame(this.frame); this.view?.renderer.cancelCameraMotion(); this.transport(); }
  step(direction) {
    if (!this.movie) return; this.pause();
    const { index, clip } = this.locate(this.movie, this.time);
    this.draw(direction < 0 ? this.time > clip.start ? clip.start : this.movie.clips[Math.max(0, index - 1)].start : this.movie.clips[index + 1]?.start ?? this.movie.duration);
  }
  seekMove(move) { if (this.movie) { this.pause(); this.draw(this.movie.clips.find(clip => clip.move === move)?.start ?? this.movie.duration); } }
  dispose() { this.generation++; this.pause(); this.resize.disconnect(); this.view?.renderer.disposeFlyoverControls(); this.view?.scene?.dispose(); this.view?.sceneCache?.clear(); }
}
