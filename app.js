/* Оцінки онлайн — сайт для батьків і викладачів.
   Дані зберігаються в Supabase. Ключ нижче — публічний (publishable):
   він дозволяє лише те, що відкривають правила доступу в базі. */
'use strict';

const SUPABASE_URL = 'https://ggjzwqzbvmicmggdanxb.supabase.co';
const SUPABASE_KEY = 'sb_publishable_AElwe1x7V10Vn3z0EYi9Qw_br47qhG9';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const KINDS = ['практична', 'лекція', 'семінар', 'самостійна', 'лабораторна', 'тест', 'контрольна', 'модульна', 'ТЗ', 'залік', 'екзамен'];
const GRADE_RE = /^(1[0-2]|[1-9]|н)$/;

const state = {
  session: null,
  me: null,          // row from teachers
  meLoaded: false,
  groups: [],
  subjects: [],
  assignments: [],   // for current teacher (or all, for admin page)
};

/* ---------- small helpers ---------- */

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'class') el.className = v;
      else if (k === 'value') el.value = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function svgIcon(path, size = 16, color = 'currentColor') {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('width', size); s.setAttribute('height', size); s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', color); s.setAttribute('stroke-width', '2');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
  for (const d of [].concat(path)) {
    const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); s.append(p);
  }
  return s;
}

// Like replaceChildren, but skips null/false (otherwise the browser prints "null").
function fill(el, ...nodes) {
  el.replaceChildren(...nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false));
}

const app = () => document.getElementById('app');
function mount(...nodes) { const a = app(); fill(a, ...nodes); }

function gradeClass(v) {
  if (v === 'н') return 'g-abs';
  const n = Number(v);
  if (!n) return '';
  if (n >= 10) return 'g-hi';
  if (n >= 7) return 'g-mid';
  return 'g-lo';
}

