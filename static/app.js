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
    if (!attachedFiles.find(x => x.name === f.name)) {
      attachedFiles.push(f);
    }
  });
  fileInput.value = '';
  renderAttachedFiles();
});

function renderAttachedFiles() {
  if (attachedFiles.length === 0) {
    attachedFilesEl.style.display = 'none';
    attachedFilesEl.innerHTML = '';
    return;
  }
  attachedFilesEl.style.display = 'flex';
  attachedFilesEl.innerHTML = attachedFiles.map((f, i) =>
    `<div class="file-chip">
      📎 ${escapeHtml(f.name)}
      <button class="remove-file" onclick="removeFile(${i})" title="Entfernen">✕</button>
    </div>`
  ).join('');
}

function removeFile(idx) {
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

  // Welcome ausblenden
  if (chatWelcome) chatWelcome.style.display = 'none';

  // User-Nachricht anzeigen
  const files = [...attachedFiles];
  appendUserMessage(text, files);

  // Eingabe leeren
  userInput.value = '';
  userInput.style.height = 'auto';
  attachedFiles = [];
  renderAttachedFiles();

  // History speichern
  conversationHistory.push({role: 'user', content: text || '[Dateien hochgeladen]'});

  // Assistent-Bubble mit Typing-Indikator
  const assistantBubble = appendAssistantMessage('', true);
  setSending(true);

  // Form-Daten aufbauen
  const formData = new FormData();
  formData.append('message', text);
  formData.append('history', JSON.stringify(conversationHistory.slice(0, -1)));
  files.forEach(f => formData.append('files', f));

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
              // Typing-Indikator entfernen
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

    // Finale Darstellung
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
    files.forEach(f => {
      const chip = document.createElement('span');
      chip.className = 'message-file-chip';
      chip.textContent = '📎 ' + f.name;
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

  // Copy-Button
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
