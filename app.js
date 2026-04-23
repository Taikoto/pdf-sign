// ========== 配置 PDF.js Worker ==========
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ========== 全局状态 ==========
const state = {
  pdfDoc: null,
  pdfBytes: null,        // 原始 PDF 二进制
  currentPage: 1,
  totalPages: 0,
  scale: 1.5,
  signatures: [],        // { id, dataUrl, page, x, y, w, h }
  signIdCounter: 0,
  activeSignId: null,
  currentTab: 'draw',
};

// ========== API 封装 ==========
const API_BASE = ''; // 同源，Flask serve 静态文件

class API {
  token() { return localStorage.getItem('sig_token'); }
  auth() { return { Authorization: 'Bearer ' + this.token() }; }
  async req(method, path, body, noAuth = false) {
    const opts = { method, headers: {} };
    if (body && !(body instanceof FormData)) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    } else if (body) { opts.body = body; }
    if (!noAuth) opts.headers = { ...opts.headers, ...this.auth() };
    const r = await fetch(API_BASE + path, opts);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || '请求失败');
    return j;
  }
  register(u, p) { return this.req('POST', '/api/register', { username: u, password: p }, true); }
  login(u, p)     { return this.req('POST', '/api/login',     { username: u, password: p }, true); }
  me()            { return this.req('GET',  '/api/me'); }
  getSigs()       { return this.req('GET',  '/api/signatures'); }
  saveSig(data)   { return this.req('POST', '/api/signatures', data); }
  delSig(id)      { return this.req('DELETE', `/api/signatures/${id}`); }
  renameSig(id, n){ return this.req('PUT',  `/api/signatures/${id}`, { name: n }); }
  getTemplates()   { return this.req('GET',  '/api/templates'); }
  saveTemplate(data) { return this.req('POST', '/api/templates', data); }
  delTemplate(id) { return this.req('DELETE', `/api/templates/${id}`); }
  getRecords()    { return this.req('GET',  '/api/records'); }
  saveRecord(data){ return this.req('POST', '/api/records', data); }
}
const api = new API();

// ========== Session 管理 ==========
let currentUser = null;

function getSession() {
  const token = localStorage.getItem('sig_token');
  const name  = localStorage.getItem('sig_username');
  return token ? { token, username: name } : null;
}

function saveSession(token, username) {
  localStorage.setItem('sig_token', token);
  localStorage.setItem('sig_username', username);
  currentUser = { token, username };
}

function clearSession() {
  localStorage.removeItem('sig_token');
  localStorage.removeItem('sig_username');
  currentUser = null;
}

function updateAuthUI() {
  const sess = getSession();
  $('auth-guest').classList.toggle('hidden', !!sess);
  $('auth-user').classList.toggle('hidden', !sess);
  if (sess) {
    $('user-display-name').textContent = sess.username;
    loadSavedSignatures();
    loadSignRecords();
  } else {
    $('saved-sigs-list').innerHTML = '';
    $('sign-records-list').innerHTML = '<div class="record-empty">登录后查看记录</div>';
    closeUserDropdown();
  }
}

// ========== Auth Modal ==========
function openAuthModal(tab = 'login') {
  $('auth-modal').classList.remove('hidden');
  switchAuthTab(tab);
  $('login-error').classList.add('hidden');
  $('reg-error').classList.add('hidden');
}

function closeAuthModal() {
  $('auth-modal').classList.add('hidden');
}

function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.authTab === tab);
  });
  $('auth-form-login').classList.toggle('hidden', tab !== 'login');
  $('auth-form-register').classList.toggle('hidden', tab !== 'register');
}

async function doLogin() {
  const u = $('login-username').value.trim();
  const p = $('login-password').value;
  if (!u || !p) { showLoginErr('请输入用户名和密码'); return; }
  try {
    const res = await api.login(u, p);
    saveSession(res.token, res.username);
    closeAuthModal();
    updateAuthUI();
    showToast(`欢迎，${res.username}！`);
  } catch(e) {
    showLoginErr(e.message);
  }
}

async function doRegister() {
  const u = $('reg-username').value.trim();
  const p = $('reg-password').value;
  const p2 = $('reg-password2').value;
  if (!u || !p) { showRegErr('请填写完整信息'); return; }
  if (p !== p2) { showRegErr('两次密码不一致'); return; }
  if (p.length < 6) { showRegErr('密码至少 6 位'); return; }
  if (u.length < 2) { showRegErr('用户名至少 2 个字符'); return; }
  try {
    const res = await api.register(u, p);
    saveSession(res.token, res.username);
    closeAuthModal();
    updateAuthUI();
    showToast(`注册成功，欢迎 ${res.username}！`);
  } catch(e) {
    showRegErr(e.message);
  }
}

function showLoginErr(msg) {
  const el = $('login-error');
  el.textContent = msg; el.classList.remove('hidden');
}
function showRegErr(msg) {
  const el = $('reg-error');
  el.textContent = msg; el.classList.remove('hidden');
}

// ========== User Dropdown ==========
function toggleUserDropdown() {
  $('user-dropdown').classList.toggle('open');
}
function closeUserDropdown() {
  $('user-dropdown').classList.remove('open');
}

function logout() {
  clearSession();
  updateAuthUI();
  showToast('已退出登录');
}

