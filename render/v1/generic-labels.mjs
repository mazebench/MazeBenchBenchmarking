// Numeric face labels for C++ generic rigid-body families. The material and
// geometry are cached by value so a room adds no per-frame canvas work.

import * as THREE from "../vendor/three.module.min.js";
import { cachedGeometry } from "./polycube-mesh.mjs";

const textureCache = new Map();
const materialCache = new Map();
const planeGeometry = () => cachedGeometry("generic-number-plane", () =>
  new THREE.PlaneGeometry(0.48, 0.48));

function numericLabel(value) {
  if (Number.isInteger(value) && value >= 0) return String(value);
  const match = /(\d+)$/.exec(String(value ?? ""));
  return match ? match[1] : null;
}

export function genericNumberLabel(object, block) {
  const roleId = block?.roleId;
  if (roleId === "weightless-pushable" || roleId === "clone") {
    return numericLabel(object.groupId ?? object.genericId);
  }
  if (object?.type === "weightless_box" || object?.type === "clone") {
    return numericLabel(object.groupId ?? object.genericId ?? object.token);
  }
  return null;
}

function textureFor(label) {
  if (textureCache.has(label)) return textureCache.get(label);
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, 128, 128);
  context.fillStyle = "rgba(247, 242, 231, .88)";
  context.beginPath();
  context.roundRect(14, 14, 100, 100, 17);
  context.fill();
  context.strokeStyle = "rgba(0, 0, 0, .72)";
  context.lineWidth = 7;
  context.stroke();
  const length = String(label).length;
  context.font = `900 ${length <= 2 ? 72 : length <= 4 ? 54 : 40}px ui-monospace, monospace`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = "#080a0d";
  context.fillText(String(label), 64, 68, 88);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  textureCache.set(label, texture);
  return texture;
}

function materialFor(label) {
  if (!materialCache.has(label)) {
    materialCache.set(label, new THREE.MeshBasicMaterial({
      alphaTest: 0.04,
      depthWrite: false,
      map: textureFor(label),
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      side: THREE.DoubleSide,
      transparent: true
    }));
  }
  return materialCache.get(label);
}

function addFace(group, label, position, rotation) {
  const mesh = new THREE.Mesh(planeGeometry(), materialFor(label));
  mesh.position.copy(position);
  mesh.rotation.copy(rotation);
  mesh.renderOrder = 16;
  group.add(mesh);
}

export function addGenericNumberFaces(group, record, dimensions) {
  const label = record.label ?? genericNumberLabel(record.object || record.source, record.block);
  if (label === null || label === undefined) return;
  const x = record.x - dimensions.totalWidth / 2 + 0.5;
  const z = record.z - dimensions.totalHeight / 2 + 0.5;
  const bottom = record.bottom ?? record.definition?.bottom ?? 0;
  const top = record.top ?? record.definition?.top ?? bottom + 1;
  const y = bottom + Math.max(0.24, Math.min(0.58, (top - bottom) / 2));
  const offset = 0.506;
  addFace(group, label, new THREE.Vector3(x, y, z + offset), new THREE.Euler(0, 0, 0));
  addFace(group, label, new THREE.Vector3(x, y, z - offset), new THREE.Euler(0, Math.PI, 0));
  addFace(group, label, new THREE.Vector3(x + offset, y, z), new THREE.Euler(0, Math.PI / 2, 0));
  addFace(group, label, new THREE.Vector3(x - offset, y, z), new THREE.Euler(0, -Math.PI / 2, 0));
  addFace(group, label, new THREE.Vector3(x, top + 0.006, z), new THREE.Euler(-Math.PI / 2, 0, 0));
}

