/* =============================================================
   features.js — LeafScan Feature Integration Layer
   Runs AFTER app.js. Hooks into existing functions without
   modifying them. Adds:
     1. Language switcher (uses translations.js)
     2. Google OAuth login
     3. MongoDB-backed auth (overrides mock login/signup)
     4. MongoDB history sync
     5. Audio+Share injection after analysis
     6. Chatbot init
     7. Enhanced PDF (with full recommendations)
   ============================================================= */

/* ── 1. LANGUAGE SWITCHER ──────────────────────────────────── */

function buildLangSwitcher() {
  const dropdown = document.getElementById('langDropdown');
  const mobileRow = document.getElementById('mobileLangRow');
  if (!dropdown) return;

  dropdown.innerHTML = '';
  mobileRow && (mobileRow.innerHTML = '');

  Object.entries(LANGUAGE_NAMES).forEach(([code, name]) => {
    // Desktop dropdown option
    const btn = document.createElement('button');
    btn.className = 'lang-option' + (code === currentLang ? ' active' : '');
    btn.dataset.lang = code;
    btn.textContent = name;
    btn.onclick = () => { applyLanguage(code); updateLangLabel(); closeLangDropdown(); };
    dropdown.appendChild(btn);

    // Mobile pill
    if (mobileRow) {
      const pill = document.createElement('button');
      pill.className = 'mobile-lang-btn' + (code === currentLang ? ' active' : '');
      pill.dataset.lang = code;
      pill.textContent = code.toUpperCase();
      pill.onclick = () => { applyLanguage(code); updateLangLabel(); buildLangSwitcher(); };
      mobileRow.appendChild(pill);
    }
  });
}

function updateLangLabel() {
  const el = document.getElementById('langLabel');
  if (el) el.textContent = currentLang.toUpperCase();
}

function toggleLangDropdown(e) {
  e.stopPropagation();
  document.getElementById('langDropdown').classList.toggle('open');
}

function closeLangDropdown() {
  const d = document.getElementById('langDropdown');
  if (d) d.classList.remove('open');
}

// Close on outside click
document.addEventListener('click', (e) => {
  if (!e.target.closest('#langSwitcher')) closeLangDropdown();
});


/* ── 2. GOOGLE OAUTH ───────────────────────────────────────── */

let _googleClientId = '';  // fetched from /health or set manually

function triggerGoogleLogin() {
  if (!window.google || !window.google.accounts) {
    showToast('Google Sign-In not available. Check your internet connection.', 'error');
    return;
  }
  if (!_googleClientId) {
    showToast('Google Client ID not configured on server.', 'error');
    return;
  }
  window.google.accounts.id.initialize({
    client_id:  _googleClientId,
    callback:   handleGoogleCredential,
    auto_select: false,
  });
  window.google.accounts.id.prompt();
}

async function handleGoogleCredential(response) {
  showLoader();
  try {
    const res = await fetch('/auth/google', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ credential: response.credential }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Google login failed');
    onAuthSuccess(data.token, data.user);
    showToast('Welcome, ' + data.user.name + '!', 'success');
  } catch (err) {
    showToast('Google login failed: ' + err.message, 'error');
  } finally {
    hideLoader();
  }
}

async function fetchGoogleClientId() {
  try {
    const res = await fetch('/health');
    const data = await res.json();
    if (data.google_client_id) {
      _googleClientId = data.google_client_id;
    }
  } catch {}
}


/* ── 3. MONGODB AUTH — override handleLogin & handleSignup ─── */

/* Store auth token separately from the mock system */
function getAuthToken() {
  return localStorage.getItem('leafscan_mongo_token') || null;
}

function onAuthSuccess(token, user) {
  localStorage.setItem('leafscan_mongo_token', token);
  localStorage.setItem('leafscan_token',       token);  // keep original key working
  localStorage.setItem('leafscan_user', JSON.stringify({
    name:      user.name,
    email:     user.email,
    createdAt: user.created_at || new Date().toISOString(),
    picture:   user.picture || null,
    mongoId:   user.id,
  }));
  initHistory();
  // Update avatar with Google picture if available
  if (user.picture) {
    document.querySelectorAll('.profile-avatar, .profile-avatar-lg').forEach(el => {
      el.style.backgroundImage = `url(${user.picture})`;
      el.style.backgroundSize  = 'cover';
      el.textContent           = '';
    });
  }
  navigate('dashboard');
}

/* Override original handleLogin with MongoDB-backed version */
const _originalHandleLogin = window.handleLogin;
window.handleLogin = async function() {
  const email = (document.getElementById('loginEmail')?.value || '').trim();
  const pw    = (document.getElementById('loginPw')?.value || '');

  // Basic frontend validation (kept same as original)
  let valid = true;
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
    const res = await fetch('/auth/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, password: pw }),
    });
    const data = await res.json();
    hideLoader();
    if (!res.ok) {
      const err = document.getElementById('loginError');
      err.textContent = data.error || 'Login failed.';
      err.classList.add('show');
      return;
    }
    onAuthSuccess(data.token, data.user);
    showToast('Welcome back, ' + data.user.name + '!', 'success');
  } catch (e) {
    hideLoader();
    // Fallback to original mock login if server unavailable
    if (_originalHandleLogin) _originalHandleLogin();
  }
};

