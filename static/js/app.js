/* =====================================================
   CONFIG
   ===================================================== */
const API_BASE = window.location.origin;

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
const SEVERITY_KEYS = ['sev_none', 'sev_low', 'sev_moderate', 'sev_severe'];

function getSeverityLabel(index) {
  return t(SEVERITY_KEYS[index] || 'sev_none');
}

function severityFromConfidence(confidence, isHealthy) {
  if (isHealthy)        return 0;
  if (confidence >= 90) return 3;
  if (confidence >= 70) return 2;
  return 1;
}

/* =====================================================
   LABEL HELPERS
   ===================================================== */
function buildDisplayName(plant, disease, isHealthy) {
  const cleanPlant   = (plant   || '').trim();
  const cleanDisease = (disease || '').trim();
  if (isHealthy) return `${cleanPlant} (${t('sev_none') !== 'None' ? t('sev_none') : 'Healthy'})`;
  const skip = ['', 'unknown', 'healthy'];
  if (cleanDisease && !skip.includes(cleanDisease.toLowerCase())) {
    return `${cleanPlant} — ${cleanDisease}`;
  }
  return cleanPlant;
}

/* Override to always say "Healthy" properly */
function buildDisplayNameI18n(plant, disease, isHealthy) {
  const cleanPlant   = (plant   || '').trim();
  const cleanDisease = (disease || '').trim();
  if (isHealthy) return `${cleanPlant} (Healthy)`;
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
function isTokenValid() {
  const token = localStorage.getItem('leafscan_token');
  if (!token) return false;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    const expMs = payload.exp > 1e12 ? payload.exp : payload.exp * 1000;
    if (expMs < Date.now()) {
      localStorage.removeItem('leafscan_token');
      localStorage.removeItem('leafscan_user');
      return false;
    }
    return true;
  } catch (e) {
    localStorage.removeItem('leafscan_token');
    localStorage.removeItem('leafscan_user');
    return false;
  }
}

function getAuthHeaders() {
  const token = localStorage.getItem('leafscan_token');
  return token ? { 'Authorization': 'Bearer ' + token } : {};
}

/* =====================================================
   NAVIGATION
   ===================================================== */
function navigate(page) {
  const protected_ = ['dashboard', 'history', 'profile'];
  if (protected_.includes(page) && !isTokenValid()) {
    showToast(t('login_subtitle'), 'info');
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
   LOGIN
   ===================================================== */
async function handleLogin() {
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
  try {
    const res  = await fetch(`${API_BASE}/auth/login`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, password: pw }),
    });
    const data = await res.json();
    if (!res.ok) {
      const err = document.getElementById('loginError');
      err.textContent = data.error || 'Login failed.';
      err.classList.add('show');
      return;
    }
    localStorage.setItem('leafscan_token', data.token);
    localStorage.setItem('leafscan_user',  JSON.stringify(data.user));
    currentUser = data.user;
    initHistory();
    showToast(t('login_welcome') + ', ' + data.user.name + '!', 'success');
    navigate('dashboard');
  } catch (err) {
    const errBanner = document.getElementById('loginError');
    errBanner.textContent = 'Network error. Please check your connection.';
    errBanner.classList.add('show');
  } finally {
    hideLoader();
  }
}

/* =====================================================
   SIGNUP
   ===================================================== */
async function handleSignup() {
  const name  = document.getElementById('signupName').value.trim();
  const email = document.getElementById('signupEmail').value.trim();
  const pw    = document.getElementById('signupPw').value;
  const pw2   = document.getElementById('signupPw2').value;
  let valid   = true;

  ['signupNameErr','signupEmailErr','signupPwErr','signupPw2Err'].forEach(id => document.getElementById(id).classList.remove('show'));
  ['signupName','signupEmail','signupPw','signupPw2'].forEach(id => document.getElementById(id).classList.remove('error'));
  document.getElementById('signupError').classList.remove('show');

  if (!name)  { document.getElementById('signupName').classList.add('error');  document.getElementById('signupNameErr').classList.add('show');  valid = false; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { document.getElementById('signupEmail').classList.add('error'); document.getElementById('signupEmailErr').classList.add('show'); valid = false; }
  if (pw.length < 6) { document.getElementById('signupPw').classList.add('error');  document.getElementById('signupPwErr').classList.add('show');  valid = false; }
  if (pw !== pw2)    { document.getElementById('signupPw2').classList.add('error'); document.getElementById('signupPw2Err').classList.add('show'); valid = false; }
  if (!valid) return;

  showLoader();
  try {
    const res  = await fetch(`${API_BASE}/auth/register`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name, email, password: pw }),
    });
    const data = await res.json();
    if (!res.ok) {
      const err = document.getElementById('signupError');
      err.textContent = data.error || 'Registration failed.';
      err.classList.add('show');
      return;
    }
    localStorage.setItem('leafscan_token', data.token);
    localStorage.setItem('leafscan_user',  JSON.stringify(data.user));
    currentUser = data.user;
    initHistory();
    showToast(t('signup_title') + '! ' + t('login_welcome') + ', ' + data.user.name + '!', 'success');
    navigate('dashboard');
  } catch (err) {
    const errBanner = document.getElementById('signupError');
    errBanner.textContent = 'Network error. Please check your connection.';
    errBanner.classList.add('show');
  } finally {
    hideLoader();
  }
}

