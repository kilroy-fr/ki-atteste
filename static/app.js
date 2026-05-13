// ============================================================
// KI-Atteste – Chat Frontend
// ============================================================

const chatMessages = document.getElementById('chatMessages');
const chatWelcome  = document.getElementById('chatWelcome');
const userInput    = document.getElementById('userInput');
const sendBtn      = document.getElementById('sendBtn');
const fileInput    = document.getElementById('fileInput');
const attachedFilesEl = document.getElementById('attachedFiles');
const modelSelect  = document.getElementById('modelSelect');

// Conversation history: [{role: 'user'|'assistant', content: '...'}]
let conversationHistory = [];
// Datei-Einträge: [{file: File, ocrJobId: string|null, ocrStatus: 'none'|'pending'|'done'|'error', ocrText: string|null, pollInterval: number|null}]
let attachedFiles = [];
let isStreaming = false;
let currentAbortController = null;

// ============================================================
// CHAT PERSISTENZ (localStorage)
// ============================================================
const CHATS_KEY = 'ki_atteste_chats';
let currentChatId = null;

function newUUID() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function getChats() {
  try { return JSON.parse(localStorage.getItem(CHATS_KEY) || '[]'); }
  catch (_) { return []; }
}

function saveChats(chats) {
  try { localStorage.setItem(CHATS_KEY, JSON.stringify(chats)); }
  catch (_) {}
}

function saveCurrentChat(title) {
  if (!currentChatId || conversationHistory.length === 0) return;
  const chats = getChats();
  const idx = chats.findIndex(c => c.id === currentChatId);
  const now = Date.now();
  if (idx >= 0) {
    chats[idx].history = [...conversationHistory];
    chats[idx].updated = now;
    if (title) chats[idx].title = title;
  } else {
    chats.unshift({ id: currentChatId, title: title || 'Chat', created: now, updated: now, history: [...conversationHistory] });
    if (chats.length > 50) chats.length = 50;
  }
  chats.sort((a, b) => b.updated - a.updated);
  saveChats(chats);
  renderSidebar();
}

function deleteChat(id) {
  saveChats(getChats().filter(c => c.id !== id));
  if (currentChatId === id) startNewChat();
  else renderSidebar();
}

function startNewChat() {
  currentChatId = null;
  conversationHistory = [];
  attachedFiles.forEach(e => { if (e.pollInterval) clearInterval(e.pollInterval); });
  attachedFiles = [];
  renderAttachedFiles();
  chatMessages.innerHTML = '';
  if (chatWelcome) chatWelcome.style.display = '';
  renderSidebar();
  userInput.focus();
}

function loadChat(id) {
  const chat = getChats().find(c => c.id === id);
  if (!chat) return;
  currentChatId = id;
  conversationHistory = [...chat.history];
  chatMessages.innerHTML = '';
  if (chatWelcome) chatWelcome.style.display = 'none';
  for (const turn of conversationHistory) {
    if (turn.role === 'user') {
      appendUserMessage(turn.content, []);
    } else if (turn.role === 'assistant') {
      const bubble = appendAssistantMessage('', false);
      updateAssistantMessage(bubble, turn.content, false);
    }
  }
  renderSidebar();
  scrollToBottom();
}

function chatTitle(text, files) {
  const raw = (text || (files.length ? files[0].file.name : 'Chat')).trim().replace(/\s+/g, ' ');
  return raw.length > 45 ? raw.slice(0, 45) + '…' : raw;
}

function formatDate(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Heute';
  if (d.toDateString() === yesterday.toDateString()) return 'Gestern';
  return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'short' });
}

