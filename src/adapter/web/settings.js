/** 浏览器界面设置：读取并保存字号、减少动效选项，保持原有存储键。 */
export function mountSettings() {
  const $ = selector => document.querySelector(selector);
  $('#settings-btn').addEventListener('click', () => $('#settings-dialog').showModal());
  let appearance = {};
  try { appearance = JSON.parse(localStorage.getItem('persona-chat-appearance') || '{}') || {}; } catch {}
  $('#reduce-motion').checked = Boolean(appearance.reduceMotion);
  $('#message-size').value = ['14', '16', '18'].includes(String(appearance.messageSize)) ? String(appearance.messageSize) : '14';
  function applyAppearance() {
    document.documentElement.classList.toggle('reduce-motion', $('#reduce-motion').checked);
    document.documentElement.style.setProperty('--message-size', `${$('#message-size').value}px`);
    try { localStorage.setItem('persona-chat-appearance', JSON.stringify({ reduceMotion: $('#reduce-motion').checked, messageSize: $('#message-size').value })); } catch {}
  }
  applyAppearance();
  $('#reduce-motion').addEventListener('change', applyAppearance);
  $('#message-size').addEventListener('change', applyAppearance);
}