/* =====================================================
   LOGOUT
   ===================================================== */
function logout() {
  localStorage.removeItem('leafscan_token');
  localStorage.removeItem('leafscan_user');
  localStorage.removeItem('leafscan_history');
  localStorage.removeItem('leafscan_mongo_token');
  currentUser = null;
  historyData = [];
  showToast(t('nav_logout') + '!', 'info');
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
  if (!['image/jpeg','image/jpg','image/png','image/webp'].includes(file.type)) {
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
   ANALYZE
   ===================================================== */
async function analyzeImage() {
  if (!selectedFile) return;

  showLoader();
  document.getElementById('analyzeBtn').disabled = true;

  document.querySelectorAll('#resultSection .result-card, #resultSection .treatment-card').forEach(e => e.remove());
  const placeholder = document.getElementById('resultPlaceholder');
  if (placeholder) placeholder.style.display = 'none';

  const formData = new FormData();
  formData.append('image', selectedFile);

  try {
    const response = await fetch(`${API_BASE}/analyze?top_k=3&lang=${typeof currentLang !== 'undefined' ? currentLang : 'en'}`, {
      method:  'POST',
      headers: getAuthHeaders(),
      body:    formData,
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || `Server error ${response.status}`);
    }

    const data        = await response.json();
    const pred        = data.prediction;
    const confidence  = +(pred.confidence * 100).toFixed(1);
    const isHealthy   = pred.is_healthy;
    const diseaseName = buildDisplayNameI18n(pred.plant, pred.disease, isHealthy);
    const severity    = severityFromConfidence(confidence, isHealthy);
    const status      = isHealthy ? 'Healthy' : 'Diseased';
    const timestamp   = Date.now();

    const record = {
      id: 'h_' + Date.now(),
      diseaseName,
      plant:           pred.plant,
      disease:         pred.disease,
      confidence,
      timestamp,
      status,
      severity,
      imageDataURL:    selectedImageDataURL,
      recommendations: data.recommendations,
    };

    historyData.unshift(record);
    saveHistory();

    // Save to MongoDB (non-blocking)
    const token = localStorage.getItem('leafscan_token');
    if (token) {
      fetch(`${API_BASE}/history/save`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body:    JSON.stringify({
          diseaseName:     record.diseaseName,
          plant:           record.plant,
          disease:         record.disease,
          confidence:      record.confidence,
          status:          record.status,
          severity:        record.severity,
          timestamp:       record.timestamp,
          imageDataURL:    record.imageDataURL,
          recommendations: record.recommendations,
        }),
      }).catch(() => {});
    }

    hideLoader();
    document.getElementById('analyzeBtn').disabled = false;

    renderResultCard(record);
    renderRecommendationCard(data.recommendations);
    showToast(t('analyze_btn').replace('🔬 ', '') + ' — ' + t('rec_title').replace('💊 ', ''), 'success');

  } catch (err) {
    hideLoader();
    document.getElementById('analyzeBtn').disabled = false;
    if (placeholder) placeholder.style.display = '';
    showToast('Error: ' + err.message, 'error');
    console.error(err);
  }
}

/* =====================================================
   RENDER RESULT CARD — fully i18n
   ===================================================== */
function renderResultCard(record) {
  const { diseaseName, confidence, timestamp, status, severity } = record;

  const sevDots = [1,2,3,4,5].map(i => {
    let cls = '';
    if (severity === 1)      cls = i <= 2 ? 'active-low'  : '';
    else if (severity === 2) cls = i <= 3 ? 'active-mid'  : '';
    else if (severity >= 3)  cls = 'active-high';
    return `<div class="severity-dot ${cls}"></div>`;
  }).join('');

  const badgeClass = status === 'Healthy'
    ? 'badge-healthy'
    : severity >= 3 ? 'badge-severe' : 'badge-diseased';

  // Translated status label
  const statusLabel = status === 'Healthy'
    ? 'Healthy'
    : status;

  const card = document.createElement('div');
  card.className = 'result-card';
  card.dataset.recordId = record.id;
  card.innerHTML = `
    <div class="result-card-header">
      <h2 data-i18n="result_title">${t('result_title')}</h2>
      <span class="badge ${badgeClass}">${statusLabel}</span>
    </div>
    <div class="result-card-body">
      <div class="disease-name">${diseaseName}</div>
      <div class="result-meta">${formatDate(timestamp)}</div>
      <div class="confidence-row">
        <span class="confidence-label" data-i18n="result_confidence">${t('result_confidence')}</span>
        <span class="confidence-val">${confidence}%</span>
      </div>
      <div class="confidence-bar-bg">
        <div class="confidence-bar" id="confBar" style="width:0%"></div>
      </div>
      <div class="severity-indicator" style="margin-top:16px">
        <div class="severity-label">
          <span data-i18n="result_severity">${t('result_severity')}</span>: 
          <span class="sev-value" data-sev-index="${severity}">${getSeverityLabel(severity)}</span>
        </div>
        <div class="severity-dots">${sevDots}</div>
      </div>
    </div>`;

  document.getElementById('resultSection').prepend(card);
  setTimeout(() => {
    const bar = document.getElementById('confBar');
    if (bar) bar.style.width = confidence + '%';
  }, 80);

  // Store for features.js
  window._lastAnalysisRecord = record;
}

/* =====================================================
   RENDER RECOMMENDATION CARD — fully i18n
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
          <h4 data-i18n="rec_treatment">${t('rec_treatment')}</h4>
          <p class="treatment-desc">${rec.treatment}</p>
        </div>`;
    }
    if (Array.isArray(rec.pesticides) && rec.pesticides.length) {
      bodyHTML += `
        <div class="treatment-section">
          <h4 data-i18n="rec_pesticides">${t('rec_pesticides')}</h4>
          <ul class="treatment-list">${rec.pesticides.map(p => `<li>${p}</li>`).join('')}</ul>
        </div>`;
    }
    if (Array.isArray(rec.fertilizers) && rec.fertilizers.length) {
      bodyHTML += `
        <div class="treatment-section">
          <h4 data-i18n="rec_fertilizers">${t('rec_fertilizers')}</h4>
          <ul class="treatment-list">${rec.fertilizers.map(f => `<li>${f}</li>`).join('')}</ul>
        </div>`;
    }
    if (Array.isArray(rec.care_tips) && rec.care_tips.length) {
      bodyHTML += `
        <div class="treatment-section">
          <h4 data-i18n="rec_care_tips">${t('rec_care_tips')}</h4>
          <ul class="treatment-list">${rec.care_tips.map(tip => `<li>${tip}</li>`).join('')}</ul>
        </div>`;
    }
  }

  card.innerHTML = `
    <div class="treatment-card-header" onclick="toggleTreatment(this)">
      <h3 data-i18n="rec_title">${t('rec_title')}</h3>
      <span class="chevron open">⌄</span>
    </div>
    <div class="treatment-body open">${bodyHTML}</div>`;

  document.getElementById('resultSection').appendChild(card);

  // Store for features.js
  window._lastAnalysisRecs = rec;
}

function toggleTreatment(header) {
  const body    = header.nextElementSibling;
  const chevron = header.querySelector('.chevron');
  body.classList.toggle('open');
  chevron.classList.toggle('open');
}

/* =====================================================
   HISTORY — fully i18n
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
      <h3 data-i18n="hist_empty_h">${t('hist_empty_h')}</h3>
      <p data-i18n="hist_empty_p">${t('hist_empty_p')}</p>
    </div>`;
    return;
  }

  filtered.forEach(item => {
    const card       = document.createElement('div');
    card.className   = 'history-card';
    const isHealthy  = item.status === 'Healthy';
    const badgeClass = isHealthy
      ? 'badge-healthy'
      : item.severity >= 3 ? 'badge-severe' : 'badge-diseased';
    const thumbHtml  = item.imageDataURL
      ? `<img class="history-thumb" src="${item.imageDataURL}" alt="Plant" />`
      : `<div class="history-thumb-placeholder">🌱</div>`;

    const displayName = buildDisplayNameI18n(item.plant, item.disease, isHealthy);

    card.innerHTML = `
      ${thumbHtml}
      <div class="history-card-body">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
          <div class="history-disease">${displayName}</div>
          <span class="badge ${badgeClass}">${item.status}</span>
        </div>
        <div class="history-conf">
          <span data-i18n="hist_conf_lbl">${t('hist_conf_lbl')}</span>
          <strong>${item.confidence}%</strong>
        </div>
        <div class="confidence-bar-bg" style="margin-bottom:12px">
          <div class="confidence-bar" style="width:${item.confidence}%"></div>
        </div>
        <div class="history-severity" style="margin-bottom:8px;font-size:12px;color:var(--muted)">
          <span data-i18n="result_severity">${t('result_severity')}</span>: 
          <span class="sev-value" data-sev-index="${item.severity}">${getSeverityLabel(item.severity)}</span>
        </div>
        <div class="history-date">📅 ${formatDate(item.timestamp)}</div>
        <div class="history-actions">
          <button class="btn btn-secondary btn-sm" onclick="downloadPDF('${item.id}')">
            <span data-i18n="hist_dl_pdf">${t('hist_dl_pdf')}</span>
          </button>
          <button class="btn btn-danger btn-sm" onclick="deleteRecord('${item.id}')">
            <span data-i18n="hist_delete">${t('hist_delete')}</span>
          </button>
        </div>
      </div>`;
    grid.appendChild(card);
  });
}

function deleteRecord(id) {
  historyData = historyData.filter(h => h.id !== id);
  saveHistory();
  renderHistory();
  showToast(t('hist_delete') + ' ✓', 'info');
}

/* =====================================================
   PDF GENERATION — i18n labels
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

      doc.setFillColor(22, 101, 52);
      doc.rect(0, 0, W, 30, 'F');
      doc.setFontSize(20); doc.setTextColor(255,255,255); doc.setFont('helvetica','bold');
      doc.text('LeafScan – Plant Disease Report', margin, 19);
      y = 42;

      doc.setTextColor(80,80,80); doc.setFontSize(10); doc.setFont('helvetica','normal');
      doc.text('Generated: '     + formatDate(Date.now()),       margin, y); y += 6;
      doc.text('Analysis Date: ' + formatDate(record.timestamp), margin, y); y += 10;
      doc.setDrawColor(200,200,200); doc.line(margin, y, W-margin, y); y += 8;

      const displayName = buildDisplayNameI18n(record.plant, record.disease, record.status === 'Healthy');
      doc.setFontSize(18); doc.setFont('helvetica','bold'); doc.setTextColor(22,101,52);
      doc.text(displayName, margin, y); y += 8;

      doc.setFontSize(11); doc.setFont('helvetica','normal'); doc.setTextColor(50,50,50);
      doc.text(
        'Status: ' + record.status +
        '  |  Confidence: ' + record.confidence + '%' +
        '  |  Severity: ' + getSeverityLabel(record.severity),
        margin, y
      ); y += 8;

      doc.setFillColor(230,230,230); doc.rect(margin, y, 120, 5, 'F');
      doc.setFillColor(22,101,52);   doc.rect(margin, y, 120*record.confidence/100, 5, 'F');
      y += 14;

      if (record.imageDataURL) {
        try {
          doc.setFont('helvetica','bold'); doc.setTextColor(30,30,30);
          doc.text('Plant Image', margin, y); y += 4;
          doc.addImage(record.imageDataURL, 'JPEG', margin, y, 80, 60);
          y += 68;
        } catch {}
      }

      // Recommendations
      const recs = record.recommendations || window._lastAnalysisRecs;
      if (recs && !recs.error) {
        doc.setDrawColor(200,200,200); doc.line(margin, y, W-margin, y); y += 8;

        const addSection = (title, content) => {
          if (!content) return;
          if (y > 260) { doc.addPage(); y = 20; }
          doc.setFontSize(11); doc.setFont('helvetica','bold'); doc.setTextColor(22,101,52);
          doc.text(title.toUpperCase(), margin, y); y += 6;
          doc.setFont('helvetica','normal'); doc.setTextColor(50,50,50); doc.setFontSize(10);
          doc.splitTextToSize(content, W-margin*2).forEach(line => {
            if (y > 270) { doc.addPage(); y = 20; }
            doc.text(line, margin, y); y += 5.5;
          });
          y += 4;
        };
        const addList = (title, items) => {
          if (!Array.isArray(items) || !items.length) return;
          if (y > 260) { doc.addPage(); y = 20; }
          doc.setFontSize(11); doc.setFont('helvetica','bold'); doc.setTextColor(22,101,52);
          doc.text(title.toUpperCase(), margin, y); y += 6;
          doc.setFont('helvetica','normal'); doc.setTextColor(50,50,50); doc.setFontSize(10);
          items.forEach(item => {
            if (y > 270) { doc.addPage(); y = 20; }
            doc.splitTextToSize('• ' + item, W-margin*2-4).forEach((line, i) => {
              doc.text(line, margin+(i>0?4:0), y); y += 5.5;
            });
          });
          y += 4;
        };

        addSection(t('rec_treatment'),   recs.treatment);
        addList(t('rec_pesticides'),     recs.pesticides);
        addList(t('rec_fertilizers'),    recs.fertilizers);
        addList(t('rec_care_tips'),      recs.care_tips);
      }

      doc.setDrawColor(200,200,200); doc.line(margin, 280, W-margin, 280);
      doc.setFontSize(9); doc.setFont('helvetica','normal'); doc.setTextColor(140,140,140);
      doc.text('LeafScan Plant Disease Detection System  |  v2.0.0  |  For informational purposes only.', margin, 285);

      doc.save(`leafscan-report-${new Date().toISOString().slice(0,10)}.pdf`);
      showToast(t('hist_dl_pdf') + '!', 'success');
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
  const since = user.createdAt || user.created_at;
  document.getElementById('sidebarSince').textContent   = t('prof_since') + ' ' + (since
    ? new Date(since).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    : '–');
}
function saveProfile() {
  const name = document.getElementById('profileName').value.trim();
  if (!name) { showToast(t('prof_name') + ' cannot be empty.', 'error'); return; }
  const user  = JSON.parse(localStorage.getItem('leafscan_user') || '{}');
  user.name   = name;
  localStorage.setItem('leafscan_user', JSON.stringify(user));
  loadProfile();
  document.getElementById('profileAvatar').textContent = name.charAt(0).toUpperCase();
  showToast(t('prof_save') + '!', 'success');
}
function changePassword() {
  const cur     = document.getElementById('curPw').value;
  const newPw   = document.getElementById('newPw').value;
  const confirm = document.getElementById('confirmNewPw').value;
  if (!cur)              { showToast(t('prof_cur_pw') + ' required.', 'error'); return; }
  if (newPw.length < 6) { showToast(t('prof_new_pw') + ' min 6 chars.', 'error'); return; }
  if (newPw !== confirm) { showToast('Passwords do not match.', 'error'); return; }
  ['curPw','newPw','confirmNewPw'].forEach(id => document.getElementById(id).value = '');
  showToast(t('prof_update_pw') + '!', 'success');
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
    month:'short', day:'numeric', year:'numeric',
    hour:'2-digit', minute:'2-digit',
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
   RE-RENDER ON LANGUAGE CHANGE
   Patch applyLanguage to refresh all dynamic content
   ===================================================== */
const _originalApplyLanguage = window.applyLanguage;
window.applyLanguage = function(lang) {
  _originalApplyLanguage(lang);

  // Re-render dynamic severity values already in DOM
  document.querySelectorAll('.sev-value[data-sev-index]').forEach(el => {
    el.textContent = getSeverityLabel(parseInt(el.dataset.sevIndex, 10));
  });

  // Re-render result card section labels already in DOM
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });

  // If on history page, re-render to update all card text
  if (currentPage === 'history') renderHistory();

  // If on dashboard and results are showing, re-render recommendation headers
  document.querySelectorAll('.treatment-card-header h3').forEach(el => {
    el.textContent = t('rec_title');
  });
  document.querySelectorAll('.treatment-section h4').forEach(el => {
    const key = el.dataset.i18n;
    if (key) el.textContent = t(key);
  });
};

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