// ========== Saved Signatures ==========
async function loadSavedSignatures() {
  const list = $('saved-sigs-list');
  list.innerHTML = '<div class="saved-sigs-empty">加载中…</div>';
  try {
    const sigs = await api.getSigs();
    if (!sigs.length) {
      list.innerHTML = '<div class="saved-sigs-empty">暂无保存的签名</div>';
      return;
    }
    list.innerHTML = sigs.map(s => `
      <div class="saved-sig-item" data-id="${s.id}" data-content="${encodeURIComponent(s.content)}" data-type="${s.sig_type}" data-color="${s.color || ''}" data-extra="${encodeURIComponent(s.extra || '')}">
        <img class="saved-sig-thumb" src="${s.content}" alt="${s.name}" />
        <div class="saved-sig-info">
          <div class="saved-sig-name">${s.name}</div>
          <div class="saved-sig-type">${typeLabel(s.sig_type)} · ${formatDate(s.created_at)}</div>
        </div>
        <button class="saved-sig-del" data-id="${s.id}" title="删除">
          <svg viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    `).join('');

    // 点击签名 → 添加到当前页
    list.querySelectorAll('.saved-sig-item').forEach(el => {
      el.addEventListener('click', e => {
        if (e.target.closest('.saved-sig-del')) return;
        const { id, content, type, color, extra } = el.dataset;
        const dataUrl = decodeURIComponent(content);
        closeUserDropdown();
        addSignatureToPage(dataUrl, decodeURIComponent(extra || '{}'));
        showToast('签名已添加到页面');
      });
    });

    // 删除签名
    list.querySelectorAll('.saved-sig-del').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        if (!confirm('确认删除该签名？')) return;
        try {
          await api.delSig(btn.dataset.id);
          btn.closest('.saved-sig-item').remove();
          showToast('已删除');
          if (!$('saved-sigs-list').children.length) {
            $('saved-sigs-list').innerHTML = '<div class="saved-sigs-empty">暂无保存的签名</div>';
          }
        } catch(err) { showToast(err.message, 'error'); }
      });
    });
  } catch(e) {
    list.innerHTML = '<div class="saved-sigs-empty">加载失败</div>';
  }
}

function typeLabel(type) {
  return { draw: '手写', text: '文字', date: '日期' }[type] || type;
}

function formatDate(ts) {
  const d = new Date(ts * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ========== 初始化 Auth 事件 ==========
function initAuth() {
  $('btn-login').addEventListener('click', () => openAuthModal('login'));
  $('btn-register').addEventListener('click', () => openAuthModal('register'));
  $('btn-do-login').addEventListener('click', doLogin);
  $('btn-do-register').addEventListener('click', doRegister);
  $('auth-backdrop').addEventListener('click', closeAuthModal);
  document.querySelectorAll('.auth-tab').forEach(t => {
    t.addEventListener('click', () => switchAuthTab(t.dataset.authTab));
  });
  $('btn-user-menu').addEventListener('click', e => {
    e.stopPropagation();
    toggleUserDropdown();
  });
  $('btn-logout').addEventListener('click', logout);
  document.addEventListener('click', e => {
    if (!e.target.closest('#user-menu')) closeUserDropdown();
  });
  // 回车登录
  $('login-password').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  $('reg-password2').addEventListener('keydown', e => { if (e.key === 'Enter') doRegister(); });
}

// ========== DOM 引用 ==========
const $ = id => document.getElementById(id);
const uploadArea    = $('upload-area');
const workspace     = $('workspace');
const sidebar       = document.querySelector('.sidebar');
const pdfInput      = $('pdf-input');
const pdfCanvas     = $('pdf-canvas');
const signOverlay   = $('sign-overlay');
const signModal     = $('sign-modal');
const signCanvas    = $('sign-canvas');
const signCtxMenu   = $('sign-context-menu');
const toast         = $('toast');

// ========== Toast 通知 ==========
let toastTimer;
function showToast(msg, type = '') {
  clearTimeout(toastTimer);
  toast.textContent = msg;
  toast.className = 'toast' + (type ? ' ' + type : '');
  toast.classList.remove('hidden');
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 2800);
}

// ========== 上传 / 拖拽 ==========
pdfInput.addEventListener('change', e => { if (e.target.files[0]) loadPDF(e.target.files[0]); });

uploadArea.addEventListener('dragover', e => { e.preventDefault(); uploadArea.querySelector('.upload-card').classList.add('drag-over'); });
uploadArea.addEventListener('dragleave', () => uploadArea.querySelector('.upload-card').classList.remove('drag-over'));
uploadArea.addEventListener('drop', e => {
  e.preventDefault();
  uploadArea.querySelector('.upload-card').classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.type === 'application/pdf') loadPDF(file);
  else showToast('请上传 PDF 格式文件', 'error');
});

async function loadPDF(file) {
  showLoading(true);
  try {
    const buf = await file.arrayBuffer();
    state.pdfBytes = new Uint8Array(buf);
    state.pdfDoc = await pdfjsLib.getDocument({ data: state.pdfBytes.slice() }).promise;
    state.totalPages = state.pdfDoc.numPages;
    state.currentPage = 1;
    state.signatures = [];

    $('doc-name').textContent = file.name;
    $('doc-pages').textContent = state.totalPages + ' 页';
    $('page-total').textContent = '共 ' + state.totalPages + ' 页';
    $('page-input').max = state.totalPages;

    uploadArea.classList.add('hidden');
    workspace.classList.remove('hidden');
    $('btn-add-sign').disabled = false;
    $('btn-export').disabled = false;

    await renderPage(state.currentPage);
    updateSignList();
    updateMobileToolbar();
  } catch (err) {
    showToast('PDF 加载失败，请检查文件', 'error');
    console.error(err);
  } finally {
    showLoading(false);
  }
}

