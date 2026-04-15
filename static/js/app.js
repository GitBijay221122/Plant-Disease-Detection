/* =====================================================
   CONFIG — change this to your deployed backend URL
   ===================================================== */
const API_BASE = window.location.origin;   // same origin; update if backend is separate

/* =====================================================
   STATE
   ===================================================== */
let currentPage          = 'landing';
let currentUser          = null;
let selectedFile         = null;
let selectedImageDataURL = null;
let historyData          = [];

/* =====================================================
   SEVERITY HELPERS
   ===================================================== */
const SEVERITY_LABELS = ['None', 'Low', 'Moderate', 'Severe'];

function severityFromConfidence(confidence, isHealthy) {
  if (isHealthy)       return 0;
  if (confidence >= 90) return 3;
  if (confidence >= 70) return 2;
  return 1;
}

/* =====================================================
   LABEL HELPERS
   Mirrors the Python parse_label logic so the frontend
   can build a clean display name from the API response.
   ===================================================== */

/**
 * Build a human-readable display name from prediction fields.
 * - Healthy plant   → "Tomato (Healthy)"
 * - Diseased plant  → "Tomato — Late Blight"
 * - Fallback        → plant name only (never shows "Unknown")
 */
function buildDisplayName(plant, disease, isHealthy) {
  const cleanPlant   = (plant   || '').trim();
  const cleanDisease = (disease || '').trim();

  if (isHealthy) return `${cleanPlant} (Healthy)`;

  // Only append disease if it is meaningful
  const skip = ['', 'unknown', 'healthy'];
  if (cleanDisease && !skip.includes(cleanDisease.toLowerCase())) {
    return `${cleanPlant} — ${cleanDisease}`;
  }
  return cleanPlant;
}

/* =====================================================
   HISTORY (localStorage)
   ===================================================== */
function initHistory() {
  historyData = JSON.parse(localStorage.getItem('leafscan_history') || '[]');
}
function saveHistory() {
  try { localStorage.setItem('leafscan_history', JSON.stringify(historyData)); } catch (e) {}
}

/* =====================================================
   AUTH UTILS
   ===================================================== */
function generateJWT(payload) {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body   = btoa(JSON.stringify({ ...payload, exp: Date.now() + 86400000 }));
  const sig    = btoa('mock_sig_' + Date.now());
  return `${header}.${body}.${sig}`;
}
function parseJWT(token) {
  try { return JSON.parse(atob(token.split('.')[1])); } catch (e) { return null; }
}
function isTokenValid() {
  const token = localStorage.getItem('leafscan_token');
  if (!token) return false;
  const payload = parseJWT(token);
  if (!payload || payload.exp < Date.now()) {
    localStorage.removeItem('leafscan_token');
    localStorage.removeItem('leafscan_user');
    return false;
  }
  return true;
}

/* =====================================================
   NAVIGATION
   ===================================================== */
function navigate(page) {
  const protected_ = ['dashboard', 'history', 'profile'];
  if (protected_.includes(page) && !isTokenValid()) {
    showToast('Please log in to continue.', 'info');
    page = 'login';
  }
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');
  document.getElementById('navbar').style.display = protected_.includes(page) ? 'flex' : 'none';
  document.getElementById('mobileMenu').classList.remove('open');
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  const activeLink = document.getElementById('nav-' + page);
  if (activeLink) activeLink.classList.add('active');
  currentPage = page;
  if (page === 'history')   renderHistory();
  if (page === 'profile')   loadProfile();
  if (page === 'dashboard') {
    const user = JSON.parse(localStorage.getItem('leafscan_user') || '{}');
    document.getElementById('profileAvatar').textContent = (user.name || 'A').charAt(0).toUpperCase();
  }
  window.scrollTo(0, 0);
}

/* =====================================================
   LOGIN / SIGNUP
   ===================================================== */
