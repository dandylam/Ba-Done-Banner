'use strict';
/* 客戶專區及管理後台共用功能 */
const BD = (() => {
  const cfg = window.BD_CONFIG || {};
  const ready = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && window.supabase);
  const sb = ready ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;
  const BUCKET = 'order-files';
  const MAX_SIZE = 50 * 1024 * 1024;
  const STATUS = {submitted: '已提交・待處理', proof_sent: '稿件待確認', revision: '要求修改中', confirmed: '稿件已確認', production: '製作中', completed: '已完成', cancelled: '已取消'};
  const PROOF_STATUS = {pending: '待確認', approved: '已確認', rejected: '要求修改', superseded: '已有新稿'};
  const PRODUCTS = ['噴畫貼紙+安裝', '車身廣告', '小巴廣告', 'Banner橫額噴畫', '亞加力招牌', '印刷', '其他'];

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : String(kid));
    }
    return el;
  }

  const orderNo = id => 'BD' + String(id).padStart(5, '0');
  const fmtDate = s => s ? new Date(s).toLocaleString('zh-HK', {dateStyle: 'medium', timeStyle: 'short'}) : '';
  const fmtDay = s => s ? new Date(s + 'T00:00').toLocaleDateString('zh-HK', {dateStyle: 'medium'}) : '';
  const fmtSize = n => n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round((n || 0) / 1024)) + 'KB';
  const isImage = name => /\.(jpe?g|png|webp|gif)$/i.test(name || '');
  const badge = (s, labels = STATUS) => h('span', {class: 'badge-status s-' + s}, labels[s] || s);

  function errText(err) {
    const m = (err && (err.message || err.error_description)) || String(err);
    if (/invalid login credentials/i.test(m)) return '電郵或密碼不正確。';
    if (/email not confirmed/i.test(m)) return '請先到電郵按確認連結，再登入。';
    if (/already registered/i.test(m)) return '此電郵已註冊，請直接登入。';
    if (/password should be at least/i.test(m)) return '密碼最少需要 8 個字元。';
    if (/rate limit|too many/i.test(m)) return '操作太頻繁，請稍後再試。';
    if (/exceeded the maximum allowed size|payload too large/i.test(m)) return '檔案太大（每個最多 50MB）。';
    if (/comment required/i.test(m)) return '請先填寫修改意見。';
    if (/proof not found or already answered/i.test(m)) return '此稿件已回覆或已有新稿，請重新整理頁面。';
    if (/failed to fetch|network/i.test(m)) return '網絡連線失敗，請檢查網絡後再試。';
    return '發生錯誤：' + m;
  }

  // 儲存路徑只用安全字元；原檔名另存於資料庫
  function storagePath(orderId, kind, file) {
    const ext = ((file.name || '').match(/\.[A-Za-z0-9]{1,8}$/) || [''])[0].toLowerCase();
    return orderId + '/' + kind + '/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext;
  }

  async function uploadFile(orderId, kind, file, extra) {
    const path = storagePath(orderId, kind, file);
    const up = await sb.storage.from(BUCKET).upload(path, file, {contentType: file.type || 'application/octet-stream'});
    if (up.error) throw up.error;
    const {data, error} = await sb.from('order_files')
      .insert({order_id: orderId, kind, path, file_name: file.name.slice(0, 255), size: file.size, ...extra})
      .select().single();
    if (error) { await sb.storage.from(BUCKET).remove([path]); throw error; }
    return data;
  }

  async function signedUrls(files) {
    if (!files.length) return {};
    const {data, error} = await sb.storage.from(BUCKET).createSignedUrls(files.map(f => f.path), 3600);
    if (error) throw error;
    return Object.fromEntries(data.filter(d => d.signedUrl).map(d => [d.path, d.signedUrl]));
  }

  const downloadUrl = (url, name) => url + '&download=' + encodeURIComponent(name);

  function fileList(files, urls, extra) {
    if (!files.length) return h('p', {class: 'muted'}, '暫未有檔案。');
    return h('ul', {class: 'files'}, files.map(f => {
      const url = urls[f.path];
      return h('li', null,
        h('div', null,
          url ? h('a', {href: downloadUrl(url, f.file_name), target: '_blank', rel: 'noopener'}, f.file_name) : h('b', null, f.file_name),
          h('small', null, [fmtSize(f.size), fmtDate(f.created_at), f.note].filter(Boolean).join(' · '))),
        extra ? extra(f) : null);
    }));
  }

  // 選擇檔案（多個），回傳 {el, files(), reset()}
  function filePicker({id, label, hint, accept, max = 10}) {
    let picked = [];
    const status = h('p', {class: 'status', role: 'status'});
    const list = h('ul', {class: 'picked'});
    const input = h('input', {id, type: 'file', multiple: max > 1, accept});
    function render() {
      list.replaceChildren(...picked.map((f, i) => h('li', null, h('span', null, f.name + '（' + fmtSize(f.size) + '）'),
        h('button', {type: 'button', class: 'linkish', onclick: () => { picked.splice(i, 1); render(); }}, '移除'))));
    }
    input.addEventListener('change', () => {
      const errors = [];
      for (const f of input.files) {
        if (f.size > MAX_SIZE) { errors.push(f.name + ' 超過 50MB'); continue; }
        if (picked.length >= max) { errors.push('最多 ' + max + ' 個檔案'); break; }
        if (!picked.some(p => p.name === f.name && p.size === f.size)) picked.push(f);
      }
      input.value = '';
      status.textContent = errors.join('；');
      status.className = 'status' + (errors.length ? ' error' : '');
      render();
    });
    const el = h('div', null, h('label', {class: 'upload', for: id}, label, h('span', null, hint), input), list, status);
    return {el, files: () => picked.slice(), reset() { picked = []; render(); status.textContent = ''; }};
  }

  async function uploadAll(orderId, kind, files, statusEl, extra) {
    for (let i = 0; i < files.length; i++) {
      statusEl.textContent = '上載中 ' + (i + 1) + ' / ' + files.length + '：' + files[i].name + ' …請勿關閉頁面';
      await uploadFile(orderId, kind, files[i], extra);
    }
  }

  function orderInfo(o) {
    const rows = [['製作類型', o.product_type], ['尺寸', o.size], ['數量', o.quantity], ['物料', o.material],
      ['需要安裝', o.install_needed ? '需要' : '不需要'], ['希望完成', fmtDay(o.due_date)], ['項目資料', o.details],
      ['聯絡人', [o.contact_name, o.company].filter(Boolean).join(' / ')], ['電話', o.phone], ['落單時間', fmtDate(o.created_at)]];
    return h('dl', {class: 'info'}, rows.filter(r => r[1] != null && r[1] !== '').map(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
  }

  const waLink = (phone, text) => 'https://wa.me/' + phone + '?text=' + encodeURIComponent(text);

  // 訂單對話：顯示訊息、發送、即時接收；回傳 cleanup 函數
  function mountChat(root, orderId, {isStaff}) {
    const seen = new Set();
    const log = h('div', {class: 'chat-log', role: 'log', 'aria-live': 'polite'});
    const input = h('textarea', {id: 'chat-input', rows: '2', maxlength: '2000', placeholder: isStaff ? '回覆客戶…' : '有問題？直接喺度問巴登…'});
    const status = h('p', {class: 'status', role: 'status'});
    const sendBtn = h('button', {class: 'btn small', type: 'submit'}, '發送');
    const empty = h('p', {class: 'muted chat-empty'}, isStaff ? '客戶未有留言。' : '有關此訂單嘅任何問題，都可以喺度留言，巴登職員會盡快回覆。');
    const markRead = () => { if (document.visibilityState === 'visible') sb.rpc('mark_messages_read', {p_order_id: orderId}); };
    function add(m) {
      if (seen.has(m.id)) return;
      seen.add(m.id);
      empty.remove();
      const mine = m.from_staff === isStaff;
      log.append(h('div', {class: 'msg' + (mine ? ' mine' : '')},
        h('small', null, (m.from_staff ? '巴登職員' : (isStaff ? '客戶' : '你')) + ' · ' + fmtDate(m.created_at)),
        h('p', null, m.body)));
      log.scrollTop = log.scrollHeight;
    }
    const form = h('form', {class: 'chat-form', onsubmit: async e => {
      e.preventDefault();
      const body = input.value.trim();
      if (!body) return;
      sendBtn.disabled = true;
      const {data, error} = await sb.from('order_messages').insert({order_id: orderId, body}).select().single();
      sendBtn.disabled = false;
      if (error) { status.className = 'status error'; status.textContent = errText(error); return; }
      status.textContent = '';
      input.value = '';
      add(data);
    }}, h('label', {for: 'chat-input', class: 'sr-only'}, '訊息'), input, sendBtn);
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) form.requestSubmit(); });
    root.replaceChildren(log, form, h('p', {class: 'hint'}, 'Ctrl / ⌘ + Enter 快速發送'), status);
    log.append(empty);
    sb.from('order_messages').select('*').eq('order_id', orderId).order('created_at').then(({data, error}) => {
      if (error) { status.className = 'status error'; status.textContent = errText(error); return; }
      data.forEach(add);
      markRead();
    });
    const channel = sb.channel('order-messages-' + orderId)
      .on('postgres_changes', {event: 'INSERT', schema: 'public', table: 'order_messages', filter: 'order_id=eq.' + orderId},
        payload => { add(payload.new); if (payload.new.from_staff !== isStaff) markRead(); })
      .subscribe();
    document.addEventListener('visibilitychange', markRead);
    return () => { sb.removeChannel(channel); document.removeEventListener('visibilitychange', markRead); };
  }

  // 未讀訊息數目（對方發出、未讀），回傳 {order_id: count}
  async function unreadCounts(isStaff) {
    const {data, error} = await sb.from('order_messages').select('order_id').is('read_at', null).eq('from_staff', !isStaff);
    if (error) return {};
    return data.reduce((acc, m) => { acc[m.order_id] = (acc[m.order_id] || 0) + 1; return acc; }, {});
  }

  // 登入／註冊／忘記密碼表格
  function mountAuth(root, {signup = true, title = '登入', intro} = {}) {
    let mode = 'login';
    const here = location.origin + location.pathname;
    const email = h('input', {id: 'auth-email', type: 'email', required: true, autocomplete: 'email', maxlength: '200'});
    const pw = h('input', {id: 'auth-pw', type: 'password', required: true, minlength: '8', autocomplete: 'current-password'});
    const pwField = h('div', {class: 'field'}, h('label', {for: 'auth-pw'}, '密碼'), pw);
    const heading = h('h2');
    const submit = h('button', {class: 'btn', type: 'submit'});
    const status = h('p', {class: 'status', role: 'status', 'aria-live': 'polite'});
    const switcher = h('p', {class: 'auth-switch'});
    const swap = (m, text) => h('button', {type: 'button', class: 'linkish', onclick: () => { mode = m; status.textContent = ''; render(); }}, text);
    function render() {
      heading.textContent = {login: title, signup: '建立客戶帳戶', reset: '忘記密碼'}[mode];
      submit.textContent = {login: '登入', signup: '註冊', reset: '寄出重設連結'}[mode];
      pwField.hidden = mode === 'reset';
      pw.required = mode !== 'reset';
      pw.autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
      switcher.replaceChildren(...(mode === 'login'
        ? [signup && swap('signup', '未有帳戶？立即註冊'), swap('reset', '忘記密碼')]
        : [swap('login', '返回登入')]).filter(Boolean));
    }
    const form = h('form', {class: 'card auth-card', onsubmit: async e => {
      e.preventDefault();
      submit.disabled = true;
      status.className = 'status';
      status.textContent = '處理中…';
      try {
        if (mode === 'login') {
          const {error} = await sb.auth.signInWithPassword({email: email.value.trim(), password: pw.value});
          if (error) throw error;
          status.textContent = '';
        } else if (mode === 'signup') {
          const {data, error} = await sb.auth.signUp({email: email.value.trim(), password: pw.value, options: {emailRedirectTo: here}});
          if (error) throw error;
          if (data.user && data.user.identities && !data.user.identities.length) throw new Error('already registered');
          if (!data.session) { status.className = 'status ok'; status.textContent = '已寄出確認電郵，請到郵箱按連結啟用帳戶，然後返回此頁登入。'; }
        } else {
          const {error} = await sb.auth.resetPasswordForEmail(email.value.trim(), {redirectTo: here});
          if (error) throw error;
          status.className = 'status ok';
          status.textContent = '如此電郵已註冊，你會收到重設密碼連結。';
        }
      } catch (err) {
        status.className = 'status error';
        status.textContent = errText(err);
      }
      submit.disabled = false;
    }}, heading, intro ? h('p', {class: 'muted'}, intro) : null,
      h('div', {class: 'field'}, h('label', {for: 'auth-email'}, '電郵'), email), pwField, submit, status, switcher);
    render();
    root.replaceChildren(form);
  }

  // 用戶由重設密碼電郵返回時，設定新密碼
  function mountRecovery(root, onDone) {
    const pw = h('input', {id: 'new-pw', type: 'password', required: true, minlength: '8', autocomplete: 'new-password'});
    const status = h('p', {class: 'status', role: 'status'});
    root.replaceChildren(h('form', {class: 'card auth-card', onsubmit: async e => {
      e.preventDefault();
      const {error} = await sb.auth.updateUser({password: pw.value});
      if (error) { status.className = 'status error'; status.textContent = errText(error); return; }
      onDone();
    }}, h('h2', null, '設定新密碼'), h('div', {class: 'field'}, h('label', {for: 'new-pw'}, '新密碼（最少 8 個字元）'), pw),
      h('button', {class: 'btn', type: 'submit'}, '儲存新密碼'), status));
  }

  return {cfg, ready, sb, STATUS, PROOF_STATUS, PRODUCTS, h, orderNo, fmtDate, fmtDay, fmtSize, isImage, badge, errText,
    uploadFile, uploadAll, signedUrls, downloadUrl, fileList, filePicker, orderInfo, waLink, mountChat, unreadCounts, mountAuth, mountRecovery};
})();