// ========== 渲染 PDF 页面 ==========
async function renderPage(pageNum) {
  if (!state.pdfDoc) return;
  showLoading(true);
  try {
    const page = await state.pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: state.scale });
    pdfCanvas.width = viewport.width;
    pdfCanvas.height = viewport.height;
    const ctx = pdfCanvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;

    // 同步 overlay 尺寸
    signOverlay.style.width  = viewport.width  + 'px';
    signOverlay.style.height = viewport.height + 'px';

    $('page-input').value = pageNum;
    refreshSignOverlay();
  } catch (err) {
    console.error(err);
  } finally {
    showLoading(false);
  }
}

// ========== 页面导航 ==========
$('btn-prev').addEventListener('click', () => goPage(state.currentPage - 1));
$('btn-next').addEventListener('click', () => goPage(state.currentPage + 1));
$('page-input').addEventListener('change', e => goPage(parseInt(e.target.value)));

function goPage(n) {
  n = Math.max(1, Math.min(state.totalPages, n));
  if (n === state.currentPage) return;
  state.currentPage = n;
  renderPage(n);
  updateMobileToolbar();
}

// ========== 缩放 ==========
$('btn-zoom-in').addEventListener('click',  () => setScale(state.scale + 0.25));
$('btn-zoom-out').addEventListener('click', () => setScale(state.scale - 0.25));

function setScale(s) {
  s = Math.max(0.5, Math.min(3.0, s));
  state.scale = s;
  $('zoom-label').textContent = Math.round(s * 100) + '%';
  renderPage(state.currentPage);
}

// ========== 签名弹窗 ==========
$('btn-add-sign').addEventListener('click', openSignModal);
$('btn-modal-close').addEventListener('click', closeSignModal);
$('btn-cancel-sign').addEventListener('click', closeSignModal);
$('modal-backdrop').addEventListener('click', closeSignModal);
$('btn-confirm-sign').addEventListener('click', confirmSign);

// Tab 切换
document.querySelectorAll('.sign-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.sign-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    state.currentTab = tab.dataset.tab;
    $('tab-draw').classList.toggle('hidden', state.currentTab !== 'draw');
    $('tab-text').classList.toggle('hidden', state.currentTab !== 'text');
    $('tab-date').classList.toggle('hidden', state.currentTab !== 'date');
    $('tab-template').classList.toggle('hidden', state.currentTab !== 'template');
    if (state.currentTab === 'date') {
      // 若日期为空，自动填入今天
      if (!$('date-year').value) fillToday();
      updateDatePreview();
    }
    if (state.currentTab === 'template') {
      loadTemplates();
    }
  });
});

function openSignModal() {
  signModal.classList.remove('hidden');
  clearSignCanvas();
  saveDrawState(); // 初始空白状态
  // 横屏提示：2秒后自动淡出
  const hint = $('rotate-hint');
  hint.classList.remove('fade-out');
  setTimeout(() => hint.classList.add('fade-out'), 2500);
}
function closeSignModal() { signModal.classList.add('hidden'); }

// ========== 手写签名画布 ==========
let isDrawing = false;
let lastX = 0, lastY = 0;
const sCtx = signCanvas.getContext('2d');
let drawHistory = []; // 撤回历史栈
const MAX_HISTORY = 20;

sCtx.lineCap = 'round';
sCtx.lineJoin = 'round';

function saveDrawState() {
  drawHistory.push(sCtx.getImageData(0, 0, signCanvas.width, signCanvas.height));
  if (drawHistory.length > MAX_HISTORY) drawHistory.shift();
}

function undoDraw() {
  if (drawHistory.length <= 1) {
    sCtx.clearRect(0, 0, signCanvas.width, signCanvas.height);
    drawHistory = [];
    return;
  }
  drawHistory.pop();
  sCtx.putImageData(drawHistory[drawHistory.length - 1], 0, 0);
}

function getPos(e, canvas) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width  / rect.width;
  const scaleY = canvas.height / rect.height;
  if (e.touches) {
    return {
      x: (e.touches[0].clientX - rect.left) * scaleX,
      y: (e.touches[0].clientY - rect.top)  * scaleY,
    };
  }
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top)  * scaleY,
  };
}

signCanvas.addEventListener('mousedown',  startDraw);
signCanvas.addEventListener('mousemove',  draw);
signCanvas.addEventListener('mouseup',    endDraw);
signCanvas.addEventListener('mouseleave', endDraw);
signCanvas.addEventListener('touchstart', e => { e.preventDefault(); startDraw(e); }, { passive: false });
signCanvas.addEventListener('touchmove',  e => { e.preventDefault(); draw(e);      }, { passive: false });
signCanvas.addEventListener('touchend',   endDraw);

