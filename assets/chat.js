/* 網站即時對話（Tawk.to 免費）：喺 tawk.to → Administration → Chat Widget 複製 Direct Chat Link
   例如 https://tawk.to/chat/6512abc.../1hb2cde...，將兩段 ID 分別填入下面即啟用 */
(function () {
  const PROPERTY_ID = '';
  const WIDGET_ID = '';
  if (!PROPERTY_ID || !WIDGET_ID) return;
  document.documentElement.classList.add('has-live-chat');
  window.Tawk_API = window.Tawk_API || {};
  window.Tawk_LoadStart = new Date();
  const s = document.createElement('script');
  s.async = true;
  s.src = 'https://embed.tawk.to/' + PROPERTY_ID + '/' + WIDGET_ID;
  s.charset = 'UTF-8';
  s.setAttribute('crossorigin', '*');
  document.head.appendChild(s);
})();
