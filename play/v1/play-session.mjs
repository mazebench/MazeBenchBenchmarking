import { countActiveRoleV1 } from "../../engine/v1/adapter.mjs";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function cloneState(state) {
  return {
    width: state.width,
    height: state.height,
    objects: state.objects.map((object) => ({ ...object }))
  };
}

export class PlaySessionV1 {
  constructor(engine, definitions, callbacks = {}) {
    this.engine = engine;
    this.definitions = definitions;
    this.onFrame = callbacks.onFrame || (() => {});
    this.onChange = callbacks.onChange || (() => {});
    this.frameDelay = callbacks.frameDelay ?? 105;
    this.room = null;
    this.state = null;
    this.initialState = null;
    this.moves = 0;
    this.history = [];
    this.queue = [];
    this.running = false;
    this.generation = 0;
  }

  open(room) {
    this.generation += 1;
    this.room = room;
    this.initialState = this.engine.createState(room);
    this.state = cloneState(this.initialState);
    this.moves = 0;
    this.history.length = 0;
    this.queue.length = 0;
    this.running = false;
    this.publish();
    this.onFrame(this.state, this.room);
  }

  reset() {
    if (!this.initialState) return;
    this.generation += 1;
    this.state = cloneState(this.initialState);
    this.moves = 0;
    this.history.length = 0;
    this.queue.length = 0;
    this.running = false;
    this.publish({ reset: true });
    this.onFrame(this.state, this.room);
  }

  undo() {
    if (!this.state || !this.history.length) return false;
    this.generation += 1;
    const previous = this.history.pop();
    this.state = cloneState(previous.state);
    this.moves = previous.moves;
    this.queue.length = 0;
    this.running = false;
    this.publish({ undone: true });
    this.onFrame(this.state, this.room);
    return true;
  }

  move(direction) {
    if (!this.state || this.queue.length >= 8 || this.playerCount < 1) return;
    this.queue.push(direction);
    return this.drain();
  }

  get gemCount() {
    return this.state ? countActiveRoleV1(this.state, this.definitions, "goal") : 0;
  }

  get playerCount() {
    return this.state ? countActiveRoleV1(this.state, this.definitions, "player") : 0;
  }

  publish(extra = {}) {
    this.onChange({
      busy: this.running,
      gems: this.gemCount,
      moves: this.moves,
      playerActive: this.playerCount > 0,
      queued: this.queue.length,
      canUndo: this.history.length > 0,
      ...extra
    });
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    const runGeneration = this.generation;
    this.publish();
    try {
      while (this.queue.length && runGeneration === this.generation) {
        const direction = this.queue.shift();
        this.history.push({ state: cloneState(this.state), moves: this.moves });
        if (this.history.length > 256) this.history.shift();
        this.publish();
        const simulation = await this.engine.simulateCommand(
          this.state,
          direction,
          this.definitions
        );
        const frames = simulation.frames.length ? simulation.frames : [simulation.final];
        for (const frame of frames) {
          if (runGeneration !== this.generation) return;
          this.state = frame;
          this.onFrame(this.state, this.room);
          await wait(this.frameDelay);
        }
        this.state = simulation.final;
        this.moves += 1;
        this.publish({ cycle: simulation.cycle });
        if (this.playerCount < 1) this.queue.length = 0;
      }
    } catch (error) {
      this.queue.length = 0;
      this.publish({ error: error?.message || "engine/v1 command failed." });
    } finally {
      if (runGeneration === this.generation) {
        this.running = false;
        this.publish();
      }
    }
  }
}
