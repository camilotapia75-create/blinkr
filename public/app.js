// ============================================================
// Blinker — client app
// ============================================================

const socket = io();

// Screens
const screens = {
  landing: document.getElementById('screen-landing'),
  setup:   document.getElementById('screen-setup'),
  waiting: document.getElementById('screen-waiting'),
  game:    document.getElementById('screen-game'),
};

function showScreen(name) {
  Object.entries(screens).forEach(([k, el]) => {
    el.classList.toggle('active', k === name);
  });
}

// Elements
const btnStart     = document.getElementById('btn-start');
const btnCancel    = document.getElementById('btn-cancel');
const btnPlayAgain = document.getElementById('btn-play-again');
const btnHome      = document.getElementById('btn-home');
const setupStatus  = document.getElementById('setup-status');
const videoSelf    = document.getElementById('video-self');
const videoOpponent= document.getElementById('video-opponent');
const canvasDetect = document.getElementById('canvas-detect');
const eyeDot       = document.getElementById('eye-dot');
const eyeLabel     = document.getElementById('eye-label');
const selfFlash    = document.getElementById('self-blink-flash');
const oppFlash     = document.getElementById('opponent-blink-flash');
const hudCountdown = document.getElementById('hud-countdown');
const hudLive      = document.getElementById('hud-live');
const hudResult    = document.getElementById('hud-result');
const countdownNum = document.getElementById('countdown-num');
const resultEmoji  = document.getElementById('result-emoji');
const resultText   = document.getElementById('result-text');
const resultWaiting= document.getElementById('result-waiting');
const myBlinkFill  = document.getElementById('my-blink-fill');
const theirBlinkFill = document.getElementById('their-blink-fill');

// State
let localStream   = null;
let detector      = null;
let peerConn      = null;
let currentRoom   = null;
let myRole        = null; // 'offerer' | 'answerer'
let gameActive    = false;
let detectLoop    = null;
let myBlinkCount  = 0;
let theirBlinkCount = 0;
const MAX_BLINKS  = 5; // visual meter max

// Eye landmark indices for MediaPipe face mesh
// Upper and lower eyelid points for each eye
const LEFT_EYE  = { upper: [386, 374, 373, 390], lower: [263, 362, 382, 381], mid: [374, 386] };
const RIGHT_EYE = { upper: [159, 145, 144, 163], lower: [33,  133, 153, 154],  mid: [145, 159] };

// EAR = eye aspect ratio; a blink = EAR drops below threshold
const EAR_THRESHOLD = 0.21;
const BLINK_CONSEC  = 2; // frames eye must be closed
let closedFrames = 0;
let eyesWereClosed = false;

// ============================================================
// Landing → setup → waiting
// ============================================================

btnStart.addEventListener('click', async () => {
  showScreen('setup');
  try {
    await initCamera();
    await initDetector();
    setupStatus.textContent = 'Finding an opponent…';
    showScreen('waiting');
    socket.emit('find-match');
  } catch (err) {
    setupStatus.textContent = 'Camera error: ' + err.message;
    console.error(err);
  }
});

btnCancel.addEventListener('click', () => {
  socket.emit('cancel');
  showScreen('landing');
});

btnHome.addEventListener('click', () => {
  resetGame();
  showScreen('landing');
});

btnPlayAgain.addEventListener('click', () => {
  btnPlayAgain.disabled = true;
  resultWaiting.classList.remove('hidden');
  socket.emit('play-again', { roomId: currentRoom });
});

// ============================================================
// Camera + detector setup
// ============================================================

async function initCamera() {
  setupStatus.textContent = 'Requesting camera access…';
  localStream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480, facingMode: 'user' },
    audio: false,
  });
  videoSelf.srcObject = localStream;
  return new Promise((res) => { videoSelf.onloadedmetadata = res; });
}

async function initDetector() {
  setupStatus.textContent = 'Loading face AI…';
  await tf.setBackend('webgl');
  await tf.ready();
  detector = await faceLandmarksDetection.createDetector(
    faceLandmarksDetection.SupportedModels.MediaPipeFaceMesh,
    {
      runtime: 'tfjs',
      refineLandmarks: false,
      maxFaces: 1,
    }
  );
  setupStatus.textContent = 'Ready!';
}

