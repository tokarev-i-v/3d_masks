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

const visibleHeightAtZDepth = (depth, camera) => {
  // compensate for cameras not positioned at z=0
  const cameraOffset = camera.position.z;
  if (depth < cameraOffset) depth -= cameraOffset;
  else depth += cameraOffset;

  // vertical fov in radians
  const vFOV = camera.fov * Math.PI / 180;

  // Math.abs to ensure the result is always positive
  return 2 * Math.tan(vFOV / 2) * Math.abs(depth);
};

const visibleWidthAtZDepth = (depth, camera) => {
  const height = visibleHeightAtZDepth(depth, camera);
  return height * camera.aspect;
};


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
  scatterGLHasInitialized = false, scatterGL, flattenedPointsData = [], facePrediction = null;

class Program {
  constructor(width, height) {
    this.SCREEN_HEIGHT = height;
    this.SCREEN_WIDTH = width;
    this.meshes_parameters = {
      width: width,
      height: height
    };

    this.Container = document.createElement("div");
    this.Container.id = "container3d";
    this.Container.style.position = "absolute";
    this.Container.style.left = "0px";
    this.Container.style.top = "0px";
    document.body.appendChild(this.Container);
    this.Scene = new THREE.Scene();
    this.Camera = new THREE.PerspectiveCamera(45, this.SCREEN_WIDTH / this.SCREEN_HEIGHT, 0.1, 10000);
    this.Camera.position.set(this.SCREEN_WIDTH / 2, this.SCREEN_HEIGHT / 2, this.SCREEN_HEIGHT / visibleHeightAtZDepth(1, this.Camera) * 1);
    this.Scene.add(this.Camera);
    this.Video = document.querySelector("#video");
    this.Object = new THREE.Object3D();
    this.HelmetScene = null;
    this.HelmetHead = null;
    this.HelmetHeadObject = null;
    // this.Scene.add(new THREE.Mesh(new THREE.SphereBufferGeometry(10, 10, 10), new THREE.MeshBasicMaterial()));



    let gltfloader = new THREE.GLTFLoader();
    gltfloader.load(
      // resource URL
      'Mask.glb',
      // called when the resource is loaded
      function (gltf) {
        gltf.scene.traverse(function (child) {

          if (child.name === "Human_02") {
            this.HelmetHead = child;
            if (!this.HelmetHead.geometry.boundingBox) {
              this.HelmetHead.geometry.computeBoundingBox();
              this.HelmetHead.material.metalness = 0;
            }
          }
          if (child.name === "entity_2") {
            this.HelmetHeadObject = child;
            this.HelmetHeadObject.position.set(100, 100, 0);
            for (let chd of this.HelmetHeadObject.children) {
              chd.material.metalness = 0;
            }
          }
          console.log(child);

        }.bind(this));
        this.HelmetScene = gltf.scene;
        this.Scene.add(this.HelmetScene);

      }.bind(this),
      // called while loading is progressing
      function (xhr) {

        console.log((xhr.loaded / xhr.total * 100) + '% loaded');

      },
      // called when loading has errors
      function (error) {

        console.log('An error happened');
        console.log(error);

      }
    );

    // let fbxloader = new THREE.FBXLoader();
    // fbxloader.load('Mask.fbx', function (object) {

    //   //mixer = new THREE.AnimationMixer(object);

    //   //var action = mixer.clipAction(object.animations[0]);
    //   //action.play();

    //   object.traverse(function (child) {

    //     if (child.isMesh) {
    //       if (child.name === "Human_02001") {
    //         this.HelmetHead = child;
    //         if (!this.HelmetHead.geometry.boundingBox) {
    //           this.HelmetHead.geometry.computeBoundingBox();
    //           this.HelmetHead.position.set(100, 100, 0);
    //         }
    //       }
    //       child.castShadow = true;
    //       child.receiveShadow = true;

    //     }

    //   });

    //   this.Scene.add(object);

    // });

    let backPlaneMat = new THREE.PointsMaterial({ color: 0xFF0000 });
    let backPlaneGeom = new THREE.BufferGeometry();
    let vertices = [
      0.0, 0.0, 0.0,
      0.0, height, 0.0,
      width, 0.0, 0.0,
      width, height, 0.0,
    ];
    backPlaneGeom.addAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    this.backPlane = new THREE.Points(backPlaneGeom, backPlaneMat);
    this.Scene.add(this.backPlane);

    // let mesh3dMat = new THREE.PointsMaterial({ color: 0x888888 });
    // let mesh3dGeom = new THREE.BufferGeometry();
    // mesh3dGeom.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    // this.FaceMesh3D = new THREE.Points();

    //this.Video.autoplay = 1;
    // this.Video.width = 224;
    // this.Video.height = 224;

    let light = new THREE.AmbientLight(0xffffff); // soft white light
    this.Scene.add(light);

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
    //this.Scene.add(this.CanvasMesh);
    //this.Scene.add(this.imageMesh);
    this.Renderer = new THREE.WebGLRenderer({ alpha: true, transparent: true });
    this.Renderer.setSize(this.SCREEN_WIDTH, this.SCREEN_HEIGHT);
    this.Renderer.autoClearColor = false;
    this.Container.appendChild(this.Renderer.domElement);
    this.render = this.render.bind(this);

    this.mesh3dMat = new THREE.PointsMaterial({ color: 0xFF0000, size: 3 });
    this.mesh3dGeom = new THREE.BufferGeometry();
    this.mesh3dGeom.addAttribute('position', new THREE.Float32BufferAttribute([], 3));
    this.FaceMesh3D = new THREE.Points(this.mesh3dGeom, this.mesh3dMat);
    this.Scene.add(this.FaceMesh3D);
  }

