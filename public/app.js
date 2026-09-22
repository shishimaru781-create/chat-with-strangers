/* ============================================================
   Chat With Strangers — Client App v3 (Full)
   Features: landing, auth, guest, filters, chat, images, voice,
   video, typing, friends, block/report, notifications, theme,
   online count, ice breakers, gender/country filter.
   ============================================================ */

const socket = io();

let token = localStorage.getItem('cws_token');
let user = JSON.parse(localStorage.getItem('cws_user') || 'null');
let guestId = localStorage.getItem('cws_guestId');
let myHistory = [];
let countries = [];
let currentCountry = 'US';
let currentGender = 'any';
let currentAvatar = '';
let partnerActive = false;
let partnerInfo = null;
let typingSendTimeout = null;
let typingRecvTimeout = null;
let mediaRecorder = null;
let audioChunks = [];
let recStartTime = 0;
let recTimerInterval = null;
let pendingImageFile = null;
let iceBreakers = [];
let filterWantGender = 'any';
let filterWantCountry = 'any';
let filterInterests = '';

// Video / WebRTC state
let localStream = null;
let pc = null;            // RTCPeerConnection
let videoActive = false;
let videoOfferPending = false;
let camEnabled = true;
let micEnabled = true;
let iceServers = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// ============ DOM ============
const landingScreen = document.getElementById('landingScreen');
const authScreen = document.getElementById('authScreen');
const chatScreen = document.getElementById('chatScreen');
const messagesEl = document.getElementById('messages');
const statusBar = document.getElementById('statusBar');
const msgInput = document.getElementById('msgInput');
const sendBtn = document.getElementById('sendBtn');
const nextBtn = document.getElementById('nextBtn');
const myAvatarEl = document.getElementById('myAvatar');
const profileModal = document.getElementById('profileModal');
const friendsModal = document.getElementById('friendsModal');
const filtersModal = document.getElementById('filtersModal');
const typingIndicator = document.getElementById('typingIndicator');
const themeBtn = document.getElementById('themeBtn');
const partnerActions = document.getElementById('partnerActions');
const imageBtn = document.getElementById('imageBtn');
const micBtn = document.getElementById('micBtn');
const imageInput = document.getElementById('imageInput');
const recordingBar = document.getElementById('recordingBar');
const recTime = document.getElementById('recTime');
const imgPreviewModal = document.getElementById('imgPreviewModal');
const imgPreview = document.getElementById('imgPreview');
const onlineCountLanding = document.getElementById('onlineCountLanding');
const onlineCountAuth = document.getElementById('onlineCountAuth');
const onlineCountChat = document.getElementById('onlineCountChat');
const statOnline = document.getElementById('statOnline');
const iceBreakerBar = document.getElementById('iceBreakerBar');
const iceBreakerText = document.getElementById('iceBreakerText');
const videoOverlay = document.getElementById('videoOverlay');
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');

// ============ THEME ============
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  themeBtn.textContent = theme === 'dark' ? '🌙' : '☀️';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#0a0f1e' : '#f0f5ff');
  localStorage.setItem('cws_theme', theme);
}
themeBtn.onclick = () => {
  const cur = document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(cur === 'dark' ? 'light' : 'dark');
};
applyTheme(localStorage.getItem('cws_theme') || 'dark');

