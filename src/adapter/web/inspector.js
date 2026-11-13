export function mountInspector(agentUrl) {
  if (!agentUrl) return () => {};
  const endpoint = new URL(agentUrl);
  endpoint.protocol = endpoint.protocol === 'wss:' ? 'https:' : 'http:';
  endpoint.pathname = '/inspect'; endpoint.search = ''; endpoint.hash = '';
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'inspection-open'; button.textContent = '模型与记忆';
  document.querySelector('.top-actions').prepend(button);
  const dialog = document.createElement('dialog'); dialog.className = 'inspection-dialog';
  dialog.innerHTML = `<header><div><h2>模型与记忆</h2><p>完整请求内容 · 最近 20 次调用 · 输入记录从本次后端启动开始</p></div><div><button type="button" data-refresh>刷新</button><button type="button" data-close aria-label="关闭观察窗口">关闭</button></div></header><p class="inspection-status" role="status"></p><div class="inspection-grid"><section data-reply><h3>聊天回复 · 完整输入</h3><select aria-label="选择聊天模型调用"></select><div class="inspection-body"></div></section><section data-memory-input><h3>记忆整理 · 完整输入</h3><select aria-label="选择记忆整理调用"></select><div class="inspection-body"></div></section><section data-memory><h3>当前记忆库</h3><div class="inspection-body"></div></section></div>`;
  document.body.append(dialog);
  const status = dialog.querySelector('.inspection-status');
  const requestPanels = [
    { purpose: 'reply', root: dialog.querySelector('[data-reply]'), selected: '', signature: '' },
    { purpose: 'memory', root: dialog.querySelector('[data-memory-input]'), selected: '', signature: '' },
  ];
  let snapshot, timer, stopped = false, loading = false, memorySignature = '';
  const abort = new AbortController();
  const pre = text => { const node = document.createElement('pre'); node.textContent = text; return node; };
  const line = (tag, text) => { const node = document.createElement(tag); node.textContent = text; return node; };
  function renderRequest(panel) {
    const requests = snapshot.requests.filter(item => item.purpose === panel.purpose).toReversed();
    const select = panel.root.querySelector('select');
    const selection = select.value;
    if (selection && !panel.followLatest) panel.selected = selection;
    if (!requests.some(item => item.id === panel.selected) || panel.followLatest) panel.selected = requests[0]?.id ?? '';
    const optionsSignature = JSON.stringify(requests.map(item => [item.id, item.status]));
    if (panel.optionsSignature !== optionsSignature) {
      select.replaceChildren(...requests.map(item => {
        const option = document.createElement('option'); option.value = item.id;
        option.textContent = `${new Date(item.startedAt).toLocaleTimeString('zh-CN')} · ${item.payload.model} · ${{ running: '调用中', completed: '完成', failed: '失败' }[item.status]}`;
        return option;
      }));
      panel.optionsSignature = optionsSignature;
    }
    select.value = panel.selected; select.disabled = !requests.length;
    const request = requests.find(item => item.id === panel.selected);
    const signature = JSON.stringify(request);
    if (signature === panel.signature) return;
    panel.signature = signature;
    const body = panel.root.querySelector('.inspection-body'); body.replaceChildren();
    if (!request) { body.append(line('p', '暂无实际调用。发送一条消息后，这里会显示完整输入。')); return; }
    body.append(line('p', `模型：${request.payload.model} · ${new Date(request.startedAt).toLocaleString('zh-CN')}`));
    for (const [index, message] of request.payload.messages.entries()) {
      body.append(line('h4', `${index + 1}. ${message.role === 'system' ? '系统提示词（角色、记忆、参考资料）' : message.role === 'user' ? '用户消息' : '历史助手消息'}`), pre(message.content));
    }
    const raw = document.createElement('details'); raw.append(line('summary', '查看完整请求 JSON'), pre(JSON.stringify(request.payload, null, 2))); body.append(raw);
    if (request.response !== undefined) {
      const output = document.createElement('details'); output.append(line('summary', '查看本次模型输出'), pre(request.response)); body.append(output);
    }
  }
  function renderMemory(memory) {
    const signature = JSON.stringify(memory);
    if (signature === memorySignature) return;
    memorySignature = signature;
    const body = dialog.querySelector('[data-memory] .inspection-body'); body.replaceChildren();
    const state = memory.state === 'processing' ? '正在整理记忆…' : memory.state === 'failed' ? '整理失败，等待后续重试' : memory.pendingMessages ? '有消息等待整理' : '记忆整理已完成';
    body.append(line('p', state), line('p', `有效记忆 ${memory.entries.length} 条 · 已整理至第 ${memory.checkpoint} 条消息 / 共 ${memory.lastSequence} 条`));
    if (memory.updatedAt) body.append(line('p', `最近整理：${new Date(memory.updatedAt).toLocaleString('zh-CN')}，本批新增／修正 ${memory.lastChanges.length} 条`));
    const changed = new Set(memory.lastChanges.map(item => item.id));
    const sources = new Map(memory.sources.map(item => [JSON.stringify([item.conversationId, item.id]), item]));
    if (!memory.entries.length) body.append(line('p', '暂无长期记忆。聊天记录仍会单独保存；只有值得保留的信息才会写入这里。'));
    for (const entry of memory.entries) {
      const card = document.createElement('article'); card.className = 'memory-entry';
      card.append(line('h4', `${{user_statement:'用户自述', interaction:'真实互动', inference:'模型推断'}[entry.kind]}${changed.has(entry.id) ? ' · 最近一批更新' : ''}`), line('p', entry.content), line('small', new Date(entry.createdAt).toLocaleString('zh-CN')));
      const details = document.createElement('details'); details.append(line('summary', '来源与修正关系'));
      details.append(line('p', `记忆 ID：${entry.id}`));
      if (entry.supersedes.length) details.append(line('p', `修正了：${entry.supersedes.join('、')}`));
      for (const ref of entry.sourceMessages) {
        const source = sources.get(JSON.stringify([ref.conversationId, ref.messageId]));
        details.append(line('p', `来源消息 ${ref.messageId}${source ? ` · ${source.role === 'user' ? '用户' : '助手'}` : ''}`));
        if (source) details.append(pre(source.text));
      }
      card.append(details); body.append(card);
    }
  }
  async function refresh() {
    if (stopped || loading || !dialog.open) return;
    loading = true;
    try {
      const response = await fetch(endpoint, { cache: 'no-store', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]) });
      if (!response.ok) throw new Error('观察接口暂不可用，请确认后端已更新并启动。');
      snapshot = await response.json();
      for (const panel of requestPanels) renderRequest(panel);
      renderMemory(snapshot.memory);
      status.textContent = `自动更新中 · ${new Date().toLocaleTimeString('zh-CN')}`;
    } catch (error) { if (!stopped) status.textContent = error.message; }
    finally { loading = false; }
  }
  for (const panel of requestPanels) {
    panel.followLatest = true;
    panel.root.querySelector('select').addEventListener('change', () => {
      panel.selected = panel.root.querySelector('select').value;
      panel.followLatest = panel.selected === snapshot.requests.filter(item => item.purpose === panel.purpose).at(-1)?.id;
      renderRequest(panel);
    });
  }
  button.addEventListener('click', () => { dialog.showModal(); void refresh(); timer = setInterval(refresh, 1500); });
  dialog.querySelector('[data-refresh]').addEventListener('click', () => void refresh());
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => clearInterval(timer));
  return () => { stopped = true; clearInterval(timer); abort.abort(); dialog.remove(); button.remove(); };
}
