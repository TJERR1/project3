/* Kanban front end. One page, three views: auth, boards, board. */

const state = { user: null, view: 'auth', boards: [], board: null, authMode: 'login' };

const $ = (sel, root = document) => root.querySelector(sel);
const tpl = (id) => $(`#${id}`).content.firstElementChild.cloneNode(true);

function showError(message) {
  const el = $('#error');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(showError.timer);
  showError.timer = setTimeout(() => el.classList.add('hidden'), 5000);
}

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({ error: 'Bad response' }));
  if (!res.ok) {
    if (res.status === 401 && state.user) { state.user = null; go('auth'); }
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

// Wrap an async handler so any thrown error lands in the banner.
const guard = (fn) => (...args) => fn(...args).catch((e) => showError(e.message));

function go(view, data) {
  state.view = view;
  if (view === 'board') state.board = data;
  render();
}

const views = {};

views.auth = () => {
  const el = tpl('tpl-auth');
  const register = state.authMode === 'register';
  $('[data-title]', el).textContent = register ? 'Register' : 'Log in';
  $('[data-submit]', el).textContent = register ? 'Register' : 'Log in';
  $('[data-switch-text]', el).textContent = register ? 'Have an account?' : 'No account?';
  $('[data-switch]', el).textContent = register ? 'Log in' : 'Register';
  $('[data-switch]', el).onclick = (e) => { e.preventDefault(); state.authMode = register ? 'login' : 'register'; render(); };
  $('[data-form]', el).onsubmit = guard(async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const creds = { email: f.get('email'), password: f.get('password') };
    if (register) await request('POST', '/api/auth/register', creds);
    const { user } = await request('POST', '/api/auth/login', creds);
    state.user = user;
    await loadBoards();
  });
  return el;
};

async function loadBoards() {
  const { boards } = await request('GET', '/api/boards');
  state.boards = boards;
  go('boards');
}

views.boards = () => {
  const el = tpl('tpl-boards');
  const list = $('[data-list]', el);
  for (const b of state.boards) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = '#';
    a.innerHTML = `<strong></strong><br><span class="pill"></span>`;
    $('strong', a).textContent = b.name;
    $('.pill', a).textContent = b.role;
    a.onclick = guard(async (e) => { e.preventDefault(); await openBoard(b.id); });
    li.append(a);
    list.append(li);
  }
  $('[data-create]', el).onsubmit = guard(async (e) => {
    e.preventDefault();
    await request('POST', '/api/boards', { name: new FormData(e.target).get('name') });
    await loadBoards();
  });
  return el;
};

async function openBoard(id) {
  const data = await request('GET', `/api/boards/${id}`);
  go('board', data);
}

views.board = () => {
  const el = document.createElement('p');
  el.textContent = 'Board view comes in the next task.';
  return el;
};

function render() {
  $('#whoami').textContent = state.user ? state.user.email : '';
  $('#logout-btn').classList.toggle('hidden', !state.user);
  const view = $('#view');
  view.replaceChildren(views[state.view]());
}

$('#logout-btn').onclick = guard(async () => {
  await request('POST', '/api/auth/logout');
  state.user = null;
  state.authMode = 'login';
  go('auth');
});
$('#home-link').onclick = guard(async (e) => { e.preventDefault(); if (state.user) await loadBoards(); });

guard(async () => {
  try {
    const { user } = await request('GET', '/api/auth/me');
    state.user = user;
    await loadBoards();
  } catch {
    go('auth');
  }
})();
