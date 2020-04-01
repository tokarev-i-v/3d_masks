/**
 * @license
 * Copyright 2020 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

import * as facemesh from '@tensorflow-models/facemesh';
import Stats from 'stats.js';
import * as tf from '@tensorflow/tfjs-core';
import * as tfjsWasm from '@tensorflow/tfjs-backend-wasm';
// TODO(annxingyuan): read version from tfjsWasm directly once
// https://github.com/tensorflow/tfjs/pull/2819 is merged.
import { version } from '@tensorflow/tfjs-backend-wasm/dist/version';

import { TRIANGULATION } from './triangulation';

tfjsWasm.setWasmPath(
  `https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@${
  version}/dist/tfjs-backend-wasm.wasm`);

function isMobile() {
  const isAndroid = /Android/i.test(navigator.userAgent);
  const isiOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  return isAndroid || isiOS;
}

function drawPath(ctx, points, closePath) {
  const region = new Path2D();
  region.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) {
    const point = points[i];
    region.lineTo(point[0], point[1]);
  }

  if (closePath) {
    region.closePath();
  }
  ctx.stroke(region);
}
const VIDEO_HEIGHT = window.innerHeight;
const VIDEO_WIDTH = window.innerWidth;
let model, ctx, videoWidth, videoHeight, video, canvas,
  scatterGLHasInitialized = false, scatterGL;

class Program {
  constructor(width, height) {
    this.SCREEN_HEIGHT = height;
    this.SCREEN_WIDTH = width;
    this.meshes_parameters = {
      width: width,
      height: height
    };
    this.Container = document.createElement("div");
    this.Container.id = "container";
    this.Container.style.position = "absolute";
    this.Container.style.left = "0px";
    this.Container.style.top = "0px";
    this.Scene = new THREE.Scene();
    this.Camera = new THREE.PerspectiveCamera(45, this.SCREEN_WIDTH / this.SCREEN_HEIGHT, 0.1, 10000);
    this.Video = document.querySelector("video");
    //this.Video.autoplay = 1;
    // this.Video.width = 224;
    // this.Video.height = 224;

    this.ctx = document.querySelector("#output").getContext("2d");
    this.ctx.canvas.width = this.meshes_parameters.width;
    this.ctx.canvas.height = this.meshes_parameters.height;
    this.ctx.fillStyle = "#FFF";
    this.ctx.fillRect(0, 0, this.ctx.canvas.width, this.ctx.canvas.height);

    //this.VideoTexture = new THREE.VideoTexture(this.Video);
    this.CanvasTexture = new THREE.CanvasTexture(this.ctx.canvas);
    //this.imageCanvasTexture = new THREE.CanvasTexture(this.ctx.canvas);
    //this.VideoTexture.minFilter = THREE.LinearFilter;
    //this.VideoTexture.magFilter = THREE.LinearFilter;

    //let videoMat = new THREE.MeshBasicMaterial({ map: this.VideoTexture, side: THREE.DoubleSide });
    let canvasMat = new THREE.MeshBasicMaterial({ map: this.CanvasTexture, side: THREE.DoubleSide });
    //let imageCanvasMat = new THREE.MeshBasicMaterial({ map: this.imageCanvasTexture, side: THREE.DoubleSide });


    //this.VideoMesh = new THREE.Mesh(new THREE.PlaneBufferGeometry(this.meshes_parameters.width, this.meshes_parameters.height), videoMat);
    this.CanvasMesh = new THREE.Mesh(new THREE.PlaneBufferGeometry(this.meshes_parameters.width, this.meshes_parameters.height), canvasMat);
    //this.imageMesh = new THREE.Mesh(new THREE.PlaneBufferGeometry(100, 100), imageCanvasMat);

    //this.VideoMesh.position.set(0, 0, -1000);
    this.CanvasMesh.position.set(0, 0, -999.99);
    //this.imageMesh.position.set(0, 0, -1000);

    //this.Scene.add(this.VideoMesh);
    this.Scene.add(this.CanvasMesh);
    //this.Scene.add(this.imageMesh);
    this.Renderer = new THREE.WebGLRenderer({ alpha: true, transparent: true });
    this.Renderer.setSize(this.SCREEN_WIDTH, this.SCREEN_HEIGHT);
    this.Container.appendChild(this.Renderer.domElement);
    this.render = this.render.bind(this);
  }
  render(coords) {
    //this.imageCanvasTexture.needsUpdate = true;
    this.CanvasTexture.needsUpdate = true;
    // this.imageMesh.position.x = coords.x;
    // this.imageMesh.position.y = coords.y;
    this.Renderer.render(this.Scene, this.Camera);
    //requestAnimationFrame(this.render);
  }
}
let prog = new Program(VIDEO_WIDTH, VIDEO_HEIGHT);
const mobile = isMobile();
// Don't render the point cloud on mobile in order to maximize performance and
// to avoid crowding limited screen space.
const renderPointcloud = mobile === false;
const stats = new Stats();
const state = {
  backend: 'wasm',
  maxFaces: 1,
  triangulateMesh: true
};

if (renderPointcloud) {
  state.renderPointcloud = true;
}


function setupDatGui() {
  const gui = new dat.GUI();
  gui.add(state, 'backend', ['wasm', 'webgl', 'cpu'])
    .onChange(async backend => {
      await tf.setBackend(backend);
    });

  gui.add(state, 'maxFaces', 1, 20, 1).onChange(async val => {
    model = await facemesh.load({ maxFaces: val });
  });

  gui.add(state, 'triangulateMesh');

  if (renderPointcloud) {
    gui.add(state, 'renderPointcloud').onChange(render => {
      document.querySelector('#scatter-gl-container').style.display =
        render ? 'inline-block' : 'none';
    });
  }
}

async function setupCamera() {
  video = document.getElementById('video');

  const stream = await navigator.mediaDevices.getUserMedia({
    'audio': false,
    'video': {
      facingMode: 'user',
      // Only setting the video to a specified size in order to accommodate a
      // point cloud, so on mobile devices accept the default size.
      width: mobile ? undefined : VIDEO_WIDTH,
      height: mobile ? undefined : VIDEO_HEIGHT
    },
  });
  video.width = VIDEO_WIDTH;
  video.height = VIDEO_HEIGHT;
  video.srcObject = stream;
  return new Promise((resolve) => {
    video.onloadedmetadata = () => {
      resolve(video);
    };
  });
}

async function renderPrediction() {
  stats.begin();

  const predictions = await model.estimateFaces(video);
  ctx.drawImage(
    video, 0, 0, videoWidth, videoHeight, 0, 0, canvas.width, canvas.height);

  if (predictions.length > 0) {
    predictions.forEach(prediction => {
      const keypoints = prediction.scaledMesh;

      if (state.triangulateMesh) {
        for (let i = 0; i < TRIANGULATION.length / 3; i++) {
          const points = [
            TRIANGULATION[i * 3], TRIANGULATION[i * 3 + 1],
            TRIANGULATION[i * 3 + 2]
          ].map(index => keypoints[index]);

          drawPath(ctx, points, true);
        }
      } else {
        for (let i = 0; i < keypoints.length; i++) {
          const x = keypoints[i][0];
          const y = keypoints[i][1];

          ctx.beginPath();
          ctx.arc(x, y, 1 /* radius */, 0, 2 * Math.PI);
          ctx.fill();
        }
      }
    });

    if (renderPointcloud && state.renderPointcloud && scatterGL != null) {
      const pointsData = predictions.map(prediction => {
        let scaledMesh = prediction.scaledMesh;
        return scaledMesh.map(point => ([-point[0], -point[1], -point[2]]));
      });

      let flattenedPointsData = [];
      for (let i = 0; i < pointsData.length; i++) {
        flattenedPointsData = flattenedPointsData.concat(pointsData[i]);
      }
      const dataset = new ScatterGL.Dataset(flattenedPointsData);

      if (!scatterGLHasInitialized) {
        scatterGL.render(dataset);
      } else {
        scatterGL.updateDataset(dataset);
      }
      scatterGLHasInitialized = true;
    }

  }
  prog.render();
  stats.end();
  requestAnimationFrame(renderPrediction);
};