function handleLogin() {
  const email = document.getElementById('loginEmail').value.trim();
  const pw    = document.getElementById('loginPw').value;
  let valid   = true;

  ['loginEmail', 'loginPw'].forEach(id => document.getElementById(id).classList.remove('error'));
  ['loginEmailErr', 'loginPwErr'].forEach(id => document.getElementById(id).classList.remove('show'));
  document.getElementById('loginError').classList.remove('show');

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    document.getElementById('loginEmail').classList.add('error');
    document.getElementById('loginEmailErr').classList.add('show');
    valid = false;
  }
  if (!pw) {
    document.getElementById('loginPw').classList.add('error');
    document.getElementById('loginPwErr').classList.add('show');
    valid = false;
  }
  if (!valid) return;

  showLoader();
  setTimeout(() => {
    hideLoader();
    const stored = JSON.parse(localStorage.getItem('leafscan_user') || '{}');
    if (stored.email && stored.email !== email) {
      const err = document.getElementById('loginError');
      err.textContent = 'Invalid email or password.';
      err.classList.add('show');
      return;
    }
    const user  = stored.email ? stored : { name: 'Demo User', email, createdAt: new Date().toISOString() };
    const token = generateJWT({ sub: email, name: user.name });
    localStorage.setItem('leafscan_token', token);
    localStorage.setItem('leafscan_user', JSON.stringify(user));
    initHistory();
    showToast('Welcome back, ' + user.name + '!', 'success');
    navigate('dashboard');
  }, 800);
}

