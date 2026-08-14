const video = document.getElementById("video");
const overlayCanvas = document.getElementById("overlayCanvas");
const canvas = document.getElementById("canvas");
const motionCanvas = document.getElementById("motionCanvas");

const startCameraButton = document.getElementById("startCamera");
const stopCameraButton = document.getElementById("stopCamera");
const takeSnapshotButton = document.getElementById("takeSnapshot");
const startRecordingButton = document.getElementById("startRecording");
const stopRecordingButton = document.getElementById("stopRecording");
const scanObjectButton = document.getElementById("scanObject");

const statusElement = document.getElementById("status");
const loadingElement = document.getElementById("loading");
const recordingBadge = document.getElementById("recordingBadge");
const motionIndicator = document.getElementById("motionIndicator");
const eventLog = document.getElementById("eventLog");
const gallery = document.getElementById("gallery");

let stream = null;
let recorder = null;
let recordedChunks = [];
let model = null;
let scanning = false;
let scanTimer = null;
let motionTimer = null;
let previousFrame = null;
let filesCaptured = 0;
let lastObjects = [];

const vehicleTypes = new Set(["car", "truck", "bus", "motorcycle", "bicycle"]);
const cameraLabels = new Map();

function formatDateTime(date = new Date()) {
  return date.toLocaleString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function updateClock() {
  document.getElementById("currentDateTime").textContent = formatDateTime();
}

function addEvent(message) {
  const item = document.createElement("li");
  item.innerHTML = `<time>${new Date().toLocaleTimeString()}</time>${message}`;
  eventLog.prepend(item);

  while (eventLog.children.length > 30) {
    eventLog.lastElementChild.remove();
  }
}

function setCameraButtons(active) {
  startCameraButton.disabled = active;
  stopCameraButton.disabled = !active;
  takeSnapshotButton.disabled = !active;
  startRecordingButton.disabled = !active;
  scanObjectButton.disabled = !active;
  document.getElementById("zoom").disabled = !active;
}

function setStatus(active, message) {
  statusElement.textContent = message;
  statusElement.className = `status ${active ? "online" : "offline"}`;
}

async function loadAIModel() {
  if (model) return model;

  document.getElementById("aiStatus").textContent = "Loading AI model...";
  addEvent("Loading COCO-SSD traffic detection model.");

  model = await cocoSsd.load();
  document.getElementById("aiStatus").textContent = "AI ready";
  document.getElementById("aiStatus").className = "ai-status ready";
  addEvent("AI traffic detection model is ready.");
  return model;
}

async function listCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) return;

  const devices = await navigator.mediaDevices.enumerateDevices();
  const select = document.getElementById("cameraSelect");
  const currentValue = select.value;

  select.innerHTML = '<option value="">Default camera</option>';

  devices
    .filter(device => device.kind === "videoinput")
    .forEach((device, index) => {
      const label = device.label || `Camera ${index + 1}`;
      cameraLabels.set(device.deviceId, label);

      const option = document.createElement("option");
      option.value = device.deviceId;
      option.textContent = label;
      select.appendChild(option);
    });

  if ([...select.options].some(option => option.value === currentValue)) {
    select.value = currentValue;
  }
}

async function startCamera() {
  try {
    stopCamera(false);

    const selectedCamera = document.getElementById("cameraSelect").value;
    const videoConstraints = selectedCamera
      ? { deviceId: { exact: selectedCamera }, width: { ideal: 1280 }, height: { ideal: 720 } }
      : { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } };

    stream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints,
      audio: true
    });

    video.srcObject = stream;
    await video.play();

    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings();
    document.getElementById("resolution").textContent =
      `${settings.width || video.videoWidth} × ${settings.height || video.videoHeight}`;
    document.getElementById("cameraName").textContent =
      cameraLabels.get(settings.deviceId) || track.label || "Active camera";

    setStatus(true, "Camera online");
    loadingElement.style.display = "none";
    setCameraButtons(true);
    addEvent("CCTV camera started successfully.");

    await listCameras();
    prepareZoom(track);

    loadAIModel().catch(error => {
      document.getElementById("aiStatus").textContent = "AI unavailable";
      addEvent(`AI model error: ${error.message}`);
    });

    startAutomaticScanning();
    startMotionDetection();
  } catch (error) {
    setStatus(false, "Camera offline");
    loadingElement.style.display = "grid";
    addEvent(`Camera error: ${error.message}`);
    alert("Unable to access the camera. Check browser permissions and use HTTPS or localhost.");
  }
}