// ============ HELPERS ============
function flagUrl(code) {
  if (!code || code === 'UN') return 'https://flagcdn.com/w80/un.png';
  return 'https://flagcdn.com/w80/' + code.toLowerCase() + '.png';
}
function avatarSrc(u) {
  if (u && u.avatar) return u.avatar;
  return flagUrl(u ? u.country : 'UN');
}
async function detectCountry() {
  try {
    const r = await fetch('https://ipapi.co/json/');
    const d = await r.json();
    if (d.country_code) return d.country_code;
  } catch (e) {}
  return 'US';
}
function setStatus(text, cls) {
  statusBar.textContent = text;
  statusBar.className = 'status ' + (cls || '');
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function formatTime(iso) {
  try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}

// ============ MESSAGES ============
function addMessage(payload, sender) {
  const d = document.createElement('div');
  d.className = 'msg ' + sender;
  if (payload.image) {
    const img = document.createElement('img');
    img.src = payload.image;
    img.onclick = () => openImage(payload.image);
    d.appendChild(img);
  }
  if (payload.audio) {
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.src = payload.audio;
    d.appendChild(audio);
  }
  if (payload.text) {
    const span = document.createElement('span');
    span.textContent = payload.text;
    d.appendChild(span);
  }
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = formatTime(payload.time || new Date().toISOString());
  d.appendChild(time);
  messagesEl.appendChild(d);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
function addSystemMessage(text) {
  addMessage({ text, time: new Date().toISOString() }, 'system');
}
function addPartnerCard(partner) {
  const card = document.createElement('div');
  card.className = 'partner-card';
  const img = partner.avatar || flagUrl(partner.country);
  card.innerHTML =
    '<img src="' + img + '" alt="" />' +
    '<div class="info">' +
      '<strong>' + escapeHtml(partner.name) + '</strong>' +
      '<span>' + (partner.country || 'Unknown') + '</span>' +
    '</div>';
  messagesEl.appendChild(card);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
function openImage(url) { imgPreview.src = url; imgPreviewModal.classList.remove('hidden'); }
document.getElementById('imgCancel').onclick = () => imgPreviewModal.classList.add('hidden');

// ============ SOUND ============
function playPing() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.22);
  } catch (e) {}
}

// ============ BROWSER NOTIFS ============
function notifyBrowser(title, body) {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible') return;
  try { new Notification(title, { body, icon: '/favicon.ico' }); } catch (e) {}
}
if ('Notification' in window && Notification.permission === 'default') {
  setTimeout(() => Notification.requestPermission(), 2500);
}

// ============ LANDING ============
const taglines = [
  "A stranger is just a friend you haven't met yet.",
  "Talk to someone new. Feel something real.",
  "The world is one chat away.",
  "No names. No filters. Just real talk.",
  "Meet the world, one conversation at a time."
];
let taglineIdx = 0;
const taglineEl = document.getElementById('rotatingTagline');
setInterval(() => {
  taglineIdx = (taglineIdx + 1) % taglines.length;
  taglineEl.style.opacity = 0;
  setTimeout(() => {
    taglineEl.textContent = taglines[taglineIdx];
    taglineEl.style.opacity = 1;
  }, 400);
}, 4000);

const bubbleFlags = ['us', 'in', 'br', 'jp', 'de', 'fr', 'gb', 'ca', 'au', 'es', 'it', 'mx', 'kr', 'ng', 'eg', 'za', 'ar', 'ru'];
function spawnFlags() {
  const container = document.getElementById('floatingFlags');
  for (let i = 0; i < 12; i++) {
    const b = document.createElement('div');
    b.className = 'flag-bubble';
    const code = bubbleFlags[i % bubbleFlags.length];
    b.style.backgroundImage = `url(https://flagcdn.com/w160/${code}.png)`;
    b.style.left = Math.random() * 95 + '%';
    b.style.animationDuration = (18 + Math.random() * 18) + 's';
    b.style.animationDelay = (Math.random() * 12) + 's';
    b.style.width = b.style.height = (40 + Math.random() * 40) + 'px';
    container.appendChild(b);
  }
}
spawnFlags();

document.getElementById('startChatBtn').onclick = () => {
  landingScreen.classList.add('hidden');
  authScreen.classList.remove('hidden');
};
document.getElementById('learnMoreBtn').onclick = () => {
  document.querySelector('.features-strip').scrollIntoView({ behavior: 'smooth' });
};
document.getElementById('backToLanding').onclick = () => {
  authScreen.classList.add('hidden');
  landingScreen.classList.remove('hidden');
};
document.getElementById('footerTerms').onclick = (e) => {
  e.preventDefault();
  alert('Terms:\n\n• Be respectful\n• No harassment or hate speech\n• No illegal content\n• You must be 18+\n• Chats are private and not stored long-term.');
};