function fmtDate(d, withYear = false) {
  if (!d) return '';
  const [y, m, day] = String(d).slice(0, 10).split('-');
  return withYear ? `${day}.${m}.${y}` : `${day}.${m}`;
}
function fmtDateTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtNum(n) {
  if (n === null || n === undefined || n === '') return '—';
  return Number(n).toLocaleString('uk-UA', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}
function initials(name) {
  const p = String(name).trim().split(/\s+/);
  return ((p[0] || '')[0] || '') + ((p[1] || '')[0] || '');
}
function todayISO() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function byName(a, b) { return String(a.full_name || a.name).localeCompare(String(b.full_name || b.name), 'uk'); }
function store(key, val) { try { if (val === null) localStorage.removeItem(key); else localStorage.setItem(key, val); } catch (e) { /* storage unavailable */ } }
function load(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }

function normalizeCode(raw) {
  // Cyrillic look-alikes typed by mistake are mapped to Latin
  let s = String(raw).toUpperCase()
    .replace(/[АВЕКМНОРСТХ]/g, (ch) => ({ А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X' }[ch]))
    .replace(/[^A-Z0-9]/g, '');
  s = s.slice(0, 8);
  return s.length > 4 ? s.slice(0, 4) + '-' + s.slice(4) : s;
}

function genPassword() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const arr = new Uint32Array(10);
  crypto.getRandomValues(arr);
  return Array.from(arr, (x) => alphabet[x % alphabet.length]).join('');
}

function errText(e) {
  const m = (e && (e.message || e.error_description || e.error)) || String(e);
  if (/Invalid login credentials/i.test(m)) return 'Неправильна пошта або пароль.';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'Немає з’єднання з сервером. Перевірте інтернет і спробуйте ще раз.';
  if (/row-level security|permission denied/i.test(m)) return 'Немає прав на цю дію.';
  return m;
}

/* ---------- auth & navigation ---------- */

async function loadMe() {
  state.me = null;
  if (state.session) {
    const { data } = await sb.from('teachers').select('id, full_name, email, is_admin').eq('id', state.session.user.id).maybeSingle();
    state.me = data || null;
  }
  state.meLoaded = true;
}

function renderNav() {
  const nav = document.getElementById('nav');
  const route = location.hash.replace('#', '') || 'parents';
  const link = (href, text) => h('a', { href: '#' + href, class: route === href ? 'active' : null }, text);
  if (state.session) {
    fill(nav, 
      state.me ? h('span', { class: 'who' }, state.me.full_name) : null,
      link('parents', 'Для батьків'),
      state.me ? link('journal', 'Журнал') : null,
      state.me && state.me.is_admin ? link('admin', 'Адміністрування') : null,
      link('password', 'Змінити пароль'),
      h('button', { class: 'linkbtn', type: 'button', onclick: logout }, 'Вийти'),
    );
  } else {
    fill(nav, route === 'login' ? link('parents', 'Для батьків') : link('login', 'Вхід для викладачів'));
  }
}

async function logout() {
  await sb.auth.signOut();
  state.session = null; state.me = null;
  location.hash = '#login';
  render();
}

async function render() {
  renderNav();
  const route = location.hash.replace('#', '') || 'parents';
  try {
    if (route === 'login') return renderLogin();
    if (route === 'journal') return requireTeacher(renderJournal);
    if (route === 'admin') return requireTeacher(renderAdmin, true);
    if (route === 'password') return state.session ? renderPassword() : renderLogin();
    return renderParents();
  } catch (e) {
    mount(h('div', { class: 'error' }, errText(e)));
  }
}

function requireTeacher(fn, adminOnly = false) {
  if (!state.session) { location.hash = '#login'; return; }
  if (!state.me) {
    return mount(h('div', { class: 'card narrow stack' },
      h('h2', null, 'Немає доступу'),
      h('p', { class: 'sub' }, 'Ваш акаунт ще не додано до списку викладачів. Зверніться до адміністратора.')));
  }
  if (adminOnly && !state.me.is_admin) {
    return mount(h('div', { class: 'card narrow' }, 'Ця сторінка доступна лише адміністратору.'));
  }
  return fn();
}

/* ---------- parents ---------- */

function renderParents() {
  const saved = load('parentCode') || '';
  const input = h('input', {
    id: 'code', class: 'input code-input', type: 'text', inputmode: 'text', autocomplete: 'off',
    autocapitalize: 'characters', spellcheck: 'false', placeholder: 'XXXX-XXXX', maxlength: '9', value: saved,
    oninput: (e) => { const pos = e.target.value; e.target.value = normalizeCode(pos); },
  });
  const remember = h('input', { type: 'checkbox', id: 'remember', checked: !!saved });
  const msg = h('div');
  const btn = h('button', { class: 'btn primary big', type: 'submit' }, 'Переглянути оцінки');

  const form = h('form', {
    class: 'card stack',
    onsubmit: async (e) => {
      e.preventDefault();
      const code = normalizeCode(input.value);
      fill(msg, );
      if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) {
        fill(msg, h('div', { class: 'error' }, 'Код має 8 символів, наприклад AB3K-7QXM.'));
        return;
      }
      btn.disabled = true; btn.textContent = 'Завантаження…';
      const { data, error } = await sb.rpc('get_student_report', { p_code: code });
      btn.disabled = false; btn.textContent = 'Переглянути оцінки';
      if (error) { fill(msg, h('div', { class: 'error' }, errText(error))); return; }
      if (!data) { fill(msg, h('div', { class: 'error' }, 'Код не знайдено. Перевірте, чи правильно його введено, або зверніться до куратора групи.')); return; }
      store('parentCode', remember.checked ? code : null);
      renderReport(data);
    },
  },
    h('div', { class: 'field' },
      h('label', { for: 'code' }, 'Код дитини'),
      input,
      h('div', { class: 'hint' }, '8 символів: латинські літери та цифри. Регістр не важливий.')),
    h('label', { class: 'checkbox' }, remember, 'Запам’ятати код на цьому пристрої'),
    btn,
    msg,
  );

  mount(h('div', { class: 'narrow' },
    h('div', { class: 'hero' },
      h('h1', { class: 'page-title' }, 'Оцінки вашої дитини'),
      h('p', { class: 'sub', style: 'margin:0' }, 'Введіть особистий код, який ви отримали від куратора групи.')),
    form,
    h('div', { class: 'notice', style: 'margin-top:16px' },
      'Код бачать лише батьки цієї дитини. Не публікуйте його в чатах групи. Немає коду — зверніться до куратора.'),
  ));
  if (!saved) input.focus();
}

function renderReport(r) {
  const subjects = (r.subjects || []).slice().sort((a, b) => String(a.subject).localeCompare(String(b.subject), 'uk'));
  const back = h('button', {
    class: 'btn small', type: 'button',
    onclick: () => renderParents(),
  }, svgIcon('M15 18l-6-6 6-6'), 'Інший код');

  const head = h('div', { class: 'card stack' },
    h('div', { class: 'student-head' },
      h('div', { class: 'avatar', 'aria-hidden': 'true' }, initials(r.student)),
      h('div', null,
        h('div', { style: 'font-size:20px;font-weight:700' }, r.student),
        h('div', { class: 'sub' }, 'Група ' + r.group))),
    h('div', { class: 'tiles' },
      h('div', { class: 'tile' }, h('div', { class: 'k' }, 'Середній бал'), h('div', { class: 'v' }, fmtNum(r.avg))),
      h('div', { class: 'tile' }, h('div', { class: 'k' }, 'Оцінок'), h('div', { class: 'v' }, String(r.grades_count ?? 0))),
      h('div', { class: 'tile' }, h('div', { class: 'k' }, 'Пропуски'), h('div', { class: 'v' }, String(r.absences ?? 0)))),
    r.updated_at ? h('div', { class: 'hint' }, 'Останнє оновлення: ' + fmtDateTime(r.updated_at)) : null,
  );

  const cards = subjects.length
    ? subjects.map((s) => h('div', { class: 'card subject' },
      h('div', { class: 'subject-top' },
        h('div', null,
          h('div', { class: 'subject-name' }, s.subject),
          s.teachers ? h('div', { class: 'hint' }, s.teachers) : null),
        h('div', { class: 'subject-avg' }, h('div', { class: 'k' }, 'середній'), h('div', { class: 'v' }, fmtNum(s.avg)))),
      (s.grades && s.grades.length)
        ? h('div', { class: 'chips' }, s.grades.map((g) => h('div', { class: 'chip-wrap', title: g.kind },
          h('div', { class: 'g ' + gradeClass(g.value) }, g.value),
          h('div', { class: 'chip-date' }, fmtDate(g.date)))))
        : h('div', { class: 'hint' }, 'Оцінок поки немає.'),
      (s.comments || []).map((c) => h('div', { class: 'comment' },
        h('strong', null, 'Коментар викладача (' + fmtDate(c.date) + '): '), c.text)),
    ))
    : [h('div', { class: 'card empty-state' }, 'Оцінок поки немає. Вони з’являться тут одразу, щойно викладачі їх поставлять.')];

  const legend = h('div', { class: 'legend' },
    h('span', null, h('span', { class: 'g mini g-hi' }, '10'), '10–12'),
    h('span', null, h('span', { class: 'g mini g-mid' }, '7'), '7–9'),
    h('span', null, h('span', { class: 'g mini g-lo' }, '5'), '1–6'),
    h('span', null, h('span', { class: 'g mini g-abs' }, 'н'), 'пропуск'));

  mount(h('div', { class: 'mid stack' }, h('div', null, back), head, cards, legend));
  window.scrollTo(0, 0);
}

/* ---------- login & password ---------- */

function renderLogin() {
  if (state.session && state.me) { location.hash = '#journal'; return; }
  const email = h('input', { id: 'email', class: 'input', type: 'email', autocomplete: 'username', required: true });
  const pass = h('input', { id: 'pass', class: 'input', type: 'password', autocomplete: 'current-password', required: true });
  const msg = h('div');
  const btn = h('button', { class: 'btn primary big', type: 'submit' }, 'Увійти');
  mount(h('div', { class: 'narrow' },
    h('div', { class: 'hero' }, h('h1', { class: 'page-title' }, 'Вхід для викладачів')),
    h('form', {
      class: 'card stack',
      onsubmit: async (e) => {
        e.preventDefault();
        btn.disabled = true; fill(msg, );
        const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pass.value });
        btn.disabled = false;
        if (error) { fill(msg, h('div', { class: 'error' }, errText(error))); return; }
        // onAuthStateChange handles the rest
      },
    },
      h('div', { class: 'field' }, h('label', { for: 'email' }, 'Пошта'), email),
      h('div', { class: 'field' }, h('label', { for: 'pass' }, 'Пароль'), pass),
      btn, msg,
      h('div', { class: 'hint' }, 'Акаунти створює адміністратор. Забули пароль — зверніться до нього.')),
  ));
  email.focus();
}