function handleSignup() {
  const name  = document.getElementById('signupName').value.trim();
  const email = document.getElementById('signupEmail').value.trim();
  const pw    = document.getElementById('signupPw').value;
  const pw2   = document.getElementById('signupPw2').value;
  let valid   = true;

  ['signupNameErr', 'signupEmailErr', 'signupPwErr', 'signupPw2Err'].forEach(id => document.getElementById(id).classList.remove('show'));
  ['signupName', 'signupEmail', 'signupPw', 'signupPw2'].forEach(id => document.getElementById(id).classList.remove('error'));
  document.getElementById('signupError').classList.remove('show');

  if (!name)  { document.getElementById('signupName').classList.add('error');  document.getElementById('signupNameErr').classList.add('show');  valid = false; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { document.getElementById('signupEmail').classList.add('error'); document.getElementById('signupEmailErr').classList.add('show'); valid = false; }
  if (pw.length < 6) { document.getElementById('signupPw').classList.add('error');  document.getElementById('signupPwErr').classList.add('show');  valid = false; }
  if (pw !== pw2)    { document.getElementById('signupPw2').classList.add('error'); document.getElementById('signupPw2Err').classList.add('show'); valid = false; }
  if (!valid) return;

  showLoader();
  setTimeout(() => {
    hideLoader();
    const user  = { name, email, createdAt: new Date().toISOString() };
    const token = generateJWT({ sub: email, name });
    localStorage.setItem('leafscan_token', token);
    localStorage.setItem('leafscan_user', JSON.stringify(user));
    initHistory();
    showToast('Account created! Welcome, ' + name + '!', 'success');
    navigate('dashboard');
  }, 800);
}

function logout() {
  localStorage.removeItem('leafscan_token');
  showToast('Logged out successfully.', 'info');
  navigate('landing');
}

/* =====================================================
   IMAGE UPLOAD
   ===================================================== */
function triggerFileInput(e) {
  if (e) e.stopPropagation();
  document.getElementById('fileInput').click();
}
function onFileSelect(e) {
  const file = e.target.files[0];
  if (file) processFile(file);
  e.target.value = '';
}
function onDragOver(e)  { e.preventDefault(); document.getElementById('uploadArea').classList.add('drag-over'); }
function onDragLeave()  { document.getElementById('uploadArea').classList.remove('drag-over'); }
function onDrop(e) {
  e.preventDefault();
  document.getElementById('uploadArea').classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) processFile(file);
}
function processFile(file) {
  if (!['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(file.type)) {
    showToast('Only JPG, PNG and WEBP files are supported.', 'error'); return;
  }
  if (file.size > 10 * 1024 * 1024) {
    showToast('File size must be under 10MB.', 'error'); return;
  }
  selectedFile = file;
  const reader = new FileReader();
  reader.onload = (ev) => {
    selectedImageDataURL = ev.target.result;
    document.getElementById('previewImg').src = ev.target.result;
    document.getElementById('imageName').textContent = file.name + ' (' + (file.size / 1024).toFixed(1) + ' KB)';
    document.getElementById('uploadPrompt').style.display  = 'none';
    document.getElementById('uploadPreview').style.display = 'block';
    document.getElementById('uploadArea').classList.add('has-image');
    document.getElementById('analyzeBtn').disabled = false;
  };
  reader.readAsDataURL(file);
}
function removeImage(e) {
  e.stopPropagation();
  selectedFile = null; selectedImageDataURL = null;
  document.getElementById('uploadPrompt').style.display  = 'block';
  document.getElementById('uploadPreview').style.display = 'none';
  document.getElementById('uploadArea').classList.remove('has-image');
  document.getElementById('analyzeBtn').disabled = true;
}

/* =====================================================
   ANALYZE — calls real /analyze backend endpoint
   ===================================================== */
async function analyzeImage() {
  if (!selectedFile) return;

  showLoader();
  document.getElementById('analyzeBtn').disabled = true;

  // Remove previous results
  document.querySelectorAll('#resultSection .result-card, #resultSection .treatment-card').forEach(e => e.remove());
  const placeholder = document.getElementById('resultPlaceholder');
  if (placeholder) placeholder.style.display = 'none';

  const formData = new FormData();
  formData.append('image', selectedFile);

  try {
    const response = await fetch(`${API_BASE}/analyze?top_k=3`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || `Server error ${response.status}`);
    }

    const data = await response.json();

    hideLoader();
    document.getElementById('analyzeBtn').disabled = false;

    const pred        = data.prediction;
    const confidence  = +(pred.confidence * 100).toFixed(1);
    const isHealthy   = pred.is_healthy;

    // ── FIXED: use buildDisplayName — never shows "Unknown" ──
    const diseaseName = buildDisplayName(pred.plant, pred.disease, isHealthy);

    const severity    = severityFromConfidence(confidence, isHealthy);
    const status      = isHealthy ? 'Healthy' : 'Diseased';
    const timestamp   = Date.now();

    const record = {
      id: 'h_' + Date.now(),
      diseaseName,
      plant:   pred.plant,
      disease: pred.disease,
      confidence,
      timestamp,
      status,
      severity,
      imageDataURL: selectedImageDataURL,
    };

    historyData.unshift(record);
    saveHistory();

    renderResultCard(record);
    renderRecommendationCard(data.recommendations);
    showToast('Analysis complete!', 'success');

  } catch (err) {
    hideLoader();
    document.getElementById('analyzeBtn').disabled = false;
    if (placeholder) placeholder.style.display = '';
    showToast('Error: ' + err.message, 'error');
    console.error(err);
  }
}

/* =====================================================
   RENDER RESULT CARD
   ===================================================== */