function startDraw(e) {
  saveDrawState(); // 开始新笔画前保存状态
  isDrawing = true;
  const pos = getPos(e, signCanvas);
  lastX = pos.x; lastY = pos.y;
}
function draw(e) {
  if (!isDrawing) return;
  const pos = getPos(e, signCanvas);
  sCtx.strokeStyle = $('sign-color').value;
  sCtx.lineWidth   = parseFloat($('sign-size').value) * 1.5;
  sCtx.beginPath();
  sCtx.moveTo(lastX, lastY);
  sCtx.lineTo(pos.x, pos.y);
  sCtx.stroke();
  lastX = pos.x; lastY = pos.y;
}
function endDraw() { isDrawing = false; }
function clearSignCanvas() {
  sCtx.clearRect(0, 0, signCanvas.width, signCanvas.height);
  drawHistory = [];
}
$('btn-clear-sign').addEventListener('click', clearSignCanvas);
$('btn-undo-sign').addEventListener('click', undoDraw);

// ========== 文字签名预览 ==========
$('text-sign-input').addEventListener('input', updateTextPreview);
$('text-sign-color').addEventListener('input', updateTextPreview);
$('text-sign-size').addEventListener('input', updateTextPreview);
$('text-sign-font').addEventListener('change', updateTextPreview);

function updateTextPreview() {
  const el = $('text-preview-content');
  const text = $('text-sign-input').value || '请输入签名文字';
  el.textContent = text;
  el.style.color = $('text-sign-color').value;
  el.style.fontSize = $('text-sign-size').value + 'px';
  el.style.fontFamily = $('text-sign-font').value;
}

// ========== 确认签名 → 生成 dataURL ==========
async function confirmSign() {
  let dataUrl;
  if (state.currentTab === 'draw') {
    // 检查是否有笔迹
    const imgData = sCtx.getImageData(0, 0, signCanvas.width, signCanvas.height);
    const hasStroke = imgData.data.some((v, i) => i % 4 === 3 && v > 0);
    if (!hasStroke) { showToast('请先绘制签名', 'error'); return; }
    dataUrl = getTrimmedSignature();
  } else if (state.currentTab === 'text') {
    const text = $('text-sign-input').value.trim();
    if (!text) { showToast('请输入签名文字', 'error'); return; }
    dataUrl = textToDataUrl(text);
  } else if (state.currentTab === 'date') {
    const year  = $('date-year').value;
    const month = $('date-month').value;
    const day   = $('date-day').value;
    if (!year || !month || !day) {
      showToast('请填写完整的年月日', 'error'); return;
    }
    dataUrl = dateToDataUrl(year, month, day);
  }

  // 如果已登录，弹出保存询问
  if (getSession()) {
    const name = prompt('为该签名起个名字（如"我的签名"）：', state.currentTab === 'text' ? $('text-sign-input').value.trim() : state.currentTab === 'date' ? '日期签名' : '手写签名');
    if (name !== null) {
      try {
        await api.saveSig({
          name: name || '未命名',
          sig_type: state.currentTab,
          content: dataUrl,
          color: state.currentTab === 'draw' ? $('sign-color').value : ($('text-sign-color') || {}).value || '#1a1a2e',
          extra: JSON.stringify(state.currentTab === 'draw' ? { size: $('sign-size').value } : {})
        });
        showToast('签名已保存到账号！');
        loadSavedSignatures();
      } catch(e) { showToast('保存失败：' + e.message, 'error'); }
    }
  }

  addSignatureToPage(dataUrl);
  closeSignModal();
  updateMobileToolbar();
}

function getTrimmedSignature() {
  // 裁剪空白区域
  const w = signCanvas.width, h = signCanvas.height;
  const imgData = sCtx.getImageData(0, 0, w, h);
  let minX = w, maxX = 0, minY = h, maxY = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = imgData.data[(y * w + x) * 4 + 3];
      if (a > 0) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    }
  }
  const pad = 8;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(w, maxX + pad); maxY = Math.min(h, maxY + pad);
  const tw = maxX - minX, th = maxY - minY;
  const tmp = document.createElement('canvas');
  tmp.width = tw; tmp.height = th;
  tmp.getContext('2d').drawImage(signCanvas, minX, minY, tw, th, 0, 0, tw, th);
  return tmp.toDataURL('image/png');
}

function textToDataUrl(text) {
  const font   = $('text-sign-font').value;
  const size   = parseInt($('text-sign-size').value);
  const color  = $('text-sign-color').value;
  const tmp    = document.createElement('canvas');
  const tmpCtx = tmp.getContext('2d');
  tmpCtx.font  = `${size}px ${font}`;
  const metrics = tmpCtx.measureText(text);
  const tw = Math.ceil(metrics.width) + 20;
  const th = size + 20;
  tmp.width = tw; tmp.height = th;
  tmpCtx.font         = `${size}px ${font}`;
  tmpCtx.fillStyle    = color;
  tmpCtx.textBaseline = 'middle';
  tmpCtx.fillText(text, 10, th / 2);
  return tmp.toDataURL('image/png');
}

// ========== 日期填写 ==========
function fillToday() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  $('date-year').value  = y;
  $('date-month').value = m;
  $('date-day').value   = d;
  updateDatePreview();
}