function renderPassword() {
  const p1 = h('input', { id: 'p1', class: 'input', type: 'password', autocomplete: 'new-password', minlength: '8', required: true });
  const p2 = h('input', { id: 'p2', class: 'input', type: 'password', autocomplete: 'new-password', minlength: '8', required: true });
  const msg = h('div');
  mount(h('div', { class: 'narrow' },
    h('div', { class: 'hero' }, h('h1', { class: 'page-title' }, 'Змінити пароль')),
    h('form', {
      class: 'card stack',
      onsubmit: async (e) => {
        e.preventDefault();
        fill(msg, );
        if (p1.value.length < 8) { fill(msg, h('div', { class: 'error' }, 'Пароль має бути щонайменше 8 символів.')); return; }
        if (p1.value !== p2.value) { fill(msg, h('div', { class: 'error' }, 'Паролі не збігаються.')); return; }
        const { error } = await sb.auth.updateUser({ password: p1.value });
        if (error) { fill(msg, h('div', { class: 'error' }, errText(error))); return; }
        p1.value = ''; p2.value = '';
        fill(msg, h('div', { class: 'success' }, 'Пароль змінено.'));
      },
    },
      h('div', { class: 'field' }, h('label', { for: 'p1' }, 'Новий пароль'), p1),
      h('div', { class: 'field' }, h('label', { for: 'p2' }, 'Повторіть пароль'), p2),
      h('button', { class: 'btn primary', type: 'submit' }, 'Зберегти'),
      msg),
  ));
}

/* ---------- reference data ---------- */

async function loadRefs() {
  const [g, s, a] = await Promise.all([
    sb.from('groups').select('id, name').order('name'),
    sb.from('subjects').select('id, name').order('name'),
    sb.from('teacher_assignments').select('teacher_id, group_id, subject_id'),
  ]);
  if (g.error) throw g.error;
  if (s.error) throw s.error;
  state.groups = g.data || [];
  state.subjects = (s.data || []).sort(byName);
  state.assignments = a.data || [];
}

function groupName(id) { const g = state.groups.find((x) => x.id === id); return g ? g.name : '?'; }
function subjectName(id) { const s = state.subjects.find((x) => x.id === id); return s ? s.name : '?'; }

/* ---------- journal ---------- */

