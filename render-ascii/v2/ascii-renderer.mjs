import { AsciiMazeRendererV1 } from "../v1/ascii-renderer.mjs";
import { renderAsciiFrameV2 } from "./ascii-scene.mjs";

// Reuse the v1 DOM painter and controls, with the corrected browser projection.
export class AsciiMazeRendererV2 extends AsciiMazeRendererV1 {
  constructor(...args) {
    super(...args);
    this.boardElement.dataset.asciiRendererVersion = "2";
  }

  async render() {
    if (!this.room) return;
    const generation = ++this.renderGeneration;
    const frame = await renderAsciiFrameV2(this.room, this.definitions, {
      catalog: this.catalog,
      hideNames: this.hideNames,
      hideNamesSeed: this.hideNamesSeed,
      pitch: this.pitch,
      yaw: this.yaw
    });
    if (generation !== this.renderGeneration) return;
    this.paintBoard(frame);
    this.paintLegend(frame.legend);
  }
}