/* Override handleSignup */
const _originalHandleSignup = window.handleSignup;
window.handleSignup = async function() {
  const name  = (document.getElementById('signupName')?.value || '').trim();
  const email = (document.getElementById('signupEmail')?.value || '').trim();
  const pw    = (document.getElementById('signupPw')?.value || '');
  const pw2   = (document.getElementById('signupPw2')?.value || '');
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
    const res = await fetch('/auth/register', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name, email, password: pw }),
    });
    const data = await res.json();
    hideLoader();
    if (!res.ok) {
      const err = document.getElementById('signupError');
      err.textContent = data.error || 'Registration failed.';
      err.classList.add('show');
      return;
    }
    onAuthSuccess(data.token, data.user);
    showToast('Account created! Welcome, ' + data.user.name + '!', 'success');
  } catch (e) {
    hideLoader();
    if (_originalHandleSignup) _originalHandleSignup();
  }
};


/* ── 4. MONGODB HISTORY SYNC ──────────────────────────────── */

/* After analyzeImage saves to localStorage, also save to MongoDB */
async function syncHistoryToMongo(record, recommendations) {
  const token = getAuthToken();
  if (!token) return;
  try {
    await fetch('/history/save', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ ...record, recommendations }),
    });
  } catch {}
}

/* Load history from MongoDB when user goes to history page */
async function loadHistoryFromMongo() {
  const token = getAuthToken();
  if (!token) return;
  try {
    const res  = await fetch('/history/list', {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data.history) && data.history.length > 0) {
      // Merge: MongoDB records take precedence, keyed by id
      const mongoRecords = data.history.map(r => ({
        id:           r.id,
        diseaseName:  r.disease_name,
        plant:        r.plant,
        disease:      r.disease,
        confidence:   r.confidence,
        timestamp:    r.timestamp,
        status:       r.status,
        severity:     r.severity,
        imageDataURL: r.image_data,
        recommendations: r.recommendations,
      }));
      // Merge with localStorage (prefer MongoDB)
      const localIds = new Set(historyData.map(h => h.id));
      mongoRecords.forEach(r => {
        if (!localIds.has(r.id)) historyData.unshift(r);
      });
      saveHistory();
    }
  } catch {}
}