async function renderJournal() {
  mount(h('div', { class: 'empty-state' }, 'Завантаження…'));
  await loadRefs();
  const me = state.me;
  const mine = state.assignments.filter((a) => a.teacher_id === me.id);

  const availableGroups = me.is_admin
    ? state.groups
    : state.groups.filter((g) => mine.some((a) => a.group_id === g.id));

  if (!availableGroups.length) {
    return mount(h('div', { class: 'card mid stack' },
      h('h2', null, 'За вами ще не закріплено жодної групи'),
      h('p', { class: 'sub' }, 'Попросіть адміністратора додати вам предмети й групи.')));
  }

  const subjectsFor = (groupId) => {
    if (me.is_admin) {
      const assigned = state.subjects.filter((s) => state.assignments.some((a) => a.group_id === groupId && a.subject_id === s.id));
      return assigned.length ? assigned.concat(state.subjects.filter((s) => !assigned.includes(s))) : state.subjects;
    }
    return state.subjects.filter((s) => mine.some((a) => a.group_id === groupId && a.subject_id === s.id));
  };

  let groupId = Number(load('j.group')) || availableGroups[0].id;
  if (!availableGroups.some((g) => g.id === groupId)) groupId = availableGroups[0].id;
  let subjectId = Number(load('j.subject')) || null;

  const groupSel = h('select', { id: 'jg', class: 'input', style: 'min-width:240px' },
    availableGroups.map((g) => h('option', { value: g.id }, g.name)));
  const subjSel = h('select', { id: 'js', class: 'input', style: 'min-width:260px' });
  const status = h('div', { class: 'status', role: 'status' });
  const tableHost = h('div');
  const titleEl = h('h1', { class: 'page-title' });
  const subEl = h('div', { class: 'sub' });

  function fillSubjects() {
    const list = subjectsFor(groupId);
    fill(subjSel, ...list.map((s) => h('option', { value: s.id }, s.name)));
    if (!list.some((s) => s.id === subjectId)) subjectId = list.length ? list[0].id : null;
    if (subjectId) subjSel.value = String(subjectId);
  }

  groupSel.value = String(groupId);
  fillSubjects();
  groupSel.addEventListener('change', () => { groupId = Number(groupSel.value); store('j.group', groupId); fillSubjects(); store('j.subject', subjectId); loadGrid(); });
  subjSel.addEventListener('change', () => { subjectId = Number(subjSel.value); store('j.subject', subjectId); loadGrid(); });

  // New column form
  const dateIn = h('input', { id: 'nd', class: 'input', type: 'date', value: todayISO() });
  const kindIn = h('input', { id: 'nk', class: 'input', list: 'kinds', value: 'практична', style: 'width:170px' });
  const kinds = h('datalist', { id: 'kinds' }, KINDS.map((k) => h('option', { value: k })));
  const addBtn = h('button', { class: 'btn primary', type: 'submit' }, svgIcon(['M12 5v14', 'M5 12h14'], 16, '#fff'), 'Додати колонку');
  const addForm = h('form', {
    class: 'row',
    onsubmit: async (e) => {
      e.preventDefault();
      if (!subjectId) return;
      addBtn.disabled = true;
      setStatus('busy', 'Збереження…');
      const { error } = await sb.from('lessons').insert({
        group_id: groupId, subject_id: subjectId, lesson_date: dateIn.value || todayISO(), kind: (kindIn.value || 'заняття').trim().slice(0, 40),
      });
      addBtn.disabled = false;
      if (error) { setStatus('err', errText(error)); return; }
      setStatus('ok', 'Колонку додано');
      loadGrid();
    },
  },
    h('div', { class: 'field' }, h('label', { for: 'nd' }, 'Дата'), dateIn),
    h('div', { class: 'field' }, h('label', { for: 'nk' }, 'Вид роботи'), kindIn, kinds),
    addBtn);

  function setStatus(kind, text) {
    status.className = 'status' + (kind === 'err' ? ' err' : kind === 'busy' ? ' busy' : '');
    status.textContent = text;
  }

  mount(h('div', { class: 'stack' },
    h('div', { class: 'toolbar' },
      h('div', { class: 'row' },
        h('div', { class: 'field' }, h('label', { for: 'jg' }, 'Група'), groupSel),
        h('div', { class: 'field' }, h('label', { for: 'js' }, 'Предмет'), subjSel)),
      addForm),
    h('div', { class: 'toolbar' }, h('div', null, titleEl, subEl), status),
    h('div', { class: 'notice' }, 'Вписуйте оцінку 1–12 або «н» (пропуск); Enter або ↓ — наступний студент. Щоб видалити оцінку, зітріть її. Зміни зберігаються одразу, і батьки бачать їх відразу.'),
    tableHost,
    h('div', { class: 'legend' },
      h('span', null, h('span', { class: 'g mini g-hi' }, '10'), '10–12'),
      h('span', null, h('span', { class: 'g mini g-mid' }, '7'), '7–9'),
      h('span', null, h('span', { class: 'g mini g-lo' }, '5'), '1–6'),
      h('span', null, h('span', { class: 'g mini g-abs' }, 'н'), 'пропуск')),
  ));

  async function loadGrid() {
    titleEl.textContent = subjectId ? subjectName(subjectId) : 'Немає предметів';
    subEl.textContent = groupName(groupId);
    if (!subjectId) { fill(tableHost, h('div', { class: 'card empty-state' }, 'Для цієї групи немає предметів.')); return; }
    fill(tableHost, h('div', { class: 'card empty-state' }, 'Завантаження…'));

    const [st, ls] = await Promise.all([
      sb.from('students').select('id, full_name').eq('group_id', groupId),
      sb.from('lessons').select('id, lesson_date, kind').eq('group_id', groupId).eq('subject_id', subjectId)
        .order('lesson_date').order('id'),
    ]);
    if (st.error || ls.error) { fill(tableHost, h('div', { class: 'error' }, errText(st.error || ls.error))); return; }
    const students = (st.data || []).sort(byName);
    const lessons = ls.data || [];
    let grades = [];
    if (lessons.length) {
      const gr = await sb.from('grades').select('lesson_id, student_id, value').in('lesson_id', lessons.map((l) => l.id));
      if (gr.error) { fill(tableHost, h('div', { class: 'error' }, errText(gr.error))); return; }
      grades = gr.data || [];
    }
    subEl.textContent = `${groupName(groupId)} · ${students.length} студентів · ${lessons.length} колонок`;
    const gmap = new Map(grades.map((g) => [g.lesson_id + ':' + g.student_id, g.value]));
    buildTable(students, lessons, gmap);
  }

  function buildTable(students, lessons, gmap) {
    if (!students.length) { fill(tableHost, h('div', { class: 'card empty-state' }, 'У групі немає студентів.')); return; }

    const avgCells = new Map();
    const rowAvg = (sid) => {
      const vals = lessons.map((l) => gmap.get(l.id + ':' + sid)).filter((v) => v && v !== 'н').map(Number);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };

    const headRow = h('tr', null,
      h('th', { class: 'name', scope: 'col' }, 'Студент'),
      lessons.map((l) => h('th', { scope: 'col' },
        h('div', { class: 'd' }, fmtDate(l.lesson_date)),
        h('div', null, l.kind),
        h('button', {
          class: 'col-del', type: 'button', title: 'Видалити колонку', 'aria-label': `Видалити колонку ${fmtDate(l.lesson_date)} ${l.kind}`,
          onclick: async () => {
            const n = students.filter((s) => gmap.has(l.id + ':' + s.id)).length;
            if (!confirm(`Видалити колонку ${fmtDate(l.lesson_date, true)} (${l.kind})${n ? ` разом з ${n} оцінками` : ''}?`)) return;
            setStatus('busy', 'Видалення…');
            const { error } = await sb.from('lessons').delete().eq('id', l.id);
            if (error) { setStatus('err', errText(error)); return; }
            setStatus('ok', 'Колонку видалено');
            loadGrid();
          },
        }, '✕ видалити'))),
      h('th', { scope: 'col' }, 'Середній'),
      h('th', { scope: 'col' }, ''));

    const inputs = []; // [row][col]
    const body = students.map((s, ri) => {
      inputs[ri] = [];
      const avgTd = h('td', { class: 'avg' }, fmtNum(rowAvg(s.id)));
      avgCells.set(s.id, avgTd);
      return h('tr', null,
        h('td', { class: 'name' }, h('span', { class: 'num' }, String(ri + 1)), s.full_name),
        lessons.map((l, ci) => {
          const key = l.id + ':' + s.id;
          const v = gmap.get(key) || '';
          const inp = h('input', {
            class: 'cell ' + gradeClass(v), value: v, maxlength: '2', inputmode: 'text', autocomplete: 'off',
            'aria-label': `${s.full_name}, ${fmtDate(l.lesson_date)} ${l.kind}`,
          });
          inp.dataset.saved = v;
          inp.addEventListener('input', () => {
            let x = inp.value.trim().toLowerCase().replace(/[hн]/g, 'н');
            inp.value = x;
            inp.className = 'cell ' + (x === '' || GRADE_RE.test(x) ? gradeClass(x) : 'bad');
          });
          inp.addEventListener('keydown', (e) => {
            const go = (r, c) => { const t = inputs[r] && inputs[r][c]; if (t) { e.preventDefault(); t.focus(); t.select(); } };
            if (e.key === 'Enter' || e.key === 'ArrowDown') go(ri + 1, ci);
            else if (e.key === 'ArrowUp') go(ri - 1, ci);
            else if (e.key === 'ArrowRight' && inp.selectionStart === inp.value.length) go(ri, ci + 1);
            else if (e.key === 'ArrowLeft' && inp.selectionStart === 0) go(ri, ci - 1);
            else if (e.key === 'Escape') { inp.value = inp.dataset.saved; inp.dispatchEvent(new Event('input')); }
          });
          inp.addEventListener('focus', () => inp.select());
          inp.addEventListener('blur', () => saveCell(inp, l.id, s.id, key));
          inputs[ri][ci] = inp;
          return h('td', null, inp);
        }),
        avgTd,
        h('td', null, h('button', { class: 'btn small', type: 'button', onclick: () => openComments(s) }, 'Коментар')));
    });

    async function saveCell(inp, lessonId, studentId, key) {
      const v = inp.value.trim();
      if (v === inp.dataset.saved) return;
      if (v !== '' && !GRADE_RE.test(v)) { setStatus('err', `«${v}» — недопустима оцінка. Можна 1–12 або «н».`); return; }
      setStatus('busy', 'Збереження…');
      const res = v === ''
        ? await sb.from('grades').delete().eq('lesson_id', lessonId).eq('student_id', studentId)
        : await sb.from('grades').upsert({ lesson_id: lessonId, student_id: studentId, value: v }, { onConflict: 'lesson_id,student_id' });
      if (res.error) {
        setStatus('err', 'Не збережено: ' + errText(res.error));
        inp.classList.add('bad');
        return;
      }
      inp.dataset.saved = v;
      if (v === '') gmap.delete(key); else gmap.set(key, v);
      avgCells.get(studentId).textContent = fmtNum(rowAvg(studentId));
      setStatus('ok', 'Усі зміни збережено');
    }

    const table = h('table', { class: 'journal' }, h('thead', null, headRow), h('tbody', null, body));
    fill(tableHost, 
      lessons.length ? null : h('div', { class: 'notice', style: 'margin-bottom:12px' }, 'Колонок ще немає. Додайте першу: оберіть дату й вид роботи вгорі та натисніть «Додати колонку».'),
      h('div', { class: 'table-box' }, table));
  }

  async function openComments(student) {
    const list = h('div', { class: 'stack' }, h('div', { class: 'hint' }, 'Завантаження…'));
    const ta = h('textarea', { id: 'ct', class: 'input', maxlength: '1000', placeholder: 'Наприклад: самостійна робота — найкраща в групі; контрольну можна перескласти до 24.11.' });
    const msg = h('div');
    const dlg = h('dialog', null,
      h('form', {
        class: 'card stack', method: 'dialog',
        onsubmit: async (e) => {
          e.preventDefault();
          const text = ta.value.trim();
          if (!text) { dlg.close(); return; }
          const { error } = await sb.from('comments').insert({ student_id: student.id, subject_id: subjectId, body: text });
          if (error) { fill(msg, h('div', { class: 'error' }, errText(error))); return; }
          ta.value = '';
          await refresh();
          setStatus('ok', 'Коментар збережено');
        },
      },
        h('h2', { style: 'font-size:18px' }, student.full_name),
        h('div', { class: 'hint' }, subjectName(subjectId) + ' · коментар бачитимуть батьки'),
        list,
        h('div', { class: 'field' }, h('label', { for: 'ct' }, 'Новий коментар'), ta),
        msg,
        h('div', { class: 'row', style: 'justify-content:flex-end' },
          h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Закрити'),
          h('button', { class: 'btn primary', type: 'submit' }, 'Додати коментар'))));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
    ta.focus();

    async function refresh() {
      const { data, error } = await sb.from('comments').select('id, body, created_at, teacher_id')
        .eq('student_id', student.id).eq('subject_id', subjectId).order('created_at', { ascending: false });
      if (error) { fill(list, h('div', { class: 'error' }, errText(error))); return; }
      if (!data.length) { fill(list, h('div', { class: 'hint' }, 'Коментарів ще немає.')); return; }
      fill(list, ...data.map((c) => h('div', { class: 'comment row', style: 'justify-content:space-between;align-items:flex-start' },
        h('div', { style: 'flex:1;min-width:0' }, h('strong', null, fmtDate(c.created_at, true) + ': '), c.body),
        (c.teacher_id === me.id || me.is_admin) ? h('button', {
          class: 'btn small danger', type: 'button',
          onclick: async () => {
            const { error: de } = await sb.from('comments').delete().eq('id', c.id);
            if (de) { fill(msg, h('div', { class: 'error' }, errText(de))); return; }
            refresh();
          },
        }, 'Видалити') : null)));
    }
    refresh();
  }

  loadGrid();
}