// ============ COUNTRIES + ICE ============
async function loadCountries() {
  try {
    const res = await fetch('/api/countries');
    countries = await res.json();
  } catch {
    countries = [{ code: 'US', name: 'United States' }, { code: 'UN', name: 'Unknown' }];
  }
  const opts = countries.map(c => `<option value="${c.code}">${c.name}</option>`).join('');
  document.getElementById('regCountry').innerHTML = opts;
  document.getElementById('profileCountry').innerHTML = opts;
  document.getElementById('filterCountry').innerHTML = '<option value="any">Any country</option>' + opts;
  const detected = await detectCountry();
  currentCountry = detected;
  document.getElementById('regCountry').value = detected;
  document.getElementById('profileCountry').value = detected;
}
async function loadIceBreakers() {
  try {
    const res = await fetch('/api/icebreakers');
    iceBreakers = await res.json();
  } catch { iceBreakers = ["What's your favorite movie?", "Where would you travel if you could?", "Coffee or tea?"]; }
}
function showRandomIceBreaker() {
  if (!iceBreakers.length) return;
  iceBreakerText.textContent = iceBreakers[Math.floor(Math.random() * iceBreakers.length)];
  iceBreakerBar.classList.remove('hidden');
}
document.getElementById('newIceBreaker').onclick = () => showRandomIceBreaker();

// ============ TABS ============
document.querySelectorAll('.tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.form').forEach(f => f.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.tab + 'Form').classList.add('active');
  };
});

// ============ LOGIN ============
document.getElementById('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  const u = document.getElementById('loginUser').value.trim();
  const p = document.getElementById('loginPass').value;
  try {
    const res = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p })
    });
    const data = await res.json();
    if (data.error) return alert(data.error);
    localStorage.setItem('cws_token', data.token);
    localStorage.setItem('cws_user', JSON.stringify(data.user));
    token = data.token;
    user = data.user;
    openFilters();
  } catch (err) { alert('Login failed: ' + err.message); }
};

// ============ REGISTER ============
document.getElementById('registerForm').onsubmit = async (e) => {
  e.preventDefault();
  const username = document.getElementById('regUser').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  const password = document.getElementById('regPass').value;
  const country = document.getElementById('regCountry').value;
  const gender = document.getElementById('regGender').value;
  const interests = document.getElementById('regInterests').value;
  try {
    const res = await fetch('/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, email, country, gender, interests, guestId })
    });
    const data = await res.json();
    if (data.error) return alert(data.error);
    localStorage.setItem('cws_token', data.token);
    localStorage.setItem('cws_user', JSON.stringify(data.user));
    token = data.token;
    user = data.user;
    if (guestId) localStorage.removeItem('cws_guestId');
    if (data.migratedHistory && data.migratedHistory.length) myHistory = data.migratedHistory;
    if (email && data.user.verified === 0) {
      setTimeout(() => alert('📧 Verification email sent! Check the VS Code terminal.'), 300);
    }
    openFilters();
  } catch (err) { alert('Registration failed: ' + err.message); }
};

// ============ GUEST ============
document.getElementById('guestBtn').onclick = async () => {
  if (!guestId) {
    guestId = 'guest_' + Math.random().toString(36).slice(2, 10) + Date.now();
    localStorage.setItem('cws_guestId', guestId);
  }
  const detected = await detectCountry();
  currentCountry = detected;
  try {
    const res = await fetch('/api/guest/' + guestId + '/backup');
    const data = await res.json();
    myHistory = data.history || [];
  } catch { myHistory = []; }
  user = {
    id: guestId,
    username: 'Guest_' + guestId.slice(-4),
    country: detected,
    gender: 'any',
    interests: '',
    avatar: ''
  };
  openFilters();
};

// ============ LOGOUT ============
document.getElementById('logoutBtn').onclick = () => {
  if (!confirm('Log out?')) return;
  localStorage.removeItem('cws_token');
  localStorage.removeItem('cws_user');
  location.reload();
};

// ============ FILTERS MODAL ============
function openFilters() {
  landingScreen.classList.add('hidden');
  authScreen.classList.add('hidden');
  filtersModal.classList.remove('hidden');
  document.getElementById('filterGender').value = filterWantGender;
  document.getElementById('filterCountry').value = filterWantCountry;
  document.getElementById('filterInterests').value = user?.interests || '';
}
document.getElementById('filtersCancel').onclick = () => {
  filtersModal.classList.add('hidden');
  authScreen.classList.remove('hidden');
};
document.getElementById('filtersStart').onclick = () => {
  filterWantGender = document.getElementById('filterGender').value;
  filterWantCountry = document.getElementById('filterCountry').value;
  filterInterests = document.getElementById('filterInterests').value;
  if (user) user.interests = filterInterests;
  filtersModal.classList.add('hidden');
  enterChat();
};

