import * as THREE from "../render/vendor/three.module.min.js";

export const OUTLINE_WIDTH_PX = 3; // Width at the reference room-view depth.
export const OUTLINE_REFERENCE_DEPTH = 48; // Default room view, in world tiles.
export const isOutline = object => object.isLineSegments && (object.material?.userData.mazeOutline || object.material?.color?.getHex() === 0x111820);
export const isEdge = object => object.isLineSegments || object.userData.mazeWideOutline;

// Expand in one draw, attenuating width with each endpoint's camera depth.
// Endpoints stay in world space for clipping and mechanism morphs.
export function thickEdgeGeometry(source) {
  const points = source.attributes.position;
  const position = [], other = [], side = [];
  const point = i => [points.getX(i), points.getY(i), points.getZ(i)];
  for (let i = 0; i < points.count; i += 2) {
    const a = point(i), b = point(i + 1);
    for (const [end, sign] of [[0,-1], [1,1], [0,1], [0,1], [1,1], [1,-1]]) {
      position.push(...(end ? b : a));
      other.push(...(end ? a : b));
      side.push(sign);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("lineOther", new THREE.Float32BufferAttribute(other, 3));
  geometry.setAttribute("lineSide", new THREE.Float32BufferAttribute(side, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

export class ThickEdges {
  constructor() {
    this.materials = new Map();
    this.geometries = new WeakMap();
    this.uniforms = {
      mazeLineViewport: { value: new THREE.Vector2(1, 1) },
      mazeLineWidth: { value: OUTLINE_WIDTH_PX },
      mazeLineReferenceDepth: { value: OUTLINE_REFERENCE_DEPTH },
      mazeLineNear: { value: .05 }
    };
  }

  material(source) {
    const material = new THREE.MeshBasicMaterial({
      color: 0x000000, side: THREE.DoubleSide, depthTest: true, depthWrite: false,
      opacity: source.userData.mazeOutline ? source.opacity : 1,
      // Subpixel strokes use coverage instead of vanishing between samples.
      transparent: true, forceSinglePass: true,
      clippingPlanes: source.clippingPlanes
    });
    material.userData.mazeOutline = material.userData.mazeWideOutline = true;
    material.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = `attribute vec3 lineOther;\nattribute float lineSide;\nuniform vec2 mazeLineViewport;\nuniform float mazeLineWidth;\nuniform float mazeLineReferenceDepth;\nuniform float mazeLineNear;\nvarying float mazeLineCoverage;\n${shader.vertexShader}`
        .replace("#include <project_vertex>", `
          vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
          vec4 otherView = modelViewMatrix * vec4(lineOther, 1.0);
          // Trim near-plane crossings before dividing by perspective w.
          float nearZ = -mazeLineNear;
          if (mvPosition.z > nearZ && otherView.z < nearZ) {
            mvPosition = mix(mvPosition, otherView, (nearZ - mvPosition.z) / (otherView.z - mvPosition.z));
          } else if (otherView.z > nearZ && mvPosition.z < nearZ) {
            otherView = mix(otherView, mvPosition, (nearZ - otherView.z) / (mvPosition.z - otherView.z));
          }
          vec4 unbiasedPosition = mvPosition;
          float viewDistance = max(length(mvPosition.xyz), 0.0001);
          float otherDistance = max(length(otherView.xyz), 0.0001);
          mvPosition.xyz *= max(viewDistance - max(.024, viewDistance * .0015), 0.0) / viewDistance;
          otherView.xyz *= max(otherDistance - max(.024, otherDistance * .0015), 0.0) / otherDistance;
          gl_Position = projectionMatrix * mvPosition;
          vec4 otherClip = projectionMatrix * otherView;
          vec2 direction = (otherClip.xy / otherClip.w - gl_Position.xy / gl_Position.w) * mazeLineViewport;
          direction /= max(length(direction), .0001);
          vec2 normal = vec2(-direction.y, direction.x);
          float depth = max(-unbiasedPosition.z, mazeLineNear);
          float width = mazeLineWidth * mazeLineReferenceDepth / depth;
          mazeLineCoverage = min(width, 1.0);
          float rasterWidth = max(width, 1.0);
          gl_Position.xy += (normal * lineSide - direction) * rasterWidth / mazeLineViewport * gl_Position.w;
          if (unbiasedPosition.z > nearZ && otherView.z > nearZ) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          mvPosition = unbiasedPosition;
        `);
      shader.fragmentShader = `varying float mazeLineCoverage;\n${shader.fragmentShader}`
        .replace("#include <opaque_fragment>", `
          diffuseColor.a *= mazeLineCoverage;
          #include <opaque_fragment>
        `);
    };
    material.customProgramCacheKey = () => "maze-depth-outline-v2";
    return material;
  }

  apply(root) {
    const lines = [], owned = new Set(root.userData.cutawayMaterials || []);
    root.traverse(object => { if (isOutline(object)) lines.push(object); });
    for (const line of lines) {
      const source = line.material;
      const transient = line.userData.transientMaterial || owned.has(source);
      if (!transient && !this.materials.has(source)) this.materials.set(source, this.material(source));
      const material = transient ? this.material(source) : this.materials.get(source);
      let geometry = this.geometries.get(line.geometry);
      if (!geometry) {
        geometry = thickEdgeGeometry(line.geometry);
        if (line.geometry.userData.persistentGeometry) {
          geometry.userData.persistentGeometry = true;
          this.geometries.set(line.geometry, geometry);
        }
      }
      const mesh = new THREE.Mesh(geometry, material);
      THREE.Object3D.prototype.copy.call(mesh, line, false);
      mesh.userData.mazeWideOutline = true;
      if (transient) mesh.userData.transientMaterial = true;
      mesh.layers.set(0);
      mesh.castShadow = mesh.receiveShadow = false;
      const parent = line.parent, index = parent.children.indexOf(line);
      parent.remove(line); parent.add(mesh);
      parent.children.splice(parent.children.indexOf(mesh), 1);
      parent.children.splice(index, 0, mesh);
      if (!line.geometry.userData.persistentGeometry) line.geometry.dispose();
      if (line.userData.transientMaterial) source.dispose();
    }
  }
}
