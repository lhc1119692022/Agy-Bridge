const api = window.agyBridge;

let state = null;
let toastTimer = 0;
let dialogModels = [];
let catalogQuery = '';

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function showError(error) {
  toast(error, 'err');
}

function toast(message, kind = 'ok') {
  const node = $('toast');
  node.hidden = false;
  node.className = `toast ${kind}`;
  node.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { node.hidden = true; }, 2200);
}

async function call(name, ...args) {
  const result = await api[name](...args);
  if (result && result.ok === false) {
    showError(result.error);
    return null;
  }
  return result?.result ?? result;
}

async function action(button, name, ...args) {
  if (button) {
    button.classList.add('busy');
    button.disabled = true;
  }
  try {
    const result = await call(name, ...args);
    if (result !== null) toast('已完成');
    return result;
  } finally {
    if (button) {
      button.classList.remove('busy');
      button.disabled = false;
    }
  }
}

function switchView(name) {
  for (const view of document.querySelectorAll('.view')) view.classList.add('hidden');
  $(`view-${name}`).classList.remove('hidden');
  for (const button of document.querySelectorAll('nav button')) {
    button.classList.toggle('active', button.dataset.view === name);
  }
}

function statusCard(label, title, detail, kind) {
  return `<div class="status-card ${kind}">
    <span class="dot"></span>
    <div>
      <span class="label">${escapeHtml(label)}</span>
      <strong>${escapeHtml(title)}</strong>
      <div class="meta">${escapeHtml(detail)}</div>
    </div>
  </div>`;
}

function renderAside() {
  const status = state.status;
  const injectorKind = status.injector.running ? 'on' : (status.injector.error ? 'warn' : '');
  const cliproxyKind = status.cliproxy.running ? 'on' : (status.cliproxy.error ? 'warn' : '');
  let agyKind = '';
  let agyTitle = '未检测到';
  let agyDetail = '未找到安装路径';
  if (status.antigravity.found && status.antigravity.running) {
    agyKind = 'on';
    agyTitle = '已打开';
    agyDetail = status.antigravity.target === 'ide' ? 'IDE' : '应用';
  } else if (status.antigravity.found) {
    agyKind = 'warn';
    agyTitle = '已安装未打开';
    agyDetail = status.antigravity.target === 'ide' ? 'IDE' : '应用';
  }
  $('aside-status').innerHTML = [
    statusCard('注入器', status.injector.running ? '运行中' : '未启动', status.injector.url || status.injector.error || '等待启动', injectorKind),
    statusCard('CLIProxyAPI', status.cliproxy.running ? '运行中' : '未启动', status.cliproxy.url || status.cliproxy.error || '可选本地引擎', cliproxyKind),
    statusCard('Antigravity', agyTitle, agyDetail, agyKind),
  ].join('');
}

function renderUpstreams() {
  const active = state.config.activeUpstreamId;
  $('upstream-list').innerHTML = state.config.upstreams.map(item => {
    const chips = item.models.length
      ? item.models.slice(0, 8).map(model => `<span class="chip">${escapeHtml(model.id)}</span>`).join('')
        + (item.models.length > 8 ? `<span class="pill">+${item.models.length - 8}</span>` : '')
      : '<span class="hint">还没有模型，可编辑添加或点「拉模型」</span>';
    return `<article class="card ${item.id === active ? 'active' : ''}">
      <div>
        <span class="pill ${item.kind === 'local' ? 'warn' : 'ok'}">${item.kind === 'local' ? '本地引擎' : '远程中转站'}</span>
        ${item.id === active ? '<span class="pill ok">当前注入源</span>' : ''}
      </div>
      <h3>${escapeHtml(item.name)}</h3>
      <div class="meta">${escapeHtml(item.baseUrl)}</div>
      <div class="chip-list" style="margin-top:10px">${chips}</div>
      <div class="card-actions">
        <button type="button" data-act="use" data-id="${item.id}">设为当前上游</button>
        <button type="button" data-act="models" data-id="${item.id}">拉模型</button>
        <button type="button" data-act="edit" data-id="${item.id}">编辑</button>
        ${item.kind === 'remote' ? `<button type="button" class="danger" data-act="delete" data-id="${item.id}">删除</button>` : ''}
      </div>
    </article>`;
  }).join('') || '<p class="hint">还没有远程中转站。可以先添加一个 generateContent 地址。</p>';
}