// ============ ENTER CHAT ============
function enterChat(isGuest) {
  chatScreen.classList.remove('hidden');

  currentCountry = (user && user.country) || currentCountry || 'US';
  currentGender = (user && user.gender) || 'any';
  currentAvatar = (user && user.avatar) || '';

  document.getElementById('userName').textContent = user.username;
  document.getElementById('userCountry').textContent = currentCountry;
  myAvatarEl.src = avatarSrc(user);

  setStatus('🔍 Looking for a stranger…');
  enableInput(false);

  if (isGuest && myHistory.length) {
    addSystemMessage('— Restored from your previous session —');
    myHistory.forEach(m => addMessage(m, m.sender || 'them'));
  }

  socket.emit('find-partner', {
    displayName: user.username,
    userId: user.id || '',
    country: currentCountry,
    gender: currentGender,
    avatar: currentAvatar,
    interests: (filterInterests || user.interests || '').split(',').map(s => s.trim()).filter(Boolean),
    wantGender: filterWantGender,
    wantCountry: filterWantCountry
  });
}

function enableInput(on) {
  msgInput.disabled = !on;
  sendBtn.disabled = !on;
  imageBtn.disabled = !on;
  micBtn.disabled = !on;
  if (on) msgInput.focus();
}

// ============ SOCKET EVENTS ============
socket.on('online-count', ({ count }) => {
  if (onlineCountLanding) onlineCountLanding.textContent = count;
  if (onlineCountAuth) onlineCountAuth.textContent = count;
  if (onlineCountChat) onlineCountChat.textContent = count;
  if (statOnline) statOnline.textContent = count;
});

socket.on('waiting', () => {
  setStatus('🔍 Looking for a stranger…');
  enableInput(false);
  partnerActive = false;
  partnerInfo = null;
  typingIndicator.classList.add('hidden');
  partnerActions.classList.add('hidden');
  iceBreakerBar.classList.add('hidden');
});

socket.on('chat-start', ({ partner }) => {
  partnerInfo = partner;
  setStatus('💬 Connected with ' + partner.name);
  addPartnerCard(partner);
  addSystemMessage('You are now chatting privately with a stranger.');
  enableInput(true);
  partnerActive = true;
  partnerActions.classList.remove('hidden');
  playPing();
  showRandomIceBreaker();
});

socket.on('message', (msg) => {
  addMessage(msg, msg.sender);
  myHistory.push({
    text: msg.text || '',
    image: msg.image || '',
    audio: msg.audio || '',
    sender: msg.sender
  });
  if (myHistory.length > 200) myHistory = myHistory.slice(-200);
  if (msg.sender === 'them') {
    playPing();
    notifyBrowser('New message', msg.text || '📷 Media message');
  }
  typingIndicator.classList.add('hidden');
  if (user && user.username.startsWith('Guest_')) {
    socket.emit('save-guest-backup', { guestId, history: myHistory });
  }
});

socket.on('partner-typing', ({ isTyping }) => {
  if (!partnerActive) return;
  clearTimeout(typingRecvTimeout);
  if (isTyping) {
    typingIndicator.classList.remove('hidden');
    typingRecvTimeout = setTimeout(() => typingIndicator.classList.add('hidden'), 3000);
  } else {
    typingIndicator.classList.add('hidden');
  }
});

socket.on('partner-left', () => {
  setStatus('⚠️ Stranger left. Press Next to find another.', 'disconnected');
  enableInput(false);
  partnerActive = false;
  typingIndicator.classList.add('hidden');
  partnerActions.classList.add('hidden');
  iceBreakerBar.classList.add('hidden');
  stopVideo(true);
});

// ---------- VIDEO SIGNALING ----------
socket.on('video-offer', async ({ offer }) => {
  if (!videoActive) {
    // Ask user if they want to accept
    const accept = confirm('Your chat partner wants to start a video call. Accept?');
    if (!accept) return;
  }
  await startVideo(false);
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('video-answer', { answer });
  } catch (e) { console.error('Video offer error', e); }
});

