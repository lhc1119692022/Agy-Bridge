const api = window.agyBridge;

let state = null;
let toastTimer = 0;
let dialogModels = [];
let catalogQuery = '';
let currentView = 'upstreams';
let renderFrame = 0;
let lastLogTail = '';
const htmlCache = new Map();

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function setHtml(node, html) {
  if (!node) return;
  if (htmlCache.get(node) === html) return;
  const top = node.scrollTop;
  htmlCache.set(node, html);
  node.innerHTML = html;
  node.scrollTop = top;
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
  if (currentView === name) return;
  currentView = name;
  for (const view of document.querySelectorAll('.view')) view.classList.add('hidden');
  $(`view-${name}`).classList.remove('hidden');
  for (const button of document.querySelectorAll('nav button')) {
    button.classList.toggle('active', button.dataset.view === name);
  }
  if (!state) return;
  if (name === 'upstreams') renderUpstreams();
  else if (name === 'inject') renderInject();
  else if (name === 'local') renderLocal();
  else if (name === 'settings') renderSettings();
  else if (name === 'logs') renderLogs();
}

function statusCard(label, title, detail, kind) {
  return `<div class="status-card ${kind}" title="${escapeHtml(`${title} · ${detail}`)}">
    <span class="dot"></span>
    <span class="label">${escapeHtml(label)}</span>
  </div>`;
}

function syncToggle(button, running, startLabel, stopLabel) {
  if (!button) return;
  button.textContent = running ? stopLabel : startLabel;
  button.classList.toggle('primary', !running);
  button.classList.toggle('danger', running);
}

function renderAside() {
  const status = state.status;
  const injectorKind = status.injector.running ? 'on' : (status.injector.error ? 'warn' : '');
  const cliproxyKind = status.cliproxy.running ? 'on' : (status.cliproxy.error ? 'warn' : '');
  let agyKind = '';
  let agyTitle = '未安装';
  let agyDetail = '未找到 Antigravity 2.0';
  if (!status.antigravity.found) {
    agyKind = '';
  } else if (status.antigravity.running && status.antigravity.injected) {
    agyKind = 'on';
    agyTitle = '已注入';
    agyDetail = status.injector.url || '由 Agy Bridge 拉起';
  } else if (status.antigravity.running) {
    agyKind = 'warn';
    agyTitle = '未注入';
    agyDetail = '请先退出官方窗口，再从本窗口启动';
  } else if (status.antigravity.injected) {
    agyKind = 'warn';
    agyTitle = '就绪';
    agyDetail = '从本窗口启动 Antigravity 2.0';
  } else {
    agyKind = 'warn';
    agyTitle = '已安装';
    agyDetail = '官方 Cloud Code';
  }
  setHtml($('aside-status'), [
    statusCard('注入器', status.injector.running ? '运行中' : '未启动', status.injector.url || status.injector.error || '等待启动', injectorKind),
    statusCard('本地', status.cliproxy.running ? '运行中' : '未启动', status.cliproxy.url || status.cliproxy.error || '可选本地引擎', cliproxyKind),
    statusCard('AG', agyTitle, agyDetail, agyKind),
  ].join(''));
  syncToggle($('aside-injector'), status.injector.running, '启动注入器', '停止注入器');
  syncToggle($('toggle-injector'), status.injector.running, '启动注入器', '停止注入器');
  syncToggle($('aside-cliproxy'), status.cliproxy.running, '启动 CLIProxyAPI', '停止 CLIProxyAPI');
}

function renderUpstreams() {
  const active = state.config.activeUpstreamId;
  setHtml($('upstream-list'), state.config.upstreams.map(item => {
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
  }).join('') || '<p class="hint">还没有远程中转站。可以先添加一个 generateContent 地址。</p>');
}

function injectContext() {
  const upstream = state.config.upstreams.find(item => item.id === state.config.activeUpstreamId);
  const selected = state.config.selectedModelIds ?? [];
  const selectedSet = new Set(selected);
  const slotCap = state.slotCap || 6;
  const injector = state.status.injector;
  const catalog = upstream?.models ?? [];
  const byId = new Map(catalog.map(model => [model.id, model]));
  const queue = selected.map(id => byId.get(id) || { id, name: id });
  const query = catalogQuery.trim().toLowerCase();
  const available = catalog.filter(model => !selectedSet.has(model.id)).filter(model => {
    if (!query) return true;
    return model.id.toLowerCase().includes(query);
  });
  return { slotCap, injector, catalog, queue, available };
}

