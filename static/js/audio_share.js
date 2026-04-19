/* =============================================================
   audio_share.js — LeafScan Text-to-Speech & Share
   Provides:
     - speakText(text, btn)        — speaks text, toggles btn state
     - stopSpeech()                — stops any ongoing speech
     - buildSpeakText(record, rec) — builds full readable text from record
     - injectResultActions(record, rec) — injects speak+share buttons into result card
   ============================================================= */

/* ── SPEECH STATE ─────────────────────────────────────────── */
let _currentUtterance = null;
let _isSpeaking       = false;

/* ── CORE SPEAK ───────────────────────────────────────────── */
function speakText(text, btn) {
  if (!('speechSynthesis' in window)) {
    showToast('Text-to-speech is not supported in your browser.', 'error');
    return;
  }

  // If already speaking — stop
  if (_isSpeaking) {
    stopSpeech();
    if (btn) {
      btn.textContent = t('speak_btn') || '🔊 Read Aloud';
      btn.classList.remove('speaking');
    }
    return;
  }

  // Cancel any leftover speech
  window.speechSynthesis.cancel();

  const lang = typeof currentLang !== 'undefined' ? currentLang : 'en';

  // Map app lang codes → BCP-47 for speechSynthesis
  const LANG_MAP = {
    en: 'en-US',
    hi: 'hi-IN',
    bn: 'bn-IN',
    ta: 'ta-IN',
    te: 'te-IN',
    es: 'es-ES',
    fr: 'fr-FR',
    ar: 'ar-SA',
  };

  _currentUtterance          = new SpeechSynthesisUtterance(text);
  _currentUtterance.lang     = LANG_MAP[lang] || 'en-US';
  _currentUtterance.rate     = 0.92;
  _currentUtterance.pitch    = 1;
  _currentUtterance.volume   = 1;

  _currentUtterance.onstart = () => {
    _isSpeaking = true;
    if (btn) {
      btn.textContent = t('stop_btn') || '⏹ Stop';
      btn.classList.add('speaking');
    }
  };

  _currentUtterance.onend = _currentUtterance.onerror = () => {
    _isSpeaking = false;
    _currentUtterance = null;
    if (btn) {
      btn.textContent = t('speak_btn') || '🔊 Read Aloud';
      btn.classList.remove('speaking');
    }
  };

  window.speechSynthesis.speak(_currentUtterance);
}

function stopSpeech() {
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
  _isSpeaking       = false;
  _currentUtterance = null;
}

/* ── BUILD READABLE TEXT ──────────────────────────────────── */
function buildSpeakText(record, rec) {
  const lines = [];

  // Disease / status
  const name = record.diseaseName || buildDisplayNameI18n(record.plant, record.disease, record.status === 'Healthy');
  lines.push(name + '.');
  lines.push((t('result_confidence') || 'Confidence') + ': ' + record.confidence + '%.');
  lines.push((t('result_severity')   || 'Severity')   + ': ' + getSeverityLabel(record.severity) + '.');

  if (!rec || rec.error) return lines.join(' ');

  // Treatment
  if (rec.treatment) {
    lines.push('');
    lines.push((t('rec_treatment') || 'Treatment') + ': ' + rec.treatment);
  }

  // Pesticides
  if (Array.isArray(rec.pesticides) && rec.pesticides.length) {
    lines.push('');
    lines.push((t('rec_pesticides') || 'Pesticides') + ':');
    rec.pesticides.forEach((p, i) => lines.push((i + 1) + '. ' + p));
  }

  // Fertilizers
  if (Array.isArray(rec.fertilizers) && rec.fertilizers.length) {
    lines.push('');
    lines.push((t('rec_fertilizers') || 'Fertilizers') + ':');
    rec.fertilizers.forEach((f, i) => lines.push((i + 1) + '. ' + f));
  }

  // Care tips
  if (Array.isArray(rec.care_tips) && rec.care_tips.length) {
    lines.push('');
    lines.push((t('rec_care_tips') || 'Care Tips') + ':');
    rec.care_tips.forEach((tip, i) => lines.push((i + 1) + '. ' + tip));
  }

  return lines.join(' ');
}