function stopCamera(log = true) {
  stopRecording(false);

  if (scanTimer) clearTimeout(scanTimer);
  if (motionTimer) clearInterval(motionTimer);

  scanTimer = null;
  motionTimer = null;
  scanning = false;
  previousFrame = null;

  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }

  video.srcObject = null;
  setStatus(false, "Camera offline");
  loadingElement.style.display = "grid";
  setCameraButtons(false);

  if (log) addEvent("CCTV camera stopped.");
}

function prepareZoom(track) {
  const zoomInput = document.getElementById("zoom");
  const capabilities = track.getCapabilities?.();

  if (capabilities?.zoom) {
    zoomInput.min = capabilities.zoom.min;
    zoomInput.max = capabilities.zoom.max;
    zoomInput.step = capabilities.zoom.step || 0.1;
    zoomInput.value = capabilities.zoom.min;
    document.getElementById("zoomValue").textContent = `${zoomInput.value}x`;
    zoomInput.oninput = async () => {
      document.getElementById("zoomValue").textContent = `${zoomInput.value}x`;
      await track.applyConstraints({ advanced: [{ zoom: Number(zoomInput.value) }] });
    };
  }
}

function startAutomaticScanning() {
  const autoScan = document.getElementById("autoScan");

  const schedule = () => {
    if (!stream || !autoScan.checked) {
      scanTimer = setTimeout(schedule, 1500);
      return;
    }

    scanObjects();
    scanTimer = setTimeout(schedule, 1800);
  };

  schedule();
}

async function scanObjects() {
  if (!stream || scanning || video.readyState < 2) return;

  scanning = true;

  try {
    const detector = await loadAIModel();
    const predictions = await detector.detect(video);
    lastObjects = predictions.filter(item => item.score >= 0.45);
    drawDetections(lastObjects);
    updateTrafficAnalytics(lastObjects);

    document.getElementById("lastScan").textContent = new Date().toLocaleTimeString();
  } catch (error) {
    addEvent(`Scanning error: ${error.message}`);
  } finally {
    scanning = false;
  }
}

function drawDetections(predictions) {
  const context = overlayCanvas.getContext("2d");
  overlayCanvas.width = video.videoWidth;
  overlayCanvas.height = video.videoHeight;
  context.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

  predictions.forEach(prediction => {
    const [x, y, width, height] = prediction.bbox;
    context.strokeStyle = vehicleTypes.has(prediction.class) ? "#27d17f" : "#31a8ff";
    context.lineWidth = 3;
    context.strokeRect(x, y, width, height);

    const label = `${prediction.class} ${Math.round(prediction.score * 100)}%`;
    context.font = "bold 14px Arial";
    const labelWidth = context.measureText(label).width + 10;
    context.fillStyle = context.strokeStyle;
    context.fillRect(x, Math.max(0, y - 22), labelWidth, 22);
    context.fillStyle = "#06111d";
    context.fillText(label, x + 5, Math.max(15, y - 7));
  });
}

function updateTrafficAnalytics(predictions) {
  const counts = {
    vehicle: 0,
    motorcycle: 0,
    bus: 0,
    person: 0
  };

  predictions.forEach(item => {
    if (vehicleTypes.has(item.class)) counts.vehicle++;
    if (item.class === "motorcycle") counts.motorcycle++;
    if (item.class === "bus") counts.bus++;
    if (item.class === "person") counts.person++;
  });

  document.getElementById("vehicleCount").textContent = counts.vehicle;
  document.getElementById("motorcycleCount").textContent = counts.motorcycle;
  document.getElementById("busCount").textContent = counts.bus;
  document.getElementById("personCount").textContent = counts.person;

  const level = counts.vehicle >= 8 ? "High" : counts.vehicle >= 4 ? "Medium" : "Low";
  const levelElement = document.getElementById("trafficLevel");
  levelElement.textContent = level;
  levelElement.className = level.toLowerCase();

  const results = document.getElementById("scanResults");
  results.innerHTML = "";

  if (!predictions.length) {
    results.innerHTML = '<li class="empty">No objects detected yet.</li>';
    return;
  }

  predictions.forEach(item => {
    const li = document.createElement("li");
    li.innerHTML = `<span>${item.class}</span><strong>${Math.round(item.score * 100)}%</strong>`;
    results.appendChild(li);
  });
}