  renderFacePoints(coords) {
    let flat = coords.flat();
    this.mesh3dGeom.addAttribute('position', new THREE.Float32BufferAttribute(flat, 3));
    this.mesh3dGeom.attributes.position.needsUpdate = true;
  }
  renderHelmetHead(faceprediction) {
    this.HelmetHead.geometry.computeBoundingBox();
    let width = faceprediction.boundingBox.bottomRight[0][0] - faceprediction.boundingBox.topLeft[0][0];
    let height = faceprediction.boundingBox.bottomRight[0][1] - faceprediction.boundingBox.topLeft[0][1];

    let head_width = this.HelmetHead.geometry.boundingBox.max.x - this.HelmetHead.geometry.boundingBox.min.x;
    let head_height = this.HelmetHead.geometry.boundingBox.max.y - this.HelmetHead.geometry.boundingBox.min.y;
    let val = width / head_width / 9;
    this.HelmetHeadObject.scale.set(val, val, val);

  }
  render(coords) {
    //this.imageCanvasTexture.needsUpdate = true;
    this.CanvasTexture.needsUpdate = true;
    // this.imageMesh.position.x = coords.x;
    // this.imageMesh.position.y = coords.y;
    this.renderFacePoints(flattenedPointsData);
    if (facePrediction && this.HelmetHead) {
      this.renderHelmetHead(facePrediction);
    }
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

  const predictions = await model.estimateFaces(canvas);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  if (predictions.length > 0) {
    facePrediction = predictions[0];
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
        return scaledMesh.map(point => ([point[0], -point[1] + VIDEO_HEIGHT, point[2]]));
      });
      //const pointsData = predictions[0].scaledMesh;

      flattenedPointsData = [];
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

  } else {
    facePrediction = null;
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

  videoWidth = video.videoWidth;
  videoHeight = video.videoHeight;
  video.width = videoWidth;
  video.height = videoHeight;
  // video.width = VIDEO_WIDTH;
  // video.height = VIDEO_HEIGHT;
  // video.style.width = VIDEO_WIDTH + "px";
  // video.style.height = VIDEO_HEIGHT + "px";

  canvas = document.getElementById('output');
  canvas.width = VIDEO_WIDTH;
  canvas.height = VIDEO_HEIGHT;
  const canvasContainer = document.querySelector('.canvas-wrapper');
  canvasContainer.style = `width: ${VIDEO_WIDTH}px; height: ${VIDEO_HEIGHT}px`;

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