async function main() {
  await tf.setBackend(state.backend);
  setupDatGui();

  stats.showPanel(0);  // 0: fps, 1: ms, 2: mb, 3+: custom
  document.getElementById('main').appendChild(stats.dom);

  await setupCamera();
  video.play();

  video.width = VIDEO_WIDTH;
  video.height = VIDEO_HEIGHT;
  video.videoWidth = VIDEO_WIDTH;
  video.videoHeight = VIDEO_HEIGHT;

  canvas = document.getElementById('output');
  canvas.width = videoWidth;
  canvas.height = videoHeight;
  const canvasContainer = document.querySelector('.canvas-wrapper');
  canvasContainer.style = `width: ${videoWidth}px; height: ${videoHeight}px`;

  ctx = canvas.getContext('2d');
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.fillStyle = '#32EEDB';
  ctx.strokeStyle = '#32EEDB';
  ctx.lineWidth = 0.5;

  model = await facemesh.load({ maxFaces: state.maxFaces });
  renderPrediction();

  if (renderPointcloud) {
    document.querySelector('#scatter-gl-container').style =
      `width: ${VIDEO_WIDTH}px; height: ${VIDEO_HEIGHT}px;`;

    scatterGL = new ScatterGL(
      document.querySelector('#scatter-gl-container'),
      { 'rotateOnStart': false, 'selectEnabled': false });
  }
};

main();
