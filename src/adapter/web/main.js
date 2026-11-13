import './style.css';
import { mountChat } from './chat.js';
import { mountSettings } from './settings.js';

const $ = selector => document.querySelector(selector);
const portrait = (className = '') => `<span class="portrait ${className}"><img src="/images/dania.png" alt="达妮娅" draggable="false"></span>`;
const icon = (name, size = 22) => {
  const paths = {
    chat: '<path d="M4 3h14l3 3v11H9l-5 4V3Z"/><path d="M8 7h9M8 11h6"/><circle cx="16" cy="14" r="1"/>',
    settings: '<path d="m9 3-1 3-3 1-2 5 2 5 3 1 1 3h6l1-3 3-1 2-5-2-5-3-1-1-3H9Z"/><circle cx="12" cy="12" r="4"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 4v.1"/>',
    expand: '<path d="M9 9 3 3m0 5V3h5m7 6 6-6m-5 0h5v5M9 15l-6 6m0-5v5h5m7-6 6 6m-5 0h5v-5"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    send: '<path d="m3 4 19 8-19 8 4-8-4-8Z"/><path d="M7 12h15"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="m7 12 3 3 7-7"/>',
    power: '<path d="M12 2v9m-5-6a9 9 0 1 0 10 0"/>',
    back: '<path d="m14 5-7 7 7 7"/>',
  };
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
};

document.querySelector('#app').innerHTML = `
  <div class="night-landscape" aria-hidden="true"><div class="night-moon"></div><div class="mountain mountain-far"></div><div class="mountain mountain-near"></div><div class="valley-lights"></div></div>
  <div class="site-shell">
    <header class="topbar">
      <div class="brand">${icon('chat', 31)}<span class="brand-dot">·</span><h1>飞讯</h1><span class="brand-subtitle">FLYING MESSAGE</span></div>
      <div class="top-actions">
        <button id="settings-btn" class="top-action" type="button" aria-label="界面设置" title="界面设置">${icon('settings', 27)}</button>
        <button id="help-btn" class="top-action" type="button" aria-label="使用说明" title="使用说明">${icon('help', 27)}</button>
        <button id="fullscreen-btn" class="top-action fullscreen-action" type="button" aria-label="进入全屏" title="进入全屏">${icon('expand', 30)}</button>
        <button id="shutdown-btn" class="top-action" type="button" hidden aria-label="关闭飞讯" title="关闭飞讯">${icon('power', 25)}</button>
      </div>
    </header>
    <main class="communication-window">
      <aside class="contact-sidebar" aria-label="联系人">
        <div class="sidebar-caption"><span>联系人</span><span>CONTACTS / 01</span></div>
        <nav class="contact-list" aria-label="选择联系人">
          <button class="contact-card selected" id="contact-dania" type="button" aria-current="page">${portrait()}<span class="contact-divider"></span><span class="contact-copy"><strong>达妮娅</strong><small>DANIA · PRIVATE CHANNEL</small></span><span class="contact-spark">✦</span></button>
          <div class="conversation-list">
            <button id="conversation-btn" class="conversation-card active" type="button">${icon('check', 23)}<span class="conversation-divider"></span><span id="conversation-preview">和达妮娅聊聊天</span><span class="conversation-tip"></span></button>
            <button id="latest-btn" class="conversation-card" type="button">${icon('chat', 21)}<span class="conversation-divider"></span><span>回到最新消息</span></button>
          </div>
        </nav>
        <div class="sidebar-bottom"><span class="sidebar-seal">✧</span><div><span>飞讯 · 私人对话</span><small>EVERY MESSAGE, A LITTLE CLOSER.</small></div><span class="sidebar-orbit" aria-hidden="true"></span></div>
      </aside>
      <div class="content-panel">
        <section id="chat-panel" class="chat-panel" aria-label="与达妮娅对话">
          <header class="panel-head chat-head"><button class="mobile-back" type="button" aria-label="返回联系人">${icon('back')}</button><div class="panel-heading"><h2>达妮娅</h2><span>PRIVATE CHANNEL <i></i> 01</span></div><span id="chat-status" class="chat-status" role="status" data-state="idle">未接入</span></header>
          <div id="chat-messages" class="chat-messages" role="log" aria-live="polite" aria-label="对话记录">
            <div id="chat-empty" class="chat-empty">${portrait('empty-portrait')}<h3>达妮娅</h3><p>有什么想和我说的吗？</p><div class="empty-rule"><span></span>✦<span></span></div></div>
            <div id="chat-typing" class="chat-message theirs chat-typing" role="status" hidden>${portrait('message-avatar')}<div class="message-content"><div class="chat-byline">达妮娅</div><div class="chat-bubble"><span class="chat-typing-dots" aria-hidden="true"><i></i><i></i><i></i></span><span>正在输入…</span></div></div></div>
          </div>
          <div class="composer-area"><div class="chat-endmark" aria-hidden="true"><span></span><b>✧</b><span></span></div><form id="chat-form" class="chat-compose"><span class="compose-mark" aria-hidden="true">${icon('chat', 20)}</span><textarea id="chat-input" rows="1" maxlength="4000" aria-label="输入要对达妮娅说的话" placeholder="和达妮娅说点什么…"></textarea><button id="chat-send" type="submit" disabled><span>发送</span>${icon('send', 18)}</button></form><p id="chat-error" class="chat-error" role="alert" hidden></p><div class="chat-caption"><span>ENTER 发送 <i>·</i> SHIFT + ENTER 换行</span><span>飞讯 <i>·</i> 私人对话</span></div></div>
        </section>
      </div>
    </main>
    <footer class="site-footer"><span><i></i> 飞讯</span><span>愿每一句话，都有人听见。</span><span>FLYING MESSAGE / 2026</span></footer>
  </div>
  <dialog id="settings-dialog" class="ui-dialog"><form method="dialog"><header><h2>界面设置</h2><button class="dialog-close" aria-label="关闭设置">${icon('close')}</button></header><label class="setting-row"><span>减少界面动效</span><input id="reduce-motion" type="checkbox"></label><label class="setting-row"><span>消息字号</span><select id="message-size" aria-label="消息字号"><option value="14">标准</option><option value="16">大</option><option value="18">更大</option></select></label><button class="dialog-done">完成</button></form></dialog>
  <dialog id="help-dialog" class="ui-dialog"><form method="dialog"><header><h2>使用说明</h2><button class="dialog-close" aria-label="关闭说明">${icon('close')}</button></header><p>在「达妮娅」中输入消息，按 Enter 发送，Shift + Enter 换行。</p><p>顶栏设置可以调整消息字号和界面动效。对话断线后会自动重连。</p><p class="help-connection">「未接入」表示尚未连接聊天服务。连接后即可发送消息。</p><button class="dialog-done">知道了</button></form></dialog>
  <div id="shutdown-screen" class="shutdown-screen" role="status" hidden><div class="shutdown-card"><span>✧</span><h2>飞讯已关闭</h2><p>再次开启时，双击项目里的「启动飞讯.command」。</p></div></div>`;