function updateDatePreview() {
  const y = $('date-year').value;
  const m = $('date-month').value;
  const d = $('date-day').value;
  const el = $('date-preview-content');
  if (y && m && d) {
    // 去除多余空格，文字紧凑排列
    el.textContent = `${y}年${String(m).padStart(2,'0')}月${String(d).padStart(2,'0')}日`;
  } else {
    el.textContent = '请填写年月日';
  }
  el.style.color   = $('date-color').value;
  el.style.fontSize = $('date-size').value + 'px';
}

function dateToDataUrl(year, month, day) {
  const text  = `${year}年${String(month).padStart(2,'0')}月${String(day).padStart(2,'0')}日`;
  const size  = parseInt($('date-size').value);
  const color = $('date-color').value;
  const tmp   = document.createElement('canvas');
  const tmpCtx = tmp.getContext('2d');
  tmpCtx.font = `${size}px "STKaiti","KaiTi",serif`;
  const metrics = tmpCtx.measureText(text);
  // 极小边距，文字紧贴画布边缘
  const pad = 2;
  const tw = Math.ceil(metrics.width) + pad * 2;
  const th = Math.ceil(size * 1.15) + pad * 2;
  tmp.width = tw; tmp.height = th;
  tmpCtx.font         = `${size}px "STKaiti","KaiTi",serif`;
  tmpCtx.fillStyle    = color;
  tmpCtx.textBaseline = 'middle';
  tmpCtx.fillText(text, pad, th / 2);
  return tmp.toDataURL('image/png');
}

// 日期输入监听
['date-year','date-month','date-day'].forEach(id => {
  $(id).addEventListener('input', updateDatePreview);
});
$('date-color').addEventListener('input', updateDatePreview);
$('date-size').addEventListener('input', updateDatePreview);
$('btn-today').addEventListener('click', fillToday);

// ========== 添加签名到页面 ==========
function addSignatureToPage(dataUrl, extraStr) {
  const id = ++state.signIdCounter;
  const canvasW = pdfCanvas.width;
  const canvasH = pdfCanvas.height;
  const sigW = 160, sigH = 60;
  const sig = {
    id,
    dataUrl,
    page: state.currentPage,
    x: (canvasW / 2 - sigW / 2) / canvasW,
    y: (canvasH / 2 - sigH / 2) / canvasH,
    w: sigW / canvasW,
    h: sigH / canvasH,
    timestamp: makeTimestamp(),
  };
  state.signatures.push(sig);
  refreshSignOverlay();
  updateSignList();
  showToast(`签名已添加（${sig.timestamp}）`, 'success');
}

// ========== 渲染签名覆盖层 ==========
function refreshSignOverlay() {
  signOverlay.innerHTML = '';
  const cw = pdfCanvas.width, ch = pdfCanvas.height;
  state.signatures
    .filter(s => s.page === state.currentPage)
    .forEach(sig => {
      const el = document.createElement('div');
      el.className = 'sign-element';
      el.dataset.id = sig.id;
      el.style.left   = (sig.x * cw) + 'px';
      el.style.top    = (sig.y * ch) + 'px';
      el.style.width  = (sig.w * cw) + 'px';
      el.style.height = (sig.h * ch) + 'px';

      const img = document.createElement('img');
      img.src = sig.dataUrl;
      el.appendChild(img);

      // resize handle
      const handle = document.createElement('div');
      handle.className = 'sign-handle';
      el.appendChild(handle);

      // 时间戳标签
      const tsBadge = document.createElement('div');
      tsBadge.className = 'sign-timestamp';
      tsBadge.textContent = sig.timestamp || '';
      el.appendChild(tsBadge);

      // 拖拽移动（鼠标 + 触摸）
      el.addEventListener('mousedown', e => {
        if (e.target === handle) return;
        startDragSign(e, sig, el, 'move');
      });
      el.addEventListener('touchstart', e => {
        if (e.target === handle) return;
        startDragSign(e, sig, el, 'move');
      }, { passive: false });

      // 拖拽缩放（鼠标 + 触摸）
      handle.addEventListener('mousedown', e => {
        e.stopPropagation();
        startDragSign(e, sig, el, 'resize');
      });
      handle.addEventListener('touchstart', e => {
        e.stopPropagation();
        startDragSign(e, sig, el, 'resize');
      }, { passive: false });
      // 右键菜单
      el.addEventListener('contextmenu', e => {
        e.preventDefault();
        showContextMenu(e, sig.id);
      });

      signOverlay.appendChild(el);
    });
}