socket.on('video-answer', async ({ answer }) => {
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
  } catch (e) { console.error('Video answer error', e); }
});

socket.on('video-ice', async ({ candidate }) => {
  try {
    if (pc && candidate) await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (e) { console.error('ICE error', e); }
});

socket.on('video-toggle', ({ enabled }) => {
  // Partner toggled their video
  remoteVideo.style.opacity = enabled ? '1' : '0.15';
});

// ============ SEND ============
function sendMessage() {
  const text = msgInput.value.trim();
  if (!text || !partnerActive) return;
  socket.emit('message', { text });
  myHistory.push({ text, sender: 'me' });
  if (myHistory.length > 200) myHistory = myHistory.slice(-200);
  socket.emit('typing', { isTyping: false });
  if (user && user.username.startsWith('Guest_')) {
    socket.emit('save-guest-backup', { guestId, history: myHistory });
  }
  msgInput.value = '';
  iceBreakerBar.classList.add('hidden');
}
sendBtn.onclick = sendMessage;
msgInput.onkeydown = (e) => { if (e.key === 'Enter') sendMessage(); };
msgInput.oninput = () => {
  if (!partnerActive) return;
  socket.emit('typing', { isTyping: true });
  clearTimeout(typingSendTimeout);
  typingSendTimeout = setTimeout(() => {
    socket.emit('typing', { isTyping: false });
  }, 1500);
};

// ============ NEXT ============
nextBtn.onclick = () => {
  stopVideo(true);
  socket.emit('next');
  messagesEl.innerHTML = '';
  myHistory = [];
  partnerActive = false;
  partnerInfo = null;
  enableInput(false);
  typingIndicator.classList.add('hidden');
  partnerActions.classList.add('hidden');
  iceBreakerBar.classList.add('hidden');
  setStatus('🔍 Looking for a stranger…');
  socket.emit('find-partner', {
    displayName: user.username,
    userId: user.id || '',
    country: currentCountry,
    gender: currentGender,
    avatar: currentAvatar,
    interests: (filterInterests || user.interests || '').split(',').map(s => s.trim()).filter(Boolean),
    wantGender: filterWantGender,
    wantCountry: filterWantCountry
  });
};

// ============ AVATAR UPLOAD ============
document.getElementById('avatarInput').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!token) {
    const reader = new FileReader();
    reader.onload = (ev) => {
      currentAvatar = ev.target.result;
      myAvatarEl.src = currentAvatar;
      if (user) user.avatar = currentAvatar;
      localStorage.setItem('cws_user', JSON.stringify(user));
      alert('Avatar updated (local only for guests).');
    };
    reader.readAsDataURL(file);
    return;
  }
  const fd = new FormData();
  fd.append('avatar', file);
  try {
    const res = await fetch('/api/upload-avatar', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.url) {
      currentAvatar = data.url;
      myAvatarEl.src = currentAvatar;
      if (user) user.avatar = currentAvatar;
      localStorage.setItem('cws_user', JSON.stringify(user));
      await fetch('/api/profile', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, avatar: currentAvatar })
      });
    }
  } catch (err) { alert('Upload failed: ' + err.message); }
};

// ============ IMAGE MESSAGE ============
imageBtn.onclick = () => imageInput.click();
imageInput.onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  pendingImageFile = file;
  const reader = new FileReader();
  reader.onload = (ev) => {
    imgPreview.src = ev.target.result;
    imgPreviewModal.classList.remove('hidden');
  };
  reader.readAsDataURL(file);
  imageInput.value = '';
};
document.getElementById('imgSend').onclick = async () => {
  if (!pendingImageFile || !partnerActive) {
    imgPreviewModal.classList.add('hidden');
    pendingImageFile = null;
    return;
  }
  try {
    const fd = new FormData();
    fd.append('file', pendingImageFile);
    const res = await fetch('/api/upload-media', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.url) {
      socket.emit('message', { image: data.url });
      myHistory.push({ image: data.url, sender: 'me' });
      if (user && user.username.startsWith('Guest_')) {
        socket.emit('save-guest-backup', { guestId, history: myHistory });
      }
    }
  } catch (err) { alert('Upload failed: ' + err.message); }
  imgPreviewModal.classList.add('hidden');
  pendingImageFile = null;
};

