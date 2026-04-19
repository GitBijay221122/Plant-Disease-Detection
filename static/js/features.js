/* =============================================================
   features.js — LeafScan Feature Integration Layer
   Runs AFTER app.js. Adds:
     1. Language switcher (uses translations.js)
     2. Google OAuth login
     3. MongoDB-backed auth
     4. MongoDB history sync
     5. Audio + Share injection after analysis
     6. Chatbot init
     7. Enhanced PDF (with recommendations)
   ============================================================= */

/* ── 1. LANGUAGE SWITCHER ──────────────────────────────────── */

function buildLangSwitcher() {
  const dropdown  = document.getElementById('langDropdown');
  const mobileRow = document.getElementById('mobileLangRow');
  if (!dropdown) return;

  dropdown.innerHTML = '';
  if (mobileRow) mobileRow.innerHTML = '';

  Object.entries(LANGUAGE_NAMES).forEach(([code, name]) => {
    const btn = document.createElement('button');
    btn.className      = 'lang-option' + (code === currentLang ? ' active' : '');
    btn.dataset.lang   = code;
    btn.textContent    = name;
    btn.onclick        = () => { applyLanguage(code); updateLangLabel(); closeLangDropdown(); };
    dropdown.appendChild(btn);

    if (mobileRow) {
      const pill = document.createElement('button');
      pill.className    = 'mobile-lang-btn' + (code === currentLang ? ' active' : '');
      pill.dataset.lang = code;
      pill.textContent  = code.toUpperCase();
      pill.onclick      = () => { applyLanguage(code); updateLangLabel(); buildLangSwitcher(); };
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

document.addEventListener('click', (e) => {
  if (!e.target.closest('#langSwitcher')) closeLangDropdown();
});

/* Hook: rebuild switcher + re-apply language on every language change */
const _baseApplyLanguage = window.applyLanguage;
window.applyLanguage = function(lang) {
  _baseApplyLanguage(lang);
  buildLangSwitcher();
  updateLangLabel();

  // Re-translate any visible dynamic text
  refreshDynamicTranslations();
};

/**
 * Refreshes all visible dynamic text that was rendered with t() at build time.
 * Called after every language switch.
 */
function refreshDynamicTranslations() {
  // Result card headers
  document.querySelectorAll('.result-card h2').forEach(el => {
    el.textContent = t('result_title');
  });
  document.querySelectorAll('.result-card .confidence-label').forEach(el => {
    el.textContent = t('result_confidence');
  });
  document.querySelectorAll('.result-card .severity-label span[data-i18n="result_severity"]').forEach(el => {
    el.textContent = t('result_severity');
  });

  // Severity values
  document.querySelectorAll('.sev-value[data-sev-index]').forEach(el => {
    el.textContent = getSeverityLabel(parseInt(el.dataset.sevIndex, 10));
  });

  // Recommendation card
  document.querySelectorAll('.treatment-card-header h3').forEach(el => {
    el.textContent = t('rec_title');
  });
  document.querySelectorAll('.treatment-section h4[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });

  // History page empty state
  document.querySelectorAll('.empty-state h3[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('.empty-state p[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });

  // History cards: confidence label, severity, delete/pdf buttons
  document.querySelectorAll('.history-conf span[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('.history-severity span[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('.history-actions button span[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });

  // Chatbot title / subtitle / placeholder
  const chatTitle    = document.querySelector('.chat-title');
  const chatSubtitle = document.querySelector('.chat-subtitle');
  const chatInput    = document.querySelector('.chat-input-field');
  const chatSendBtn  = document.querySelector('.chat-send-btn');
  if (chatTitle)    chatTitle.textContent    = t('chat_title');
  if (chatSubtitle) chatSubtitle.textContent = t('chat_subtitle');
  if (chatInput)    chatInput.placeholder    = t('chat_placeholder');
  if (chatSendBtn)  chatSendBtn.textContent  = t('chat_send');

  // Audio/share button labels in result section
  document.querySelectorAll('.result-speak-btn').forEach(btn => {
    if (!btn.classList.contains('speaking')) btn.textContent = t('speak_btn');
  });
  document.querySelectorAll('.result-share-btn').forEach(btn => {
    btn.textContent = t('share_btn');
  });

  // If on history page, fully re-render to rebuild all cards in new language
  if (typeof currentPage !== 'undefined' && currentPage === 'history') {
    if (typeof renderHistory === 'function') renderHistory();
  }
}


/* ── 2. GOOGLE OAUTH ───────────────────────────────────────── */

let _googleClientId = '';

function triggerGoogleLogin() {
  if (!window.google || !window.google.accounts) {
    showToast('Google Sign-In not available.', 'error');
    return;
  }
  if (!_googleClientId) {
    showToast('Google Client ID not configured on server.', 'error');
    return;
  }
  window.google.accounts.id.initialize({
    client_id:   _googleClientId,
    callback:    handleGoogleCredential,
    auto_select: false,
  });
  window.google.accounts.id.prompt();
}

async function handleGoogleCredential(response) {
  showLoader();
  try {
    const res  = await fetch('/auth/google', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ credential: response.credential }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Google login failed');
    onAuthSuccess(data.token, data.user);
    showToast(t('login_welcome') + ', ' + data.user.name + '!', 'success');
  } catch (err) {
    showToast('Google login failed: ' + err.message, 'error');
  } finally {
    hideLoader();
  }
}

async function fetchGoogleClientId() {
  try {
    const res  = await fetch('/health');
    const data = await res.json();
    if (data.google_client_id) _googleClientId = data.google_client_id;
  } catch {}
}


/* ── 3. MONGODB AUTH ───────────────────────────────────────── */

function getAuthToken() {
  return localStorage.getItem('leafscan_mongo_token') || null;
}

function onAuthSuccess(token, user) {
  localStorage.setItem('leafscan_mongo_token', token);
  localStorage.setItem('leafscan_token', token);
  localStorage.setItem('leafscan_user', JSON.stringify({
    name:      user.name,
    email:     user.email,
    createdAt: user.created_at || new Date().toISOString(),
    picture:   user.picture || null,
    mongoId:   user.id,
  }));
  initHistory();
  if (user.picture) {
    document.querySelectorAll('.profile-avatar, .profile-avatar-lg').forEach(el => {
      el.style.backgroundImage = `url(${user.picture})`;
      el.style.backgroundSize  = 'cover';
      el.textContent           = '';
    });
  }
  navigate('dashboard');
}

/* Override handleLogin */
const _originalHandleLogin = window.handleLogin;
window.handleLogin = async function() {
  const email = (document.getElementById('loginEmail')?.value || '').trim();
  const pw    = (document.getElementById('loginPw')?.value   || '');
  let valid   = true;

  ['loginEmail','loginPw'].forEach(id => document.getElementById(id).classList.remove('error'));
  ['loginEmailErr','loginPwErr'].forEach(id => document.getElementById(id).classList.remove('show'));
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
    const res  = await fetch('/auth/login', {
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
    showToast(t('login_welcome') + ', ' + data.user.name + '!', 'success');
  } catch (e) {
    hideLoader();
    showToast('Network error. Please check your connection.', 'error');
  }
};

/* Override handleSignup */
const _originalHandleSignup = window.handleSignup;
window.handleSignup = async function() {
  const name  = (document.getElementById('signupName')?.value  || '').trim();
  const email = (document.getElementById('signupEmail')?.value || '').trim();
  const pw    = (document.getElementById('signupPw')?.value    || '');
  const pw2   = (document.getElementById('signupPw2')?.value   || '');
  let valid   = true;

  ['signupNameErr','signupEmailErr','signupPwErr','signupPw2Err'].forEach(id => document.getElementById(id).classList.remove('show'));
  ['signupName','signupEmail','signupPw','signupPw2'].forEach(id => document.getElementById(id).classList.remove('error'));
  document.getElementById('signupError').classList.remove('show');

  if (!name)             { document.getElementById('signupName').classList.add('error');  document.getElementById('signupNameErr').classList.add('show');  valid = false; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { document.getElementById('signupEmail').classList.add('error'); document.getElementById('signupEmailErr').classList.add('show'); valid = false; }
  if (pw.length < 6)    { document.getElementById('signupPw').classList.add('error');   document.getElementById('signupPwErr').classList.add('show');   valid = false; }
  if (pw !== pw2)        { document.getElementById('signupPw2').classList.add('error');  document.getElementById('signupPw2Err').classList.add('show');  valid = false; }
  if (!valid) return;

  showLoader();
  try {
    const res  = await fetch('/auth/register', {
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
    showToast(t('signup_btn') + '! ' + t('login_welcome') + ', ' + data.user.name + '!', 'success');
  } catch (e) {
    hideLoader();
    showToast('Network error. Please check your connection.', 'error');
  }
};


/* ── 4. MONGODB HISTORY SYNC ──────────────────────────────── */

async function syncHistoryToMongo(record, recommendations) {
  const token = getAuthToken();
  if (!token) return;
  try {
    await fetch('/history/save', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body:    JSON.stringify({ ...record, recommendations }),
    });
  } catch {}
}

async function loadHistoryFromMongo() {
  const token = getAuthToken();
  if (!token) return;
  try {
    const res  = await fetch('/history/list', { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data.history) && data.history.length > 0) {
      const mongoRecords = data.history.map(r => ({
        id:              r.id,
        diseaseName:     r.disease_name,
        plant:           r.plant,
        disease:         r.disease,
        confidence:      r.confidence,
        timestamp:       r.timestamp,
        status:          r.status,
        severity:        r.severity,
        imageDataURL:    r.image_data,
        recommendations: r.recommendations,
      }));
      const localIds = new Set(historyData.map(h => h.id));
      mongoRecords.forEach(r => { if (!localIds.has(r.id)) historyData.unshift(r); });
      saveHistory();
    }
  } catch {}
}

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
  await _originalAnalyzeImage();
  if (window._lastAnalysisRecord) {
    injectResultActions(window._lastAnalysisRecord, window._lastAnalysisRecs || {});
    syncHistoryToMongo(window._lastAnalysisRecord, window._lastAnalysisRecs || {});
    if (typeof setChatContext === 'function') {
      setChatContext(
        window._lastAnalysisRecord.plant,
        window._lastAnalysisRecord.disease,
        window._lastAnalysisRecord.status === 'Healthy',
        window._lastAnalysisRecord.confidence,
      );
    }
  }
};

/* Patch navigate to sync MongoDB history */
const _origNavigate = window.navigate;
window.navigate = function(page) {
  _origNavigate(page);
  if (page === 'history') loadHistoryFromMongo();
};

/* Patch renderHistory to add audio buttons */
const _origRenderHistory = window.renderHistory;
window.renderHistory = function() {
  _origRenderHistory();
  document.querySelectorAll('.history-card').forEach(card => {
    if (card.querySelector('.hist-audio-btn')) return;
    const actions = card.querySelector('.history-actions');
    if (!actions) return;
    const btn         = document.createElement('button');
    btn.className     = 'hist-audio-btn btn-sm';
    btn.textContent   = '🔊';
    btn.title         = t('speak_btn');
    btn.onclick = () => {
      const nameEl = card.querySelector('.history-disease');
      if (!nameEl) return;
      const name = nameEl.textContent;
      const rec  = historyData.find(h =>
        (h.diseaseName === name) ||
        (buildDisplayNameI18n(h.plant, h.disease, h.status === 'Healthy') === name)
      );
      if (rec && typeof speakText === 'function') {
        speakText(buildSpeakText(rec, rec.recommendations), btn);
      }
    };
    actions.appendChild(btn);
  });
};


/* ── 6. ENHANCED PDF (with recommendations + i18n labels) ─── */

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

      doc.setFillColor(22,101,52);
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
          doc.setFont('helvetica','bold'); doc.setFontSize(12); doc.setTextColor(30,30,30);
          doc.text('Plant Image', margin, y); y += 4;
          doc.addImage(record.imageDataURL, 'JPEG', margin, y, 80, 60);
          y += 68;
        } catch {}
      }

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
};


/* ── 7. INIT ───────────────────────────────────────────────── */

(function initFeatures() {
  buildLangSwitcher();
  updateLangLabel();
  applyLanguage(currentLang);

  if (typeof initChatbot === 'function') initChatbot();

  fetchGoogleClientId();
})();