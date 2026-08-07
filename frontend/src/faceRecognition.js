import * as faceapi from "face-api.js";

// Below this distance the two faces are considered the same person.
// face-api.js's own docs use 0.6 as the standard cutoff for its 128-d
// descriptors — lower distance means more similar.
export const MATCH_THRESHOLD = 0.6;

const MODEL_URL = "/models";
let loadPromise = null;

// Models are only fetched the first time they're actually needed (feature is
// off by default), and only once per page load after that.
export function loadFaceModels() {
  if (!loadPromise) {
    loadPromise = Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ]);
  }
  return loadPromise;
}

function dataUrlToImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load image for face detection"));
    img.src = dataUrl;
  });
}

async function getFaceDescriptor(dataUrl) {
  const img = await dataUrlToImage(dataUrl);
  const detection = await faceapi
    .detectSingleFace(img, new faceapi.TinyFaceDetectorOptions())
    .withFaceLandmarks()
    .withFaceDescriptor();
  return detection || null;
}

// Compares a reference photo (employee's profile photo) against a freshly
// captured photo. Returns { match, distance, reason } — reason is set when
// no comparison could be made at all (e.g. no face found in one of the two).
export async function compareFaces(referencePhoto, capturedPhoto) {
  await loadFaceModels();
  const [refDetection, capturedDetection] = await Promise.all([
    getFaceDescriptor(referencePhoto),
    getFaceDescriptor(capturedPhoto),
  ]);

  if (!refDetection) {
    return { match: false, distance: null, reason: "No face detected in the employee's profile photo." };
  }
  if (!capturedDetection) {
    return { match: false, distance: null, reason: "No face detected in the attached photo — retake it with your face clearly visible." };
  }

  const distance = faceapi.euclideanDistance(refDetection.descriptor, capturedDetection.descriptor);
  return { match: distance < MATCH_THRESHOLD, distance, reason: null };
}
