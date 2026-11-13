export function resolveAgentUrl(value, pageUrl) {
  if (typeof value !== 'string') throw new Error('聊天服务地址必须是字符串。');
  if (!value.trim()) return '';
  const url = new URL(value.trim(), pageUrl);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('聊天服务地址需要使用 ws 或 wss。');
  return url.href;
}

// The transport owns connection state and message identity; it has no DOM or agent-runtime dependency.
export function createAgentClient({ url, userName = '你', onStatus = () => {}, onMessage = () => {}, onTyping = () => {}, onError = () => {}, retryMs = 1000, maxRetryMs = 10000 }) {
  let socket;
  let retryTimer;
  let retryDelay = retryMs;
  let stopped = true;
  let online = false;
  let state = 'idle';
  const seenIds = new Set();
  const seenSnapshots = new Set();

  function setStatus(next) {
    state = next;
    online = next === 'online';
    if (!online) onTyping(false);
    onStatus(next);
  }

  function emitMessage(frame, history = false) {
    if (!frame || typeof frame !== 'object' || typeof frame.text !== 'string' || !frame.text.trim()) return;
    const role = frame.role ?? (typeof frame.from === 'string' ? (frame.from === userName ? 'user' : 'assistant') : undefined);
    if (role !== 'user' && role !== 'assistant') return;
    const id = typeof frame.id === 'string' && frame.id ? frame.id : undefined;
    const ts = typeof frame.ts === 'string' ? frame.ts : new Date().toISOString();
    const snapshot = JSON.stringify([role, frame.text, ts]);
    if (id ? seenIds.has(id) : history && seenSnapshots.has(snapshot)) return;
    if (id) seenIds.add(id);
    seenSnapshots.add(snapshot);
    if (role === 'assistant' && !history) onTyping(false);
    onMessage({ id, role, text: frame.text, ts, history });
  }

  function handleFrame(raw) {
    let frame;
    try { frame = JSON.parse(raw); } catch { return; }
    if (!frame || typeof frame !== 'object') return;
    switch (frame.type) {
      case 'msg':
        emitMessage(frame, frame.history === true);
        break;
      case 'history':
        if (Array.isArray(frame.messages)) frame.messages.forEach(message => emitMessage(message, true));
        break;
      case 'presence':
        if (typeof frame.online === 'boolean') setStatus(frame.online ? 'online' : 'offline');
        break;
      case 'typing':
        if (typeof frame.active === 'boolean') onTyping(online && frame.active);
        break;
      case 'error':
        if (typeof frame.text === 'string') {
          onTyping(false);
          onError(frame.text);
        }
        break;
    }
  }

  function scheduleRetry() {
    if (stopped) return;
    retryTimer = setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 1.7, maxRetryMs);
  }

  function connect() {
    if (stopped) return;
    setStatus('connecting');
    let current;
    try { current = new WebSocket(url); } catch {
      setStatus('offline');
      scheduleRetry();
      return;
    }
    socket = current;
    current.addEventListener('open', () => {
      if (stopped || socket !== current) return;
      retryDelay = retryMs;
      current.send(JSON.stringify({ type: 'hello', name: userName }));
      setStatus('online');
    });
    current.addEventListener('message', event => {
      if (!stopped && socket === current) handleFrame(event.data);
    });
    current.addEventListener('close', () => {
      if (stopped || socket !== current) return;
      socket = undefined;
      setStatus('offline');
      scheduleRetry();
    });
    current.addEventListener('error', () => {
      if (socket === current) current.close();
    });
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      if (url) connect();
      else setStatus('idle');
    },
    sendMessage(text) {
      const body = text.trim();
      if (!body || !online || socket?.readyState !== WebSocket.OPEN) return false;
      const id = crypto.randomUUID();
      try { socket.send(JSON.stringify({ type: 'msg', id, text: body })); } catch {
        onError('消息未能发送，请稍后重试。');
        return false;
      }
      emitMessage({ id, role: 'user', text: body });
      onTyping(true);
      return true;
    },
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      const current = socket;
      socket = undefined;
      current?.close();
      setStatus(url ? 'offline' : 'idle');
    },
    get status() { return state; },
  };
}