// ============ VOICE ============
micBtn.onclick = async () => {
  if (!partnerActive) return;
  if (mediaRecorder && mediaRecorder.state === 'recording') { stopRecording(true); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      if (audioChunks.length === 0) return;
      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      try {
        const fd = new FormData();
        fd.append('file', blob, 'voice.webm');
        const res = await fetch('/api/upload-media', { method: 'POST', body: fd });
        const data = await res.json();
        if (data.url) {
          socket.emit('message', { audio: data.url });
          myHistory.push({ audio: data.url, sender: 'me' });
          if (user && user.username.startsWith('Guest_')) {
            socket.emit('save-guest-backup', { guestId, history: myHistory });
          }
        }
      } catch (err) { alert('Upload failed: ' + err.message); }
    };
    mediaRecorder.start();
    recStartTime = Date.now();
    recordingBar.classList.remove('hidden');
    recTimerInterval = setInterval(() => {
      const s = Math.floor((Date.now() - recStartTime) / 1000);
      recTime.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }, 500);
  } catch (err) { alert('Microphone access denied: ' + err.message); }
};
function stopRecording(send) {
  if (recTimerInterval) clearInterval(recTimerInterval);
  recTimerInterval = null;
  recordingBar.classList.add('hidden');
  recTime.textContent = '0:00';
  if (!mediaRecorder) return;
  if (!send) audioChunks = [];
  try { mediaRecorder.stop(); } catch (e) {}
  mediaRecorder = null;
}
document.getElementById('stopRecBtn').onclick = () => stopRecording(true);
document.getElementById('cancelRecBtn').onclick = () => stopRecording(false);

// ============ VIDEO CHAT (WebRTC) ============
document.getElementById('videoBtn').onclick = async () => {
  if (!partnerActive) return;
  await startVideo(true);
};

async function startVideo(isInitiator) {
  if (videoActive) return;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
    videoOverlay.classList.remove('hidden');
    videoActive = true;
    camEnabled = true; micEnabled = true;

    pc = new RTCPeerConnection(iceServers);
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    pc.ontrack = (event) => {
      if (remoteVideo.srcObject !== event.streams[0]) {
        remoteVideo.srcObject = event.streams[0];
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) socket.emit('video-ice', { candidate: event.candidate });
    };

    if (isInitiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('video-offer', { offer });
    }
  } catch (err) {
    alert('Camera/mic access denied: ' + err.message);
  }
}

function stopVideo(silent) {
  if (!videoActive) return;
  videoActive = false;
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (pc) {
    try { pc.close(); } catch (e) {}
    pc = null;
  }
  localVideo.srcObject = null;
  remoteVideo.srcObject = null;
  videoOverlay.classList.add('hidden');
  if (!silent) socket.emit('video-toggle', { enabled: false });
}
document.getElementById('videoEndBtn').onclick = () => stopVideo(false);

document.getElementById('videoMuteBtn').onclick = (e) => {
  if (!localStream) return;
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
  e.target.textContent = micEnabled ? 'Mute' : 'Unmute';
};

document.getElementById('videoCamBtn').onclick = (e) => {
  if (!localStream) return;
  camEnabled = !camEnabled;
  localStream.getVideoTracks().forEach(t => t.enabled = camEnabled);
  e.target.textContent = camEnabled ? 'Camera Off' : 'Camera On';
  socket.emit('video-toggle', { enabled: camEnabled });
};