/* ---------- admin ---------- */

async function renderAdmin() {
  mount(h('div', { class: 'empty-state' }, 'Завантаження…'));
  await loadRefs();
  const tabs = [
    ['codes', 'Коди для батьків'],
    ['students', 'Студенти'],
    ['teachers', 'Викладачі'],
    ['subjects', 'Предмети й групи'],
  ];
  let current = load('a.tab') || 'codes';
  const host = h('div');
  const tabBar = h('div', { class: 'tabs', role: 'tablist' });

  function drawTabs() {
    fill(tabBar, ...tabs.map(([id, label]) => h('button', {
      class: 'tab' + (id === current ? ' active' : ''), type: 'button', role: 'tab', 'aria-selected': String(id === current),
      onclick: () => { current = id; store('a.tab', id); drawTabs(); show(); },
    }, label)));
  }
  function show() {
    if (current === 'codes') return adminCodes(host);
    if (current === 'students') return adminStudents(host);
    if (current === 'teachers') return adminTeachers(host);
    return adminSubjects(host);
  }
  mount(h('div', null, h('h1', { class: 'page-title', style: 'margin-bottom:16px' }, 'Адміністрування'), tabBar, host));
  drawTabs();
  show();
}

function groupSelect(id, onChange, storeKey) {
  const sel = h('select', { id, class: 'input', style: 'min-width:260px' }, state.groups.map((g) => h('option', { value: g.id }, g.name)));
  const saved = Number(load(storeKey));
  if (saved && state.groups.some((g) => g.id === saved)) sel.value = String(saved);
  sel.addEventListener('change', () => { store(storeKey, sel.value); onChange(Number(sel.value)); });
  return sel;
}