// ========== 拖拽逻辑（同时支持鼠标和触摸） ==========
function getClientPos(e) {
  if (e.touches && e.touches.length > 0) {
    return { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }
  return { x: e.clientX, y: e.clientY };
}

// ========== 删除浮动按钮 ==========
const sigDeleteBtn = document.createElement('div');
sigDeleteBtn.id = 'sig-delete-btn';
sigDeleteBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>删除</span>`;
sigDeleteBtn.className = 'sig-action-btn';
document.body.appendChild(sigDeleteBtn);

function showSigActionBtn(sig, el) {
  const rect = el.getBoundingClientRect();
  sigDeleteBtn.style.left = (rect.left - 44) + 'px';
  sigDeleteBtn.style.top  = rect.top + 'px';
  sigDeleteBtn.classList.add('visible');
  sigDeleteBtn.onclick = () => {
    state.signatures = state.signatures.filter(s => s.id !== sig.id);
    sigDeleteBtn.classList.remove('visible');
    sigDeleteBtn.onclick = null;
    refreshSignOverlay();
    updateSignList();
    updateMobileToolbar();
    showToast('签名已删除');
  };
}

function hideSigActionBtn() {
  sigDeleteBtn.classList.remove('visible');
  sigDeleteBtn.onclick = null;
}

function startDragSign(e, sig, el, mode) {
  e.preventDefault();
  e.stopPropagation();
  state.activeSignId = sig.id;
  el.classList.add('selected');
  showSigActionBtn(sig, el);

  const cw = pdfCanvas.width, ch = pdfCanvas.height;
  const startPos = getClientPos(e);
  const origX = sig.x * cw, origY = sig.y * ch;
  const origW = sig.w * cw, origH = sig.h * ch;

  const onMove = e => {
    const pos = getClientPos(e);
    const dx = pos.x - startPos.x;
    const dy = pos.y - startPos.y;

    if (mode === 'move') {
      let nx = origX + dx, ny = origY + dy;
      nx = Math.max(0, Math.min(cw - origW, nx));
      ny = Math.max(0, Math.min(ch - origH, ny));
      sig.x = nx / cw; sig.y = ny / ch;
      el.style.left = nx + 'px';
      el.style.top  = ny + 'px';
    } else {
      let nw = Math.max(40, origW + Math.max(dx, dy));
      const ratio = origW / origH;
      const nh = nw / ratio;
      sig.w = nw / cw; sig.h = nh / ch;
      el.style.width  = nw + 'px';
      el.style.height = nh + 'px';
    }
    updateSignList();
  };

  const onEnd = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup',   onEnd);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend',   onEnd);
    // 拖拽结束后保留选中状态，让删除按钮仍可见
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup',   onEnd);
  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('touchend',   onEnd);
}

// 点击页面空白处 → 取消选中 + 隐藏删除按钮
signOverlay.addEventListener('click', e => {
  if (e.target === signOverlay) {
    document.querySelectorAll('.sign-element.selected').forEach(el => el.classList.remove('selected'));
    hideSigActionBtn();
  }
});

// ========== 右键菜单 ==========
let ctxTargetId = null;

function showContextMenu(e, id) {
  ctxTargetId = id;
  signCtxMenu.style.left = e.clientX + 'px';
  signCtxMenu.style.top  = e.clientY + 'px';
  signCtxMenu.classList.remove('hidden');
}

document.addEventListener('click', () => signCtxMenu.classList.add('hidden'));

$('ctx-delete').addEventListener('click', () => {
  if (ctxTargetId == null) return;
  state.signatures = state.signatures.filter(s => s.id !== ctxTargetId);
  ctxTargetId = null;
  refreshSignOverlay();
  updateSignList();
  updateMobileToolbar();
  showToast('签名已删除');
});

$('ctx-resize-smaller').addEventListener('click', () => {
  const sig = state.signatures.find(s => s.id === ctxTargetId);
  if (!sig) return;
  sig.w *= 0.8; sig.h *= 0.8;
  refreshSignOverlay(); updateSignList();
});
$('ctx-resize-larger').addEventListener('click', () => {
  const sig = state.signatures.find(s => s.id === ctxTargetId);
  if (!sig) return;
  sig.w *= 1.2; sig.h *= 1.2;
  refreshSignOverlay(); updateSignList();
});

// ========== 签名列表 ==========
function updateSignList() {
  const list = $('sign-list');
  if (state.signatures.length === 0) {
    list.innerHTML = '<div class="sign-empty">尚未添加签名</div>';
    return;
  }
  list.innerHTML = '';
  state.signatures.forEach(sig => {
    const item = document.createElement('div');
    item.className = 'sign-list-item';
    item.innerHTML = `
      <img src="${sig.dataUrl}" alt="签名" />
      <div class="sign-list-item-info">
        <div class="sign-list-item-page">第 ${sig.page} 页</div>
        <div class="sign-list-item-time">${sig.timestamp || ''}</div>
      </div>
      <button class="sign-list-item-del" title="删除" data-id="${sig.id}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
    `;
    item.querySelector('.sign-list-item-del').addEventListener('click', e => {
      const id = parseInt(e.currentTarget.dataset.id);
      state.signatures = state.signatures.filter(s => s.id !== id);
      refreshSignOverlay(); updateSignList(); updateMobileToolbar();
    });
    // 点击列表项 → 跳转到对应页
    item.addEventListener('click', e => {
      if (e.target.closest('.sign-list-item-del')) return;
      goPage(sig.page);
    });
    list.appendChild(item);
  });
}

// ========== 导出 PDF ==========
$('btn-export').addEventListener('click', exportPDF);

async function exportPDF() {
  if (!state.pdfBytes) return;
  if (state.signatures.length === 0) { showToast('请先添加签名再导出', 'error'); return; }

  showToast('正在生成 PDF，请稍候…');
  try {
    const { PDFDocument } = PDFLib;
    const pdfDoc = await PDFDocument.load(state.pdfBytes);
    const pages  = pdfDoc.getPages();

    for (const sig of state.signatures) {
      const page = pages[sig.page - 1];
      const { width: pw, height: ph } = page.getSize();

      // 加载签名图片
      const imgBytes = await dataUrlToBytes(sig.dataUrl);
      const pdfImg   = await pdfDoc.embedPng(imgBytes);

      const sigW = sig.w * pw;   // 签名宽（PDF单位）
      const sigH = sig.h * ph;
      // PDF 坐标系：原点在左下，Y 轴向上
      const sigX = sig.x * pw;
      const sigY = ph - (sig.y + sig.h) * ph;   // 转换 Y 坐标

      page.drawImage(pdfImg, { x: sigX, y: sigY, width: sigW, height: sigH });
    }

    const pdfBytesOut = await pdfDoc.save();
    downloadBytes(pdfBytesOut, 'signed.pdf');
    showToast('PDF 导出成功！', 'success');
  } catch (err) {
    showToast('导出失败：' + err.message, 'error');
    console.error(err);
  }
}

function dataUrlToBytes(dataUrl) {
  return new Promise(resolve => {
    const b64 = dataUrl.split(',')[1];
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    resolve(bytes);
  });
}

function downloadBytes(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ========== Loading 遮罩 ==========
let loadingEl = null;
function showLoading(show) {
  if (show) {
    if (loadingEl) return;
    loadingEl = document.createElement('div');
    loadingEl.className = 'loading-overlay';
    loadingEl.innerHTML = '<div class="spinner"></div><span>加载中…</span>';
    const wrap = $('pdf-page-wrap');
    if (wrap) wrap.appendChild(loadingEl);
  } else {
    if (loadingEl) { loadingEl.remove(); loadingEl = null; }
  }
}

// ========== 键盘快捷键 ==========
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (!state.pdfDoc) return;
  if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')   goPage(state.currentPage - 1);
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown')  goPage(state.currentPage + 1);
  if (e.key === '+' || e.key === '=') setScale(state.scale + 0.25);
  if (e.key === '-')                  setScale(state.scale - 0.25);
  if (e.key === 'Escape') closeSignModal();
});

// ========== 移动端底部工具栏 ==========
const mobileToolbar = $('mobile-toolbar');
const sidebarOverlay = $('sidebar-overlay');

function updateMobileToolbar() {
  const visible = state.pdfDoc !== null;
  mobileToolbar.classList.toggle('visible', visible);
  $('mbtn-add').disabled = !visible;
  $('mbtn-export').disabled = !visible || state.signatures.length === 0;
  $('mbtn-prev').disabled = state.currentPage <= 1;
  $('mbtn-next').disabled = state.currentPage >= state.totalPages;
}

$('mbtn-prev').addEventListener('click', () => goPage(state.currentPage - 1));
$('mbtn-next').addEventListener('click', () => goPage(state.currentPage + 1));
$('mbtn-add').addEventListener('click', openSignModal);
$('mbtn-export').addEventListener('click', exportPDF);

// 移动端打开侧边栏
function openSidebar() {
  if (window.innerWidth <= 768) {
    sidebar.classList.add('mobile-open');
    sidebarOverlay.classList.add('visible');
  }
}
sidebarOverlay.addEventListener('click', () => {
  sidebar.classList.remove('mobile-open');
  sidebarOverlay.classList.remove('visible');
});

// 监听窗口大小变化
window.addEventListener('resize', () => {
  if (window.innerWidth > 768) {
    sidebar.classList.remove('mobile-open');
    sidebarOverlay.classList.remove('visible');
  }
});

// ========== 模板功能 ==========
async function loadTemplates() {
  const list = $('template-list');
  if (!getSession()) {
    list.innerHTML = '<div class="template-tip error">请先登录后使用模板功能</div>';
    return;
  }
  list.innerHTML = '<div class="template-tip">加载中…</div>';
  try {
    const temps = await api.getTemplates();
    if (!temps.length) {
      list.innerHTML = '<div class="template-tip">暂无模板，保存当前签名即可创建</div>';
      return;
    }
    list.innerHTML = temps.map(t => `
      <div class="template-item" data-id="${t.id}" data-content="${encodeURIComponent(t.content)}" data-type="${t.sig_type}" data-color="${t.color || ''}" data-extra="${encodeURIComponent(t.extra || '{}')}">
        <img class="template-thumb" src="${t.content}" alt="${t.name}" />
        <div class="template-info">
          <div class="template-name">${t.name}</div>
          <div class="template-meta">${typeLabel(t.sig_type)} · ${formatDate(t.created_at)}</div>
        </div>
        <button class="template-del" data-id="${t.id}" title="删除模板">
          <svg viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
      </div>
    `).join('');

    // 点击使用模板
    list.querySelectorAll('.template-item').forEach(el => {
      el.addEventListener('click', e => {
        if (e.target.closest('.template-del')) return;
        const { content, type, color, extra } = el.dataset;
        const dataUrl = decodeURIComponent(content);
        closeSignModal();
        addSignatureToPage(dataUrl, decodeURIComponent(extra || '{}'));
        showToast('模板签名已添加到页面');
      });
    });

    // 删除模板
    list.querySelectorAll('.template-del').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        if (!confirm('确认删除该模板？')) return;
        try {
          await api.delTemplate(btn.dataset.id);
          loadTemplates();
          showToast('模板已删除');
        } catch(err) { showToast(err.message, 'error'); }
      });
    });
  } catch(e) {
    list.innerHTML = '<div class="template-tip error">加载失败</div>';
  }
}

async function saveAsTemplate() {
  if (!getSession()) { showToast('请先登录', 'error'); return; }
  const name = $('template-name-input').value.trim();
  if (!name) { showToast('请输入模板名称', 'error'); return; }
  let dataUrl, sig_type, color, extra = '{}';
  if (state.currentTab === 'draw') {
    const imgData = sCtx.getImageData(0, 0, signCanvas.width, signCanvas.height);
    const hasStroke = imgData.data.some((v, i) => i % 4 === 3 && v > 0);
    if (!hasStroke) { showToast('请先绘制签名', 'error'); return; }
    dataUrl = getTrimmedSignature();
    sig_type = 'draw';
    color = $('sign-color').value;
    extra = JSON.stringify({ size: $('sign-size').value });
  } else if (state.currentTab === 'text') {
    const text = $('text-sign-input').value.trim();
    if (!text) { showToast('请先输入文字签名', 'error'); return; }
    dataUrl = textToDataUrl(text);
    sig_type = 'text';
    color = $('text-sign-color').value;
  } else if (state.currentTab === 'date') {
    const y = $('date-year').value, m = $('date-month').value, d = $('date-day').value;
    if (!y || !m || !d) { showToast('请先填写日期', 'error'); return; }
    dataUrl = dateToDataUrl(y, m, d);
    sig_type = 'date';
    color = $('date-color').value;
  }
  try {
    await api.saveTemplate({ name, sig_type, content: dataUrl, color, extra });
    $('template-name-input').value = '';
    loadTemplates();
    showToast('模板已保存！');
  } catch(e) { showToast('保存失败：' + e.message, 'error'); }
}

$('btn-save-as-template').addEventListener('click', saveAsTemplate);

// ========== 签署时间戳（添加到签名元数据） ==========
function makeTimestamp() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

// ========== SHA-256 哈希计算 ==========
async function sha256(buffer) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function computeFileHash(bytes) {
  return await sha256(bytes);
}

// ========== 签署记录 ==========
async function loadSignRecords() {
  const list = $('sign-records-list');
  if (!getSession()) {
    list.innerHTML = '<div class="record-empty">登录后查看记录</div>';
    return;
  }
  list.innerHTML = '<div class="record-empty">加载中…</div>';
  try {
    const records = await api.getRecords();
    if (!records.length) {
      list.innerHTML = '<div class="record-empty">暂无签署记录</div>';
      return;
    }
    list.innerHTML = records.map(r => `
      <div class="record-item">
        <div class="record-doc">${r.doc_name}</div>
        <div class="record-meta">
          <span>${r.sig_count} 个签名</span> ·
          <span>${r.page_count} 页</span>
        </div>
        <div class="record-time">${formatDate(r.signed_at)}</div>
        <div class="record-hash" title="文件哈希（SHA-256）">${r.file_hash.substring(0, 12)}…</div>
      </div>
    `).join('');
  } catch(e) {
    list.innerHTML = '<div class="record-empty">加载失败</div>';
  }
}

// 更新导出 PDF：计算哈希 + 保存记录
async function exportPDF() {
  if (!state.pdfBytes) return;
  if (state.signatures.length === 0) { showToast('请先添加签名再导出', 'error'); return; }

  showToast('正在生成 PDF，请稍候…');
  try {
    const { PDFDocument } = PDFLib;
    const pdfDoc = await PDFDocument.load(state.pdfBytes);
    const pages  = pdfDoc.getPages();

    for (const sig of state.signatures) {
      const page = pages[sig.page - 1];
      const { width: pw, height: ph } = page.getSize();
      const imgBytes = await dataUrlToBytes(sig.dataUrl);
      const pdfImg   = await pdfDoc.embedPng(imgBytes);
      const sigW = sig.w * pw;
      const sigH = sig.h * ph;
      const sigX = sig.x * pw;
      const sigY = ph - (sig.y + sig.h) * ph;
      page.drawImage(pdfImg, { x: sigX, y: sigY, width: sigW, height: sigH });
    }

    // 计算原始 PDF 的哈希（用于存证）
    const rawHash = await computeFileHash(state.pdfBytes);

    // 生成带签名后的 PDF 字节
    const pdfBytesOut = await pdfDoc.save();

    // 保存签署记录（登录用户）
    const docName = $('doc-name').textContent || '未命名.pdf';
    if (getSession()) {
      try {
        const signedHash = await computeFileHash(pdfBytesOut);
        await api.saveRecord({
          doc_name: docName,
          file_hash: signedHash,
          page_count: state.totalPages,
          sig_count: state.signatures.length
        });
        showToast(`PDF 导出成功！SHA-256: ${signedHash.substring(0, 16)}…`);
      } catch(e) {
        showToast('PDF 导出成功（记录保存失败）', 'success');
      }
    } else {
      showToast(`PDF 导出成功！SHA-256: ${rawHash.substring(0, 16)}…`);
    }

    // 下载文件名带时间戳
    const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const baseName = docName.replace(/\.pdf$/i, '');
    downloadBytes(pdfBytesOut, `${baseName}_已签署_${ts}.pdf`);
  } catch (err) {
    showToast('导出失败：' + err.message, 'error');
    console.error(err);
  }
}

// ========== 初始化 ==========
initAuth();
updateAuthUI();
updateTextPreview();
updateMobileToolbar();