const disposeChat = mountChat();

function openChat() {
  document.querySelector('.communication-window').classList.add('show-content');
  $('#chat-messages').scrollTop = $('#chat-messages').scrollHeight;
}
$('#contact-dania').addEventListener('click', openChat);
$('#conversation-btn').addEventListener('click', openChat);
$('#latest-btn').addEventListener('click', openChat);
$('.mobile-back').addEventListener('click', () => {
  document.querySelector('.communication-window').classList.remove('show-content');
});

$('#help-btn').addEventListener('click', () => $('#help-dialog').showModal());
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); }));
mountSettings();
$('#fullscreen-btn').hidden = !document.fullscreenEnabled;
$('#fullscreen-btn').addEventListener('click', async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch {}
});
document.addEventListener('fullscreenchange', () => {
  const label = document.fullscreenElement ? '退出全屏' : '进入全屏';
  $('#fullscreen-btn').setAttribute('aria-label', label);
  $('#fullscreen-btn').title = label;
});
fetch('/__local/status', { cache: 'no-store' })
  .then(async response => { if (response.ok && (await response.json()).local === true) $('#shutdown-btn').hidden = false; })
  .catch(() => {});
$('#shutdown-btn').addEventListener('click', async () => {
  const button = $('#shutdown-btn');
  button.disabled = true;
  try {
    const response = await fetch('/__local/shutdown', { method: 'POST' });
    if (!response.ok) throw new Error('shutdown failed');
    disposeChat();
    $('#shutdown-screen').hidden = false;
  } catch { button.disabled = false; button.title = '重试关闭'; }
});