async function adminCodes(host) {
  const tableHost = h('div');
  let rows = [];
  const sel = groupSelect('cg', (gid) => loadCodes(gid), 'a.group');
  const printBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => printSlips() }, 'Друкувати аркуш з кодами');
  fill(host, h('div', { class: 'stack' },
    h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', { for: 'cg' }, 'Група'), sel), printBtn),
    h('div', { class: 'notice' }, 'Аркуш друкується по 2 картки в ряд: розріжте й роздайте студентам для батьків. Кожен код відкриває оцінки лише однієї дитини.'),
    tableHost));

  async function loadCodes(gid) {
    fill(tableHost, h('div', { class: 'hint' }, 'Завантаження…'));
    const { data, error } = await sb.from('students').select('id, full_name, parent_codes(code)').eq('group_id', gid);
    if (error) { fill(tableHost, h('div', { class: 'error' }, errText(error))); return; }
    rows = (data || []).sort(byName).map((s) => ({
      name: s.full_name,
      code: Array.isArray(s.parent_codes) ? (s.parent_codes[0] || {}).code : (s.parent_codes || {}).code,
    }));
    fill(tableHost, h('div', { class: 'card', style: 'padding:0;overflow-x:auto' },
      h('table', { class: 'list' },
        h('thead', null, h('tr', null, h('th', null, '№'), h('th', null, 'Студент'), h('th', null, 'Код для батьків'))),
        h('tbody', null, rows.map((r, i) => h('tr', null, h('td', null, String(i + 1)), h('td', null, r.name), h('td', { class: 'mono' }, r.code || '—')))))));
  }

  function printSlips() {
    const gname = groupName(Number(sel.value));
    const url = location.origin + location.pathname;
    const area = document.getElementById('print-area');
    fill(area, 
      h('div', { class: 'print-head' }, 'Коди для перегляду оцінок · ' + gname),
      h('div', { class: 'slips' }, rows.map((r) => h('div', { class: 'slip' },
        h('div', { class: 't' }, 'Оцінки онлайн — для батьків'),
        h('div', null, r.name + ' · ' + gname),
        h('div', { class: 'c' }, r.code || '—'),
        h('div', { class: 's' }, 'Відкрийте ' + url + ' і введіть цей код. Не передавайте код стороннім.')))));
    window.print();
  }

  loadCodes(Number(sel.value));
}