function renderInject() {
  const panel = $('inject-panel');
  const active = document.activeElement;
  const keepFocus = active && active.id === 'catalog-query';
  const keepQuery = keepFocus ? active.value : catalogQuery;
  catalogQuery = keepQuery;

  const upstream = state.config.upstreams.find(item => item.id === state.config.activeUpstreamId);
  const selected = state.config.selectedModelIds ?? [];
  const selectedSet = new Set(selected);
  const slotCap = state.slotCap || 6;
  const injector = state.status.injector;
  const catalog = upstream?.models ?? [];
  const byId = new Map(catalog.map(model => [model.id, model]));
  const queue = selected.map(id => byId.get(id)).filter(Boolean);
  const query = catalogQuery.trim().toLowerCase();
  const available = catalog.filter(model => !selectedSet.has(model.id)).filter(model => {
    if (!query) return true;
    return model.id.toLowerCase().includes(query) || model.name.toLowerCase().includes(query);
  });

  const slots = Array.from({ length: slotCap }, (_, index) => {
    const model = queue[index];
    if (!model) return `<div class="slot"><span class="idx">槽位 ${index + 1}</span>空</div>`;
    return `<div class="slot filled"><span class="idx">槽位 ${index + 1}</span>${escapeHtml(model.name || model.id)}</div>`;
  }).join('');

  const queueHtml = queue.map((model, index) => `
    <div class="queue-item">
      <div class="pos">${index + 1}</div>
      <div>
        <div class="item-name">${escapeHtml(model.name)}</div>
        <div class="item-id">${escapeHtml(model.id)}</div>
      </div>
      <div class="queue-actions">
        <button type="button" class="icon-btn" data-act="up" data-id="${escapeHtml(model.id)}" ${index === 0 ? 'disabled' : ''}>上移</button>
        <button type="button" class="icon-btn" data-act="down" data-id="${escapeHtml(model.id)}" ${index === queue.length - 1 ? 'disabled' : ''}>下移</button>
        <button type="button" class="icon-btn danger" data-act="remove" data-id="${escapeHtml(model.id)}">移除</button>
      </div>
    </div>
  `).join('') || '<p class="hint">还没有注入队列。从右侧把模型加进来，再用上移/下移决定 Antigravity 里的顺序。</p>';

  const catalogHtml = available.map(model => `
    <div class="catalog-item">
      <div>
        <div class="item-name">${escapeHtml(model.name)}</div>
        <div class="item-id">${escapeHtml(model.id)}</div>
      </div>
      <button type="button" data-act="add" data-id="${escapeHtml(model.id)}" ${queue.length >= slotCap ? 'disabled' : ''}>加入队列</button>
    </div>
  `).join('') || '<p class="hint">没有可加入的模型。先到上游页拉模型，或换一个关键词。</p>';

  panel.innerHTML = `
    <div class="panel slot-meter">
      <div class="slot-meter-head">
        <strong>Antigravity 槽位 ${queue.length} / ${slotCap}</strong>
        <span class="hint">${injector.running ? `注入器 ${injector.url}` : (injector.error || '注入器未启动')}</span>
      </div>
      <div class="slot-track">${slots}</div>
      <p class="hint">左边是将要出现在 Antigravity 里的顺序。改队列后请重新启动注入器或 Antigravity。</p>
      <div class="row wrap">
        <button type="button" id="launch-app" class="primary">启动 Antigravity 应用</button>
        <button type="button" id="launch-ide">启动 Antigravity IDE</button>
      </div>
    </div>
    <div class="model-grid">
      <section class="panel">
        <div class="field-head"><span>注入队列</span><span class="hint">上移 / 下移</span></div>
        <div class="queue">${queueHtml}</div>
      </section>
      <section class="panel">
        <div class="field-head"><span>上游模型</span><span class="hint">${catalog.length} 个</span></div>
        <input id="catalog-query" placeholder="搜索模型 ID 或名称" value="${escapeHtml(catalogQuery)}" />
        <div class="catalog">${catalogHtml}</div>
      </section>
    </div>
  `;
  const search = $('catalog-query');
  if (search && keepFocus) {
    search.focus();
    search.setSelectionRange(catalogQuery.length, catalogQuery.length);
  }
}