// ============================================================
// WebRTC
// ============================================================

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

function createPeerConnection() {
  const pc = new RTCPeerConnection(RTC_CONFIG);

  // Add local tracks
  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  // Receive remote stream
  pc.ontrack = (e) => {
    if (videoOpponent.srcObject !== e.streams[0]) {
      videoOpponent.srcObject = e.streams[0];
    }
  };

  // ICE candidates → signal
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('signal', { roomId: currentRoom, data: { type: 'ice', candidate: e.candidate } });
    }
  };

  return pc;
}

socket.on('matched', async ({ roomId, role }) => {
  currentRoom = roomId;
  myRole = role;
  showScreen('game');
  resetHUD();

  peerConn = createPeerConnection();

  if (role === 'offerer') {
    const offer = await peerConn.createOffer();
    await peerConn.setLocalDescription(offer);
    socket.emit('signal', { roomId, data: { type: 'offer', sdp: offer } });
  }
});

socket.on('signal', async ({ data }) => {
  if (!peerConn) return;
  if (data.type === 'offer') {
    await peerConn.setRemoteDescription(new RTCSessionDescription(data.sdp));
    const answer = await peerConn.createAnswer();
    await peerConn.setLocalDescription(answer);
    socket.emit('signal', { roomId: currentRoom, data: { type: 'answer', sdp: answer } });
  } else if (data.type === 'answer') {
    await peerConn.setRemoteDescription(new RTCSessionDescription(data.sdp));
    // Both connected — signal ready
    socket.emit('game-start', { roomId: currentRoom });
  } else if (data.type === 'ice') {
    try { await peerConn.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch {}
  }
});

socket.on('waiting', () => {
  // Already on waiting screen; just confirm
});

// ============================================================
// Countdown → game start
// ============================================================

socket.on('countdown-start', () => {
  startCountdown();
});

function startCountdown() {
  hudCountdown.classList.remove('hidden');
  hudLive.classList.add('hidden');
  hudResult.classList.add('hidden');
  gameActive = false;

  let n = 3;
  countdownNum.textContent = n;

  const tick = setInterval(() => {
    n--;
    if (n <= 0) {
      clearInterval(tick);
      countdownNum.textContent = 'GO!';
      setTimeout(() => {
        hudCountdown.classList.add('hidden');
        hudLive.classList.remove('hidden');
        startGame();
      }, 600);
    } else {
      countdownNum.textContent = n;
    }
  }, 1000);
}

function startGame() {
  gameActive = true;
  closedFrames = 0;
  eyesWereClosed = false;
  myBlinkCount = 0;
  theirBlinkCount = 0;
  updateBlinkMeters();
  startDetectionLoop();
}

// ============================================================
// Blink detection loop
// ============================================================

function startDetectionLoop() {
  if (detectLoop) cancelAnimationFrame(detectLoop);

  const ctx = canvasDetect.getContext('2d');
  canvasDetect.width  = videoSelf.videoWidth  || 640;
  canvasDetect.height = videoSelf.videoHeight || 480;

  async function loop() {
    if (!gameActive) return;

    if (videoSelf.readyState === 4) {
      const faces = await detector.estimateFaces(videoSelf, { flipHorizontal: false });
      if (faces.length > 0) {
        const kp = faces[0].keypoints;
        const ear = calcEAR(kp);
        const isClosed = ear < EAR_THRESHOLD;

        updateEyeStatus(isClosed);

        if (isClosed) {
          closedFrames++;
          if (closedFrames >= BLINK_CONSEC && !eyesWereClosed) {
            eyesWereClosed = true;
            onBlinkDetected();
          }
        } else {
          closedFrames = 0;
          eyesWereClosed = false;
        }
      }
    }

    detectLoop = requestAnimationFrame(loop);
  }

  loop();
}

function calcEAR(keypoints) {
  // Average EAR for both eyes
  const earL = eyeAR(keypoints, LEFT_EYE);
  const earR = eyeAR(keypoints, RIGHT_EYE);
  return (earL + earR) / 2;
}

function eyeAR(kp, eye) {
  // EAR = (||p2-p6|| + ||p3-p5||) / (2 * ||p1-p4||)
  // We use top/bottom mid-points vs corner width
  const top    = kp[eye.upper[0]];
  const bottom = kp[eye.lower[0]];
  const left   = kp[eye.upper[1]];
  const right  = kp[eye.lower[1]];

  if (!top || !bottom || !left || !right) return 1;

  const vertical = dist(top, bottom);
  const horizontal = dist(left, right);
  return horizontal > 0 ? vertical / horizontal : 1;
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function updateEyeStatus(closed) {
  eyeDot.classList.toggle('closed', closed);
  eyeLabel.textContent = closed ? 'Eyes closing' : 'Eyes open';
}

function onBlinkDetected() {
  if (!gameActive) return;
  gameActive = false;

  // Flash self panel
  flashPanel(selfFlash);
  myBlinkCount++;
  updateBlinkMeters();

  socket.emit('blink-detected', { roomId: currentRoom });
}

// ============================================================
// Game over
// ============================================================

socket.on('game-over', ({ loserId, winnerId }) => {
  gameActive = false;
  if (detectLoop) cancelAnimationFrame(detectLoop);

  const iWon = loserId !== socket.id;

  if (!iWon) {
    // I blinked — show loss
    flashPanel(selfFlash);
  } else {
    // They blinked — flash their panel
    flashPanel(oppFlash);
    theirBlinkCount++;
    updateBlinkMeters();
  }

  setTimeout(() => showResult(iWon), 600);
});

function showResult(won) {
  hudLive.classList.add('hidden');
  hudCountdown.classList.add('hidden');
  hudResult.classList.remove('hidden');

  resultEmoji.textContent = won ? '🏆' : '😵';
  resultText.innerHTML = won
    ? '<span style="color:var(--green)">You won!</span><br><small>They blinked first.</small>'
    : '<span style="color:var(--red)">You blinked!</span><br><small>Better luck next time.</small>';

  btnPlayAgain.disabled = false;
  resultWaiting.classList.add('hidden');
}

socket.on('opponent-ready-again', () => {
  resultWaiting.textContent = 'Opponent is ready — waiting for you…';
  resultWaiting.classList.remove('hidden');
});

socket.on('opponent-disconnected', () => {
  gameActive = false;
  if (detectLoop) cancelAnimationFrame(detectLoop);
  hudLive.classList.add('hidden');
  hudCountdown.classList.add('hidden');
  hudResult.classList.remove('hidden');
  resultEmoji.textContent = '👋';
  resultText.innerHTML = '<span style="color:var(--muted)">Opponent left.</span>';
  btnPlayAgain.disabled = true;
  resultWaiting.classList.add('hidden');
});

// ============================================================
// Helpers
// ============================================================

function flashPanel(el) {
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 400);
}

function updateBlinkMeters() {
  const myPct    = Math.min(myBlinkCount    / MAX_BLINKS * 100, 100);
  const theirPct = Math.min(theirBlinkCount / MAX_BLINKS * 100, 100);
  myBlinkFill.style.width    = myPct + '%';
  theirBlinkFill.style.width = theirPct + '%';
}

function resetHUD() {
  hudCountdown.classList.add('hidden');
  hudLive.classList.add('hidden');
  hudResult.classList.add('hidden');
  myBlinkCount = 0;
  theirBlinkCount = 0;
  updateBlinkMeters();
}

function resetGame() {
  gameActive = false;
  if (detectLoop) { cancelAnimationFrame(detectLoop); detectLoop = null; }
  if (peerConn)   { peerConn.close(); peerConn = null; }
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  videoSelf.srcObject = null;
  videoOpponent.srcObject = null;
  currentRoom = null;
  myRole = null;
}

// ============================================================
// Landing eye animation
// ============================================================
const eyeOuter = document.querySelector('.eye-outer');
setInterval(() => {
  eyeOuter.classList.add('blink-anim');
  setTimeout(() => eyeOuter.classList.remove('blink-anim'), 300);
}, 4000 + Math.random() * 2000);