async function adminStudents(host) {
  const listHost = h('div');
  const sel = groupSelect('sg', (gid) => loadList(gid), 'a.group');
  const nameIn = h('input', { id: 'sn', class: 'input', placeholder: 'Прізвище Ім’я По батькові', style: 'min-width:320px' });
  const msg = h('div');
  fill(host, h('div', { class: 'stack' },
    h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', { for: 'sg' }, 'Група'), sel)),
    h('form', {
      class: 'card row',
      onsubmit: async (e) => {
        e.preventDefault();
        const name = nameIn.value.trim().replace(/\s+/g, ' ');
        if (name.split(' ').length < 2) { fill(msg, h('div', { class: 'error' }, 'Вкажіть щонайменше прізвище та ім’я.')); return; }
        const { error } = await sb.from('students').insert({ group_id: Number(sel.value), full_name: name });
        if (error) { fill(msg, h('div', { class: 'error' }, errText(error))); return; }
        nameIn.value = '';
        fill(msg, h('div', { class: 'success' }, 'Студента додано, код для батьків створено автоматично.'));
        loadList(Number(sel.value));
      },
    },
      h('div', { class: 'field', style: 'flex:1' }, h('label', { for: 'sn' }, 'Додати студента до групи'), nameIn),
      h('button', { class: 'btn primary', type: 'submit' }, 'Додати')),
    msg,
    listHost));

  async function loadList(gid) {
    const { data, error } = await sb.from('students').select('id, full_name').eq('group_id', gid);
    if (error) { fill(listHost, h('div', { class: 'error' }, errText(error))); return; }
    const rows = (data || []).sort(byName);
    fill(listHost, h('div', { class: 'card', style: 'padding:0;overflow-x:auto' },
      h('table', { class: 'list' },
        h('thead', null, h('tr', null, h('th', null, '№'), h('th', null, 'Студент'), h('th', null, ''))),
        h('tbody', null, rows.map((s, i) => h('tr', null,
          h('td', null, String(i + 1)), h('td', null, s.full_name),
          h('td', { style: 'text-align:right' }, h('button', {
            class: 'btn small danger', type: 'button',
            onclick: async () => {
              if (!confirm(`Видалити студента «${s.full_name}» разом з усіма його оцінками? Цю дію не можна скасувати.`)) return;
              const { error: de } = await sb.from('students').delete().eq('id', s.id);
              if (de) { fill(msg, h('div', { class: 'error' }, errText(de))); return; }
              loadList(gid);
            },
          }, 'Видалити'))))))));
  }
  loadList(Number(sel.value));
}

async function adminTeachers(host) {
  const listHost = h('div');
  const msg = h('div');

  // New teacher form
  const fn = h('input', { id: 'tn', class: 'input', placeholder: 'Прізвище Ім’я По батькові', style: 'min-width:280px' });
  const em = h('input', { id: 'te', class: 'input', type: 'email', placeholder: 'name@example.com', style: 'min-width:240px' });
  const pw = h('input', { id: 'tp', class: 'input', value: genPassword(), style: 'width:170px' });
  const adm = h('input', { type: 'checkbox' });
  const pairs = [];
  const pairsHost = h('div');
  const gSel = h('select', { class: 'input', 'aria-label': 'Група' }, state.groups.map((g) => h('option', { value: g.id }, g.name)));
  const sSel = h('select', { class: 'input', 'aria-label': 'Предмет' }, state.subjects.map((s) => h('option', { value: s.id }, s.name)));
  function drawPairs() {
    fill(pairsHost, ...pairs.map((p, i) => h('span', { class: 'pill' }, `${subjectName(p.subject_id)} — ${groupName(p.group_id)}`,
      h('button', { type: 'button', 'aria-label': 'Прибрати', onclick: () => { pairs.splice(i, 1); drawPairs(); } }, '✕'))));
  }
  const createBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Створити акаунт');
  const form = h('form', {
    class: 'card stack',
    onsubmit: async (e) => {
      e.preventDefault();
      fill(msg, );
      createBtn.disabled = true; createBtn.textContent = 'Створення…';
      const { data, error } = await sb.functions.invoke('create-teacher', {
        body: { full_name: fn.value.trim(), email: em.value.trim(), password: pw.value, is_admin: adm.checked, assignments: pairs },
      });
      createBtn.disabled = false; createBtn.textContent = 'Створити акаунт';
      let errMsg = null;
      if (error) {
        try { const b = await error.context.json(); errMsg = b.error || error.message; } catch (x) { errMsg = error.message; }
      } else if (data && data.error) errMsg = data.error;
      if (errMsg) { fill(msg, h('div', { class: 'error' }, errMsg)); return; }
      fill(msg, h('div', { class: 'success' },
        `Акаунт створено. Передайте викладачу: сайт ${location.origin + location.pathname}, пошта ${em.value.trim()}, тимчасовий пароль ${pw.value}. Після входу хай змінить пароль у меню «Змінити пароль».`,
        data && data.warning ? ' ' + data.warning : ''));
      fn.value = ''; em.value = ''; pw.value = genPassword(); adm.checked = false; pairs.length = 0; drawPairs();
      await loadRefs();
      loadList();
    },
  },
    h('h2', { style: 'font-size:18px' }, 'Новий викладач'),
    h('div', { class: 'row' },
      h('div', { class: 'field' }, h('label', { for: 'tn' }, 'ПІБ'), fn),
      h('div', { class: 'field' }, h('label', { for: 'te' }, 'Пошта'), em),
      h('div', { class: 'field' }, h('label', { for: 'tp' }, 'Тимчасовий пароль'), pw)),
    h('div', { class: 'field' },
      h('span', { class: 'label' }, 'Предмети й групи'),
      h('div', { class: 'row' }, sSel, gSel,
        h('button', {
          class: 'btn', type: 'button',
          onclick: () => {
            const p = { group_id: Number(gSel.value), subject_id: Number(sSel.value) };
            if (!pairs.some((x) => x.group_id === p.group_id && x.subject_id === p.subject_id)) pairs.push(p);
            drawPairs();
          },
        }, '+ Додати')),
      pairsHost),
    h('label', { class: 'checkbox' }, adm, 'Адміністратор (бачить усі групи, коди батьків, керує викладачами)'),
    h('div', null, createBtn),
    msg);

  fill(host, h('div', { class: 'stack' }, form, listHost));

  async function loadList() {
    const { data, error } = await sb.from('teachers').select('id, full_name, email, is_admin');
    if (error) { fill(listHost, h('div', { class: 'error' }, errText(error))); return; }
    const teachers = (data || []).sort(byName);
    fill(listHost, h('div', { class: 'card', style: 'padding:0;overflow-x:auto' },
      h('table', { class: 'list' },
        h('thead', null, h('tr', null, h('th', null, 'Викладач'), h('th', null, 'Предмети й групи'), h('th', null, 'Додати'))),
        h('tbody', null, teachers.map((t) => {
          const mine = state.assignments.filter((a) => a.teacher_id === t.id)
            .sort((a, b) => (subjectName(a.subject_id) + groupName(a.group_id)).localeCompare(subjectName(b.subject_id) + groupName(b.group_id), 'uk'));
          const g2 = h('select', { class: 'input', 'aria-label': 'Група' }, state.groups.map((g) => h('option', { value: g.id }, g.name)));
          const s2 = h('select', { class: 'input', 'aria-label': 'Предмет' }, state.subjects.map((s) => h('option', { value: s.id }, s.name)));
          return h('tr', null,
            h('td', null, h('div', { style: 'font-weight:600' }, t.full_name, t.is_admin ? h('span', { class: 'badge' }, 'адмін') : null),
              h('div', { class: 'hint' }, t.email || '')),
            h('td', null, mine.length ? mine.map((a) => h('span', { class: 'pill' }, `${subjectName(a.subject_id)} — ${groupName(a.group_id)}`,
              h('button', {
                type: 'button', 'aria-label': 'Прибрати призначення',
                onclick: async () => {
                  const { error: de } = await sb.from('teacher_assignments').delete()
                    .eq('teacher_id', t.id).eq('group_id', a.group_id).eq('subject_id', a.subject_id);
                  if (de) { fill(msg, h('div', { class: 'error' }, errText(de))); return; }
                  await loadRefs(); loadList();
                },
              }, '✕'))) : h('span', { class: 'hint' }, t.is_admin ? 'Адміністратор має доступ до всіх груп' : 'Нічого не закріплено')),
            h('td', null, h('div', { class: 'row', style: 'flex-wrap:nowrap' }, s2, g2,
              h('button', {
                class: 'btn small', type: 'button',
                onclick: async () => {
                  const { error: ie } = await sb.from('teacher_assignments')
                    .upsert({ teacher_id: t.id, group_id: Number(g2.value), subject_id: Number(s2.value) }, { ignoreDuplicates: true });
                  if (ie) { fill(msg, h('div', { class: 'error' }, errText(ie))); return; }
                  await loadRefs(); loadList();
                },
              }, 'Закріпити'))));
        })))));
  }
  loadList();
}