// ============ PARTNER ACTIONS ============
document.getElementById('addFriendBtn').onclick = async () => {
  if (!partnerInfo || !partnerInfo.name) return;
  if (!token) return alert('Login to add friends.');
  if (partnerInfo.name.startsWith('Guest_')) return alert('Guests cannot be added as friends.');
  try {
    const res = await fetch('/api/friends/add', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, friendUsername: partnerInfo.name })
    });
    const data = await res.json();
    if (data.error) return alert(data.error);
    alert('✅ ' + partnerInfo.name + ' added to friends!');
  } catch { alert('Failed'); }
};
document.getElementById('reportBtn').onclick = async () => {
  if (!partnerInfo || !partnerInfo.name) return;
  if (!token) return alert('Login to report.');
  const reason = prompt('Reason for report?', '');
  if (reason === null) return;
  try {
    const res = await fetch('/api/report', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, reportedUsername: partnerInfo.name, reason })
    });
    const data = await res.json();
    alert(data.autoBanned ? '✅ Report submitted. User auto-banned.' : '✅ Report submitted.');
    socket.emit('next');
    messagesEl.innerHTML = '';
    setStatus('🔍 Looking for a stranger…');
  } catch { alert('Failed'); }
};
document.getElementById('blockBtn').onclick = async () => {
  if (!partnerInfo || !partnerInfo.name) return;
  if (!token) return alert('Login to block.');
  if (partnerInfo.name.startsWith('Guest_')) return alert('Guests cannot be blocked.');
  if (!confirm('Block ' + partnerInfo.name + '?')) return;
  try {
    await fetch('/api/block', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, blockedUsername: partnerInfo.name })
    });
    alert('🚫 Blocked.');
    socket.emit('next');
    messagesEl.innerHTML = '';
    setStatus('🔍 Looking for a stranger…');
  } catch { alert('Failed'); }
};

// ============ FRIENDS MODAL ============
document.getElementById('friendsBtn').onclick = async () => {
  friendsModal.classList.remove('hidden');
  const list = document.getElementById('friendsList');
  list.innerHTML = '<p class="note">Loading…</p>';
  if (!token) { list.innerHTML = '<p class="note">Login to see friends.</p>'; return; }
  try {
    const res = await fetch('/api/friends', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    const data = await res.json();
    const friends = data.friends || [];
    if (!friends.length) {
      list.innerHTML = '<p class="note">No friends yet. Chat with someone and click ➕ Add Friend.</p>';
      return;
    }
    list.innerHTML = '';
    friends.forEach(f => {
      const el = document.createElement('div');
      el.className = 'friend-item';
      el.innerHTML =
        '<img src="' + (f.avatar || flagUrl(f.country)) + '" alt="" />' +
        '<div class="info"><strong>' + escapeHtml(f.username) + '</strong>' +
        '<span>' + (f.country || '') + '</span></div>' +
        '<button data-id="' + f.id + '">Remove</button>';
      el.querySelector('button').onclick = async () => {
        if (!confirm('Remove ' + f.username + '?')) return;
        await fetch('/api/friends/remove', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, friendId: f.id })
        });
        el.remove();
      };
      list.appendChild(el);
    });
  } catch { list.innerHTML = '<p class="note">Failed to load.</p>'; }
};
document.getElementById('friendsClose').onclick = () => friendsModal.classList.add('hidden');

// ============ PROFILE MODAL ============
document.getElementById('profileBtn').onclick = () => {
  document.getElementById('profileCountry').value = currentCountry || 'US';
  document.getElementById('profileGender').value = currentGender || 'any';
  document.getElementById('profileInterests').value = (user && user.interests) || '';
  profileModal.classList.remove('hidden');
};
document.getElementById('profileCancel').onclick = () => profileModal.classList.add('hidden');
document.getElementById('profileSave').onclick = async () => {
  const country = document.getElementById('profileCountry').value;
  const gender = document.getElementById('profileGender').value;
  const interests = document.getElementById('profileInterests').value;
  currentCountry = country;
  currentGender = gender;
  if (user) {
    user.country = country;
    user.gender = gender;
    user.interests = interests;
    localStorage.setItem('cws_user', JSON.stringify(user));
  }
  document.getElementById('userCountry').textContent = country;
  if (!currentAvatar) myAvatarEl.src = flagUrl(country);
  if (token) {
    try {
      await fetch('/api/profile', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, country, gender, interests })
      });
    } catch (e) {}
  }
  profileModal.classList.add('hidden');
};

// ============ INIT ============
(async () => {
  await loadCountries();
  await loadIceBreakers();
  if (token && user) openFilters();
})();
/* ============================================================
   GROWTH PACK — Share buttons, toast, visitor tracking
   ============================================================ */

// ============ TOAST ============
function showToast(message, duration = 2000) {
  let toast = document.getElementById('cwsToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'cwsToast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), duration);
}