function renderResultCard(record) {
  const { diseaseName, confidence, timestamp, status, severity } = record;

  const sevDots = [1, 2, 3, 4, 5].map(i => {
    let cls = '';
    if (severity === 1)      cls = i <= 2 ? 'active-low'  : '';
    else if (severity === 2) cls = i <= 3 ? 'active-mid'  : '';
    else if (severity >= 3)  cls = 'active-high';
    return `<div class="severity-dot ${cls}"></div>`;
  }).join('');

  const badgeClass = status === 'Healthy'
    ? 'badge-healthy'
    : severity >= 3 ? 'badge-severe' : 'badge-diseased';

  const card = document.createElement('div');
  card.className = 'result-card';
  card.innerHTML = `
    <div class="result-card-header">
      <h2>Analysis Result</h2>
      <span class="badge ${badgeClass}">${status}</span>
    </div>
    <div class="result-card-body">
      <div class="disease-name">${diseaseName}</div>
      <div class="result-meta">${formatDate(timestamp)}</div>
      <div class="confidence-row">
        <span class="confidence-label">Confidence</span>
        <span class="confidence-val">${confidence}%</span>
      </div>
      <div class="confidence-bar-bg">
        <div class="confidence-bar" id="confBar" style="width:0%"></div>
      </div>
      <div class="severity-indicator" style="margin-top:16px">
        <div class="severity-label">Severity: ${SEVERITY_LABELS[severity] || 'None'}</div>
        <div class="severity-dots">${sevDots}</div>
      </div>
    </div>`;

  document.getElementById('resultSection').prepend(card);
  setTimeout(() => {
    const bar = document.getElementById('confBar');
    if (bar) bar.style.width = confidence + '%';
  }, 80);
}

/* =====================================================
   RENDER RECOMMENDATION CARD (from Groq API data)
   ===================================================== */
function renderRecommendationCard(rec) {
  const card = document.createElement('div');
  card.className = 'treatment-card';

  let bodyHTML = '';

  if (!rec || rec.error) {
    bodyHTML = `<div class="rec-error">⚠️ ${rec?.error || 'Could not load recommendations.'}</div>`;
  } else {
    if (rec.treatment) {
      bodyHTML += `
        <div class="treatment-section">
          <h4>Treatment</h4>
          <p class="treatment-desc">${rec.treatment}</p>
        </div>`;
    }
    if (Array.isArray(rec.pesticides) && rec.pesticides.length) {
      bodyHTML += `
        <div class="treatment-section">
          <h4>Pesticides</h4>
          <ul class="treatment-list">${rec.pesticides.map(p => `<li>${p}</li>`).join('')}</ul>
        </div>`;
    }
    if (Array.isArray(rec.fertilizers) && rec.fertilizers.length) {
      bodyHTML += `
        <div class="treatment-section">
          <h4>Fertilizers</h4>
          <ul class="treatment-list">${rec.fertilizers.map(f => `<li>${f}</li>`).join('')}</ul>
        </div>`;
    }
    if (Array.isArray(rec.care_tips) && rec.care_tips.length) {
      bodyHTML += `
        <div class="treatment-section">
          <h4>Care Tips</h4>
          <ul class="treatment-list">${rec.care_tips.map(t => `<li>${t}</li>`).join('')}</ul>
        </div>`;
    }
  }

  card.innerHTML = `
    <div class="treatment-card-header" onclick="toggleTreatment(this)">
      <h3>💊 AI Recommendations</h3>
      <span class="chevron open">⌄</span>
    </div>
    <div class="treatment-body open">${bodyHTML}</div>`;

  document.getElementById('resultSection').appendChild(card);
}

function toggleTreatment(header) {
  const body    = header.nextElementSibling;
  const chevron = header.querySelector('.chevron');
  body.classList.toggle('open');
  chevron.classList.toggle('open');
}

/* =====================================================
   HISTORY
   ===================================================== */
