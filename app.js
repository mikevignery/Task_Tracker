/* Task Tracker - plain JS, no build step.
 * Hierarchy: Project -> Task -> (Task Notes, Work Logs -> Work Log Notes)
 * All user-supplied text is rendered with textContent (never innerHTML). */
(function () {
  'use strict';

  // ---------------------------------------------------------------- setup
  const cfg = window.TASK_TRACKER_CONFIG || {};
  const configured = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY &&
    !/YOUR-/.test(cfg.SUPABASE_URL + cfg.SUPABASE_ANON_KEY));
  let db = window.__TEST_DB__ || null;
  const makeClient = () => {
    if (!db && configured && window.supabase && window.supabase.createClient) {
      db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    }
  };
  // If the first CDN was blocked/unreachable, try backups before giving up.
  const LIB_URLS = [
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js',
    'https://unpkg.com/@supabase/supabase-js@2/dist/umd/supabase.js',
    'https://cdnjs.cloudflare.com/ajax/libs/supabase-js/2.45.4/umd/supabase.min.js'
  ];
  async function ensureLibrary() {
    for (const url of LIB_URLS) {
      if (window.supabase && window.supabase.createClient) return true;
      await new Promise((resolve) => {
        const s = document.createElement('script');
        s.src = url; s.onload = resolve; s.onerror = resolve;
        document.head.appendChild(s);
      });
    }
    return !!(window.supabase && window.supabase.createClient);
  }
  makeClient();

  const state = { user: null, projects: [], tasks: [], running: null };
  const $app = document.getElementById('app');
  const STATUSES = [['todo', 'To do'], ['in_progress', 'In progress'], ['blocked', 'Blocked'], ['done', 'Done']];
  const PRIORITIES = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']];
  const PROJECT_STATUSES = [['active', 'Active'], ['on_hold', 'On hold'], ['done', 'Done'], ['archived', 'Archived']];
  const label = (list, v) => (list.find(x => x[0] === v) || [v, v])[1];

  // -------------------------------------------------------------- helpers
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.appendChild(typeof kid === 'object' ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const must = (res) => { if (res && res.error) throw new Error(res.error.message || String(res.error)); return res ? res.data : null; };
  const nul = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());
  const fmtMin = (m) => { m = Math.max(0, Math.round(m || 0)); const hr = Math.floor(m / 60), mm = m % 60; return hr ? `${hr}h ${String(mm).padStart(2, '0')}m` : `${mm}m`; };
  const fmtDT = (s) => { const d = new Date(s); return isNaN(d) ? '' : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); };
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = () => ymd(new Date());
  const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return ymd(d); };
  // Chart / pill colours (mirrored in style.css)
  const COLORS = { todo: '#38bdf8', in_progress: '#2dd4bf', blocked: '#fbbf24', done: '#4ade80' };
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function s(tag, props, ...kids) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(props || {})) if (v != null) el.setAttribute(k, v);
    for (const kid of kids.flat(Infinity)) { if (kid == null) continue; el.appendChild(typeof kid === 'object' ? kid : document.createTextNode(String(kid))); }
    return el;
  }
  const projectName = (id) => (state.projects.find(p => p.id === id) || {}).name || null;
  const taskLabel = (t) => (t.project_id && projectName(t.project_id) ? projectName(t.project_id) + ' › ' : '') + t.title;

  function toast(msg, isErr) {
    const box = document.getElementById('toasts');
    if (!box) return;
    const t = h('div', { class: 'toast' + (isErr ? ' err' : ''), role: isErr ? 'alert' : 'status' }, msg);
    box.appendChild(t);
    setTimeout(() => t.remove(), isErr ? 6000 : 2800);
  }
  async function guard(fn) { try { return await fn(); } catch (e) { toast(e.message || String(e), true); return undefined; } }

  // ---------------------------------------------------------- form modal
  function fillSelect(sel, options, current) {
    sel.replaceChildren(...options.map(o => h('option', { value: o.value }, o.label)));
    const has = options.some(o => String(o.value) === String(current));
    sel.value = has ? current : (options[0] ? options[0].value : '');
  }

  /** fields: {name,label,type,required,options|fn(values),dependsOn}. Returns the modal element. */
  function openForm({ title, fields, values = {}, submitLabel = 'Save', onSubmit }) {
    const inputs = {};
    const err = h('div', { class: 'error', role: 'alert' });
    const form = h('form', { novalidate: true });
    const current = () => { const o = {}; for (const f of fields) o[f.name] = inputs[f.name].value; return o; };

    for (const f of fields) {
      let input;
      const id = 'f_' + f.name;
      if (f.type === 'select') input = h('select', { name: f.name, id });
      else if (f.type === 'textarea') input = h('textarea', { name: f.name, id, rows: 4 });
      else input = h('input', { name: f.name, id, type: f.type || 'text', min: f.type === 'number' ? 0 : null });
      inputs[f.name] = input;
      form.appendChild(h('div', { class: 'field' }, h('label', { for: id }, f.label + (f.required ? ' *' : '')), input));
    }
    const populate = (f, keepValue) => {
      const opts = typeof f.options === 'function' ? f.options(current()) : f.options;
      fillSelect(inputs[f.name], opts, keepValue);
    };
    for (const f of fields) {
      if (f.type === 'select') populate(f, values[f.name]);
      else inputs[f.name].value = values[f.name] == null ? '' : values[f.name];
    }
    for (const f of fields) {
      if (f.dependsOn) inputs[f.dependsOn].addEventListener('change', () => populate(f, null));
    }

    const cancel = h('button', { type: 'button', class: 'btn' }, 'Cancel');
    const save = h('button', { type: 'submit', class: 'btn primary' }, submitLabel);
    form.appendChild(err);
    form.appendChild(h('div', { class: 'form-actions' }, cancel, save));

    const overlay = h('div', { class: 'overlay' }, h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('h2', null, title), form));
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    cancel.addEventListener('click', close);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      const vals = current();
      for (const f of fields) if (f.required && !String(vals[f.name]).trim()) { err.textContent = `${f.label} is required.`; inputs[f.name].focus(); return; }
      save.disabled = true;
      try { await onSubmit(vals); close(); }
      catch (ex) { err.textContent = ex.message || String(ex); save.disabled = false; }
    });
    document.body.appendChild(overlay);
    const first = fields.find(f => f.type !== 'select') || fields[0];
    inputs[first.name].focus();
    return overlay;
  }

  // ------------------------------------------------- dropdown option lists
  const projectOptions = () => [{ value: '', label: '— No project —' }].concat(
    state.projects.filter(p => p.status !== 'archived').map(p => ({ value: p.id, label: p.name })));
  const projectOptionsIncluding = (id) => {
    const opts = projectOptions();
    if (id && !opts.some(o => o.value === id)) opts.push({ value: id, label: projectName(id) || 'Project' });
    return opts;
  };
  const taskOptions = () => state.tasks.map(t => ({ value: t.id, label: taskLabel(t) }));
  const statusOptions = (list) => list.map(([value, l]) => ({ value, label: l }));

  // ------------------------------------------------------------ data layer
  async function loadCore() {
    state.projects = must(await db.from('projects').select('*').order('name', { ascending: true })) || [];
    state.tasks = must(await db.from('tasks').select('*').order('created_at', { ascending: false })) || [];
    const run = must(await db.from('work_logs').select('*').not('timer_started_at', 'is', null)) || [];
    state.running = run[0] || null;
    updateTimerUI();
  }
  async function saveRow(table, id, payload) {
    if (id) must(await db.from(table).update(payload).eq('id', id));
    else must(await db.from(table).insert(payload));
  }
  async function deleteRow(table, id, what) {
    if (!window.confirm(`Delete this ${what}? This cannot be undone.`)) return false;
    must(await db.from(table).delete().eq('id', id));
    return true;
  }

  // ------------------------------------------------------------ entity forms
  function projectForm(p) {
    openForm({
      title: p ? 'Edit project' : 'New project', values: p || { status: 'active' },
      fields: [
        { name: 'name', label: 'Name', required: true },
        { name: 'description', label: 'Description', type: 'textarea' },
        { name: 'status', label: 'Status', type: 'select', options: statusOptions(PROJECT_STATUSES) }
      ],
      onSubmit: async (v) => {
        await saveRow('projects', p && p.id, { name: v.name.trim(), description: nul(v.description), status: v.status });
        await loadCore(); render();
      }
    });
  }

  /** Task form. `prefill.project_id` is the auto-populated parent. */
  function taskForm(t, prefill = {}) {
    const vals = t || Object.assign({ status: 'todo', priority: 'medium', project_id: '' }, prefill);
    openForm({
      title: t ? 'Edit task' : 'New task', values: vals,
      fields: [
        { name: 'project_id', label: 'Project', type: 'select', options: () => projectOptionsIncluding(vals.project_id) },
        { name: 'title', label: 'Title', required: true },
        { name: 'description', label: 'Description', type: 'textarea' },
        { name: 'status', label: 'Status', type: 'select', options: statusOptions(STATUSES) },
        { name: 'priority', label: 'Priority', type: 'select', options: statusOptions(PRIORITIES) },
        { name: 'due_date', label: 'Due date', type: 'date' }
      ],
      onSubmit: async (v) => {
        await saveRow('tasks', t && t.id, {
          project_id: nul(v.project_id), title: v.title.trim(), description: nul(v.description),
          status: v.status, priority: v.priority, due_date: nul(v.due_date)
        });
        await loadCore(); render();
      }
    });
  }

  function taskNoteForm(n, prefill = {}) {
    openForm({
      title: n ? 'Edit task note' : 'New task note', values: n || prefill,
      fields: [
        { name: 'task_id', label: 'Task', type: 'select', required: true, options: taskOptions },
        { name: 'body', label: 'Note', type: 'textarea', required: true }
      ],
      onSubmit: async (v) => { await saveRow('task_notes', n && n.id, { task_id: v.task_id, body: v.body.trim() }); render(); }
    });
  }

  function workLogForm(w, prefill = {}) {
    openForm({
      title: w ? 'Edit work log' : 'New work log', values: w || Object.assign({ work_date: today(), minutes: 30 }, prefill),
      fields: [
        { name: 'task_id', label: 'Task', type: 'select', required: true, options: taskOptions },
        { name: 'work_date', label: 'Date', type: 'date', required: true },
        { name: 'minutes', label: 'Minutes worked', type: 'number', required: true },
        { name: 'summary', label: 'What did you do?', type: 'textarea' }
      ],
      onSubmit: async (v) => {
        const minutes = parseInt(v.minutes, 10);
        if (isNaN(minutes) || minutes < 0) throw new Error('Minutes must be 0 or more.');
        await saveRow('work_logs', w && w.id, { task_id: v.task_id, work_date: v.work_date, minutes, summary: nul(v.summary) });
        render();
      }
    });
  }

  /** Two chained dropdowns: Task, then that task's Work Log. Both auto-populate. */
  async function workLogNoteForm(n, prefill = {}) {
    const logs = must(await db.from('work_logs').select('id,task_id,work_date,minutes,summary').order('work_date', { ascending: false })) || [];
    const logToTask = (id) => (logs.find(l => l.id === id) || {}).task_id;
    const startLog = n ? n.work_log_id : prefill.work_log_id;
    const startTask = prefill.task_id || logToTask(startLog) || (state.tasks[0] || {}).id;
    const logLabel = (l) => `${l.work_date} · ${fmtMin(l.minutes)}${l.summary ? ' · ' + l.summary.slice(0, 50) : ''}`;
    openForm({
      title: n ? 'Edit work log note' : 'New work log note',
      values: { task_id: startTask, work_log_id: startLog, body: n ? n.body : '' },
      fields: [
        { name: 'task_id', label: 'Task', type: 'select', options: taskOptions },
        { name: 'work_log_id', label: 'Work log', type: 'select', required: true, dependsOn: 'task_id',
          options: (cur) => logs.filter(l => l.task_id === cur.task_id).map(l => ({ value: l.id, label: logLabel(l) })) },
        { name: 'body', label: 'Note', type: 'textarea', required: true }
      ],
      onSubmit: async (v) => {
        if (!v.work_log_id) throw new Error('This task has no work logs yet. Add a work log first.');
        await saveRow('work_log_notes', n && n.id, { work_log_id: v.work_log_id, body: v.body.trim() });
        render();
      }
    });
  }

  // ----------------------------------------------------------------- timer
  let tick = null;
  function elapsedMin(startIso) { return (Date.now() - new Date(startIso).getTime()) / 60000; }
  function updateTimerUI() {
    const box = document.getElementById('timer');
    if (!box) return;
    clearInterval(tick);
    if (!state.running) { box.hidden = true; return; }
    const t = state.tasks.find(x => x.id === state.running.task_id);
    box.hidden = false;
    const link = document.getElementById('timer-link');
    link.textContent = t ? t.title : 'Running timer';
    link.setAttribute('href', '#/task/' + state.running.task_id);
    const clock = document.getElementById('timer-clock');
    const paint = () => {
      const s = Math.max(0, Math.floor((Date.now() - new Date(state.running.timer_started_at).getTime()) / 1000));
      clock.textContent = [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(n => String(n).padStart(2, '0')).join(':');
    };
    paint(); tick = setInterval(paint, 1000);
  }
  async function startTimer(taskId) {
    if (state.running) { toast('A timer is already running. Stop it first.', true); return; }
    must(await db.from('work_logs').insert({ task_id: taskId, work_date: today(), minutes: 0, timer_started_at: new Date().toISOString() }));
    await loadCore(); render();
  }
  async function stopTimer() {
    const w = state.running; if (!w) return;
    const total = (w.minutes || 0) + Math.max(1, Math.round(elapsedMin(w.timer_started_at)));
    must(await db.from('work_logs').update({ minutes: total, timer_started_at: null }).eq('id', w.id));
    await loadCore(); render();
    toast(`Timer stopped: ${fmtMin(total)} logged.`);
  }

  // ----------------------------------------------------------- shared bits
  function badge(text, cls) { return h('span', { class: 'badge ' + (cls || '') }, text); }
  function pageHead(title, sub, actions, crumbs) {
    return h('div', { class: 'page-head' },
      h('div', { class: 'grow' }, crumbs ? h('div', { class: 'crumbs' }, crumbs) : null, h('h1', null, title), sub ? h('div', { class: 'muted' }, sub) : null),
      h('div', { class: 'actions' }, actions));
  }
  const btn = (text, onclick, cls) => h('button', { type: 'button', class: 'btn ' + (cls || ''), onclick: () => guard(onclick) }, text);
  function isOverdue(t) { return t.due_date && t.status !== 'done' && t.due_date < today(); }

  function taskTable(tasks, showProject) {
    if (!tasks.length) return h('div', { class: 'empty' }, 'No tasks to show.');
    return h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Task'), showProject ? h('th', null, 'Project') : null, h('th', null, 'Status'), h('th', null, 'Priority'), h('th', null, 'Due'))),
      h('tbody', null, tasks.map(t => h('tr', { 'data-task-id': t.id },
        h('td', null, h('a', { href: '#/task/' + t.id }, t.title)),
        showProject ? h('td', null, t.project_id ? h('a', { href: '#/project/' + t.project_id }, projectName(t.project_id) || '') : h('span', { class: 'muted' }, '—')) : null,
        h('td', null, badge(label(STATUSES, t.status), 's-' + t.status)),
        h('td', null, badge(label(PRIORITIES, t.priority), 'p-' + t.priority)),
        h('td', null, t.due_date ? badge(t.due_date, isOverdue(t) ? 'overdue' : '') : h('span', { class: 'muted' }, '—')))))));
  }

  // ------------------------------------------------------------------ views
  function viewProjects() {
    const counts = {};
    for (const t of state.tasks) { const c = counts[t.project_id] || (counts[t.project_id] = { open: 0, all: 0 }); c.all++; if (t.status !== 'done') c.open++; }
    const inbox = counts[null] || counts['null'] || { open: 0, all: 0 };
    return [
      pageHead('Projects', 'Projects only exist when you create them.', btn('+ New project', () => projectForm(null), 'primary')),
      h('div', { class: 'card' }, state.projects.length ? h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Project'), h('th', null, 'Status'), h('th', null, 'Open tasks'))),
        h('tbody', null, state.projects.map(p => h('tr', { 'data-project-id': p.id },
          h('td', null, h('a', { href: '#/project/' + p.id }, p.name)),
          h('td', null, badge(label(PROJECT_STATUSES, p.status), 'ps-' + p.status)),
          h('td', null, `${(counts[p.id] || { open: 0 }).open} of ${(counts[p.id] || { all: 0 }).all}`))))))
        : h('div', { class: 'empty' }, 'No projects yet. Tasks can exist without one.')),
      h('p', { class: 'muted small' }, `Tasks with no project: ${inbox.all} (${inbox.open} open). `, h('a', { href: '#/tasks?project=none' }, 'View'))
    ];
  }

  function viewProject(id) {
    const p = state.projects.find(x => x.id === id);
    if (!p) return h('p', null, 'Project not found. ', h('a', { href: '#/projects' }, 'Back to projects'));
    const tasks = state.tasks.filter(t => t.project_id === id);
    return [
      pageHead(p.name, p.description, [
        btn('+ New task', () => taskForm(null, { project_id: id }), 'primary'),
        btn('Edit', () => projectForm(p)),
        btn('Delete', async () => { if (await deleteRow('projects', id, 'project (its tasks are kept, just unassigned)')) { await loadCore(); location.hash = '#/projects'; } }, 'danger')
      ], h('a', { href: '#/projects' }, '‹ Projects')),
      h('div', { class: 'card' }, badge(label(PROJECT_STATUSES, p.status), 'ps-' + p.status), ' ', taskTable(tasks, false))
    ];
  }

  function parseQuery() { const q = (location.hash.split('?')[1] || ''); return new URLSearchParams(q); }
  function viewTasks() {
    const q = parseQuery();
    const f = { status: q.get('status') || 'open', project: q.get('project') || 'all', text: q.get('q') || '' };
    const setF = (k, v) => { f[k] = v; const sp = new URLSearchParams(); if (f.status !== 'open') sp.set('status', f.status); if (f.project !== 'all') sp.set('project', f.project); if (f.text) sp.set('q', f.text); history.replaceState(null, '', '#/tasks' + (sp.toString() ? '?' + sp : '')); draw(); };
    const listBox = h('div', { class: 'card' });
    const draw = () => {
      const rows = state.tasks.filter(t =>
        (f.status === 'all' || (f.status === 'overdue' ? isOverdue(t) : f.status === 'open' ? t.status !== 'done' : t.status === f.status)) &&
        (f.project === 'all' || (f.project === 'none' ? !t.project_id : t.project_id === f.project)) &&
        (!f.text || (t.title + ' ' + (t.description || '')).toLowerCase().includes(f.text.toLowerCase())));
      listBox.replaceChildren(taskTable(rows, true));
    };
    const sel = (opts, val, cb, name) => { const s = h('select', { name, 'aria-label': name }); fillSelect(s, opts, val); s.addEventListener('change', () => cb(s.value)); return s; };
    const search = h('input', { type: 'search', placeholder: 'Search tasks…', 'aria-label': 'search' }); search.value = f.text;
    search.addEventListener('input', () => { f.text = search.value; draw(); });
    draw();
    const newTaskProject = () => (f.project !== 'all' && f.project !== 'none' ? f.project : '');
    return [
      pageHead('Tasks', null, btn('+ New task', () => taskForm(null, { project_id: newTaskProject() }), 'primary')),
      h('div', { class: 'filters' },
        sel([{ value: 'open', label: 'Open' }, { value: 'overdue', label: 'Overdue' }, { value: 'all', label: 'All statuses' }].concat(statusOptions(STATUSES)), f.status, v => setF('status', v), 'status'),
        sel([{ value: 'all', label: 'All projects' }, { value: 'none', label: 'No project' }].concat(state.projects.map(p => ({ value: p.id, label: p.name }))), f.project, v => setF('project', v), 'project'),
        search),
      listBox
    ];
  }

  async function viewTask(id) {
    const t = must(await db.from('tasks').select('*').eq('id', id).maybeSingle());
    if (!t) return h('p', null, 'Task not found. ', h('a', { href: '#/tasks' }, 'Back to tasks'));
    const notes = must(await db.from('task_notes').select('*').eq('task_id', id).order('created_at', { ascending: false })) || [];
    const logs = must(await db.from('work_logs').select('*').eq('task_id', id).order('work_date', { ascending: false })) || [];
    const logNotes = logs.length ? (must(await db.from('work_log_notes').select('*').in('work_log_id', logs.map(l => l.id)).order('created_at', { ascending: true })) || []) : [];

    const totalMin = logs.reduce((s, l) => s + (l.minutes || 0), 0);
    const noteEl = (n, onEdit, table, what) => h('div', { class: 'note', 'data-note-id': n.id },
      h('div', { class: 'meta' }, fmtDT(n.created_at),
        h('button', { type: 'button', class: 'btn link small', onclick: () => guard(onEdit) }, 'Edit'),
        h('button', { type: 'button', class: 'btn link small del', onclick: () => guard(async () => { if (await deleteRow(table, n.id, what)) render(); }) }, 'Delete')),
      h('div', { class: 'body' }, n.body));

    const proj = t.project_id ? state.projects.find(p => p.id === t.project_id) : null;
    return [
      pageHead(t.title, t.description, [
        btn('Edit', () => taskForm(t)),
        btn('Delete', async () => { if (await deleteRow('tasks', id, 'task (with its notes and work logs)')) { await loadCore(); location.hash = '#/tasks'; } }, 'danger')
      ], [h('a', { href: '#/tasks' }, 'Tasks'), ' › ', proj ? h('a', { href: '#/project/' + proj.id }, proj.name) : 'No project']),
      h('div', { class: 'card' },
        badge(label(STATUSES, t.status), 's-' + t.status), ' ', badge(label(PRIORITIES, t.priority), 'p-' + t.priority), ' ',
        t.due_date ? badge('Due ' + t.due_date, isOverdue(t) ? 'overdue' : '') : null, ' ',
        t.source === 'transcript' ? badge('From transcript') : null, ' ', h('span', { class: 'muted small' }, `Total logged: ${fmtMin(totalMin)}`)),

      h('div', { class: 'card', id: 'notes-card' },
        h('div', { class: 'card-head' }, h('h2', { class: 'grow' }, `Notes (${notes.length})`),
          btn('+ New note', () => taskNoteForm(null, { task_id: id }), 'small')),
        notes.length ? notes.map(n => noteEl(n, () => taskNoteForm(n), 'task_notes', 'note')) : h('div', { class: 'empty' }, 'No notes yet.')),

      h('div', { class: 'card', id: 'logs-card' },
        h('div', { class: 'card-head' }, h('h2', { class: 'grow' }, `Work logs (${logs.length})`),
          state.running && state.running.task_id === id ? null : btn('⏱ Start timer', () => startTimer(id), 'small'),
          btn('+ New work log', () => workLogForm(null, { task_id: id }), 'small')),
        logs.length ? logs.map(w => {
          const mine = logNotes.filter(n => n.work_log_id === w.id);
          const running = !!w.timer_started_at;
          return h('div', { class: 'log' + (running ? ' running' : ''), 'data-log-id': w.id },
            h('div', { class: 'card-head' },
              h('h3', { class: 'grow' }, w.work_date, ' · ', running ? 'timer running…' : fmtMin(w.minutes)),
              running ? null : h('button', { type: 'button', class: 'btn link small', onclick: () => guard(() => workLogForm(w)) }, 'Edit'),
              h('button', { type: 'button', class: 'btn link small del', onclick: () => guard(async () => { if (await deleteRow('work_logs', w.id, 'work log (with its notes)')) { await loadCore(); render(); } }) }, 'Delete'),
              btn('+ Note', () => workLogNoteForm(null, { task_id: id, work_log_id: w.id }), 'small')),
            w.summary ? h('div', { class: 'body', style: 'white-space:pre-wrap' }, w.summary) : null,
            mine.length ? h('div', { class: 'log-notes' }, mine.map(n => noteEl(n, () => workLogNoteForm(n, { task_id: id }), 'work_log_notes', 'work log note'))) : null);
        }) : h('div', { class: 'empty' }, 'No work logged yet.'))
    ];
  }

  // ------------------------------------------------------------- dashboard
  function grad(id, c1, c2) {
    return s('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 }, s('stop', { offset: '0%', 'stop-color': c1 }), s('stop', { offset: '100%', 'stop-color': c2 }));
  }
  function donut(segments, total) {
    const R = 54, C = 2 * Math.PI * R;
    const svg = s('svg', { viewBox: '0 0 140 140', class: 'donut', role: 'img', 'aria-label': 'Tasks by status: ' + segments.map(g => `${g.label} ${g.value}`).join(', ') },
      s('circle', { cx: 70, cy: 70, r: R, fill: 'none', stroke: 'rgba(148,197,255,.14)', 'stroke-width': 16 }));
    let off = 0;
    for (const g of segments) {
      if (!g.value || !total) continue;
      const len = g.value / total * C, dash = Math.max(len - 3, 0.5);
      svg.appendChild(s('circle', { cx: 70, cy: 70, r: R, fill: 'none', stroke: g.color, 'stroke-width': 16, 'stroke-dasharray': `${dash} ${C - dash}`, 'stroke-dashoffset': -off, transform: 'rotate(-90 70 70)', class: 'seg' }, s('title', null, `${g.label}: ${g.value}`)));
      off += len;
    }
    svg.appendChild(s('text', { x: 70, y: 70, 'text-anchor': 'middle', class: 'donut-num' }, String(total)));
    svg.appendChild(s('text', { x: 70, y: 88, 'text-anchor': 'middle', class: 'donut-sub' }, total === 1 ? 'task' : 'tasks'));
    return svg;
  }
  function hoursChart(days) {
    const W = 600, H = 230, L = 34, Rr = 8, T = 22, B = 36;
    const maxH = Math.max(1, Math.ceil(Math.max(...days.map(d => d.minutes)) / 60));
    const iw = W - L - Rr, ih = H - T - B, slot = iw / days.length, bw = slot * 0.62;
    const yOf = (hrs) => T + ih - (hrs / maxH) * ih;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img',
      'aria-label': 'Hours logged per day over the last 14 days: ' + days.map(d => `${d.date} ${fmtMin(d.minutes)}`).join(', ') },
      s('defs', null, grad('gBar', '#2dd4bf', '#1d4ed8'), grad('gToday', '#a5f3fc', '#14b8a6')));
    for (const v of [0, maxH / 2, maxH]) {
      svg.appendChild(s('line', { x1: L, x2: W - Rr, y1: yOf(v), y2: yOf(v), class: 'grid' }));
      svg.appendChild(s('text', { x: L - 6, y: yOf(v) + 3.5, 'text-anchor': 'end', class: 'axis' }, `${v}h`));
    }
    days.forEach((d, i) => {
      const hrs = d.minutes / 60, x = L + i * slot + (slot - bw) / 2;
      const hgt = d.minutes > 0 ? Math.max(3, (hrs / maxH) * ih) : 0;
      if (hgt) {
        svg.appendChild(s('rect', { x, y: T + ih - hgt, width: bw, height: hgt, rx: 4, class: 'bar', style: `animation-delay:${i * 35}ms`,
          fill: i === days.length - 1 ? 'url(#gToday)' : 'url(#gBar)' }, s('title', null, `${d.date}: ${fmtMin(d.minutes)}`)));
        svg.appendChild(s('text', { x: x + bw / 2, y: T + ih - hgt - 5, 'text-anchor': 'middle', class: 'val' }, hrs >= 10 ? Math.round(hrs) : hrs.toFixed(1)));
      }
      const dt = new Date(d.date + 'T00:00:00');
      svg.appendChild(s('text', { x: x + bw / 2, y: H - 20, 'text-anchor': 'middle', class: 'axis' + (i === days.length - 1 ? ' today' : '') }, 'SMTWTFS'[dt.getDay()]));
      svg.appendChild(s('text', { x: x + bw / 2, y: H - 7, 'text-anchor': 'middle', class: 'axis' + (i === days.length - 1 ? ' today' : '') }, String(dt.getDate())));
    });
    if (days.every(d => d.minutes === 0)) svg.appendChild(s('text', { x: W / 2, y: T + ih / 2, 'text-anchor': 'middle', class: 'axis empty-msg' }, 'No time logged yet – start a timer or add a work log'));
    return svg;
  }

  async function viewDashboard() {
    const logs = must(await db.from('work_logs').select('id,task_id,work_date,minutes,timer_started_at,created_at').gte('work_date', daysAgo(13))) || [];
    const openTasks = state.tasks.filter(t => t.status !== 'done');
    const overdue = openTasks.filter(isOverdue);
    const weekMin = logs.filter(l => l.work_date >= daysAgo(6)).reduce((a, l) => a + (l.minutes || 0), 0);
    const doneWeek = state.tasks.filter(t => t.status === 'done' && Date.now() - new Date(t.updated_at).getTime() < 7 * 864e5).length;
    const activeProjects = state.projects.filter(p => p.status === 'active');
    const days = [];
    for (let i = 13; i >= 0; i--) { const date = daysAgo(i); days.push({ date, minutes: logs.filter(l => l.work_date === date).reduce((a, l) => a + (l.minutes || 0), 0) }); }
    const statusCounts = STATUSES.map(([k, l]) => ({ key: k, label: l, color: COLORS[k], value: state.tasks.filter(t => t.status === k).length }));

    const hr = new Date().getHours();
    const greeting = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
    const tile = (val, lab, sub, cls, href) => h(href ? 'a' : 'div', { class: 'kpi ' + cls, href: href || null },
      h('div', { class: 'kpi-val' }, val), h('div', { class: 'kpi-label' }, lab), sub ? h('div', { class: 'kpi-sub' }, sub) : null);

    // quick-create defaults: the running task, else an in-progress task, else the first open task
    const defaultTaskId = () => (state.running && state.running.task_id) || (openTasks.find(t => t.status === 'in_progress') || openTasks[0] || state.tasks[0] || {}).id;
    const recentLog = logs.slice().sort((a, b) => (b.work_date + b.created_at).localeCompare(a.work_date + a.created_at))[0];
    const needTask = (fn) => () => { const id = defaultTaskId(); if (!id) { toast('Create a task first.', true); return; } fn(id); };

    // per-project stats
    const stats = activeProjects.map(p => {
      const ts = state.tasks.filter(t => t.project_id === p.id);
      const done = ts.filter(t => t.status === 'done').length;
      return { p, total: ts.length, done, open: ts.length - done, over: ts.filter(isOverdue).length };
    }).sort((a, b) => b.open - a.open || a.p.name.localeCompare(b.p.name));
    const unassigned = state.tasks.filter(t => !t.project_id);
    const unassignedOpen = unassigned.filter(t => t.status !== 'done').length;

    const projectCard = (name, href, st, onAdd) => {
      const pct = st.total ? Math.round(st.done / st.total * 100) : 0;
      return h('div', { class: 'proj-card' },
        h('div', { class: 'proj-top' }, h('a', { class: 'proj-name', href }, name), st.over ? badge(`${st.over} overdue`, 'overdue') : null),
        h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': `${name} progress` }, h('span', { style: `width:${pct}%` })),
        h('div', { class: 'proj-meta' }, h('span', null, `${st.done}/${st.total} done`), badge(`${st.open} open`, 's-in_progress'), h('span', { class: 'pct' }, pct + '%')),
        h('div', { class: 'actions' }, h('a', { class: 'btn small', href }, 'Open'), btn('+ Task', onAdd, 'small')));
    };

    // workload (open tasks per project)
    const load = stats.map(x => ({ name: x.p.name, href: '#/project/' + x.p.id, n: x.open }));
    if (unassignedOpen) load.push({ name: 'No project', href: '#/tasks?project=none', n: unassignedOpen });
    load.sort((a, b) => b.n - a.n); const top = load.slice(0, 6), maxLoad = Math.max(1, ...top.map(x => x.n));
    const prio = PRIORITIES.slice().reverse().map(([k, l]) => badge(`${l} · ${openTasks.filter(t => t.priority === k).length}`, 'p-' + k));

    const pw = { high: 0, medium: 1, low: 2 };
    const attention = openTasks.slice().sort((a, b) => (isOverdue(b) ? 1 : 0) - (isOverdue(a) ? 1 : 0) ||
      (a.due_date || '9999').localeCompare(b.due_date || '9999') || pw[a.priority] - pw[b.priority]).slice(0, 10);

    return [
      h('section', { class: 'hero' },
        h('div', null, h('h1', null, greeting), h('div', { class: 'hero-sub' },
          new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }), ' • ',
          `${openTasks.length} open task${openTasks.length === 1 ? '' : 's'}`, overdue.length ? `, ${overdue.length} overdue` : '')),
        h('div', { class: 'quick', id: 'quick-create' },
          btn('+ Project', () => projectForm(null), 'primary'),
          btn('+ Task', () => taskForm(null, { project_id: '' }), 'primary'),
          btn('+ Work log', needTask(id => workLogForm(null, { task_id: id })), 'primary'),
          btn('+ Task note', needTask(id => taskNoteForm(null, { task_id: id })), 'ghost'),
          btn('+ Work log note', needTask(id => workLogNoteForm(null, recentLog ? { task_id: recentLog.task_id, work_log_id: recentLog.id } : { task_id: id })), 'ghost'))),

      h('section', { class: 'kpis' },
        tile(activeProjects.length, 'Active projects', `${state.projects.length} total`, 'k-teal', '#/projects'),
        tile(openTasks.length, 'Open tasks', `${state.tasks.length} all-time`, 'k-blue', '#/tasks'),
        tile(overdue.length, 'Overdue', overdue.length ? 'Needs attention' : 'All caught up', 'k-red', '#/tasks?status=overdue'),
        tile(doneWeek, 'Done this week', 'last 7 days', 'k-green', '#/tasks?status=done'),
        tile(fmtMin(weekMin), 'Time this week', 'last 7 days', 'k-cyan')),

      h('section', { class: 'charts' },
        h('div', { class: 'panel' }, h('h2', null, 'Tasks by status'),
          h('div', { class: 'donut-wrap' }, donut(statusCounts, state.tasks.length),
            h('ul', { class: 'legend' }, statusCounts.map(g => h('li', null, badge(g.label, 's-' + g.key), h('b', null, g.value)))))),
        h('div', { class: 'panel wide' }, h('h2', null, 'Hours logged · last 14 days'), hoursChart(days)),
        h('div', { class: 'panel' }, h('h2', null, 'Open work by project'),
          top.length ? h('div', { class: 'hbars' }, top.map((x, i) => h('a', { class: 'hrow c' + (i % 6), href: x.href },
            h('span', { class: 'hname' }, x.name), h('span', { class: 'htrack' }, h('span', { class: 'hfill', style: `width:${Math.max(6, x.n / maxLoad * 100)}%` })), h('b', null, x.n))))
            : h('div', { class: 'empty' }, 'Nothing open. Nice.'),
          h('div', { class: 'pill-row' }, prio))),

      h('section', null,
        h('div', { class: 'section-head' }, h('h2', null, 'Active projects'), h('a', { href: '#/projects' }, 'All projects ›')),
        (stats.length || unassigned.length) ? h('div', { class: 'proj-grid' },
          stats.map(x => projectCard(x.p.name, '#/project/' + x.p.id, x, () => taskForm(null, { project_id: x.p.id }))),
          unassigned.length ? projectCard('No project', '#/tasks?project=none', { total: unassigned.length, done: unassigned.length - unassignedOpen, open: unassignedOpen, over: unassigned.filter(isOverdue).length }, () => taskForm(null, { project_id: '' })) : null)
          : h('div', { class: 'panel empty' }, 'No active projects yet. Use “+ Project” above to create one.')),

      h('section', null,
        h('div', { class: 'section-head' }, h('h2', null, 'Needs your attention'), h('a', { href: '#/tasks' }, `All ${openTasks.length} open tasks ›`)),
        h('div', { class: 'panel' }, taskTable(attention, true)))
    ];
  }

  // ------------------------------------------------ transcript import view
  const PROMPT = `You are helping me turn a meeting transcript into tasks for my task tracker.

Read the transcript at the bottom and extract ONLY action items that someone explicitly committed to or was asked to do. Do not invent tasks. Skip general discussion, background, and decisions that need no follow-up. Merge duplicates.

Return ONLY one JSON object (no commentary, no markdown) in exactly this shape:
{
  "meeting_title": "short title or null",
  "meeting_date": "YYYY-MM-DD or null",
  "tasks": [
    {
      "title": "imperative verb phrase, max 100 characters",
      "description": "1-3 sentences of needed context, or null",
      "priority": "low | medium | high",
      "due_date": "YYYY-MM-DD or null",
      "owner": "person named as responsible, or null",
      "context_quote": "short verbatim quote (max 200 chars) that supports this task"
    }
  ]
}

Rules:
- priority is "medium" unless urgency is clearly stated.
- due_date only if a specific date is given or can be resolved from a relative phrase using meeting_date; otherwise null.
- If there are no action items, return "tasks": [].

TRANSCRIPT:
<paste transcript here>`;

  function parseImport(text) {
    let s = String(text || '').trim();
    s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a < 0 || b < a) throw new Error('No JSON object found. Paste exactly what Claude returned.');
    let obj;
    try { obj = JSON.parse(s.slice(a, b + 1)); } catch (e) { throw new Error('That is not valid JSON: ' + e.message); }
    if (!Array.isArray(obj.tasks)) throw new Error('JSON must contain a "tasks" array.');
    const dateOk = (d) => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : '');
    return {
      title: nul(obj.meeting_title), date: dateOk(obj.meeting_date),
      tasks: obj.tasks.filter(t => t && nul(t.title)).map(t => ({
        title: String(t.title).trim().slice(0, 200), description: nul(t.description) || '',
        priority: ['low', 'medium', 'high'].includes(t.priority) ? t.priority : 'medium',
        due_date: dateOk(t.due_date), owner: nul(t.owner) || '', quote: nul(t.context_quote) || ''
      }))
    };
  }

  function viewImport() {
    const promptPre = h('pre', { class: 'prompt', id: 'prompt-text' }, PROMPT);
    const jsonBox = h('textarea', { id: 'import-json', placeholder: 'Paste the JSON Claude returned here…', rows: 8 });
    const draftsBox = h('div', { id: 'drafts' });
    const msg = h('div', { class: 'error', role: 'alert' });
    const defaultProject = h('select', { id: 'import-project', 'aria-label': 'Default project' });
    fillSelect(defaultProject, projectOptions(), '');

    const copy = async () => {
      try { await navigator.clipboard.writeText(PROMPT); toast('Prompt copied.'); }
      catch (e) { const r = document.createRange(); r.selectNodeContents(promptPre); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); toast('Select + copy the prompt manually.'); }
    };

    const showDrafts = () => {
      msg.textContent = '';
      let parsed;
      try { parsed = parseImport(jsonBox.value); } catch (e) { msg.textContent = e.message; draftsBox.replaceChildren(); return; }
      if (!parsed.tasks.length) { draftsBox.replaceChildren(h('div', { class: 'empty' }, 'No action items found in that JSON.')); return; }
      const rows = parsed.tasks.map((d, i) => {
        const inc = h('input', { type: 'checkbox', checked: true, 'aria-label': 'include' });
        const title = h('input', { type: 'text', value: d.title, 'aria-label': 'title', style: 'width:100%' });
        const desc = h('textarea', { rows: 2, 'aria-label': 'description' }); desc.value = d.description;
        const pri = h('select', { 'aria-label': 'priority' }); fillSelect(pri, statusOptions(PRIORITIES), d.priority);
        const due = h('input', { type: 'date', 'aria-label': 'due date', value: d.due_date });
        const proj = h('select', { 'aria-label': 'project', class: 'draft-project' }); fillSelect(proj, projectOptions(), defaultProject.value);
        const card = h('div', { class: 'card draft', 'data-draft': i },
          inc, h('div', null, title, desc,
            h('div', { class: 'draft-grid' }, h('div', null, h('label', null, 'Priority'), pri), h('div', null, h('label', null, 'Due'), due), h('div', null, h('label', null, 'Project'), proj)),
            d.owner || d.quote ? h('div', { class: 'muted small', style: 'margin-top:6px' }, d.owner ? `Owner: ${d.owner}. ` : '', d.quote ? `“${d.quote}”` : '') : null));
        return { d, inc, title, desc, pri, due, proj, card };
      });
      defaultProject.onchange = () => rows.forEach(r => { fillSelect(r.proj, projectOptions(), defaultProject.value); });
      const save = btn('Save selected tasks', () => saveDrafts(parsed, rows), 'primary');
      save.id = 'save-drafts';
      draftsBox.replaceChildren(
        h('h2', null, `Review ${rows.length} draft task${rows.length === 1 ? '' : 's'}`),
        h('p', { class: 'muted small' }, 'Nothing is saved until you click Save. Edit or untick anything first.'),
        ...rows.map(r => r.card), h('div', { class: 'actions' }, save));
    };

    const saveDrafts = async (parsed, rows) => {
      const chosen = rows.filter(r => r.inc.checked && r.title.value.trim());
      if (!chosen.length) { toast('Nothing selected.', true); return; }
      const inserted = must(await db.from('tasks').insert(chosen.map(r => ({
        project_id: nul(r.proj.value), title: r.title.value.trim(), description: nul(r.desc.value),
        priority: r.pri.value, due_date: nul(r.due.value), status: 'todo', source: 'transcript'
      }))).select()) || [];
      const noteRows = inserted.map((t, i) => {
        const d = chosen[i].d;
        const parts = [`Imported from meeting${parsed.title ? ` "${parsed.title}"` : ''}${parsed.date ? ` (${parsed.date})` : ''}.`];
        if (d.owner) parts.push(`Owner mentioned: ${d.owner}.`);
        if (d.quote) parts.push(`Transcript: “${d.quote}”`);
        return { task_id: t.id, body: parts.join('\n') };
      });
      if (noteRows.length) must(await db.from('task_notes').insert(noteRows));
      await loadCore();
      toast(`${inserted.length} task${inserted.length === 1 ? '' : 's'} created.`);
      location.hash = '#/tasks';
    };

    return [
      pageHead('Import from a meeting transcript', 'Claude-assisted: no API key or cost inside this app.'),
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', { class: 'grow' }, '1. Copy this prompt'), btn('Copy prompt', copy, 'small')),
        h('p', { class: 'muted small' }, 'Paste it into Claude, replace the last line with your transcript, and send.'), promptPre),
      h('div', { class: 'card' },
        h('h2', null, '2. Paste Claude’s JSON reply'), jsonBox,
        h('div', { class: 'filters', style: 'margin-top:8px' },
          h('label', { for: 'import-project', class: 'muted small', style: 'align-self:center' }, 'Default project for all drafts:'), defaultProject,
          btn('Preview drafts', showDrafts, 'primary')), msg),
      draftsBox
    ];
  }

  // ------------------------------------------------------------- auth view
  function viewAuth() {
    const err = h('div', { class: 'error', role: 'alert' });
    const email = h('input', { type: 'email', id: 'auth-email', autocomplete: 'email', required: true });
    const pass = h('input', { type: 'password', id: 'auth-pass', autocomplete: 'current-password', required: true });
    const go = async (mode) => {
      err.textContent = '';
      if (!email.value || !pass.value) { err.textContent = 'Email and password are required.'; return; }
      const res = mode === 'up' ? await db.auth.signUp({ email: email.value, password: pass.value }) : await db.auth.signInWithPassword({ email: email.value, password: pass.value });
      if (res.error) { err.textContent = res.error.message; return; }
      if (mode === 'up' && !res.data.session) err.textContent = 'Account created. Check your email to confirm it, then sign in.';
    };
    return h('div', { class: 'card auth' }, h('h1', null, 'Task Tracker'), h('p', { class: 'muted' }, 'Sign in to continue.'),
      h('form', { onsubmit: (e) => { e.preventDefault(); go('in'); } },
        h('div', { class: 'field' }, h('label', { for: 'auth-email' }, 'Email'), email),
        h('div', { class: 'field' }, h('label', { for: 'auth-pass' }, 'Password'), pass), err,
        h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onclick: () => go('up') }, 'Create account'), h('button', { type: 'submit', class: 'btn primary' }, 'Sign in'))));
  }
  function viewSetup() {
    const yes = (b) => (b ? '✅ yes' : '❌ no');
    const hasUrl = !!cfg.SUPABASE_URL && !/YOUR-/.test(cfg.SUPABASE_URL);
    const hasKey = !!cfg.SUPABASE_ANON_KEY && !/YOUR-/.test(cfg.SUPABASE_ANON_KEY);
    const libOk = !!(window.supabase && window.supabase.createClient);
    let advice;
    if (!window.TASK_TRACKER_CONFIG) advice = 'config.js did not load. Check that the file is in the same folder as index.html and named exactly config.js.';
    else if (!hasUrl || !hasKey) advice = 'config.js still has the placeholder values (or your browser cached the old copy: hard-refresh with Ctrl+Shift+R / Cmd+Shift+R).';
    else if (!libOk) advice = 'Your settings are fine, but the Supabase library could not be downloaded from any CDN. Check your internet connection and any ad/privacy blockers or firewall, then reload.';
    else advice = 'Reload the page.';
    return h('div', { class: 'card auth' }, h('h1', null, 'Almost there'),
      h('p', null, advice),
      h('ul', { class: 'small' },
        h('li', null, 'config.js loaded: ', yes(!!window.TASK_TRACKER_CONFIG)),
        h('li', null, 'Supabase URL set: ', yes(hasUrl)),
        h('li', null, 'Anon key set: ', yes(hasKey)),
        h('li', null, 'Supabase library loaded: ', yes(libOk))));
  }

  // ---------------------------------------------------------------- router
  let renderSeq = 0;
  async function render() {
    const seq = ++renderSeq;
    const topbar = document.getElementById('topbar');
    if (!db) { topbar.hidden = true; $app.replaceChildren(viewSetup()); return; }
    if (!state.user) { topbar.hidden = true; $app.replaceChildren(viewAuth()); return; }
    topbar.hidden = false;
    document.getElementById('user-email').textContent = state.user.email || '';
    const [name, id] = location.hash.replace(/^#\/?/, '').split('?')[0].split('/');
    document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === (name === 'project' ? 'projects' : name === 'task' ? 'tasks' : (name || 'dashboard'))));
    let out;
    try {
      if (name === 'tasks') out = viewTasks();
      else if (name === 'projects') out = viewProjects();
      else if (name === 'project') out = viewProject(id);
      else if (name === 'task') out = await viewTask(id);
      else if (name === 'import') out = viewImport();
      else out = await viewDashboard();
    } catch (e) { out = h('div', { class: 'card' }, h('p', { class: 'error' }, e.message || String(e))); }
    if (seq !== renderSeq) return;            // a newer render superseded this one
    $app.replaceChildren(...[].concat(out));
  }

  // ------------------------------------------------------------------ boot
  async function applySession(session) {
    const user = session && session.user ? session.user : null;
    if ((user && state.user && user.id === state.user.id) || (!user && !state.user)) return;
    state.user = user;
    if (user) { await guard(loadCore); if (!location.hash) location.hash = '#/dashboard'; }
    else { state.projects = []; state.tasks = []; state.running = null; updateTimerUI(); }
    render();
  }
  async function boot() {
    document.getElementById('signout').addEventListener('click', () => db && db.auth.signOut());
    document.getElementById('timer-stop').addEventListener('click', () => guard(stopTimer));
    window.addEventListener('hashchange', render);
    if (!db && configured) { await ensureLibrary(); makeClient(); }
    if (!db) { render(); return; }
    db.auth.onAuthStateChange((_evt, session) => { setTimeout(() => applySession(session), 0); });
    const { data } = await db.auth.getSession();
    await applySession(data && data.session);
    render();
  }
  window.__TaskTracker = { state, render, parseImport, boot };
  boot();
})();
