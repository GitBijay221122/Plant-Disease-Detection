/* =============================================================
   chatbot.js — LeafScan AI Plant Assistant
   - Floating chat widget fixed bottom-right
   - Groq LLaMA via /chat Flask endpoint
   - Syncs with selected language
   - Context-aware: knows last analysis result
   ============================================================= */

window._chatMessages    = [];
window._chatContext     = null;   // set after each analysis
let _chatOpen           = false;
let _chatWaiting        = false;

/* ── Build the chat widget DOM ────────────────────────────── */
function initChatbot() {
  // FAB button
  const fab = document.createElement('button');
  fab.className = 'chat-fab';
  fab.id = 'chatFab';
  fab.innerHTML = `🌿<span class="chat-fab-badge" id="chatBadge"></span>`;
  fab.onclick = toggleChat;
  document.body.appendChild(fab);

  // Chat window
  const win = document.createElement('div');
  win.className = 'chat-window';
  win.id = 'chatWindow';
  win.innerHTML = `
    <div class="chat-header">
      <div class="chat-header-left">
        <div class="chat-header-icon">🌿</div>
        <div class="chat-header-info">
          <div class="chat-header-title" data-i18n="chat_title">Plant Assistant</div>
          <div class="chat-header-sub"   data-i18n="chat_subtitle">Ask me anything about plant health</div>
        </div>
      </div>
      <button class="chat-close-btn" onclick="toggleChat()">✕</button>
    </div>
    <div class="chat-messages" id="chatMessages">
      <div class="chat-msg bot">
        <div class="chat-msg-avatar">🌿</div>
        <div class="chat-bubble chat-greeting-msg">${t('chat_greeting')}</div>
      </div>
    </div>
    <div class="chat-input-area">
      <input class="chat-input" id="chatInput" type="text"
             placeholder="${t('chat_placeholder')}"
             data-i18n-ph="chat_placeholder"
             onkeydown="onChatKey(event)" />
      <button class="chat-send-btn" id="chatSendBtn" onclick="sendChatMessage()">➤</button>
    </div>`;
  document.body.appendChild(win);
}

function toggleChat() {
  _chatOpen = !_chatOpen;
  document.getElementById('chatWindow').classList.toggle('open', _chatOpen);
  if (_chatOpen) {
    hideChatBadge();
    document.getElementById('chatInput').focus();
    scrollChatToBottom();
  }
  // Swap icon
  document.getElementById('chatFab').innerHTML =
    (_chatOpen ? '✕' : '🌿') + '<span class="chat-fab-badge" id="chatBadge"></span>';
}

function onChatKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
}

async function sendChatMessage() {
  const input = document.getElementById('chatInput');
  const text  = (input.value || '').trim();
  if (!text || _chatWaiting) return;

  input.value = '';
  appendChatMsg('user', text);
  window._chatMessages.push({ role: 'user', content: text });

  showChatTyping();
  _chatWaiting = true;
  document.getElementById('chatSendBtn').disabled = true;

  try {
    const res = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: window._chatMessages,
        lang:     currentLang,
        context:  window._chatContext,
      }),
    });
    const data = await res.json();
    hideChatTyping();
    const reply = data.reply || data.error || 'Sorry, I could not respond right now.';
    appendChatMsg('bot', reply);
    window._chatMessages.push({ role: 'assistant', content: reply });
  } catch (e) {
    hideChatTyping();
    appendChatMsg('bot', '⚠️ Connection error. Please try again.');
  }

  _chatWaiting = false;
  document.getElementById('chatSendBtn').disabled = false;
  scrollChatToBottom();

  // Show badge if window is closed
  if (!_chatOpen) showChatBadge();
}

function appendChatMsg(role, text) {
  const msgs   = document.getElementById('chatMessages');
  const user   = JSON.parse(localStorage.getItem('leafscan_user') || '{}');
  const initials = (user.name || 'U').charAt(0).toUpperCase();

  const div = document.createElement('div');
  div.className = `chat-msg ${role}`;
  div.innerHTML = `
    <div class="chat-msg-avatar">${role === 'bot' ? '🌿' : initials}</div>
    <div class="chat-bubble">${escapeHTML(text)}</div>`;
  msgs.appendChild(div);
  scrollChatToBottom();
}

let _typingEl = null;
function showChatTyping() {
  const msgs = document.getElementById('chatMessages');
  _typingEl = document.createElement('div');
  _typingEl.className = 'chat-msg bot';
  _typingEl.id = 'chatTyping';
  _typingEl.innerHTML = `
    <div class="chat-msg-avatar">🌿</div>
    <div class="chat-bubble">
      <div class="chat-typing-dots">
        <span></span><span></span><span></span>
      </div>
    </div>`;
  msgs.appendChild(_typingEl);
  scrollChatToBottom();
}
function hideChatTyping() {
  const el = document.getElementById('chatTyping');
  if (el) el.remove();
}

function scrollChatToBottom() {
  const msgs = document.getElementById('chatMessages');
  if (msgs) setTimeout(() => { msgs.scrollTop = msgs.scrollHeight; }, 50);
}
function showChatBadge() {
  const b = document.getElementById('chatBadge');
  if (b) b.classList.add('show');
}
function hideChatBadge() {
  const b = document.getElementById('chatBadge');
  if (b) b.classList.remove('show');
}

/* Called from app.js after analysis completes */
function setChatContext(plant, disease, isHealthy, confidence) {
  window._chatContext = { plant, disease, isHealthy, confidence };
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/\n/g,'<br>');
}