function renderHistory() {
  const q      = (document.getElementById('historySearch')?.value || '').toLowerCase().trim();
  const sort   = document.getElementById('historySort')?.value || 'latest';
  let filtered = historyData.filter(h => !q || h.diseaseName.toLowerCase().includes(q));
  if (sort === 'latest')     filtered.sort((a, b) => b.timestamp - a.timestamp);
  if (sort === 'confidence') filtered.sort((a, b) => b.confidence - a.confidence);

  const grid = document.getElementById('historyGrid');
  grid.innerHTML = '';

  if (!filtered.length) {
    grid.innerHTML = `<div class="empty-state">
      <div class="empty-icon">🌿</div>
      <h3>No records found</h3>
      <p>Your plant disease detection history will appear here.</p>
    </div>`;
    return;
  }

  filtered.forEach(item => {
    const card       = document.createElement('div');
    card.className   = 'history-card';
    const badgeClass = item.status === 'Healthy'
      ? 'badge-healthy'
      : item.severity >= 3 ? 'badge-severe' : 'badge-diseased';
    const thumbHtml  = item.imageDataURL
      ? `<img class="history-thumb" src="${item.imageDataURL}" alt="Plant" />`
      : `<div class="history-thumb-placeholder">🌱</div>`;

    // Rebuild clean display name for any old records that still say "Unknown"
    const displayName = buildDisplayName(item.plant, item.disease, item.status === 'Healthy');

    card.innerHTML = `
      ${thumbHtml}
      <div class="history-card-body">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
          <div class="history-disease">${displayName}</div>
          <span class="badge ${badgeClass}">${item.status}</span>
        </div>
        <div class="history-conf">Confidence: <strong>${item.confidence}%</strong></div>
        <div class="confidence-bar-bg" style="margin-bottom:12px">
          <div class="confidence-bar" style="width:${item.confidence}%"></div>
        </div>
        <div class="history-date">📅 ${formatDate(item.timestamp)}</div>
        <div class="history-actions">
          <button class="btn btn-secondary btn-sm" onclick="downloadPDF('${item.id}')">⬇ Download PDF</button>
          <button class="btn btn-danger btn-sm"    onclick="deleteRecord('${item.id}')">🗑 Delete</button>
        </div>
      </div>`;
    grid.appendChild(card);
  });
}

function deleteRecord(id) {
  historyData = historyData.filter(h => h.id !== id);
  saveHistory();
  renderHistory();
  showToast('Record deleted.', 'info');
}

/* =====================================================
   PDF GENERATION
   ===================================================== */
function downloadPDF(id) {
  const record = historyData.find(h => h.id === id);
  if (!record) { showToast('Record not found.', 'error'); return; }

  showLoader();
  setTimeout(() => {
    try {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ unit: 'mm', format: 'a4' });
      const W = 210, margin = 18;
      let y = 0;

      // Header banner
      doc.setFillColor(22, 101, 52);
      doc.rect(0, 0, W, 30, 'F');
      doc.setFontSize(20); doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold');
      doc.text('LeafScan – Plant Disease Report', margin, 19);
      y = 42;

      // Meta info
      doc.setTextColor(80, 80, 80); doc.setFontSize(10); doc.setFont('helvetica', 'normal');
      doc.text('Generated: '     + formatDate(Date.now()),        margin, y); y += 6;
      doc.text('Analysis Date: ' + formatDate(record.timestamp),  margin, y); y += 10;

      doc.setDrawColor(200, 200, 200); doc.line(margin, y, W - margin, y); y += 8;

      // Clean display name — guaranteed no "Unknown"
      const displayName = buildDisplayName(record.plant, record.disease, record.status === 'Healthy');

      doc.setFontSize(18); doc.setFont('helvetica', 'bold'); doc.setTextColor(22, 101, 52);
      doc.text(displayName, margin, y); y += 8;

      doc.setFontSize(11); doc.setFont('helvetica', 'normal'); doc.setTextColor(50, 50, 50);
      doc.text(
        'Status: ' + record.status +
        '  |  Confidence: ' + record.confidence + '%' +
        '  |  Severity: ' + (SEVERITY_LABELS[record.severity] || 'None'),
        margin, y
      ); y += 8;

      // Confidence bar
      doc.setFillColor(230, 230, 230); doc.rect(margin, y, 120, 5, 'F');
      doc.setFillColor(22, 101, 52);   doc.rect(margin, y, 120 * record.confidence / 100, 5, 'F');
      y += 14;

      // Plant image
      if (record.imageDataURL) {
        try {
          doc.setFont('helvetica', 'bold'); doc.setTextColor(30, 30, 30);
          doc.text('Plant Image', margin, y); y += 4;
          doc.addImage(record.imageDataURL, 'JPEG', margin, y, 80, 60);
          y += 68;
        } catch (imgErr) { /* skip if image fails */ }
      }

      // Footer
      doc.setDrawColor(200, 200, 200); doc.line(margin, 280, W - margin, 280);
      doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(140, 140, 140);
      doc.text('LeafScan Plant Disease Detection System  |  v1.0.0  |  For informational purposes only.', margin, 285);

      doc.save(`leafscan-report-${new Date().toISOString().slice(0, 10)}.pdf`);
      showToast('PDF downloaded!', 'success');
    } catch (e) {
      console.error(e);
      showToast('Failed to generate PDF.', 'error');
    }
    hideLoader();
  }, 400);
}

