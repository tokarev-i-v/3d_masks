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
import { runInThisContext } from 'vm';

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
let VIDEO_HEIGHT = window.innerHeight;
let VIDEO_WIDTH = window.innerWidth;
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

    this.loadGLTF = this.loadGLTF.bind(this);

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
      'Orange_test_centered.glb', this.loadGLTF,
      function (xhr) {
        console.log((xhr.loaded / xhr.total * 100) + '% loaded');
      },
      function (error) {
        console.log('An error happened');
        console.log(error);
      }
    );

    this.ctx1 = document.querySelector("#output").getContext("2d");
    this.facecanvas = document.createElement("canvas");
    this.ctx = this.facecanvas.getContext("2d");
    this.ctx.canvas.width = this.meshes_parameters.width;
    this.ctx.canvas.height = this.meshes_parameters.height;
    this.ctx.fillStyle = "#FFF";
    this.ctx.fillRect(0, 0, this.ctx.canvas.width, this.ctx.canvas.height);

    this.Helpinfo = {
      "initialEyesDistance": 0
    }

    this.CanvasTexture = new THREE.CanvasTexture(this.ctx.canvas);

    let canvasMat = new THREE.ShaderMaterial({
      vertexShader: `
      varying vec2 vUv;

      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
      fragmentShader: `
      varying vec2 vUv;
      uniform sampler2D texture;
      uniform float width;
      uniform float height;
      uniform float cp_x;
      uniform float cp_y;
      const float colorspeed = 50.;

      vec3 hsv(vec3 c) {
        vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
        vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
        return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
      }
      // vec2 centerPoint(float height, float width){
      //   vec2 ra = vec2(width/2.0, height/2.0);
      //   return ra;
      // }
      // float getCoeff(vec2 cp){
      //   if (glFragCoord.x < 200.0){
      //       return 0.0;
      //   }
      //   return 1.0;// - distance(cp, gl_FragCoord.xy)/10.0;
      // }
      void main() {
        //vec2 cp = centerPoint(width, height);
        //float dist_coef = getCoeff(cp);
        //gl_FragColor = texture2D( texture, vUv );
        //gl_FragColor.r = dist_coef;
        float dist = distance(gl_FragCoord.xy, vec2(cp_x, cp_y));
        gl_FragColor = texture2D(texture, vUv);
        if (dist < height/2.5){

        } else {
          gl_FragColor.a = 0.0;
        }
        //gl_FragColor = vec4(1.0, 0.0, 0.0, 0.5);
      }`,
      uniforms: {
        texture: { value: this.CanvasTexture },
        width: { value: 0 },
        height: { value: 0 },
        cp_x: { value: 0 },
        cp_y: { value: 0 }
      },
      transparent: true
    });


    let path = './pisa/';
    let format = '.png';
    let urls = [
      path + 'px' + format, path + 'nx' + format,
      path + 'py' + format, path + 'ny' + format,
      path + 'pz' + format, path + 'nz' + format
    ];

    let reflectionCube = new THREE.CubeTextureLoader().load(urls);
    this.refractionCube = new THREE.CubeTextureLoader().load(urls);
    this.refractionCube.mapping = THREE.CubeRefractionMapping;
    //this.Scene.background = reflectionCube;

    this.CanvasMesh = new THREE.Mesh(new THREE.PlaneBufferGeometry(1, 1), canvasMat);
    this.Scene.add(this.CanvasMesh);
    this.Renderer = new THREE.WebGLRenderer({ alpha: true, transparent: true });
    this.Renderer.setSize(this.SCREEN_WIDTH, this.SCREEN_HEIGHT);
    this.Renderer.autoClearColor = false;
    this.Container.appendChild(this.Renderer.domElement);
    this.render = this.render.bind(this);

    this.mesh3dMat = new THREE.PointsMaterial({ color: 0xFF0000, size: 10 });
    this.mesh3dGeom = new THREE.BufferGeometry();
    this.mesh3dGeom.addAttribute('position', new THREE.Float32BufferAttribute([], 3));
    this.FaceMesh3D = new THREE.Points(this.mesh3dGeom, this.mesh3dMat);
    this.Scene.add(this.FaceMesh3D);
    this.createInfo();
  }


  // called when the resource is loaded
  loadGLTF(gltf) {
    gltf.scene.traverse(function (child) {

      if (child.name === "Human_02002") {
        this.HelmetHead = child;
        if (!this.HelmetHead.geometry.boundingBox) {
          this.HelmetHead.geometry.computeBoundingBox();
          this.HelmetHead.material.envMap = this.refractionCube;
          this.HelmetHead.material.refractionRatio = 0.7;
          this.HelmetHead.material.roughness = 0.3;
          //this.HelmetHead.material.metalness = 0;
        }
      }

      if ((child.name !== "Human_02002") && (child instanceof THREE.Mesh)) {
        child.material.transparent = true;
        child.material.opacity = 0;

      }
      if (child.name === "entity_2") {
        this.HelmetHeadObject = child;
        var light = new THREE.DirectionalLight(0xffffff, 5, 100);
        light.position.set(-100, 50, -50);
        this.Scene.add(light);
        light = new THREE.DirectionalLight(0xffffff, 5, 100);
        light.position.set(50, 50, 50);
        this.Scene.add(light);
        this.HelmetHeadObject.position.set(100, 100, 0);
        for (let chd of this.HelmetHeadObject.children) {
          chd.material.metalness = 1.0;
          chd.material.roughness = 0.39;
          // chd.material.side = THREE.FrontSide;
        }
        let leftEyeVector = this.HelmetHeadObject.children[0].getWorldPosition();
        let rightEyeVector = this.HelmetHeadObject.children[1].getWorldPosition();
        this.Helpinfo.initialEyesDistance = leftEyeVector.distanceTo(rightEyeVector);
      }
      console.log(child);

    }.bind(this));
    this.HelmetScene = gltf.scene;
    this.Scene.add(this.HelmetScene);

  }


  renderFacePoints(coords) {
    let flat = coords.flat();
    // let points = [];
    // for (let i = 0; i < TRIANGULATION.length / 3; i++) {
    //   points = [
    //     TRIANGULATION[i * 3], TRIANGULATION[i * 3 + 1],
    //     TRIANGULATION[i * 3 + 2]
    //   ].map(index => coords[index]);
    // }
    // this.mesh3dGeom.setIndex(points);
    this.mesh3dGeom.addAttribute('position', new THREE.Float32BufferAttribute(flat, 3));
    this.mesh3dGeom.attributes.position.needsUpdate = true;
  }

  renderFaceTexture(faceprediction) {
    let width = faceprediction.boundingBox.bottomRight[0][0] - faceprediction.boundingBox.topLeft[0][0];
    let height = faceprediction.boundingBox.bottomRight[0][1] - faceprediction.boundingBox.topLeft[0][1];
    this.ctx.canvas.width = width;
    this.ctx.canvas.height = height;
    this.CanvasMesh.scale.set(width, height, 1)
    this.CanvasMesh.position.set(faceprediction.boundingBox.topLeft[0][0] + width / 2, this.SCREEN_HEIGHT - (faceprediction.boundingBox.topLeft[0][1] + height / 2), 0)
    //this.ctx.fillStyle = "#FFF";
    // this.CanvasMesh.geometry.parameters.width = width;
    // this.CanvasMesh.geometry.parameters.height = height;
    this.ctx.drawImage(this.ctx1.canvas, faceprediction.boundingBox.topLeft[0][0], faceprediction.boundingBox.topLeft[0][1], width, height, 0, 0, width, height);
    this.CanvasMesh.material.uniforms.width.value = width;
    this.CanvasMesh.material.uniforms.height.value = height;
    this.CanvasMesh.material.uniforms.cp_x.value = faceprediction.boundingBox.topLeft[0][0] + width / 2;
    this.CanvasMesh.material.uniforms.cp_y.value = this.SCREEN_HEIGHT - (faceprediction.boundingBox.topLeft[0][1] + height / 2);
    // this.ctx.beginPath();
    // this.ctx.arc(50, 50, 50, 0, 2 * Math.PI, false);
    // this.ctx.clip();
    //this.ctx.fillRect(0, 0, this.ctx.canvas.width, this.ctx.canvas.height);

  }

  createInfo() {
    this.info = document.createElement("div");
    document.body.appendChild(this.info);
    this.info.style.position = "absolute";
    this.info.style.left = "200px";
    this.info.style.top = "20px";
    this.info.style.color = "white";
    this.info.innerText = "";
  }
  updateInfo() {
    this.info.innerText = JSON.stringify(this.HelmetHeadObject.children[0].getWorldPosition()) + " " + JSON.stringify(this.HelmetHeadObject.children[1].getWorldPosition());
  }

  renderHelmetHead(faceprediction) {
    this.HelmetHead.geometry.computeBoundingBox();
    let width = faceprediction.boundingBox.bottomRight[0][0] - faceprediction.boundingBox.topLeft[0][0];
    let height = faceprediction.boundingBox.bottomRight[0][1] - faceprediction.boundingBox.topLeft[0][1];

    //let head_width = this.HelmetHead.geometry.boundingBox.max.x - this.HelmetHead.geometry.boundingBox.min.x;
    // let head_height = this.HelmetHead.geometry.boundingBox.max.y - this.HelmetHead.geometry.boundingBox.min.y;
    // let val = width / head_width / 100;

    let rightEye = new THREE.Vector3(faceprediction.annotations.rightEyeUpper0[0][0], faceprediction.annotations.rightEyeUpper0[0][1], faceprediction.annotations.rightEyeUpper0[0][2]);
    let leftEye = new THREE.Vector3(faceprediction.annotations.leftEyeUpper0[0][0], faceprediction.annotations.leftEyeUpper0[0][1], faceprediction.annotations.leftEyeUpper0[0][2]);
    let eyedist = rightEye.distanceTo(leftEye);
    let val = eyedist / this.Helpinfo.initialEyesDistance * 0.75;
    this.HelmetHeadObject.scale.set(val, val, val);
    let imagecenter = new THREE.Vector3(faceprediction.boundingBox.topLeft[0][0] + width / 2, this.SCREEN_HEIGHT - (faceprediction.boundingBox.topLeft[0][1] + height / 2), 0);
    //this.HelmetHeadObject.scale.set(1, 1, 1);
    // this.HelmetHeadObject.position.set(faceprediction.boundingBox.topLeft[0][0] + width / 2, this.SCREEN_HEIGHT - (faceprediction.boundingBox.topLeft[0][1] + height * 0.75), 0);
    // this.HelmetHeadObject.position.copy(leftEye);
    //this.HelmetHeadObject.position.z = 0;


    rightEye.add(this.HelmetHeadObject.children[1].position.clone().multiplyScalar(val));
    this.HelmetHeadObject.position.set(rightEye.x + width / 2 * 0.8, this.SCREEN_HEIGHT - rightEye.y, 0);
    // let cloned_vec = this.HelmetHeadObject.children[0].position.clone().multiplyScalar(val);

    // this.HelmetHeadObject.position.add();
    //this.HelmetHeadObject.children[0].position.copy(leftEye);
    let annot = new THREE.Vector3(faceprediction.annotations.noseTip[0][0], faceprediction.annotations.noseTip[0][1] + height, -faceprediction.annotations.noseTip[0][2]);
    //    let pos = this.HelmetHeadObject.children[7].position.clone();
    // this.HelmetHeadObject.children[7].position.set(0, 0, 0);
    // annot.sub(imagecenter);
    //annot.add(this.HelmetHeadObject.children[7].position);
    this.HelmetHeadObject.children[7].lookAt(annot);
    //this.HelmetHeadObject.children[7].position.copy(pos);
    // annot.multiplyScalar(val * 100);
    // this.HelmetHeadObject.lookAt(annot);
    // let targvec = new THREE.Vector3();
    // targvec.copy(this.HelmetHeadObject.position).add(annot);
    // this.HelmetHeadObject.children[7].lookAt(targvec);
    // //annot.add(this.HelmetHeadObject.position);
    // //this.HelmetHeadObject.children[0].position.set(0, 0, 0);
    //this.HelmetHeadObject.lookAt(targvec);
    //this.HelmetHeadObject.lookAt(annot);
    //this.updateInfo();
  }
  render(coords) {
    //this.imageCanvasTexture.needsUpdate = true;
    this.CanvasTexture.needsUpdate = true;
    // this.imageMesh.position.x = coords.x;
    // this.imageMesh.position.y = coords.y;
    //this.renderFacePoints(flattenedPointsData);
    if (facePrediction && this.HelmetHead) {
      this.renderFaceTexture(facePrediction);
      this.renderHelmetHead(facePrediction);
    }
    this.Renderer.render(this.Scene, this.Camera);
    //requestAnimationFrame(this.render);
  }
}
let prog = null;
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
      // width: mobile ? undefined : VIDEO_WIDTH,
      // height: mobile ? undefined : VIDEO_HEIGHT
    },
  });
  // VIDEO_WIDTH = video.video
  // video.width = VIDEO_WIDTH;
  // video.height = VIDEO_HEIGHT;
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
    // predictions.forEach(prediction => {
    //   const keypoints = prediction.scaledMesh;

    //   // if (state.triangulateMesh) {
    //   //   for (let i = 0; i < TRIANGULATION.length / 3; i++) {
    //   //     const points = [
    //   //       TRIANGULATION[i * 3], TRIANGULATION[i * 3 + 1],
    //   //       TRIANGULATION[i * 3 + 2]
    //   //     ].map(index => keypoints[index]);

    //   //     drawPath(ctx, points, true);
    //   //   }
    //   // } else {
    //   //   for (let i = 0; i < keypoints.length; i++) {
    //   //     const x = keypoints[i][0];
    //   //     const y = keypoints[i][1];

    //   //     ctx.beginPath();
    //   //     ctx.arc(x, y, 1 /* radius */, 0, 2 * Math.PI);
    //   //     ctx.fill();
    //   //   }
    //   // }
    // });

    if (renderPointcloud && state.renderPointcloud && scatterGL != null) {
      const pointsData = predictions.map(prediction => {
        let scaledMesh = prediction.scaledMesh;
        return scaledMesh.map(point => ([point[0], -point[1] + VIDEO_HEIGHT, -point[2]]));
      });
      //const pointsData = predictions[0].scaledMesh;

      flattenedPointsData = [];
      for (let i = 0; i < pointsData.length; i++) {
        flattenedPointsData = flattenedPointsData.concat(pointsData[i]);
      }
      //const dataset = new ScatterGL.Dataset(flattenedPointsData);

      //scatterGLHasInitialized = true;
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
  VIDEO_WIDTH = videoWidth * 2;
  VIDEO_HEIGHT = videoHeight * 2;
  video.width = videoWidth;
  video.height = videoHeight;
  prog = new Program(VIDEO_WIDTH, VIDEO_HEIGHT);
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

  // if (renderPointcloud) {
  //   document.querySelector('#scatter-gl-container').style =
  //     `width: ${VIDEO_WIDTH}px; height: ${VIDEO_HEIGHT}px;`;

  //   scatterGL = new ScatterGL(
  //     document.querySelector('#scatter-gl-container'),
  //     { 'rotateOnStart': false, 'selectEnabled': false });
  // }
};

main();