function renderSlots(ctx) {
  const { slotCap, injector, queue } = ctx;
  const label = $('slot-label');
  const nextLabel = `槽位 ${queue.length} / ${slotCap}`;
  if (label.textContent !== nextLabel) label.textContent = nextLabel;
  const hint = injector.running ? `注入器 ${injector.url}` : (injector.error || '注入器未启动');
  const hintNode = $('slot-hint');
  if (hintNode.textContent !== hint) hintNode.textContent = hint;
  setHtml($('slot-dots'), Array.from({ length: slotCap }, (_, index) => {
    const model = queue[index];
    return `<span class="slot-dot${model ? ' filled' : ''}" title="${model ? escapeHtml(model.id) : `空槽 ${index + 1}`}"></span>`;
  }).join(''));
}

function renderQueue(ctx) {
  const { queue } = ctx;
  setHtml($('inject-queue'), queue.map((model, index) => `
    <div class="queue-item">
      <div class="pos">${index + 1}</div>
      <div class="item-id" title="${escapeHtml(model.id)}">${escapeHtml(model.id)}</div>
      <div class="queue-actions">
        <button type="button" class="icon-btn" data-act="up" data-id="${escapeHtml(model.id)}" ${index === 0 ? 'disabled' : ''}>上</button>
        <button type="button" class="icon-btn" data-act="down" data-id="${escapeHtml(model.id)}" ${index === queue.length - 1 ? 'disabled' : ''}>下</button>
        <button type="button" class="icon-btn danger" data-act="remove" data-id="${escapeHtml(model.id)}">移除</button>
      </div>
    </div>
  `).join('') || '<p class="hint">还没有注入队列。从右侧把模型加进来，再用上 / 下决定 Antigravity 里的顺序。</p>');
}

function renderCatalog(ctx) {
  const { catalog, queue, available, slotCap } = ctx;
  const count = $('catalog-count');
  const nextCount = `${catalog.length} 个`;
  if (count.textContent !== nextCount) count.textContent = nextCount;
  setHtml($('inject-catalog'), available.map(model => `
    <div class="catalog-item">
      <div class="item-id" title="${escapeHtml(model.id)}">${escapeHtml(model.id)}</div>
      <button type="button" data-act="add" data-id="${escapeHtml(model.id)}" ${queue.length >= slotCap ? 'disabled' : ''}>加入</button>
    </div>
  `).join('') || '<p class="hint">没有可加入的模型。先到上游页拉模型，或换一个关键词。</p>');
}

function renderInject() {
  const search = $('catalog-query');
  if (search && document.activeElement === search) catalogQuery = search.value;
  else if (search && search.value !== catalogQuery) search.value = catalogQuery;
  const ctx = injectContext();
  renderSlots(ctx);
  renderQueue(ctx);
  renderCatalog(ctx);
}

function renderLocal() {
  const accounts = state.cliproxy?.accounts ?? [];
  const authDir = state.cliproxy?.authDir || '~/.cli-proxy-api';
  setHtml($('cliproxy-accounts'), `
    <div class="field-head"><span>已发现账号</span><span class="hint">${accounts.length} 个 · ${escapeHtml(authDir)}</span></div>
    <div class="chip-list">${accounts.length
      ? accounts.map(account => `<span class="chip">${escapeHtml(account.type)} · ${escapeHtml(account.email)}</span>`).join('')
      : '<span class="hint">还没有账号。点「添加 Antigravity 账号」用 CLIProxyAPI 登录。</span>'}</div>
  `);
  const detected = ['静默启动 cli-proxy-api'];
  detected.push(state.status.cliproxy.running ? '服务运行中' : '服务未启动');
  const detectedText = detected.join(' · ');
  if ($('cliproxy-detected').textContent !== detectedText) $('cliproxy-detected').textContent = detectedText;
  const usage = [];
  usage.push(state.cliproxy?.upstreamUrl || '尚未读取 URL');
  usage.push(state.cliproxy?.clientKeyCount ? `已读取 ${state.cliproxy.clientKeyCount} 把客户端 Key` : 'config.yaml 里没有 api-keys');
  if (state.cliproxy?.proxyConfigured) usage.push('出站代理已在项目中配置');
  const usageText = usage.join(' · ');
  if ($('cliproxy-usage').textContent !== usageText) $('cliproxy-usage').textContent = usageText;
  renderKeeper();
  if (document.activeElement && document.activeElement.id === 'cliproxy-dir') return;
  $('cliproxy-dir').value = state.config.cliproxy.projectDir || state.cliproxy?.projectDir || '';
}

function formatEventTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || '';
  return date.toLocaleString('zh-CN', { hour12: false });
}

function renderKeeper() {
  const keeper = state.keeper ?? {};
  const running = !!keeper.running;
  const status = $('keeper-status');
  const statusText = !keeper.found
    ? (keeper.error || '项目里没有 Keeper')
    : running
      ? `运行中 · ${keeper.dashboardUrl || 'http://127.0.0.1:8080/'}`
      : '未启动';
  if (status && status.textContent !== statusText) status.textContent = statusText;
  const startBtn = $('start-keeper');
  if (startBtn) startBtn.textContent = running ? '打开 Keeper 管理页' : '启动 Keeper';
  const hint = $('keeper-events-hint');
  const hintText = !running
    ? 'Keeper 未启动。启动 CLIProxyAPI 会一起拉起，或点「启动 Keeper」。'
    : keeper.eventsError
      ? keeper.eventsError
      : `已同步 ${keeper.totalCount || keeper.events?.length || 0} 条 · 今日`;
  if (hint && hint.textContent !== hintText) hint.textContent = hintText;
  const events = keeper.events ?? [];
  const html = !running
    ? '<p class="hint">还没有事件。Keeper 起来后会自动同步请求日志。</p>'
    : events.length
      ? `<table class="event-table">
          <thead><tr><th>时间</th><th>模型</th><th>来源</th><th>结果</th><th>延迟</th><th>Token</th></tr></thead>
          <tbody>${events.map(event => `
            <tr>
              <td>${escapeHtml(formatEventTime(event.timestamp))}</td>
              <td title="${escapeHtml(event.endpoint || event.model)}">${escapeHtml(event.model || '—')}</td>
              <td>${escapeHtml(event.source || '—')}</td>
              <td class="${event.failed ? 'fail' : 'ok'}">${event.failed ? '失败' : '成功'}</td>
              <td>${event.latencyMs ? `${event.latencyMs} ms` : '—'}</td>
              <td>${event.totalTokens || '—'}</td>
            </tr>`).join('')}</tbody>
        </table>`
      : '<p class="hint">今天还没有请求事件。</p>';
  setHtml($('keeper-events'), html);
}

function renderSettings() {
  if (document.activeElement && ['proxy-url', 'ide-path', 'app-path'].includes(document.activeElement.id)) return;
  $('proxy-enabled').checked = state.config.proxyEnabled;
  $('proxy-url').value = state.config.proxyUrl;
  $('ide-path').value = state.config.antigravity.idePath;
  $('app-path').value = state.config.antigravity.appPath;
}

function renderLogs() {
  const logs = state.logs || [];
  const tail = `${logs.length}:${logs[logs.length - 1] || ''}`;
  if (tail === lastLogTail) return;
  lastLogTail = tail;
  const node = $('log-view');
  const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
  node.textContent = logs.join('\n');
  if (atBottom) node.scrollTop = node.scrollHeight;
}

function render() {
  if (!state) return;
  renderAside();
  if (currentView === 'upstreams') renderUpstreams();
  else if (currentView === 'inject') renderInject();
  else if (currentView === 'local') renderLocal();
  else if (currentView === 'settings') renderSettings();
  else if (currentView === 'logs') renderLogs();
}

function scheduleRender() {
  if (renderFrame) return;
  renderFrame = requestAnimationFrame(() => {
    renderFrame = 0;
    render();
  });
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

async function toggleInjector(button) {
  if (state?.status?.injector?.running) await action(button, 'stopInjector');
  else await action(button, 'startInjector');
}

async function toggleCliproxy(button) {
  if (state?.status?.cliproxy?.running) await action(button, 'stopLocalEngine');
  else await action(button, 'startLocalEngine');
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

$('catalog-query').addEventListener('input', event => {
  catalogQuery = event.target.value;
  if (!state) return;
  renderCatalog(injectContext());
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
});

$('toggle-injector').addEventListener('click', event => toggleInjector(event.currentTarget));
$('aside-injector').addEventListener('click', event => toggleInjector(event.currentTarget));
$('aside-cliproxy').addEventListener('click', event => toggleCliproxy(event.currentTarget));
$('launch-app').addEventListener('click', event => action(event.currentTarget, 'launch', 'app'));
$('aside-launch-app').addEventListener('click', event => action(event.currentTarget, 'launch', 'app'));
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
$('start-keeper').addEventListener('click', event => action(event.currentTarget, 'startKeeper'));

$('launch-ide').addEventListener('click', event => action(event.currentTarget, 'launch', 'ide'));

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
  scheduleRender();
});

reload();