function renderSidebar() {
  const listEl = document.getElementById('chatHistoryList');
  if (!listEl) return;
  const chats = getChats();
  if (chats.length === 0) {
    listEl.innerHTML = '<div class="chat-history-empty">Noch keine gespeicherten Chats</div>';
    return;
  }
  listEl.innerHTML = chats.map(c => {
    const active = c.id === currentChatId ? ' active' : '';
    return `<div class="chat-item${active}" onclick="loadChat('${c.id}')">
      <div class="chat-item-body">
        <div class="chat-item-title">${escapeHtml(c.title)}</div>
        <div class="chat-item-date">${formatDate(c.updated)}</div>
      </div>
      <button class="chat-item-delete" onclick="event.stopPropagation();deleteChat('${c.id}')" title="Löschen">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
          <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
        </svg>
      </button>
    </div>`;
  }).join('');
}

document.getElementById('newChatBtn').addEventListener('click', startNewChat);

// ---- Modell-Selector laden ----
async function loadModels() {
  try {
    const res = await fetch('/api/models');
    const data = await res.json();
    modelSelect.innerHTML = '';
    if (!data.models || data.models.length === 0) {
      const opt = document.createElement('option');
      opt.value = 'qwen2.5:14b';
      opt.textContent = 'qwen2.5:14b';
      modelSelect.appendChild(opt);
      return;
    }
    data.models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      if (m === data.selected) opt.selected = true;
      modelSelect.appendChild(opt);
    });
  } catch (e) {
    console.error('Fehler beim Laden der Modelle:', e);
  }
}

modelSelect.addEventListener('change', async () => {
  const model = modelSelect.value;
  try {
    await fetch('/api/set_model', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({model})
    });
  } catch (e) {
    console.error('Fehler beim Setzen des Modells:', e);
  }
});

// ---- Datei-Anhänge ----
fileInput.addEventListener('change', () => {
  Array.from(fileInput.files).forEach(f => {
    if (attachedFiles.find(x => x.file.name === f.name)) return;
    const needsOcr = /\.(jpg|jpeg|pdf)$/i.test(f.name);
    const entry = {
      file: f,
      ocrJobId: null,
      ocrStatus: needsOcr ? 'pending' : 'none',
      ocrText: null,
      pollInterval: null,
    };
    attachedFiles.push(entry);
    if (needsOcr) startOcr(entry);
  });
  fileInput.value = '';
  renderAttachedFiles();
});

async function startOcr(entry) {
  try {
    const fd = new FormData();
    fd.append('file', entry.file);
    const res = await fetch('/api/ocr', {method: 'POST', body: fd});
    const data = await res.json();
    if (data.job_id) {
      entry.ocrJobId = data.job_id;
      entry.pollInterval = setInterval(() => pollOcr(entry), 1500);
    } else {
      entry.ocrStatus = 'error';
      entry.ocrText = '[OCR-Fehler]';
      renderAttachedFiles();
    }
  } catch (e) {
    entry.ocrStatus = 'error';
    entry.ocrText = '[OCR-Fehler]';
    renderAttachedFiles();
  }
}

async function pollOcr(entry) {
  try {
    const res = await fetch(`/api/ocr/${entry.ocrJobId}`);
    const data = await res.json();
    if (data.status === 'done') {
      clearInterval(entry.pollInterval);
      entry.pollInterval = null;
      entry.ocrStatus = 'done';
      entry.ocrText = data.text;
      renderAttachedFiles();
    } else if (data.status === 'error') {
      clearInterval(entry.pollInterval);
      entry.pollInterval = null;
      entry.ocrStatus = 'error';
      entry.ocrText = data.text || '[OCR-Fehler]';
      renderAttachedFiles();
    }
  } catch (_) {}
}

function renderAttachedFiles() {
  if (attachedFiles.length === 0) {
    attachedFilesEl.style.display = 'none';
    attachedFilesEl.innerHTML = '';
    return;
  }
  attachedFilesEl.style.display = 'flex';
  attachedFilesEl.innerHTML = attachedFiles.map((entry, i) => {
    const pending = entry.ocrStatus === 'pending';
    const icon = pending ? '<span class="chip-spinner"></span>' : '📎';
    return `<div class="file-chip${pending ? ' ocr-pending' : ''}">
      ${icon} ${escapeHtml(entry.file.name)}
      <button class="remove-file" onclick="removeFile(${i})" title="Entfernen">✕</button>
    </div>`;
  }).join('');
}

