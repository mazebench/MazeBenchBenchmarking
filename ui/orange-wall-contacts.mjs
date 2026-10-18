import * as THREE from "../render/vendor/three.module.min.js";
import { voxelPieceDefinition } from "../render/v1/voxel-scene-v2.mjs";
import { edgeMaterial } from "../render/v1/polycube-mesh.mjs";
import { surfaceContactEdges } from "./joined-voxel-surface.mjs";

export function contactShape(object, block) {
  if (!block || object.engineHidden || block.visual?.orangeForm === "hidden") return null;
  const definition = voxelPieceDefinition(object, block);
  if (!["cube", "floor", "slope", "gate", "raised_lift", "lowered_lift", "floating_floor"].includes(definition.kind)) return null;
  return {
    position: [object.x, definition.bottom, object.y],
    size: [1, definition.top - definition.bottom, 1],
    ...(definition.kind === "slope" ? { direction: object.orientation || "right" } : {})
  };
}

export function worldContactShapes(world) {
  const walls = [], supports = [];
  for (const room of world.rooms) for (const object of room.objects) {
    const block = world.blockDefinitions.get(object.blockId);
    const shape = contactShape(object, block);
    if (!shape) continue;
    shape.position[0] += room.columnIndex * world.roomWidth;
    shape.position[2] += room.rowIndex * world.roomHeight;
    (block.roleId === "orange-wall" ? walls : supports).push(shape);
  }
  return { walls, supports };
}

export function addOrangeWallContacts(content, world, dimensions, ceiling = null) {
  const { walls, supports } = worldContactShapes(world);
  const positions = surfaceContactEdges(walls, supports, dimensions.totalWidth / 2, dimensions.totalHeight / 2);
  if (!positions.length) return;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
  const lines = new THREE.LineSegments(geometry, edgeMaterial());
  if (ceiling !== null) {
    lines.material = lines.material.clone();
    lines.material.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, -1, 0), ceiling)];
    lines.userData.transientMaterial = true;
  }
  lines.renderOrder = 10;
  lines.userData.orangeWallContacts = true;
  content.add(lines);
}

// One small retained outline buffer per moving wall group. The shader/clip/
// fade materials are inherited from its actor; no scene or geometry rebuilds.
export class AnimatedWallContacts {
  constructor(renderer, root, walls, supports) {
    this.renderer = renderer;
    this.root = root;
    this.walls = walls;
    // Only bodies whose swept horizontal bounds meet a wall can touch it.
    const bounds = track => [0, 1].map(axis => [Math.min(...track.positions.map(p => p[axis])), Math.max(...track.positions.map(p => p[axis])) + 1]);
    const wallBounds = walls.map(({ track }) => bounds(track));
    let pairCount = 0;
    this.supports = supports.filter(({ track }) => {
      const box = bounds(track);
      const count = wallBounds.filter(wall => box.every(([min, max], axis) => max >= wall[axis][0] && min <= wall[axis][1])).length;
      pairCount += count;
      return count > 0;
    });
    const geometry = new THREE.BufferGeometry();
    // A cube/wedge pair contributes at most 6×6 intersection segments.
    const vertices = pairCount * 36 * 6;
    for (const name of ["position", "lineOther"]) geometry.setAttribute(name,
      new THREE.BufferAttribute(new Float32Array(vertices * 3), 3).setUsage(THREE.DynamicDrawUsage));
    const sides = new Float32Array(vertices), ends = new Float32Array(vertices);
    for (let i = 0; i < vertices; i += 6) {
      sides.set([-1, 1, 1, 1, 1, -1], i);
      ends.set([0, 1, 0, 0, 1, 1], i);
    }
    geometry.setAttribute("lineSide", new THREE.BufferAttribute(sides, 1));
    geometry.setAttribute("lineEnd", new THREE.BufferAttribute(ends, 1));
    geometry.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(geometry, renderer.thickEdges.material(edgeMaterial()));
    this.mesh.userData.mazeWideOutline = this.mesh.userData.orangeWallContacts = this.mesh.userData.transientMaterial = true;
    this.mesh.renderOrder = 10;
    this.mesh.frustumCulled = false;
    root.add(this.mesh);
  }

  update() {
    const signature = [...this.walls, ...this.supports].map(({ shape, visible }) =>
      `${visible}:${shape.position}:${shape.size}`).join(";");
    if (signature === this.signature) return;
    this.signature = signature;
    const walls = this.walls.filter(record => record.visible).map(record => record.shape);
    const supports = this.supports.filter(record => record.visible).map(record => record.shape);
    const positions = surfaceContactEdges(walls, supports, this.renderer.totalWidth / 2, this.renderer.totalHeight / 2);
    const geometry = this.mesh.geometry, position = geometry.attributes.position, other = geometry.attributes.lineOther;
    let index = 0;
    for (let i = 0; i < positions.length; i += 6) {
      for (const end of [0, 1, 0, 0, 1, 1]) {
        for (const [attribute, offset] of [[position, end * 3], [other, (1 - end) * 3]]) {
          attribute.setXYZ(index, positions[i + offset] - this.root.position.x,
            positions[i + offset + 1] - this.root.position.y, positions[i + offset + 2] - this.root.position.z);
        }
        index++;
      }
    }
    for (const attribute of [position, other]) {
      attribute.clearUpdateRanges();
      if (index) attribute.addUpdateRange(0, index * 3);
      attribute.needsUpdate = true;
    }
    geometry.setDrawRange(0, index);
  }
}
