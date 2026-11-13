import { createAgentClient, resolveAgentUrl } from './agent-client.js';
import { mountInspector } from './inspector.js';

export function mountChat() {
  const messages = document.querySelector('#chat-messages');
  const empty = document.querySelector('#chat-empty');
  const typing = document.querySelector('#chat-typing');
  const status = document.querySelector('#chat-status');
  const form = document.querySelector('#chat-form');
  const input = document.querySelector('#chat-input');
  const send = document.querySelector('#chat-send');
  const error = document.querySelector('#chat-error');
  let client;
  let disposeInspector = () => {};
  let ready = false;
  let lastDate;
  let unloading = false;
  let followLatest = true;
  messages.addEventListener('scroll', () => {
    followLatest = messages.scrollHeight - messages.clientHeight - messages.scrollTop < 48;
  });
  const resizeObserver = new ResizeObserver(() => {
    if (followLatest) messages.scrollTop = messages.scrollHeight;
  });
  resizeObserver.observe(messages);

  function setStatus(state) {
    status.textContent = { idle: '未接入', connecting: '连接中', online: '在线', offline: '离线' }[state];
    status.dataset.state = state;
    ready = state === 'online';
    if (!ready) setTyping(false);
    else error.hidden = true;
    updateComposer();
  }

  function updateComposer() {
    send.disabled = !ready || !input.value.trim();
  }

  function setTyping(active) {
    typing.hidden = !active;
    if (active) {
      empty.hidden = true;
      messages.scrollTop = messages.scrollHeight;
    }
  }

  function appendMessage({ role, text: body, ts: timestamp }) {
    empty.hidden = true;
    const mine = role === 'user';
    const time = timestamp ? new Date(timestamp) : new Date();
    const validTime = !Number.isNaN(time.getTime());
    const date = validTime ? time.toLocaleDateString('zh-CN') : '';
    if (date && date !== lastDate) {
      const divider = document.createElement('div');
      divider.className = 'history-divider';
      divider.textContent = date;
      messages.insertBefore(divider, typing);
      lastDate = date;
    }
    const row = document.createElement('div');
    row.className = `chat-message ${mine ? 'mine' : 'theirs'}`;
    const avatar = document.createElement('span');
    avatar.className = mine ? 'user-avatar' : 'portrait message-avatar';
    if (mine) {
      avatar.textContent = '你';
      avatar.setAttribute('aria-hidden', 'true');
    } else {
      const image = document.createElement('img');
      image.src = '/images/dania.png';
      image.alt = '达妮娅';
      image.draggable = false;
      avatar.append(image);
    }
    const content = document.createElement('div');
    content.className = 'message-content';
    const byline = document.createElement('div');
    byline.className = 'chat-byline';
    byline.textContent = mine ? '你' : '达妮娅';
    if (validTime) {
      const label = document.createElement('time');
      label.dateTime = time.toISOString();
      label.textContent = time.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      byline.append(label);
    }
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    bubble.textContent = body;
    content.append(byline, bubble);
    row.append(avatar, content);
    messages.insertBefore(row, typing);
    document.querySelector('#conversation-preview').textContent = body.replace(/\s+/g, ' ');
    messages.scrollTop = messages.scrollHeight;
  }

  function showError(text) {
    error.textContent = text;
    error.hidden = false;
  }

  async function connectAgent() {
    try {
      const response = await fetch('/agent-config.json', { cache: 'no-store' });
      if (!response.ok) throw new Error('无法加载聊天连接设置。');
      const config = await response.json();
      const url = resolveAgentUrl(config?.url, location.href);
      if (unloading) return;
      client = createAgentClient({ url, onStatus: setStatus, onMessage: appendMessage, onTyping: setTyping, onError: showError });
      client.start();
      if (!url) return;
      disposeInspector = mountInspector(url);
      const settingsUrl = new URL(url);
      settingsUrl.protocol = settingsUrl.protocol === 'wss:' ? 'https:' : 'http:';
      settingsUrl.pathname = '/settings/model';
      settingsUrl.search = '';
      const switcher = document.createElement('button');
      switcher.type = 'button';
      switcher.className = 'model-switch';
      switcher.textContent = '加载模型来源…';
      switcher.disabled = true;
      status.parentElement.append(switcher);
      let provider = 'local';
      const renderProvider = value => {
        provider = value.provider;
        switcher.textContent = provider === 'deepseek' ? 'DeepSeek API · 切换本地' : '本地模型 · 切换 API';
        switcher.setAttribute('aria-label', switcher.textContent);
        switcher.disabled = false;
      };
      switcher.addEventListener('click', async () => {
        switcher.disabled = true;
        try {
          const result = await fetch(settingsUrl, { method: 'POST', body: JSON.stringify({ provider: provider === 'local' ? 'deepseek' : 'local' }) });
          const value = await result.json();
          if (!result.ok) throw new Error(value.error || '切换失败。');
          renderProvider(value);
        } catch (failure) { showError(failure.message); switcher.disabled = false; }
      });
      try {
        const result = await fetch(settingsUrl);
        if (!result.ok) throw new Error();
        renderProvider(await result.json());
      } catch { switcher.textContent = '模型切换不可用'; }
    } catch {
      if (unloading) return;
      setStatus('offline');
      showError('聊天连接设置不可用，请检查后刷新页面。');
    }
  }

  input.addEventListener('input', () => {
    updateComposer();
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 112)}px`;
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const body = input.value.trim();
    if (!body || !client?.sendMessage(body)) return;
    error.hidden = true;
    input.value = '';
    input.style.height = 'auto';
    send.disabled = true;
  });

  setStatus('idle');
  connectAgent();
  function dispose() {
    if (unloading) return;
    unloading = true;
    resizeObserver.disconnect();
    client?.stop();
    disposeInspector();
  }
  window.addEventListener('beforeunload', dispose, { once: true });
  return dispose;
}