function renderLocal() {
  const accounts = state.cliproxy?.accounts ?? [];
  const authDir = state.cliproxy?.authDir || '~/.cli-proxy-api';
  $('cliproxy-accounts').innerHTML = `
    <div class="field-head"><span>已发现账号</span><span class="hint">${accounts.length} 个 · ${escapeHtml(authDir)}</span></div>
    <div class="chip-list">${accounts.length
      ? accounts.map(account => `<span class="chip">${escapeHtml(account.type)} · ${escapeHtml(account.email)}</span>`).join('')
      : '<span class="hint">还没有账号。点「添加 Antigravity 账号」用 CLIProxyAPI 登录。</span>'}</div>
  `;
  const detected = ['启动方式 start.cmd'];
  detected.push(state.status.cliproxy.running ? '服务运行中' : '服务未启动');
  $('cliproxy-detected').textContent = detected.join(' · ');
  const usage = [];
  usage.push(state.cliproxy?.upstreamUrl || '尚未读取 URL');
  usage.push(state.cliproxy?.clientKeyCount ? `已读取 ${state.cliproxy.clientKeyCount} 把客户端 Key` : 'config.yaml 里没有 api-keys');
  if (state.cliproxy?.proxyConfigured) usage.push('出站代理已在项目中配置');
  $('cliproxy-usage').textContent = usage.join(' · ');
  if (document.activeElement && document.activeElement.id === 'cliproxy-dir') return;
  $('cliproxy-dir').value = state.config.cliproxy.projectDir || state.cliproxy?.projectDir || '';
}

function renderSettings() {
  if (document.activeElement && ['proxy-url', 'ide-path', 'app-path'].includes(document.activeElement.id)) return;
  $('proxy-enabled').checked = state.config.proxyEnabled;
  $('proxy-url').value = state.config.proxyUrl;
  $('ide-path').value = state.config.antigravity.idePath;
  $('app-path').value = state.config.antigravity.appPath;
}

function renderLogs() {
  $('log-view').textContent = (state.logs || []).join('\n');
  $('log-view').scrollTop = $('log-view').scrollHeight;
}

function render() {
  if (!state) return;
  renderAside();
  renderUpstreams();
  renderInject();
  renderLocal();
  renderSettings();
  renderLogs();
}

function renderDialogChips() {
  $('u-model-count').textContent = `${dialogModels.length} 个`;
  $('u-model-chips').innerHTML = dialogModels.length
    ? dialogModels.map((model, index) => `
        <span class="chip">${escapeHtml(model.id)}
          <button type="button" data-chip-remove="${index}" aria-label="移除">×</button>
        </span>`).join('')
    : '<span class="hint">还没有模型</span>';
}

function addDialogModel(raw) {
  const id = raw.trim();
  if (!id) return;
  if (dialogModels.some(model => model.id === id)) {
    toast('这个模型已经在列表里', 'err');
    return;
  }
  dialogModels.push({ id, name: id });
  $('u-model-add').value = '';
  renderDialogChips();
}

function openUpstreamDialog(existing) {
  $('dialog-title').textContent = existing
    ? (existing.kind === 'local' ? '编辑本地中转站' : '编辑远程中转站')
    : '添加远程中转站';
  $('u-id').value = existing?.id ?? '';
  $('u-name').value = existing?.name ?? '';
  $('u-url').value = existing?.baseUrl ?? '';
  $('u-key').value = existing?.apiKey ?? '';
  dialogModels = (existing?.models ?? []).map(model => ({ id: model.id, name: model.name || model.id }));
  renderDialogChips();
  $('upstream-dialog').showModal();
}

async function moveSelected(id, delta) {
  const selected = [...(state.config.selectedModelIds ?? [])];
  const index = selected.indexOf(id);
  const next = index + delta;
  if (index < 0 || next < 0 || next >= selected.length) return;
  [selected[index], selected[next]] = [selected[next], selected[index]];
  await call('setSelectedModels', selected);
}

document.querySelector('nav').addEventListener('click', event => {
  const button = event.target.closest('button');
  if (button?.dataset.view) switchView(button.dataset.view);
});

$('add-upstream').addEventListener('click', () => openUpstreamDialog());

$('u-model-add-btn').addEventListener('click', () => addDialogModel($('u-model-add').value));
$('u-model-add').addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    addDialogModel($('u-model-add').value);
  }
});
$('u-model-chips').addEventListener('click', event => {
  const button = event.target.closest('button[data-chip-remove]');
  if (!button) return;
  dialogModels.splice(Number(button.dataset.chipRemove), 1);
  renderDialogChips();
});

