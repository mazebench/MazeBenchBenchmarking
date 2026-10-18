import { PlayWorldRenderer } from "../../ui/play-world-renderer.mjs";
import { WorldContextRenderer } from "../../ui/world-context-renderer.mjs";
import { FlyoverRenderer } from "../../ui/flyover-renderer.mjs";
import { installFlyoverControls } from "../../ui/flyover-controls.mjs";
import { createPlayWorldContext } from "../../ui/play-world-context.mjs";
import { CommandAnimationScene } from "../../animations/v1/scene.mjs";
import { easeInOut, sampleSegments } from "../../animations/v1/timeline.mjs";
import { gemId, locateReplay, replayCamera, unpackTimeline } from "./movie.mjs";

class ReplayRenderer extends PlayWorldRenderer {
  installEvents() { this.disposeFlyoverControls = installFlyoverControls(this); }
  setFreeYaw(yaw) { FlyoverRenderer.prototype.setFreeYaw.call(this, yaw); }
  recomputeContinuousDirections() { FlyoverRenderer.prototype.recomputeContinuousDirections.call(this); }
  runCameraFrame(now) { FlyoverRenderer.prototype.runCameraFrame.call(this, now); }
  cancelCameraMotion() { FlyoverRenderer.prototype.cancelCameraMotion.call(this); }
  // A paused movie owns its animation clock, including idle gems. Camera input
  // may redraw it, but must never advance the timeline or start an idle loop.
  render() { WorldContextRenderer.prototype.render.call(this); }
  centerBoard() { if (this.onReplayCenter) this.onReplayCenter(); else super.centerBoard(); }
}

export class ReplayView {
  constructor(canvas, world, movie) {
    this.source = world;
    this.world = { ...world, rooms: world.rooms.map(room => ({ ...room })) };
    this.rooms = new Map(this.world.rooms.map(room => [room.fileName, room]));
    this.context = createPlayWorldContext(this.world);
    this.renderer = new ReplayRenderer(canvas, this.context(this.rooms.get(movie.startRoom)), { mode: "play" });
    this.renderer.gemMotionEnabled = true;
    this.renderer.onReplayCenter = () => this.center();
    this.setMovie(movie);
  }

  setMovie(movie) {
    this.scene?.dispose();
    this.renderer.commandAnimation = null;
    this.scene = null;
    this.movie = movie;
    this.index = -1;
    this.lastCamera = null;
    this.renderer.cancelCameraMotion();
    this.show(0);
  }

  updateGems(time) {
    const collected = new Set(this.movie.gems.filter(gem => gem.at <= time).map(gem => gem.id));
    const signature = [...collected].join(",");
    if (signature === this.gemSignature) return false;
    this.gemSignature = signature;
    this.source.rooms.forEach((source, index) => {
      const objects = source.objects.filter((_, i) => !collected.has(gemId(source, i)));
      const current = this.world.rooms[index].objects;
      if (objects.length !== current.length || objects.some((object, i) => object !== current[i])) this.world.rooms[index].objects = objects;
    });
    return true;
  }

  show(time) {
    const location = locateReplay(this.movie, time), { clip, local, index } = location, renderer = this.renderer;
    const pan = this.lastCamera ? [renderer.target.x - this.lastCamera[0], renderer.target.z - this.lastCamera[1]] : [0, 0];
    renderer.renderSuspended = (renderer.renderSuspended || 0) + 1;
    try {
      const changedGems = this.updateGems(location.time);
      if (index !== this.index) {
        this.scene?.dispose();
        renderer.commandAnimation = null;
        this.scene = null;
      }
      if (changedGems || renderer.world.contextActiveRoom.fileName !== clip.room) {
        renderer.setWorld(this.context(this.rooms.get(clip.room)), { preserveCamera: true, preserveCameraPosition: true });
      }
      if (!this.scene) {
        this.scene = new CommandAnimationScene(renderer, unpackTimeline(this.movie, clip, this.world));
        renderer.commandAnimation = this.scene;
      }
      this.scene.update(local);
      this.lastCamera = replayCamera(clip, local);
      renderer.target.x = this.lastCamera[0] + pan[0];
      renderer.target.z = this.lastCamera[1] + pan[1];
      if (clip.type === "room") {
        const t = easeInOut(local / clip.duration);
        if (clip.from === clip.to) renderer.roomLighting.setWeights([this.rooms.get(clip.to)], [1]);
        else renderer.roomLighting.setWeights([this.rooms.get(clip.from), this.rooms.get(clip.to)], [1 - t, t]);
      } else renderer.roomLighting.setWeights(clip.rooms.map(id => this.rooms.get(id)),
        sampleSegments(clip.lighting, clip.initialLight, local, { alwaysEase: true }));
      renderer.presentationTime = location.time;
      this.index = index;
      renderer.canvas.dataset.replayAction = String(index + 1);
      renderer.canvas.dataset.replayTime = location.time.toFixed(2);
    } finally { renderer.renderSuspended--; }
    renderer.render();
    return location;
  }

  center() {
    if (!this.lastCamera) return;
    this.renderer.cancelCameraMotion();
    this.renderer.target.x = this.lastCamera[0];
    this.renderer.target.z = this.lastCamera[1];
    this.renderer.render();
  }
}