function captureSnapshot() {
  if (!stream) return;

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);

  canvas.toBlob(blob => {
    const url = URL.createObjectURL(blob);
    addGalleryFile(url, "Snapshot", "image");
    addEvent("Snapshot captured and added to the gallery.");
  }, "image/jpeg", .92);
}

function startRecording() {
  if (!stream || !window.MediaRecorder) {
    alert("Video recording is not supported by this browser.");
    return;
  }

  recordedChunks = [];
  const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
    ? "video/webm;codecs=vp9"
    : "video/webm";

  recorder = new MediaRecorder(stream, { mimeType });
  recorder.ondataavailable = event => {
    if (event.data.size) recordedChunks.push(event.data);
  };

  recorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: mimeType });
    const url = URL.createObjectURL(blob);
    addGalleryFile(url, "Traffic recording", "video");
    addEvent("Video recording saved to the gallery.");
  };

  recorder.start();
  document.getElementById("recordingStatus").textContent = "Yes";
  recordingBadge.style.display = "block";
  startRecordingButton.disabled = true;
  stopRecordingButton.disabled = false;
  addEvent("Video recording started.");
}

function stopRecording(log = true) {
  if (recorder && recorder.state !== "inactive") recorder.stop();

  recorder = null;
  document.getElementById("recordingStatus").textContent = "No";
  recordingBadge.style.display = "none";
  startRecordingButton.disabled = !stream;
  stopRecordingButton.disabled = true;

  if (log) addEvent("Video recording stopped.");
}

function addGalleryFile(url, title, type) {
  filesCaptured++;
  document.getElementById("fileCount").textContent =
    `${filesCaptured} file${filesCaptured === 1 ? "" : "s"}`;

  const empty = gallery.querySelector(".empty");
  if (empty) empty.remove();

  const card = document.createElement("article");
  card.className = "file-card";

  const media = type === "image"
    ? document.createElement("img")
    : document.createElement("video");

  media.src = url;
  media.controls = true;
  media.muted = true;

  const caption = document.createElement("p");
  caption.textContent = `${title} • ${formatDateTime()}`;

  card.append(media, caption);
  gallery.prepend(card);
}

function startMotionDetection() {
  const checkbox = document.getElementById("motionDetection");

  motionTimer = setInterval(() => {
    if (!stream || !checkbox.checked || video.readyState < 2) return;

    motionCanvas.width = 160;
    motionCanvas.height = 90;
    const context = motionCanvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(video, 0, 0, 160, 90);

    const currentFrame = context.getImageData(0, 0, 160, 90).data;

    if (previousFrame) {
      let difference = 0;
      for (let i = 0; i < currentFrame.length; i += 16) {
        difference += Math.abs(currentFrame[i] - previousFrame[i]);
      }

      const motionDetected = difference > 8500;
      motionIndicator.style.display = motionDetected ? "block" : "none";
      document.getElementById("motionStatus").textContent =
        motionDetected ? "Detected" : "Inactive";
    }

    previousFrame = currentFrame;
  }, 500);
}

startCameraButton.addEventListener("click", startCamera);
stopCameraButton.addEventListener("click", () => stopCamera());
takeSnapshotButton.addEventListener("click", captureSnapshot);
startRecordingButton.addEventListener("click", startRecording);
stopRecordingButton.addEventListener("click", () => stopRecording());
scanObjectButton.addEventListener("click", scanObjects);

document.getElementById("cameraSelect").addEventListener("change", () => {
  if (stream) startCamera();
});

document.getElementById("clearEvents").addEventListener("click", () => {
  eventLog.innerHTML = "";
});

navigator.mediaDevices?.addEventListener?.("devicechange", listCameras);

updateClock();
setInterval(updateClock, 1000);
listCameras();
addEvent("System initialized. Press Start Camera to begin monitoring.");