/* =====================================================
   PROFILE
   ===================================================== */
function loadProfile() {
  const user = JSON.parse(localStorage.getItem('leafscan_user') || '{}');
  document.getElementById('profileName').value          = user.name  || '';
  document.getElementById('profileEmail').value         = user.email || '';
  document.getElementById('sidebarName').textContent    = user.name  || '–';
  document.getElementById('sidebarEmail').textContent   = user.email || '–';
  document.getElementById('sidebarInitial').textContent = (user.name || 'A').charAt(0).toUpperCase();
  document.getElementById('sidebarSince').textContent   = 'Member since ' + (user.createdAt
    ? new Date(user.createdAt).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    : '–');
}
function saveProfile() {
  const name = document.getElementById('profileName').value.trim();
  if (!name) { showToast('Name cannot be empty.', 'error'); return; }
  const user  = JSON.parse(localStorage.getItem('leafscan_user') || '{}');
  user.name   = name;
  localStorage.setItem('leafscan_user', JSON.stringify(user));
  localStorage.setItem('leafscan_token', generateJWT({ sub: user.email, name }));
  loadProfile();
  document.getElementById('profileAvatar').textContent = name.charAt(0).toUpperCase();
  showToast('Profile updated!', 'success');
}
function changePassword() {
  const cur     = document.getElementById('curPw').value;
  const newPw   = document.getElementById('newPw').value;
  const confirm = document.getElementById('confirmNewPw').value;
  if (!cur)              { showToast('Enter your current password.', 'error'); return; }
  if (newPw.length < 6) { showToast('New password must be at least 6 characters.', 'error'); return; }
  if (newPw !== confirm) { showToast('Passwords do not match.', 'error'); return; }
  ['curPw', 'newPw', 'confirmNewPw'].forEach(id => document.getElementById(id).value = '');
  showToast('Password updated successfully!', 'success');
}

/* =====================================================
   NAVBAR
   ===================================================== */
function toggleDropdown()   { document.getElementById('dropdownMenu').classList.toggle('open'); }
function toggleMobileMenu() { document.getElementById('mobileMenu').classList.toggle('open');  }
document.addEventListener('click', (e) => {
  if (!e.target.closest('.profile-dropdown')) document.getElementById('dropdownMenu').classList.remove('open');
});

/* =====================================================
   UTILITIES
   ===================================================== */
function formatDate(ts) {
  return new Date(ts).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}
function togglePw(inputId, btn) {
  const inp = document.getElementById(inputId);
  inp.type  = inp.type === 'password' ? 'text' : 'password';
  btn.textContent = inp.type === 'password' ? '👁' : '🙈';
}
function showLoader() { document.getElementById('loader').classList.add('show');    }
function hideLoader() { document.getElementById('loader').classList.remove('show'); }
function showToast(msg, type = 'info') {
  const icons     = { success: '✅', error: '❌', info: 'ℹ️' };
  const container = document.getElementById('toastContainer');
  const toast     = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-icon">${icons[type]}</span><span class="toast-msg">${msg}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('out');
    setTimeout(() => toast.remove(), 350);
  }, 3200);
}

/* =====================================================
   INIT
   ===================================================== */
(function init() {
  if (isTokenValid()) {
    initHistory();
    navigate('dashboard');
  } else {
    navigate('landing');
  }
})();