/* ── INJECT SPEAK + SHARE BUTTONS INTO RESULT SECTION ──────── */
function injectResultActions(record, rec) {
  // Remove any previous action bar
  const existing = document.getElementById('resultActionBar');
  if (existing) existing.remove();

  const bar = document.createElement('div');
  bar.id        = 'resultActionBar';
  bar.className = 'result-action-bar';

  /* ── Speak button ── */
  const speakBtn = document.createElement('button');
  speakBtn.className = 'btn result-speak-btn';
  speakBtn.innerHTML = `🔊 <span>${t('speak_btn') || 'Read Aloud'}</span>`;
  speakBtn.onclick   = () => {
    const text = buildSpeakText(record, rec);
    speakText(text, speakBtn);
  };

  /* ── Share button ── */
  const shareBtn = document.createElement('button');
  shareBtn.className = 'btn result-share-btn';
  shareBtn.innerHTML = `📤 <span>${t('share_btn') || 'Share'}</span>`;
  shareBtn.onclick   = () => showShareMenu(record, shareBtn);

  bar.appendChild(speakBtn);
  bar.appendChild(shareBtn);

  // Insert after the result card, before the treatment card
  const resultSection = document.getElementById('resultSection');
  const treatmentCard = resultSection?.querySelector('.treatment-card');
  if (treatmentCard) {
    resultSection.insertBefore(bar, treatmentCard);
  } else if (resultSection) {
    resultSection.appendChild(bar);
  }
}

/* ── SHARE MENU ───────────────────────────────────────────── */
function showShareMenu(record, anchor) {
  // Remove existing menu
  const existing = document.getElementById('shareMenu');
  if (existing) { existing.remove(); return; }

  const isHealthy = record.status === 'Healthy';
  const rawText   = isHealthy
    ? (t('share_healthy_text') || 'My {plant} is Healthy ({confidence}% confidence) via LeafScan 🌿')
    : (t('share_text')         || 'My {plant} was diagnosed with {disease} ({confidence}% confidence) via LeafScan 🌿');

  const shareText = rawText
    .replace('{plant}',      record.plant      || '')
    .replace('{disease}',    record.disease     || '')
    .replace('{confidence}', record.confidence  || '');

  const encodedText = encodeURIComponent(shareText);
  const pageUrl     = encodeURIComponent(window.location.href);

  const menu = document.createElement('div');
  menu.id        = 'shareMenu';
  menu.className = 'share-menu';
  menu.innerHTML = `
    <a class="share-option" href="https://wa.me/?text=${encodedText}" target="_blank" rel="noopener">
      <span class="share-icon">💬</span> ${t('share_whatsapp') || 'WhatsApp'}
    </a>
    <a class="share-option" href="https://twitter.com/intent/tweet?text=${encodedText}" target="_blank" rel="noopener">
      <span class="share-icon">🐦</span> ${t('share_twitter') || 'Twitter'}
    </a>
    <a class="share-option" href="https://www.facebook.com/sharer/sharer.php?u=${pageUrl}&quote=${encodedText}" target="_blank" rel="noopener">
      <span class="share-icon">📘</span> ${t('share_facebook') || 'Facebook'}
    </a>
    <button class="share-option" id="shareCopyBtn">
      <span class="share-icon">🔗</span> ${t('share_copy') || 'Copy Link'}
    </button>
  `;

  // Position below anchor button
  const rect = anchor.getBoundingClientRect();
  menu.style.top  = (rect.bottom + window.scrollY + 8) + 'px';
  menu.style.left = (rect.left   + window.scrollX)     + 'px';

  document.body.appendChild(menu);

  // Copy button
  menu.querySelector('#shareCopyBtn').onclick = () => {
    navigator.clipboard.writeText(shareText).then(() => {
      showToast(t('share_copied') || 'Copied!', 'success');
      menu.remove();
    }).catch(() => {
      showToast('Could not copy to clipboard.', 'error');
    });
  };

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', function closeMenu(e) {
      if (!menu.contains(e.target) && e.target !== anchor) {
        menu.remove();
        document.removeEventListener('click', closeMenu);
      }
    });
  }, 10);
}

/* ── AUTO-STOP SPEECH ON PAGE NAVIGATE ──────────────────── */
const _origNavigateAudio = window.navigate;
window.navigate = function(page) {
  stopSpeech();
  // Remove share menu and action bar on navigate
  document.getElementById('shareMenu')?.remove();
  if (typeof _origNavigateAudio === 'function') _origNavigateAudio(page);
};