$('upstream-form').addEventListener('submit', async event => {
  if (event.submitter && event.submitter.value === 'cancel') return;
  event.preventDefault();
  const saved = await action($('u-save'), 'saveUpstream', {
    id: $('u-id').value || undefined,
    name: $('u-name').value,
    baseUrl: $('u-url').value,
    apiKey: $('u-key').value,
    models: dialogModels,
    enabled: true,
  });
  if (saved !== null) $('upstream-dialog').close();
});

$('upstream-list').addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button) return;
  const id = button.dataset.id;
  if (button.dataset.act === 'use') await action(button, 'setActiveUpstream', id);
  if (button.dataset.act === 'models') await action(button, 'refreshModels', id);
  if (button.dataset.act === 'delete') {
    if (!confirm('确定删除这个上游？')) return;
    await action(button, 'deleteUpstream', id);
  }
  if (button.dataset.act === 'edit') {
    openUpstreamDialog(state.config.upstreams.find(item => item.id === id));
  }
});

$('inject-panel').addEventListener('input', event => {
  if (event.target.id === 'catalog-query') catalogQuery = event.target.value;
});
$('inject-panel').addEventListener('keyup', event => {
  if (event.target.id === 'catalog-query') {
    catalogQuery = event.target.value;
    renderInject();
  }
});
$('inject-panel').addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button) return;
  const id = button.dataset.id;
  const selected = [...(state.config.selectedModelIds ?? [])];
  const slotCap = state.slotCap || 6;
  if (button.dataset.act === 'add') {
    if (selected.includes(id)) return;
    if (selected.length >= slotCap) {
      showError(`Antigravity 最多同时注入 ${slotCap} 个模型`);
      return;
    }
    selected.push(id);
    await call('setSelectedModels', selected);
  }
  if (button.dataset.act === 'remove') {
    await call('setSelectedModels', selected.filter(item => item !== id));
  }
  if (button.dataset.act === 'up') await moveSelected(id, -1);
  if (button.dataset.act === 'down') await moveSelected(id, 1);
  if (button.id === 'launch-app') await action(button, 'launch', 'app');
  if (button.id === 'launch-ide') await action(button, 'launch', 'ide');
});

$('start-injector').addEventListener('click', event => action(event.currentTarget, 'startInjector'));
$('stop-injector').addEventListener('click', event => action(event.currentTarget, 'stopInjector'));
$('start-local').addEventListener('click', event => action(event.currentTarget, 'startLocalEngine'));
$('stop-local').addEventListener('click', event => action(event.currentTarget, 'stopLocalEngine'));

$('save-cliproxy').addEventListener('click', async event => {
  const dir = $('cliproxy-dir').value.trim();
  if (dir) {
    const saved = await action(event.currentTarget, 'updateSettings', {
      cliproxy: { ...state.config.cliproxy, projectDir: dir },
    });
    if (saved === null) return;
  }
  await call('setActiveUpstream', 'local-cliproxy');
  await action(event.currentTarget, 'refreshModels', 'local-cliproxy');
});
$('detect-cliproxy').addEventListener('click', event => action(event.currentTarget, 'detectCliproxy'));
$('login-local').addEventListener('click', event => action(event.currentTarget, 'loginLocal'));
$('open-management').addEventListener('click', event => action(event.currentTarget, 'openManagement'));

$('save-settings').addEventListener('click', async event => {
  await action(event.currentTarget, 'updateSettings', {
    proxyEnabled: $('proxy-enabled').checked,
    proxyUrl: $('proxy-url').value,
    antigravity: {
      ...state.config.antigravity,
      idePath: $('ide-path').value,
      appPath: $('app-path').value,
    },
  });
});

$('pick-cliproxy').addEventListener('click', async () => {
  const folder = await api.pickFolder();
  if (!folder) return;
  $('cliproxy-dir').value = folder;
  await call('updateSettings', {
    cliproxy: { ...state.config.cliproxy, projectDir: folder },
  });
});
$('pick-ide').addEventListener('click', async () => {
  const file = await api.pickFile();
  if (file) $('ide-path').value = file;
});
$('pick-app').addEventListener('click', async () => {
  const file = await api.pickFile();
  if (file) $('app-path').value = file;
});

async function reload() {
  state = await api.state();
  render();
}

api.onState(next => {
  state = next;
  render();
});

reload();
setInterval(async () => {
  try {
    const next = await api.state();
    if (!next || !state) return;
    state.status = next.status;
    renderAside();
  } catch { /* ignore */ }
}, 2000);
