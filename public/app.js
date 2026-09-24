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
    a.onclick = guard(async (e) => { e.preventDefault(); membersOpen = false; await openBoard(b.id); });
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

const COLUMNS = [['todo', 'To Do'], ['doing', 'Doing'], ['done', 'Done']];
const RANK = { viewer: 1, editor: 2, owner: 3 };
let membersOpen = false;

views.board = () => {
  const { board, role, members, cards } = state.board;
  const can = (min) => RANK[role] >= RANK[min];
  const el = tpl('tpl-board');
  const reload = () => openBoard(board.id);

  $('[data-name]', el).textContent = board.name;
  $('[data-role]', el).textContent = role;
  $('[data-back]', el).onclick = guard(async (e) => { e.preventDefault(); await loadBoards(); });

  // Owner controls
  if (can('owner')) {
    for (const sel of ['[data-rename]', '[data-members-toggle]', '[data-delete]']) $(sel, el).classList.remove('hidden');
    $('[data-members-panel]', el).classList.toggle('hidden', !membersOpen);
    $('[data-rename]', el).onclick = guard(async () => {
      const name = prompt('Board name', board.name);
      if (name === null || name.trim() === '') return;
      await request('PATCH', `/api/boards/${board.id}`, { name });
      await reload();
    });
    $('[data-delete]', el).onclick = guard(async () => {
      if (!confirm(`Delete "${board.name}" and all its cards?`)) return;
      await request('DELETE', `/api/boards/${board.id}`);
      await loadBoards();
    });
    $('[data-members-toggle]', el).onclick = () => {
      membersOpen = !membersOpen;
      $('[data-members-panel]', $('#view')).classList.toggle('hidden', !membersOpen);
    };
  } else {
    $('[data-leave]', el).classList.remove('hidden');
    $('[data-leave]', el).onclick = guard(async () => {
      if (!confirm(`Leave "${board.name}"?`)) return;
      await request('DELETE', `/api/boards/${board.id}/members/me`);
      await loadBoards();
    });
  }

  // Members panel (owner only; the toggle is hidden for others)
  const memberList = $('[data-members-list]', el);
  for (const m of members) {
    const li = document.createElement('li');
    const email = document.createElement('span');
    email.textContent = m.email;
    li.append(email);
    if (m.role === 'owner') {
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.textContent = 'owner';
      li.append(pill);
    } else {
      const select = document.createElement('select');
      for (const r of ['editor', 'viewer']) {
        const o = new Option(r, r, r === m.role, r === m.role);
        select.append(o);
      }
      select.onchange = guard(async () => {
        await request('PATCH', `/api/boards/${board.id}/members/${m.user_id}`, { role: select.value });
        await reload();
      });
      const remove = document.createElement('button');
      remove.className = 'ghost danger';
      remove.textContent = 'Remove';
      remove.onclick = guard(async () => {
        await request('DELETE', `/api/boards/${board.id}/members/${m.user_id}`);
        await reload();
      });
      li.append(select, remove);
    }
    memberList.append(li);
  }
  $('[data-add-member]', el).onsubmit = guard(async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    await request('POST', `/api/boards/${board.id}/members`, { email: f.get('email'), role: f.get('role') });
    membersOpen = true;
    await reload();
  });

  // Columns and cards
  const columnsEl = $('[data-columns]', el);
  for (const [key, label] of COLUMNS) {
    const col = tpl('tpl-column');
    col.dataset.column = key;
    $('[data-heading]', col).textContent = label;
    const cardsEl = $('[data-cards]', col);
    for (const card of cards.filter((c) => c.column === key)) {
      const node = tpl('tpl-card');
      node.dataset.id = card.id;
      $('[data-title]', node).textContent = card.title;
      $('[data-desc]', node).textContent = card.description;
      if (can('editor')) {
        node.draggable = true;
        node.ondragstart = (e) => { e.dataTransfer.setData('text/plain', card.id); node.classList.add('dragging'); };
        node.ondragend = () => node.classList.remove('dragging');
        node.onclick = () => editCard(card, reload);
      }
      cardsEl.append(node);
    }
    if (can('editor')) {
      const form = $('[data-add-card]', col);
      form.classList.remove('hidden');
      form.onsubmit = guard(async (e) => {
        e.preventDefault();
        await request('POST', `/api/boards/${board.id}/cards`, { title: new FormData(e.target).get('title'), column: key });
        await reload();
      });
      col.ondragover = (e) => { e.preventDefault(); col.classList.add('drop-target'); };
      col.ondragleave = () => col.classList.remove('drop-target');
      col.ondrop = guard(async (e) => {
        e.preventDefault();
        col.classList.remove('drop-target');
        const id = e.dataTransfer.getData('text/plain');
        if (!id) return;
        // Position = number of non-dragged cards whose vertical midpoint is above the pointer.
        const others = [...cardsEl.querySelectorAll('[data-card]')].filter((n) => n.dataset.id !== id);
        const position = others.filter((n) => { const r = n.getBoundingClientRect(); return r.top + r.height / 2 < e.clientY; }).length;
        await request('PATCH', `/api/boards/${board.id}/cards/${id}`, { column: key, position });
        await reload();
      });
    }
    columnsEl.append(col);
  }
  return el;
};

function editCard(card, reload) {
  const dialog = $('#card-dialog');
  const form = $('[data-card-form]', dialog);
  form.elements.title.value = card.title;
  form.elements.description.value = card.description;
  const boardId = state.board.board.id;
  form.onsubmit = guard(async (e) => {
    e.preventDefault();
    await request('PATCH', `/api/boards/${boardId}/cards/${card.id}`, {
      title: form.elements.title.value,
      description: form.elements.description.value,
    });
    dialog.close();
    await reload();
  });
  $('[data-card-cancel]', dialog).onclick = () => dialog.close();
  $('[data-card-delete]', dialog).onclick = guard(async () => {
    await request('DELETE', `/api/boards/${boardId}/cards/${card.id}`);
    dialog.close();
    await reload();
  });
  dialog.showModal();
}

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
  let user = null;
  try {
    ({ user } = await request('GET', '/api/auth/me'));
  } catch {
    // no valid session
  }
  if (!user) { go('auth'); return; }
  state.user = user;
  try {
    await loadBoards();
  } catch (e) {
    showError(e.message);
    state.boards = [];
    go('boards');
  }
})();