function removeFile(idx) {
  const entry = attachedFiles[idx];
  if (entry.pollInterval) clearInterval(entry.pollInterval);
  attachedFiles.splice(idx, 1);
  renderAttachedFiles();
}

// ---- Textarea auto-resize ----
userInput.addEventListener('input', () => {
  userInput.style.height = 'auto';
  userInput.style.height = Math.min(userInput.scrollHeight, 200) + 'px';
});

userInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!isStreaming) sendMessage();
  }
});

sendBtn.addEventListener('click', () => {
  if (isStreaming) {
    if (currentAbortController) currentAbortController.abort();
  } else {
    sendMessage();
  }
});

// ---- Beispiel-Buttons ----
function setExample(btn) {
  userInput.value = btn.textContent;
  userInput.dispatchEvent(new Event('input'));
  userInput.focus();
}

// ---- Nachricht senden ----
async function sendMessage() {
  const text = userInput.value.trim();
  if (!text && attachedFiles.length === 0) return;

  if (chatWelcome) chatWelcome.style.display = 'none';

  const files = [...attachedFiles];
  const isNewChat = currentChatId === null;
  if (isNewChat) currentChatId = newUUID();
  const newTitle = isNewChat ? chatTitle(text, files) : null;

  // Polling stoppen (Jobs laufen server-seitig weiter, aber wir brauchen sie nicht mehr)
  files.forEach(entry => {
    if (entry.pollInterval) clearInterval(entry.pollInterval);
  });

  userInput.value = '';
  userInput.style.height = 'auto';
  attachedFiles = [];
  renderAttachedFiles();

  appendUserMessage(text, files);
  conversationHistory.push({role: 'user', content: text || '[Dateien hochgeladen]'});

  const assistantBubble = appendAssistantMessage('', true);
  setSending(true);

  const formData = new FormData();
  formData.append('message', text);
  formData.append('history', JSON.stringify(conversationHistory.slice(0, -1)));

  // Vorextrahierte OCR-Texte separat schicken; Dateien ohne OCR direkt anhängen
  const preExtracted = {};
  files.forEach(entry => {
    if (entry.ocrText !== null) {
      preExtracted[entry.file.name] = entry.ocrText;
    } else {
      formData.append('files', entry.file);
    }
  });
  formData.append('pre_extracted_texts', JSON.stringify(preExtracted));

  let fullResponse = '';

  try {
    currentAbortController = new AbortController();
    const response = await fetch('/chat', {method: 'POST', body: formData, signal: currentAbortController.signal});

    if (!response.ok) {
      throw new Error(`Server-Fehler: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let started = false;

    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, {stream: true});

      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw) continue;
        try {
          const chunk = JSON.parse(raw);
          if (chunk.error) {
            updateAssistantMessage(assistantBubble, `⚠️ Fehler: ${chunk.error}`, false);
            break;
          }
          if (chunk.token) {
            if (!started) {
              started = true;
              const content = assistantBubble.querySelector('.message-content');
              if (content) content.innerHTML = '';
            }
            fullResponse += chunk.token;
            updateAssistantMessage(assistantBubble, fullResponse, true);
          }
          if (chunk.done) {
            updateAssistantMessage(assistantBubble, fullResponse, false);
          }
        } catch (_) {}
      }
    }

    updateAssistantMessage(assistantBubble, fullResponse, false);
    conversationHistory.push({role: 'assistant', content: fullResponse});
    saveCurrentChat(newTitle);

  } catch (err) {
    if (err.name === 'AbortError') {
      const partial = fullResponse || '*(Abgebrochen)*';
      updateAssistantMessage(assistantBubble, partial, false);
      conversationHistory.push({role: 'assistant', content: partial});
    } else {
      updateAssistantMessage(assistantBubble, `⚠️ Verbindungsfehler: ${err.message}`, false);
      conversationHistory.push({role: 'assistant', content: `Fehler: ${err.message}`});
    }
    saveCurrentChat(newTitle);
  } finally {
    currentAbortController = null;
    setSending(false);
    scrollToBottom();
  }
}

// ---- UI Hilfsfunktionen ----
function appendUserMessage(text, files) {
  const group = document.createElement('div');
  group.className = 'message-group';

  const bubble = document.createElement('div');
  bubble.className = 'message-user';

  const meta = document.createElement('div');
  meta.className = 'message-meta';
  meta.textContent = 'Sie · ' + formatTime();
  bubble.appendChild(meta);

  if (text) {
    const content = document.createElement('div');
    content.textContent = text;
    bubble.appendChild(content);
  }

  if (files.length > 0) {
    const filesDiv = document.createElement('div');
    filesDiv.className = 'message-files';
    files.forEach(entry => {
      const chip = document.createElement('span');
      chip.className = 'message-file-chip';
      chip.textContent = '📎 ' + entry.file.name;
      filesDiv.appendChild(chip);
    });
    bubble.appendChild(filesDiv);
  }

  group.appendChild(bubble);
  chatMessages.appendChild(group);
  scrollToBottom();
}

function appendAssistantMessage(text, isLoading) {
  const group = document.createElement('div');
  group.className = 'message-group';

  const bubble = document.createElement('div');
  bubble.className = 'message-assistant';

  const meta = document.createElement('div');
  meta.className = 'message-meta';
  const modelTag = document.createElement('span');
  modelTag.className = 'model-tag';
  modelTag.textContent = modelSelect.value || 'KI';
  meta.appendChild(modelTag);
  meta.appendChild(document.createTextNode(' · ' + formatTime()));
  bubble.appendChild(meta);

  const content = document.createElement('div');
  content.className = 'message-content';
  if (isLoading) {
    content.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
  } else if (text) {
    content.innerHTML = renderMarkdown(text);
  }
  bubble.appendChild(content);

  const copyBtn = document.createElement('button');
  copyBtn.className = 'copy-msg-btn';
  copyBtn.title = 'Kopieren';
  copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
  copyBtn.onclick = () => {
    const rawText = bubble.dataset.rawText || text;
    navigator.clipboard.writeText(rawText).then(() => {
      copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="15" height="15"><polyline points="20 6 9 17 4 12"/></svg>';
      copyBtn.classList.add('copied');
      setTimeout(() => {
        copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
        copyBtn.classList.remove('copied');
      }, 2000);
    });
  };
  bubble.appendChild(copyBtn);

  group.appendChild(bubble);
  chatMessages.appendChild(group);
  scrollToBottom();
  return bubble;
}

function updateAssistantMessage(bubble, text, streaming) {
  const content = bubble.querySelector('.message-content');
  if (!content) return;
  bubble.dataset.rawText = text;
  if (streaming) {
    content.classList.add('streaming-cursor');
    content.innerHTML = renderMarkdown(text);
  } else {
    content.classList.remove('streaming-cursor');
    content.innerHTML = renderMarkdown(text);
  }
  scrollToBottom();
}

function scrollToBottom() {
  const area = document.getElementById('chatArea');
  if (area) area.scrollTop = area.scrollHeight;
}

function setSending(on) {
  isStreaming = on;
  sendBtn.disabled = false;
  if (on) {
    sendBtn.classList.add('cancel-mode');
    sendBtn.title = 'Abbrechen';
    sendBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>';
  } else {
    sendBtn.classList.remove('cancel-mode');
    sendBtn.title = 'Senden (Enter)';
    sendBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>';
  }
}

function formatTime() {
  return new Date().toLocaleTimeString('de-DE', {hour: '2-digit', minute: '2-digit'});
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function renderMarkdown(text) {
  if (typeof marked === 'undefined') return escapeHtml(text).replace(/\n/g, '<br>');
  try {
    return marked.parse(text);
  } catch(_) {
    return escapeHtml(text).replace(/\n/g, '<br>');
  }
}

// ---- Init ----
loadModels();
renderSidebar();
userInput.focus();
