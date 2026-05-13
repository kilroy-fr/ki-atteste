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
  if (!isStreaming) sendMessage();
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
    const response = await fetch('/chat', {method: 'POST', body: formData});

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

  } catch (err) {
    updateAssistantMessage(assistantBubble, `⚠️ Verbindungsfehler: ${err.message}`, false);
    conversationHistory.push({role: 'assistant', content: `Fehler: ${err.message}`});
  } finally {
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
  copyBtn.textContent = 'Kopieren';
  copyBtn.onclick = () => {
    const rawText = bubble.dataset.rawText || text;
    navigator.clipboard.writeText(rawText).then(() => {
      copyBtn.textContent = 'Kopiert!';
      setTimeout(() => copyBtn.textContent = 'Kopieren', 2000);
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
  sendBtn.disabled = on;
  if (on) {
    sendBtn.innerHTML = '<div class="spinner" style="width:16px;height:16px;border-width:3px;"></div>';
  } else {
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
userInput.focus();