/* Patch deleteRecord to also delete from MongoDB */
const _originalDeleteRecord = window.deleteRecord;
window.deleteRecord = async function(id) {
  _originalDeleteRecord(id);
  const token = getAuthToken();
  if (!token) return;
  try {
    await fetch(`/history/${id}`, {
      method:  'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
  } catch {}
};


/* ── 5. PATCH analyzeImage to inject audio+share ───────────── */

const _originalAnalyzeImage = window.analyzeImage;
window.analyzeImage = async function() {
  // We need to intercept the result. Since analyzeImage is complex,
  // we patch renderResultCard + renderRecommendationCard to capture state.
  await _originalAnalyzeImage();
  // After analysis, inject audio+share toolbar
  // _lastAnalysisRecord and _lastAnalysisRecs set by patched renders below
  if (window._lastAnalysisRecord) {
    injectResultActions(window._lastAnalysisRecord, window._lastAnalysisRecs || {});
    // Sync to MongoDB
    syncHistoryToMongo(window._lastAnalysisRecord, window._lastAnalysisRecs || {});
    // Set chatbot context
    setChatContext(
      window._lastAnalysisRecord.plant,
      window._lastAnalysisRecord.disease,
      window._lastAnalysisRecord.status === 'Healthy',
      window._lastAnalysisRecord.confidence
    );
  }
};

/* Patch renderResultCard to capture record */
const _origRenderResultCard = window.renderResultCard;
window.renderResultCard = function(record) {
  _origRenderResultCard(record);
  window._lastAnalysisRecord = record;
};

/* Patch renderRecommendationCard to capture recs */
const _origRenderRecommendationCard = window.renderRecommendationCard;
window.renderRecommendationCard = function(rec) {
  _origRenderRecommendationCard(rec);
  window._lastAnalysisRecs = rec;
};

/* Patch navigate to load MongoDB history */
const _origNavigate = window.navigate;
window.navigate = function(page) {
  _origNavigate(page);
  if (page === 'history') loadHistoryFromMongo();
};


/* ── 6. ENHANCED PDF (adds recommendations section) ────────── */

/* Override downloadPDF with enhanced version */
window.downloadPDF = function(id) {
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

      // Meta
      doc.setTextColor(80, 80, 80); doc.setFontSize(10); doc.setFont('helvetica', 'normal');
      doc.text('Generated: '     + formatDate(Date.now()),        margin, y); y += 6;
      doc.text('Analysis Date: ' + formatDate(record.timestamp),  margin, y); y += 10;
      doc.setDrawColor(200, 200, 200); doc.line(margin, y, W - margin, y); y += 8;

      // Disease name
      const displayName = buildDisplayName(record.plant, record.disease, record.status === 'Healthy');
      doc.setFontSize(18); doc.setFont('helvetica', 'bold'); doc.setTextColor(22, 101, 52);
      doc.text(displayName, margin, y); y += 8;

      doc.setFontSize(11); doc.setFont('helvetica', 'normal'); doc.setTextColor(50, 50, 50);
      const sevLabels = ['None', 'Low', 'Moderate', 'Severe'];
      doc.text(
        'Status: ' + record.status +
        '  |  Confidence: ' + record.confidence + '%' +
        '  |  Severity: ' + (sevLabels[record.severity] || 'None'),
        margin, y
      ); y += 8;

      // Confidence bar
      doc.setFillColor(230, 230, 230); doc.rect(margin, y, 120, 5, 'F');
      doc.setFillColor(22, 101, 52);   doc.rect(margin, y, 120 * record.confidence / 100, 5, 'F');
      y += 14;

      // Plant image
      if (record.imageDataURL) {
        try {
          doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(30, 30, 30);
          doc.text('Plant Image', margin, y); y += 4;
          doc.addImage(record.imageDataURL, 'JPEG', margin, y, 80, 60);
          y += 68;
        } catch {}
      }

      // [NEW] Recommendations section
      const recs = record.recommendations || window._lastAnalysisRecs;
      if (recs && !recs.error) {
        doc.setDrawColor(200, 200, 200); doc.line(margin, y, W - margin, y); y += 8;

        const addSection = (title, content) => {
          if (!content) return;
          if (y > 260) { doc.addPage(); y = 20; }
          doc.setFontSize(11); doc.setFont('helvetica', 'bold'); doc.setTextColor(22, 101, 52);
          doc.text(title.toUpperCase(), margin, y); y += 6;
          doc.setFont('helvetica', 'normal'); doc.setTextColor(50, 50, 50); doc.setFontSize(10);
          const lines = doc.splitTextToSize(content, W - margin * 2);
          lines.forEach(line => {
            if (y > 270) { doc.addPage(); y = 20; }
            doc.text(line, margin, y); y += 5.5;
          });
          y += 4;
        };

        const addList = (title, items) => {
          if (!Array.isArray(items) || !items.length) return;
          if (y > 260) { doc.addPage(); y = 20; }
          doc.setFontSize(11); doc.setFont('helvetica', 'bold'); doc.setTextColor(22, 101, 52);
          doc.text(title.toUpperCase(), margin, y); y += 6;
          doc.setFont('helvetica', 'normal'); doc.setTextColor(50, 50, 50); doc.setFontSize(10);
          items.forEach(item => {
            if (y > 270) { doc.addPage(); y = 20; }
            const lines = doc.splitTextToSize('• ' + item, W - margin * 2 - 4);
            lines.forEach((line, i) => {
              doc.text(line, margin + (i > 0 ? 4 : 0), y); y += 5.5;
            });
          });
          y += 4;
        };

        addSection('Treatment', recs.treatment);
        addList('Pesticides', recs.pesticides);
        addList('Fertilizers', recs.fertilizers);
        addList('Care Tips', recs.care_tips);
      }

      // Footer
      doc.setDrawColor(200, 200, 200); doc.line(margin, 280, W - margin, 280);
      doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(140, 140, 140);
      doc.text('LeafScan Plant Disease Detection System  |  v2.0.0  |  For informational purposes only.', margin, 285);

      doc.save(`leafscan-report-${new Date().toISOString().slice(0, 10)}.pdf`);
      showToast('PDF downloaded!', 'success');
    } catch (e) {
      console.error(e);
      showToast('Failed to generate PDF.', 'error');
    }
    hideLoader();
  }, 400);
};

/* Add audio button to history cards by patching renderHistory */
const _origRenderHistory = window.renderHistory;
window.renderHistory = function() {
  _origRenderHistory();
  // Add audio button to each card after render
  document.querySelectorAll('.history-card').forEach(card => {
    if (card.querySelector('.hist-audio-btn')) return; // already added
    const actions = card.querySelector('.history-actions');
    if (!actions) return;
    const btn = document.createElement('button');
    btn.className = 'hist-audio-btn btn-sm';
    btn.textContent = '🔊';
    btn.title = t('speak_btn');
    btn.onclick = () => {
      // Find matching record by checking card content (confidence shown)
      const nameEl = card.querySelector('.history-disease');
      if (!nameEl) return;
      const name = nameEl.textContent;
      const rec  = historyData.find(h => buildDisplayName(h.plant, h.disease, h.status === 'Healthy') === name);
      if (rec) speakText(buildSpeakText(rec, rec.recommendations), btn);
    };
    actions.appendChild(btn);
  });
};


/* ── 7. INIT ───────────────────────────────────────────────── */

(function initFeatures() {
  // Language
  buildLangSwitcher();
  updateLangLabel();
  applyLanguage(currentLang);

  // Chatbot
  initChatbot();

  // Google Client ID
  fetchGoogleClientId();

  // Update /health to expose google_client_id
  // (app.py health route already includes it)
})();