// ============ SHARE BUTTONS ============
function getSiteUrl() {
  return window.location.origin;
}
function getShareText() {
  return "I'm on Chat With Strangers — anonymous global chat. No signup needed. Come talk to someone new! 🌍";
}

// WhatsApp
const whatsappBtn = document.getElementById('shareWhatsapp');
if (whatsappBtn) {
  whatsappBtn.onclick = () => {
    const url = `https://wa.me/?text=${encodeURIComponent(getShareText() + '\n' + getSiteUrl())}`;
    window.open(url, '_blank');
  };
}

// Twitter
const twitterBtn = document.getElementById('shareTwitter');
if (twitterBtn) {
  twitterBtn.onclick = () => {
    const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(getShareText())}&url=${encodeURIComponent(getSiteUrl())}`;
    window.open(url, '_blank');
  };
}

// Copy link
const copyBtn = document.getElementById('shareCopy');
if (copyBtn) {
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(getSiteUrl());
      showToast('✅ Link copied!');
    } catch {
      // Fallback for old browsers
      const ta = document.createElement('textarea');
      ta.value = getSiteUrl();
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      showToast('✅ Link copied!');
    }
  };
}

// ============ WHATSAPP INVITE BANNER (after 3 messages) ============
let messageCount = 0;
let inviteShown = false;
const _origAddMessage = addMessage;
addMessage = function(payload, sender) {
  _origAddMessage(payload, sender);
  messageCount++;
  if (messageCount === 3 && !inviteShown && sender === 'them') {
    inviteShown = true;
    setTimeout(() => {
      const bar = document.createElement('div');
      bar.className = 'icebreaker';
      bar.style.background = 'rgba(37, 211, 102, 0.12)';
      bar.style.borderTopColor = 'rgba(37, 211, 102, 0.3)';
      bar.style.borderBottomColor = 'rgba(37, 211, 102, 0.3)';
      bar.innerHTML = `
        <span style="flex:1;">💚 Enjoying? Invite a friend!</span>
        <button class="small-action" id="inviteFriendBtn" style="border-color:rgba(37,211,102,0.5);color:#25d366;">Share</button>
      `;
      const footer = document.querySelector('#chatScreen footer');
      footer.parentNode.insertBefore(bar, footer);
      document.getElementById('inviteFriendBtn').onclick = () => {
        const url = `https://wa.me/?text=${encodeURIComponent(getShareText() + '\n' + getSiteUrl())}`;
        window.open(url, '_blank');
      };
      setTimeout(() => bar.remove(), 20000);
    }, 500);
  }
};

// ============ VISITOR TRACKING ============
(function trackVisitor() {
  try {
    const stored = localStorage.getItem('cws_visitor');
    if (!stored) {
      const id = 'v_' + Math.random().toString(36).slice(2, 10) + Date.now();
      localStorage.setItem('cws_visitor', id);
      console.log('👋 New visitor:', id);
    } else {
      console.log('👋 Returning visitor');
    }
  } catch (e) {}
})();

// ============ TERMS & PRIVACY ============
const termsLink = document.getElementById('footerTerms');
if (termsLink) {
  termsLink.onclick = (e) => {
    e.preventDefault();
    alert(
      'Terms of Service\n\n' +
      '1. You must be 18 years or older.\n' +
      '2. Be respectful. No harassment, hate speech, or illegal content.\n' +
      '3. Do not share personal information you would not want public.\n' +
      '4. Chats are private and not stored long-term.\n' +
      '5. We may ban users who violate these terms.\n' +
      '6. Use at your own risk. Meet strangers safely.'
    );
  };
}

const privacyLink = document.getElementById('footerPrivacy');
if (privacyLink) {
  privacyLink.onclick = (e) => {
    e.preventDefault();
    alert(
      'Privacy Policy\n\n' +
      'We collect: username, country, and optional email.\n\n' +
      'We do NOT: sell your data, track your location precisely, or read your chats.\n\n' +
      'Messages are stored on our server temporarily for session continuity, ' +
      'then deleted. Uploaded images/audio are cleared when the server restarts.\n\n' +
      'Contact: privacy@chatwithstrangers.app'
    );
  };
}

console.log('🚀 Growth pack loaded');