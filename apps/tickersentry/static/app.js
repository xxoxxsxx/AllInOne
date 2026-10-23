const runButton = document.querySelector('#run');
const errorBack = document.querySelector('#error-back');
if (errorBack) {
  const referrer = document.referrer ? new URL(document.referrer) : null;
  if (referrer && referrer.origin === location.origin && history.length > 1) {
    errorBack.addEventListener('click', event => {
      event.preventDefault();
      history.back();
    });
  } else {
    errorBack.textContent = '返回首页';
  }
}
document.querySelectorAll('form[data-confirm]').forEach(form => {
  form.addEventListener('submit', event => {
    if (!confirm(form.dataset.confirm)) event.preventDefault();
  });
});
const stockForm = document.querySelector('#stock-form');
if (stockForm) stockForm.addEventListener('submit', event => {
  const symbol = stockForm.elements.symbol.value.trim().toUpperCase();
  if (symbol !== stockForm.dataset.originalSymbol && !confirm('修改代码会重新启用全部档位提醒。继续？')) event.preventDefault();
});
if (runButton) runButton.addEventListener('click', async () => {
  runButton.disabled = true;
  const msg = document.querySelector('#run-message');
  msg.textContent = '正在创建查询任务…';
  try {
    const response = await fetch(fetchBase('/api/runs'), {method: 'POST', headers: {'X-CSRF-Token': runButton.dataset.csrf}, signal: AbortSignal.timeout(15000)});
    if (!response.ok) throw new Error(await response.text());
    const run = await response.json();
    location.assign(appBase(`/runs/${run.id}`));
  } catch (error) { msg.textContent = error.name === 'TimeoutError' ? '请求超时，请重试；已有查询任务会继续运行。' : `查询未启动：${error.message}`; runButton.disabled = false; }
});
const table = document.querySelector('#results');
if (table && table.dataset.status === 'running') {
  const cells = [...table.querySelectorAll('tbody tr')];
  const formatter = new Intl.DateTimeFormat('zh-CN', {timeZone: table.dataset.timezone, dateStyle: 'medium', timeStyle: 'medium'});
  const clock = date => date ? formatter.format(new Date(date)) : '—';
  const message = document.querySelector('#poll-message');
  let finished = false;
  const status = value => ({running: '查询中', completed: '已完成', partial: '部分完成', failed: '失败', error: '失败', skipped: '已跳过', interrupted: '已中断', pending: '等待中', ok: '成功'})[value] || value;
  const poll = async () => {
    try {
      const response = await fetch(fetchBase(`/api/runs/${table.dataset.runId}`), {signal: AbortSignal.timeout(10000)});
      if (!response.ok) {
        if (response.status === 404) finished = true;
        throw new Error(response.status === 404 ? '查询记录已不存在，请返回监控概览。' : '暂时无法获取进度，将自动重试。');
      }
      const run = await response.json();
      message.textContent = '';
      document.querySelector('#run-progress').textContent = `${run.done} / ${run.total}`;
      document.querySelector('#reason').classList.toggle('info-strip', Boolean(run.reason));
      document.querySelector('#status').textContent = status(run.status);
      document.querySelector('#reason').textContent = run.reason;
      run.results.forEach((item, index) => {
        const td = cells[index]?.querySelectorAll('td');
        if (!td) return;
        [item.symbol, item.price || '—', item.open || '—', item.previous_close || '—', clock(item.quote_at), clock(item.fetched_at), item.source, item.time_field, item.delay, `${status(item.status)} ${item.error}`, item.alert_status].forEach((text, col) => td[col].textContent = text);
      });
      finished = run.status !== 'running';
    } catch (error) {
      message.textContent = error.name === 'TimeoutError' || error instanceof TypeError ? '连接暂时中断，保留上次结果并自动重试。' : error.message;
    } finally {
      if (!finished) setTimeout(poll, 2000);
    }
  };
  poll();
}

// Show the current section on all pages, including stock and query details.
// 子路径部署时导航链接带完整前缀，改为按链接路径结尾匹配当前分区。
const lastSegment = '/' + (location.pathname.split('/').filter(Boolean).pop() ?? '');
const section = lastSegment === '/settings' ? '/settings' : lastSegment === '/schedule' ? '/schedule' : '/';
document.querySelectorAll('nav a').forEach(a => {
  const href = a.getAttribute('href') ?? '';
  if (!href.endsWith(section)) return;
  if (section === '/' && href !== '/' && !href.endsWith('/')) return;
  a.setAttribute('aria-current', 'page');
});