async function adminSubjects(host) {
  const sIn = h('input', { id: 'nsub', class: 'input', placeholder: 'Назва предмета', style: 'min-width:320px' });
  const gIn = h('input', { id: 'ngr', class: 'input', placeholder: 'АФК-9-26-К1ХХ(3.0д)', style: 'min-width:260px' });
  const msg = h('div');
  const addTo = (table, input, label) => h('form', {
    class: 'card row',
    onsubmit: async (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) return;
      const { error } = await sb.from(table).insert({ name });
      if (error) { fill(msg, h('div', { class: 'error' }, /duplicate/i.test(error.message) ? 'Така назва вже є.' : errText(error))); return; }
      input.value = '';
      fill(msg, h('div', { class: 'success' }, 'Додано.'));
      await loadRefs(); draw();
    },
  }, h('div', { class: 'field', style: 'flex:1' }, h('label', { for: input.id }, label), input), h('button', { class: 'btn primary', type: 'submit' }, 'Додати'));

  const lists = h('div', { class: 'row', style: 'align-items:flex-start' });
  function draw() {
    fill(lists, 
      h('div', { class: 'card', style: 'flex:1;min-width:280px' }, h('h2', { style: 'font-size:16px;margin-bottom:8px' }, `Предмети (${state.subjects.length})`),
        h('ul', { style: 'margin:0;padding-left:18px' }, state.subjects.map((s) => h('li', null, s.name)))),
      h('div', { class: 'card', style: 'flex:1;min-width:280px' }, h('h2', { style: 'font-size:16px;margin-bottom:8px' }, `Групи (${state.groups.length})`),
        h('ul', { style: 'margin:0;padding-left:18px' }, state.groups.map((g) => h('li', null, g.name)))));
  }
  fill(host, h('div', { class: 'stack' }, addTo('subjects', sIn, 'Новий предмет'), addTo('groups', gIn, 'Нова група'), msg, lists));
  draw();
}

/* ---------- start ---------- */

window.addEventListener('hashchange', render);

sb.auth.onAuthStateChange((event, session) => {
  const was = state.session && state.session.user.id;
  state.session = session;
  const now = session && session.user.id;
  if (event === 'SIGNED_IN' && was !== now) {
    // Defer: Supabase calls inside this callback can deadlock the auth lock.
    setTimeout(() => loadMe().then(() => {
      if (location.hash === '#login' || !location.hash) location.hash = state.me ? '#journal' : '#parents';
      render();
    }), 0);
  } else if (event === 'SIGNED_OUT') {
    state.me = null;
    render();
  }
});

(async function start() {
  const { data } = await sb.auth.getSession();
  state.session = data.session;
  await loadMe();
  render();
})();