// 子路径支持：应用 BASE_PATH 通过 body data 属性传入，fetch/跳转统一加前缀。
const BASE = document.body.dataset.base?.replace(/\/$/, '') ?? '';
const appBase = path => BASE + path;
const fetchBase = path => appBase(path);

// Completion notices float as transient toasts instead of staying in the page.
const toastStack = document.createElement('div');
toastStack.className = 'toast-stack';
toastStack.setAttribute('role', 'status');
toastStack.setAttribute('aria-live', 'polite');
const toast = text => {
  if (!text) return;
  // A native <dialog> renders in the top layer, so host toasts inside it while open.
  const host = document.querySelector('dialog[open]') || document.body;
  if (toastStack.parentElement !== host) host.appendChild(toastStack);
  const item = document.createElement('div');
  item.className = 'toast';
  const label = document.createElement('span');
  label.textContent = text;
  const close = document.createElement('button');
  close.type = 'button';
  close.setAttribute('aria-label', '关闭提示');
  close.textContent = '×';
  item.append(label, close);
  toastStack.append(item);
  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    item.classList.add('is-leaving');
    item.addEventListener('transitionend', () => item.remove(), {once: true});
    setTimeout(() => item.remove(), 400);
  };
  close.addEventListener('click', dismiss);
  timer = setTimeout(dismiss, 5000);
};
document.querySelectorAll('[data-flash]').forEach(el => {
  toast(el.textContent.trim());
  el.remove();
});

const stockDialog = document.querySelector('#stock-dialog');
if (stockDialog) {
  const form = document.querySelector('#add-stock-form');
  const message = document.querySelector('#add-stock-message');
  let changed = false;
  let saving = false;
  document.querySelectorAll('[data-add-stock]').forEach(button => button.addEventListener('click', () => stockDialog.showModal()));
  document.querySelector('#close-stock-dialog').addEventListener('click', () => { if (!saving) stockDialog.close(); });
  stockDialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  stockDialog.addEventListener('close', () => { if (changed) location.reload(); });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving) return;
    const next = event.submitter?.value;
    saving = true;
    form.querySelectorAll('button').forEach(button => button.disabled = true);
    message.textContent = '正在保存…';
    try {
      const response = await fetch(fetchBase('/stocks'), {method: 'POST', headers: {'Accept': 'application/json'}, body: new URLSearchParams(new FormData(form))});
      if (!response.ok) throw new Error(await response.text());
      const stock = await response.json();
      changed = true;
      if (next === 'levels') { location.assign(appBase(`/stocks/${stock.id}?flash=stock_added#add-level`)); return; }
      form.reset();
      message.textContent = '';
      toast(`已添加 ${stock.symbol}。可以继续添加下一只，关闭窗口后在列表设置提醒。`);
      form.elements.symbol.focus();
    } catch (error) {
      message.textContent = error instanceof TypeError ? '连接中断，保存结果未知。请关闭窗口并刷新列表确认后再试。' : error.message;
    } finally {
      saving = false;
      form.querySelectorAll('button').forEach(button => button.disabled = false);
    }
  });
}
const stockSearch = document.querySelector('#stock-search');
if (stockSearch) {
  const filter = document.querySelector('#stock-filter');
  const rows = [...document.querySelectorAll('.watch-item')];
  const update = () => {
    const query = stockSearch.value.trim().toLocaleLowerCase();
    let count = 0;
    rows.forEach(row => {
      const matches = `${row.dataset.symbol} ${row.dataset.note}`.toLocaleLowerCase().includes(query);
      const capped = row.dataset.capped === 'true';
      const status = filter.value === 'all' || (filter.value === 'active' && row.dataset.enabled === 'true' && !capped) || (filter.value === 'paused' && row.dataset.enabled === 'false') || (filter.value === 'capped' && capped);
      row.hidden = !matches || !status;
      if (!row.hidden) count++;
    });
    document.querySelector('#stock-count').textContent = `显示 ${count} / ${rows.length} 只`;
    document.querySelector('#no-stock-match').hidden = count !== 0;
  };
  stockSearch.addEventListener('input', update);
  filter.addEventListener('change', update);
  update();
}
