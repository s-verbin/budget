'use strict';
// Интерфейс бюджета. Данные хранит сервер (SQLite), расчёты делает Calc (calc.js).

const $ = id => document.getElementById(id);
const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const MON = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MON_FULL = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const EVERY = [[0, 'один раз'], [1, 'каждый месяц'], [3, 'раз в 3 месяца'], [6, 'раз в полгода'], [12, 'раз в год']];
const MODES = [['term', 'Сократить срок'], ['payment', 'Уменьшить платёж']];
const HORIZONS = [[12, '12 месяцев'], [24, '24 месяца'], [36, '36 месяцев'], [60, '60 месяцев']];
const DEFAULT_CATEGORIES = ['Жильё', 'Еда', 'Транспорт', 'Дети', 'Здоровье', 'Развлечения', 'Путешествия', 'Одежда', 'Связь и подписки', 'Прочее'];

const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const fmt = n => nf.format(Math.round(n));
const fmtR = n => fmt(n) + ' ₽';
const signed = n => (Math.round(n) > 0 ? '+' : '') + fmt(n);
const short = n => {
  const a = Math.abs(n), s = n < 0 ? '−' : '';
  if (a >= 1e6) return s + (a / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace('.', ',').replace(',0', '') + ' млн';
  if (a >= 1e3) return s + Math.round(a / 1e3) + ' тыс';
  return s + Math.round(a);
};
const monthLabel = idx => MON[idx % 12] + ' ' + Math.floor(idx / 12);
const monthFull = idx => MON_FULL[idx % 12] + ' ' + Math.floor(idx / 12);
const termText = t => { const y = Math.floor(t / 12), m = t % 12; return (y ? y + ' г.' : '') + (y && m ? ' ' : '') + (m || !y ? m + ' мес.' : ''); };

let S = null;   // данные с сервера: {settings, items, loans, prepayments, deposits, deposit_contributions}
let F = null;   // прогноз Calc.forecast(S)
const openMonths = new Set();   // раскрытые месяцы в таблице
let shareMode = 'month';        // «Структура расходов»: по месяцам или по годам

// ---------- сервер
async function api(method, url, body) {
  const r = await fetch(url, {
    method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Ошибка ' + r.status);
  return data;
}

function setSaved(state, msg) {
  const el = $('saved');
  el.className = 'saved' + (state === 'err' ? ' err' : '');
  el.textContent = state === 'busy' ? 'Сохраняю…' : state === 'ok' ? 'Сохранено' : 'Не сохранено: ' + msg;
}

// Изменения уходят на сервер с задержкой: пока печатаете, запросов не шлём.
const timers = new Map();
function persist(table, obj) {
  const key = table + ':' + (obj.id || 0);
  clearTimeout(timers.get(key));
  setSaved('busy');
  timers.set(key, setTimeout(async () => {
    timers.delete(key);
    try {
      const { id, ...body } = obj;
      await api('PUT', table === 'settings' ? '/api/settings' : `/api/${table}/${id}`, body);
      if (!timers.size) setSaved('ok');
    } catch (e) { setSaved('err', e.message); }
  }, 350));
}
function forget(table, id) { const k = table + ':' + id; clearTimeout(timers.get(k)); timers.delete(k); }

function changed(table, rec) { persist(table, rec); renderResults(); }

// ---------- элементы форм
function field(label, control) {
  const d = mk('div', 'f'), l = mk('span', 'fl', label);
  d.append(l, control); d.label = l;
  return d;
}

function numField(id, get, set, unit, { money = true, neg = false, aria } = {}) {
  const w = mk('div', 'inp'), i = mk('input');
  i.type = 'text'; i.inputMode = 'decimal'; i.autocomplete = 'off'; i.id = id;
  if (aria) i.setAttribute('aria-label', aria);
  const show = () => { i.value = money ? fmt(get()) : String(get()).replace('.', ','); };
  show();
  i.addEventListener('input', () => {
    const v = parseFloat(i.value.replace(/[\s ]/g, '').replace(',', '.').replace('−', '-'));
    set(isNaN(v) ? 0 : (neg ? v : Math.max(0, v)));
  });
  i.addEventListener('blur', show);
  const u = mk('span', 'u', unit);
  w.append(i, u);
  return w;
}

function textField(id, get, set, aria) {
  const w = mk('div', 'inp'), i = mk('input', 'l');
  i.type = 'text'; i.id = id; i.autocomplete = 'off'; i.placeholder = 'Название'; i.value = get();
  i.setAttribute('aria-label', aria);
  i.addEventListener('input', () => set(i.value));
  w.appendChild(i);
  return w;
}

function categoryField(id, get, set, aria) {
  const w = mk('div', 'inp'), i = mk('input', 'l');
  i.type = 'text'; i.id = id; i.autocomplete = 'off'; i.placeholder = 'Категория'; i.value = get();
  i.setAttribute('list', 'cat-list'); i.setAttribute('aria-label', aria);
  i.addEventListener('input', () => set(i.value));
  i.addEventListener('blur', () => buildCategoryList());
  w.appendChild(i);
  return w;
}

function selectEl(id, opts, value, onChange, aria) {
  const s = mk('select', 'sel'); s.id = id; s.setAttribute('aria-label', aria);
  opts.forEach(([v, t]) => s.add(new Option(t, v)));
  s.value = String(value);
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

// Месяц + год двумя списками (нативный <input type=month> есть не везде).
function monthPicker(id, get, set, aria, optional) {
  const w = mk('div', 'mp'), mo = mk('select', 'sel'), yr = mk('select', 'sel');
  mo.id = id + '-m'; yr.id = id + '-y';
  mo.setAttribute('aria-label', aria + ': месяц'); yr.setAttribute('aria-label', aria + ': год');
  if (optional) mo.add(new Option('—', ''));
  MON.forEach((t, i) => mo.add(new Option(t, i + 1)));
  const baseYear = () => +S.settings.start.slice(0, 4);
  const show = () => {
    const v = get();
    let lo = baseYear() - 1, hi = baseYear() + 40;
    if (v) { const y = +v.slice(0, 4); lo = Math.min(lo, y); hi = Math.max(hi, y); }
    yr.replaceChildren();
    for (let y = lo; y <= hi; y++) yr.add(new Option(y, y));
    if (v) { mo.value = String(+v.slice(5)); yr.value = v.slice(0, 4); yr.hidden = false; }
    else { mo.value = ''; yr.value = String(baseYear()); yr.hidden = true; }
  };
  const commit = () => {
    if (optional && mo.value === '') set(null);
    else set(yr.value + '-' + String(mo.value).padStart(2, '0'));
    show();
  };
  mo.addEventListener('change', commit); yr.addEventListener('change', commit);
  show();
  w.append(mo, yr);
  return w;
}

function delButton(onDel) {
  const b = mk('button', 'del', '×'); b.type = 'button'; b.setAttribute('aria-label', 'Удалить'); b.title = 'Удалить';
  b.addEventListener('click', onDel);
  return b;
}

// Повтор + «когда/с» + «до» для статей и досрочных погашений.
function recFields(rec, table, idp) {
  const fEvery = field('Повтор', selectEl(idp + '-every', EVERY, rec.every, v => { rec.every = +v; sync(); changed(table, rec); }, 'Повтор'));
  const fStart = field('', monthPicker(idp + '-start', () => rec.start, v => { rec.start = v; changed(table, rec); }, 'Начало'));
  const fUntil = field('До', monthPicker(idp + '-until', () => rec.until, v => { rec.until = v; changed(table, rec); }, 'Конец', true));
  const sync = () => { fStart.label.textContent = rec.every === 0 ? 'Когда' : 'Начало'; fUntil.hidden = rec.every === 0; };
  sync();
  return [fEvery, fStart, fUntil];
}

// ---------- строки
function itemRow(it) {
  const row = mk('div', 'brow');
  const nm = field('Название', textField(`item-${it.id}-name`, () => it.name, v => { it.name = v; changed('items', it); }, 'Название'));
  nm.classList.add('nm');
  const amount = field('Сумма', numField(`item-${it.id}-amount`, () => it.amount, v => { it.amount = v; changed('items', it); }, '₽', { aria: 'Сумма' }));
  const rest = mk('div', 'rest');
  const fields = [amount, ...recFields(it, 'items', `item-${it.id}`)];
  if (it.kind === 'expense') {
    fields.push(field('Категория', categoryField(`item-${it.id}-cat`, () => it.category || '', v => { it.category = v; changed('items', it); }, 'Категория')));
  }
  rest.append(...fields);
  row.append(nm, rest, delButton(() => removeItem(it)));
  if (it.kind === 'expense') row.appendChild(factBox(it));
  return row;
}

// Факт по статье расхода: список введённых сумм по месяцам, чтобы свериться с планом.
function factRow(a) {
  const row = mk('div', 'factrow');
  row.append(
    field('Месяц', monthPicker(`fa-${a.id}`, () => a.month, v => { a.month = v; changed('actuals', a); }, 'Месяц факта')),
    field('Фактически потрачено', numField(`fa-${a.id}-amount`, () => a.amount, v => { a.amount = v; changed('actuals', a); }, '₽', { aria: 'Фактически потрачено' })),
    delButton(() => removeActual(a)));
  return row;
}

function factBox(it) {
  const box = mk('details', 'yrs');
  const sm = mk('summary', null, 'Факт'); sm.id = `item-${it.id}-fact-sm`;
  const list = mk('div'); list.id = `item-${it.id}-fact-list`;
  S.actuals.filter(a => a.item_id === it.id).forEach(a => list.appendChild(factRow(a)));
  const add = mk('button', null, '+ Указать факт'); add.type = 'button';
  add.addEventListener('click', () => addActual(it));
  const actions = mk('div', 'actions'); actions.appendChild(add);
  box.append(sm, list, actions);
  return box;
}

function prepayRow(pp) {
  const row = mk('div', 'brow');
  const nm = field('Сумма досрочного', numField(`pp-${pp.id}-amount`, () => pp.amount, v => { pp.amount = v; changed('prepayments', pp); }, '₽', { aria: 'Сумма досрочного погашения' }));
  nm.classList.add('nm');
  const mode = field('Что уменьшить', selectEl(`pp-${pp.id}-mode`, MODES, pp.mode, v => { pp.mode = v; changed('prepayments', pp); }, 'Что уменьшить'));
  const rest = mk('div', 'rest');
  const [fEvery, fStart, fUntil] = recFields(pp, 'prepayments', `pp-${pp.id}`);
  rest.append(fEvery, fStart, fUntil, mode);
  row.append(nm, rest, delButton(() => removePrepay(pp)));
  return row;
}

function contribRow(c) {
  const row = mk('div', 'brow');
  const nm = field('Сумма пополнения', numField(`dc-${c.id}-amount`, () => c.amount, v => { c.amount = v; changed('deposit_contributions', c); }, '₽', { aria: 'Сумма пополнения вклада' }));
  nm.classList.add('nm');
  const rest = mk('div', 'rest');
  rest.append(...recFields(c, 'deposit_contributions', `dc-${c.id}`));
  row.append(nm, rest, delButton(() => removeContribution(c)));
  return row;
}

function loanBox(ln) {
  const box = mk('div', 'loanbox');
  const head = mk('div', 'lhead');
  head.append(
    field('Название', textField(`loan-${ln.id}-name`, () => ln.name, v => { ln.name = v; changed('loans', ln); }, 'Название кредита')),
    delButton(() => removeLoan(ln)));
  const num = (key, label, unit, money, aria) =>
    field(label, numField(`loan-${ln.id}-${key}`, () => ln[key], v => { ln[key] = key === 'term' ? Math.round(v) : v; changed('loans', ln); }, unit, { money, aria: aria || label }));
  const lf = mk('div', 'lfields');
  lf.append(
    num('principal', 'Сумма или остаток долга', '₽', true),
    num('rate', 'Ставка в год', '%', false),
    num('term', 'Срок', 'мес.', false),
    field('Первый платёж', monthPicker(`loan-${ln.id}-start`, () => ln.start, v => { ln.start = v; changed('loans', ln); }, 'Первый платёж')),
    num('down_payment', 'Первоначальный взнос', '₽', true));

  const res = mk('div', 'res'); res.id = `loan-${ln.id}-res`;
  const chart = mk('div', 'chartwrap lbox-chart'); chart.id = `loan-${ln.id}-chart`;
  const ppList = mk('div'); ppList.id = `loan-${ln.id}-pp`;
  S.prepayments.filter(p => p.loan_id === ln.id).forEach(p => ppList.appendChild(prepayRow(p)));
  const add = mk('button', null, '+ Досрочное погашение'); add.type = 'button';
  add.addEventListener('click', () => addPrepay(ln));
  const actions = mk('div', 'actions'); actions.appendChild(add);

  const yrs = mk('details', 'yrs');
  const sm = mk('summary', null, 'График по годам');
  const tw = mk('div', 'tblwrap'); const tbl = mk('table', 'cmp'); tbl.id = `loan-${ln.id}-years`; tw.appendChild(tbl);
  yrs.append(sm, tw);

  box.append(head, lf, res, mk('div', 'ppt', 'Досрочные погашения'), ppList, actions, chart, yrs);
  return box;
}

function depositBox(dep) {
  const box = mk('div', 'loanbox');
  const head = mk('div', 'lhead');
  head.append(
    field('Название', textField(`dep-${dep.id}-name`, () => dep.name, v => { dep.name = v; changed('deposits', dep); }, 'Название вклада')),
    delButton(() => removeDeposit(dep)));
  const num = (key, label, unit, money, aria) =>
    field(label, numField(`dep-${dep.id}-${key}`, () => dep[key], v => { dep[key] = v; changed('deposits', dep); }, unit, { money, aria: aria || label }));
  const lf = mk('div', 'lfields');
  lf.append(
    num('opening', 'Остаток сейчас', '₽', true),
    num('rate', 'Ставка в год', '%', false),
    num('tax', 'Налог с процентов', '%', false),
    field('Открыт', monthPicker(`dep-${dep.id}-start`, () => dep.start, v => { dep.start = v; changed('deposits', dep); }, 'Открыт')));

  const res = mk('div', 'res'); res.id = `dep-${dep.id}-res`;
  const chart = mk('div', 'chartwrap lbox-chart'); chart.id = `dep-${dep.id}-chart`;
  const list = mk('div'); list.id = `dep-${dep.id}-list`;
  S.deposit_contributions.filter(c => c.deposit_id === dep.id).forEach(c => list.appendChild(contribRow(c)));
  const add = mk('button', null, '+ Пополнение'); add.type = 'button';
  add.addEventListener('click', () => addContribution(dep));
  const actions = mk('div', 'actions'); actions.appendChild(add);

  const yrs = mk('details', 'yrs');
  const sm = mk('summary', null, 'По годам');
  const tw = mk('div', 'tblwrap'); const tbl = mk('table', 'cmp'); tbl.id = `dep-${dep.id}-years`; tw.appendChild(tbl);
  yrs.append(sm, tw);

  box.append(head, lf, res, mk('div', 'ppt', 'Пополнения'), list, actions, chart, yrs);
  return box;
}

function buildCategoryList() {
  const dl = $('cat-list'); if (!dl) return;
  const used = S.items.filter(i => i.kind === 'expense' && i.category).map(i => i.category.trim());
  const all = [...DEFAULT_CATEGORIES, ...used].filter((v, i, a) => v && a.indexOf(v) === i);
  dl.replaceChildren(...all.map(c => new Option(c)));
}

function buildLists() {
  ['income', 'expense'].forEach(kind => {
    const box = $('lst-' + kind); box.replaceChildren();
    const arr = S.items.filter(i => i.kind === kind);
    if (!arr.length) box.appendChild(mk('p', 'hint', 'Пока ничего нет.'));
    arr.forEach(it => box.appendChild(itemRow(it)));
  });
  buildCategoryList();
  const lb = $('lst-loans'); lb.replaceChildren();
  if (!S.loans.length) lb.appendChild(mk('p', 'hint', 'Кредитов нет.'));
  S.loans.forEach(ln => lb.appendChild(loanBox(ln)));
  const ld = $('lst-deposits'); ld.replaceChildren();
  if (!S.deposits.length) ld.appendChild(mk('p', 'hint', 'Вкладов нет.'));
  S.deposits.forEach(dep => ld.appendChild(depositBox(dep)));
}

function buildSetup() {
  const box = $('setup-fields'); box.replaceChildren();
  const st = S.settings;
  box.append(
    field('Считать с', monthPicker('set-start', () => st.start, v => { st.start = v; changed('settings', st); }, 'Считать с')),
    field('Горизонт', selectEl('set-horizon', HORIZONS, st.horizon, v => { st.horizon = +v; changed('settings', st); }, 'Горизонт')),
    field('Остаток на счетах на начало', numField('set-opening', () => st.opening, v => { st.opening = v; changed('settings', st); }, '₽', { neg: true, aria: 'Остаток на счетах на начало периода' })),
    field('Неснижаемый резерв', numField('set-reserve', () => st.reserve, v => { st.reserve = v; changed('settings', st); }, '₽', { aria: 'Неснижаемый резерв' })));
}

// ---------- действия
async function addItem(kind) {
  try {
    const it = await api('POST', '/api/items', { kind, name: '', amount: 0, start: S.settings.start, every: 1, until: null });
    S.items.push(it); buildLists(); renderResults();
    const f = $(`item-${it.id}-name`); if (f) f.focus();
  } catch (e) { setSaved('err', e.message); }
}
async function removeItem(it) {
  forget('items', it.id);
  try { await api('DELETE', '/api/items/' + it.id); S.items = S.items.filter(x => x !== it); buildLists(); renderResults(); }
  catch (e) { setSaved('err', e.message); }
}
async function addLoan() {
  try {
    const ln = await api('POST', '/api/loans', { name: '', principal: 0, rate: 0, term: 12, start: S.settings.start, down_payment: 0 });
    S.loans.push(ln); buildLists(); renderResults();
    const f = $(`loan-${ln.id}-name`); if (f) f.focus();
  } catch (e) { setSaved('err', e.message); }
}
async function removeLoan(ln) {
  if (!confirm('Удалить кредит «' + (ln.name || 'без названия') + '» вместе с его досрочными погашениями?')) return;
  forget('loans', ln.id);
  try {
    await api('DELETE', '/api/loans/' + ln.id);
    S.loans = S.loans.filter(x => x !== ln); S.prepayments = S.prepayments.filter(p => p.loan_id !== ln.id);
    buildLists(); renderResults();
  } catch (e) { setSaved('err', e.message); }
}
async function addPrepay(ln) {
  try {
    const pp = await api('POST', '/api/prepayments', { loan_id: ln.id, amount: 0, start: ln.start, every: 0, until: null, mode: 'term' });
    S.prepayments.push(pp); buildLists(); renderResults();
    const f = $(`pp-${pp.id}-amount`); if (f) f.focus();
  } catch (e) { setSaved('err', e.message); }
}
async function removePrepay(pp) {
  forget('prepayments', pp.id);
  try { await api('DELETE', '/api/prepayments/' + pp.id); S.prepayments = S.prepayments.filter(x => x !== pp); buildLists(); renderResults(); }
  catch (e) { setSaved('err', e.message); }
}
async function addDeposit() {
  try {
    const dep = await api('POST', '/api/deposits', { name: '', opening: 0, rate: 0, tax: 0, start: S.settings.start });
    S.deposits.push(dep); buildLists(); renderResults();
    const f = $(`dep-${dep.id}-name`); if (f) f.focus();
  } catch (e) { setSaved('err', e.message); }
}
async function removeDeposit(dep) {
  if (!confirm('Удалить вклад «' + (dep.name || 'без названия') + '» вместе с его пополнениями?')) return;
  forget('deposits', dep.id);
  try {
    await api('DELETE', '/api/deposits/' + dep.id);
    S.deposits = S.deposits.filter(x => x !== dep); S.deposit_contributions = S.deposit_contributions.filter(c => c.deposit_id !== dep.id);
    buildLists(); renderResults();
  } catch (e) { setSaved('err', e.message); }
}
async function addContribution(dep) {
  try {
    const c = await api('POST', '/api/deposit_contributions', { deposit_id: dep.id, amount: 0, start: S.settings.start, every: 0, until: null });
    S.deposit_contributions.push(c); buildLists(); renderResults();
    const f = $(`dc-${c.id}-amount`); if (f) f.focus();
  } catch (e) { setSaved('err', e.message); }
}
async function removeContribution(c) {
  forget('deposit_contributions', c.id);
  try { await api('DELETE', '/api/deposit_contributions/' + c.id); S.deposit_contributions = S.deposit_contributions.filter(x => x !== c); buildLists(); renderResults(); }
  catch (e) { setSaved('err', e.message); }
}
async function addActual(it) {
  // первый месяц без факта начиная с текущего начала расчёта, чтобы не столкнуться с уже занятым месяцем
  const used = new Set(S.actuals.filter(a => a.item_id === it.id).map(a => a.month));
  let idx = Calc.ymIdx(S.settings.start);
  while (used.has(Calc.idxYm(idx))) idx++;
  try {
    const a = await api('POST', '/api/actuals', { item_id: it.id, month: Calc.idxYm(idx), amount: 0 });
    S.actuals.push(a); buildLists(); renderResults();
    const f = $(`fa-${a.id}-amount`); if (f) f.focus();
  } catch (e) { setSaved('err', e.message); }
}
async function removeActual(a) {
  forget('actuals', a.id);
  try { await api('DELETE', '/api/actuals/' + a.id); S.actuals = S.actuals.filter(x => x !== a); buildLists(); renderResults(); }
  catch (e) { setSaved('err', e.message); }
}

// ---------- график
function niceTicks(min, max, target) {
  const span = (max - min) || 1, raw = span / target, p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / p;
  const step = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
  const lo = Math.floor(min / step + 1e-9);
  let hi = Math.ceil(max / step - 1e-9);
  if (hi <= lo) hi = lo + 1;   // шкала не должна схлопываться в одну точку
  const t = [];
  for (let i = lo; i <= hi; i++) t.push(i * step);
  return t;
}

function drawFlow(box, months, settings) {
  const N = months.length;
  if (!N) { box.replaceChildren(); return; }
  const W = Math.max(300, box.clientWidth || 640);
  const L = 58, R = 12, T = 10, H1 = 190, GAP = 36, H2 = 84, XB = 34;
  const H = T + H1 + GAP + H2 + XB;
  const bw = (W - L - R) / N, cx = k => L + bw * (k + 0.5);
  const reserve = +settings.reserve || 0, opening = +settings.opening || 0;

  const t1 = niceTicks(Math.min(0, reserve, opening, ...months.map(m => m.balance)), Math.max(0, reserve, opening, ...months.map(m => m.balance)), 4);
  const lo1 = t1[0], hi1 = t1[t1.length - 1];
  const y1 = v => T + H1 * (1 - (v - lo1) / (hi1 - lo1));

  const maxNet = Math.max(1, ...months.map(m => Math.abs(m.net)));
  const t2 = niceTicks(-maxNet, maxNet, 2);
  const lo2 = t2[0], hi2 = t2[t2.length - 1], top2 = T + H1 + GAP;
  const y2 = v => top2 + H2 * (1 - (v - lo2) / (hi2 - lo2));

  let o = '';
  months.forEach((m, k) => { if (m.gap) o += `<rect class="gapband" x="${L + bw * k}" y="${T}" width="${bw}" height="${H1}"/>`; });
  t1.forEach(v => {
    o += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y1(v)}" y2="${y1(v)}"/><text x="${L - 6}" y="${y1(v) + 4}" text-anchor="end">${short(v)}</text>`;
  });
  if (lo1 < 0) o += `<line class="zero" x1="${L}" x2="${W - R}" y1="${y1(0)}" y2="${y1(0)}"/>`;
  if (reserve > 0) {
    o += `<line class="reserve" x1="${L}" x2="${W - R}" y1="${y1(reserve)}" y2="${y1(reserve)}"/>`;
    o += `<text class="lab-reserve" x="${W - R - 2}" y="${y1(reserve) - 5}" text-anchor="end">резерв ${short(reserve)}</text>`;
  }
  const pts = [[L, y1(opening)], ...months.map((m, k) => [cx(k), y1(m.balance)])];
  const path = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('');
  o += `<path class="area" d="${path}L${pts[pts.length - 1][0].toFixed(1)} ${y1(0)}L${L} ${y1(0)}Z"/><path class="line" d="${path}"/>`;
  months.forEach((m, k) => {
    if (m.gap || m.low) o += `<circle class="${m.gap ? 'pt-gap' : 'pt-low'}" cx="${cx(k)}" cy="${y1(m.balance)}" r="3.5"/>`;
  });
  o += `<circle class="pt-end" cx="${cx(N - 1)}" cy="${y1(months[N - 1].balance)}" r="4"/>`;

  // нижняя панель: итог месяца
  o += `<text x="${L}" y="${top2 - 12}">Итог за месяц</text>`;
  t2.forEach(v => {
    o += `<line class="${v === 0 ? 'axis' : 'grid'}" x1="${L}" x2="${W - R}" y1="${y2(v)}" y2="${y2(v)}"/><text x="${L - 6}" y="${y2(v) + 4}" text-anchor="end">${short(v)}</text>`;
  });
  months.forEach((m, k) => {
    const yv = y2(m.net), y0 = y2(0), h = Math.max(1, Math.abs(yv - y0));
    o += `<rect class="${m.net >= 0 ? 'bar-pos' : 'bar-neg'}" x="${L + bw * k + bw * 0.15}" y="${m.net >= 0 ? y0 - h : y0}" width="${Math.max(1, bw * 0.7)}" height="${h}" rx="1.5"/>`;
  });

  // подписи месяцев: шаг зависит от ширины столбца
  const step = Math.max(1, Math.ceil(46 / bw));
  let lastYear = null;
  months.forEach((m, k) => {
    if (k % step) return;
    const mi = m.idx % 12, yy = Math.floor(m.idx / 12);
    o += `<text x="${cx(k)}" y="${top2 + H2 + 16}" text-anchor="middle">${MON[mi]}</text>`;
    if (yy !== lastYear) { o += `<text x="${cx(k)}" y="${top2 + H2 + 30}" text-anchor="middle">${yy}</text>`; lastYear = yy; }
  });
  o += `<line class="cursor" id="cur" x1="0" x2="0" y1="${T}" y2="${top2 + H2}" style="display:none"/>`;

  box.innerHTML = `<svg class="chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Остаток на счетах и итог по месяцам">${o}</svg>`;
  const svg = box.firstChild, cur = svg.querySelector('#cur');
  const show = ev => {
    const r = svg.getBoundingClientRect();
    const k = Math.max(0, Math.min(N - 1, Math.floor((ev.clientX - r.left - L) / bw)));
    const m = months[k];
    cur.setAttribute('x1', cx(k)); cur.setAttribute('x2', cx(k)); cur.style.display = '';
    const extra = m.prepay + m.down;
    $('ro').innerHTML = `<b>${monthFull(m.idx)}</b>: доходы ${fmtR(m.income)}, расходы ${fmtR(m.expense)}, кредиты ${fmtR(m.loan)}` +
      (extra > 0 ? `, досрочно и взносы ${fmtR(extra)}` : '') + `. Остаток <b style="color:var(--${m.gap ? 'bad' : m.low ? 'warn' : 'ink'})">${fmtR(m.balance)}</b>`;
  };
  svg.onpointerdown = svg.onpointermove = show;
}

function drawLoanChart(box, startIdx, actual, base) {
  const N = base.length;
  if (N < 2) { box.replaceChildren(); return; }
  const W = Math.max(300, box.clientWidth || 640), L = 58, R = 12, T = 8, H1 = 150, XB = 24, H = T + H1 + XB;
  const ticks = niceTicks(0, Math.max(...base), 4), hi = ticks[ticks.length - 1];
  const x = k => L + (W - L - R) * k / (N - 1), y = v => T + H1 * (1 - v / hi);
  let o = '';
  ticks.forEach(v => { o += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${short(v)}</text>`; });
  // подписи: конец каждого года (декабрь), не чаще, чем позволяет ширина
  const perYear = (W - L - R) * 12 / (N - 1), yStep = Math.max(1, Math.ceil(46 / perYear));
  let shown = 0;
  for (let k = 0; k < N; k++) {
    const mi = startIdx + k - 1;
    if (k > 0 && mi % 12 === 11) { if (shown++ % yStep === 0) o += `<text x="${x(k)}" y="${T + H1 + 16}" text-anchor="middle">${Math.floor(mi / 12)}</text>`; }
  }
  const line = (vals, cls) => `<path class="line ${cls}" d="${vals.map((v, k) => (k ? 'L' : 'M') + x(k).toFixed(1) + ' ' + y(v).toFixed(1)).join('')}"/>`;
  o += line(base, 'base') + line(actual, '');
  box.innerHTML = `<div class="legend"><span><i class="ln dash" style="color:var(--muted)"></i>Остаток долга без досрочных</span><span><i class="ln" style="background:var(--a)"></i>С досрочными</span></div>` +
    `<svg class="chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Остаток долга с досрочными погашениями и без">${o}</svg>`;
}

// ---------- вывод результатов
function runs(months, pred) {
  const out = []; let cur = null;
  months.forEach(m => {
    if (pred(m)) { if (!cur) { cur = { from: m.idx, to: m.idx, min: m.balance }; out.push(cur); } cur.to = m.idx; cur.min = Math.min(cur.min, m.balance); }
    else cur = null;
  });
  return out;
}
const runLabel = r => r.from === r.to ? monthFull(r.from) : monthLabel(r.from) + ' – ' + monthLabel(r.to);

function renderVerdict() {
  const v = $('verdict'), al = [];
  if (!S.items.length && !S.loans.length && !S.deposits.length) {
    v.innerHTML = '<div class="big">Добавьте доходы и расходы</div><div class="sub">Тогда покажу остаток по месяцам и кассовые разрывы</div>';
    $('alerts').replaceChildren(); return;
  }
  const m = F.minMonth, reserve = +S.settings.reserve || 0, N = F.months.length;
  const tail = `свободно в среднем ${fmtR(F.avgRegular)} в месяц` + (F.debtLoad === null ? '' : ` · долговая нагрузка ${Math.round(F.debtLoad * 100)}%`);
  if (F.gapCount) {
    v.innerHTML = `<div class="big short">Кассовый разрыв: ${monthFull(F.firstGap.idx)}</div>` +
      `<div class="sub">Минимум на счетах ${fmtR(m.balance)} (${monthFull(m.idx)}) · разрыв в ${F.gapCount} мес. из ${N} · ${tail}</div>`;
  } else if (F.lowCount) {
    const low = F.months.find(x => x.low);
    v.innerHTML = `<div class="big tight">Остаток ниже резерва: ${monthFull(low.idx)}</div>` +
      `<div class="sub">Минимум на счетах ${fmtR(m.balance)} (${monthFull(m.idx)}) · ниже резерва ${F.lowCount} мес. из ${N} · ${tail}</div>`;
  } else {
    v.innerHTML = `<div class="big save">Кассовых разрывов нет</div>` +
      `<div class="sub">Минимум на счетах ${fmtR(m.balance)} (${monthFull(m.idx)}) · в конце периода ${fmtR(F.endBalance)} · ${tail}</div>`;
  }

  const gaps = runs(F.months, x => x.gap);
  gaps.slice(0, 3).forEach(r => al.push(['bad', `Не хватает денег: ${runLabel(r)}. Самый глубокий минус ${fmtR(r.min)}.`]));
  if (gaps.length > 3) al.push(['bad', `И ещё ${gaps.length - 3} периода с разрывом.`]);
  if (F.gapCount) {
    const need = -m.balance;
    al.push(['warn', `Чтобы разрыва не было, на начало периода нужно на ${fmtR(need)} больше` + (reserve ? ` (с учётом резерва: на ${fmtR(need + reserve)})` : '') + '. Или сдвиньте разовые траты, досрочные погашения и старт кредита.']);
  } else if (F.lowCount) {
    const lows = runs(F.months, x => x.low);
    al.push(['warn', `Ниже резерва ${fmtR(reserve)}: ${lows.slice(0, 3).map(runLabel).join('; ')}${lows.length > 3 ? '…' : ''}.`]);
  }
  if (F.debtLoad !== null && F.debtLoad > 0.5) al.push(['bad', `Платежи по кредитам занимают ${Math.round(F.debtLoad * 100)}% среднего дохода. Это тяжёлая нагрузка.`]);
  else if (F.debtLoad !== null && F.debtLoad > 0.3) al.push(['warn', `Платежи по кредитам занимают ${Math.round(F.debtLoad * 100)}% среднего дохода.`]);
  $('alerts').innerHTML = al.map(([c, t]) => `<div class="alert ${c}">${t}</div>`).join('');
}

const LINE_ORDER = { income: 0, expense: 1, loan: 2, prepay: 3, down: 4, depositContrib: 5 };
function renderTable() {
  const cls = n => n < 0 ? 'neg' : n > 0 ? 'pos' : 'dim';
  const hasDep = S.deposits.length > 0;   // колонка пополнений нужна, только если есть вклады
  const cols = hasDep ? 8 : 7;
  let h = '<thead><tr><th>Месяц</th><th>Доходы</th><th>Расходы</th><th>Кредиты</th><th>Досрочно и взносы</th>' + (hasDep ? '<th>Пополнение вкладов</th>' : '') + '<th>За месяц</th><th>Остаток</th></tr></thead><tbody>';
  F.months.forEach(m => {
    const extra = m.prepay + m.down, open = openMonths.has(m.idx);
    h += `<tr class="m ${m.gap ? 'gap' : m.low ? 'low' : ''}" data-idx="${m.idx}" tabindex="0" aria-expanded="${open}">` +
      `<td><span class="caret">${open ? '▾' : '▸'}</span>${monthLabel(m.idx)}</td><td>${fmt(m.income)}</td><td>${fmt(m.expense)}</td><td>${fmt(m.loan)}</td><td>${fmt(extra)}</td>` +
      (hasDep ? `<td>${fmt(m.depositContrib)}</td>` : '') +
      `<td class="${cls(m.net)}">${signed(m.net)}</td><td class="bal">${fmt(m.balance)}</td></tr>`;
    if (open) {
      const lines = [...m.lines].sort((a, b) => LINE_ORDER[a.type] - LINE_ORDER[b.type]);
      h += `<tr class="det"><td colspan="${cols}"><div class="lines">` + (lines.length ? lines.map(l =>
        `<div class="${l.type === 'income' ? 'in' : l.type === 'expense' ? 'out' : 'ln2'}"><span>${esc(l.name)}${l.factual ? ' <i>факт</i>' : ''}</span><span>${l.type === 'income' ? '+' : '−'}${fmt(l.amount)}</span></div>`).join('') : '<span class="dim">Ничего не запланировано.</span>') + '</div></td></tr>';
    }
  });
  const sum = k => F.months.reduce((s, m) => s + m[k], 0);
  const net = sum('net');
  h += `<tr style="font-weight:700"><td>Всего</td><td>${fmt(sum('income'))}</td><td>${fmt(sum('expense'))}</td><td>${fmt(sum('loan'))}</td><td>${fmt(sum('prepay') + sum('down'))}</td>` +
    (hasDep ? `<td>${fmt(sum('depositContrib'))}</td>` : '') + `<td class="${cls(net)}">${signed(net)}</td><td></td></tr></tbody>`;
  $('months').innerHTML = h;
}

// Вклад или досрочное погашение: сравнение ставок и двух сценариев на одном горизонте.
const pp1 = n => n.toFixed(1).replace('.', ',');

function renderDeposits() {
  const endIdx = Calc.ymIdx(S.settings.start) + S.settings.horizon - 1;
  S.deposits.forEach(dep => {
    const res = $(`dep-${dep.id}-res`);
    if (!res) return;
    const contribs = S.deposit_contributions.filter(c => c.deposit_id === dep.id);
    const s = Calc.depositSchedule(dep, contribs, endIdx);
    const chart = $(`dep-${dep.id}-chart`), years = $(`dep-${dep.id}-years`);
    if (!s.rows.length) {
      res.textContent = dep.opening > 0 || dep.rate > 0
        ? 'Дата открытия позже конца горизонта расчёта: сдвиньте горизонт в «Исходных данных» или дату открытия.'
        : 'Укажите остаток и ставку, тогда посчитаю рост вклада.';
      chart.replaceChildren(); years.innerHTML = ''; return;
    }
    const last = s.rows[s.rows.length - 1];
    const fact = (label, val) => `<div><span>${label}</span><b>${val}</b></div>`;
    res.innerHTML = `<div class="facts">${fact('Остаток сейчас', fmtR(last.balance))}${fact('на ' + monthFull(last.idx), '')}` +
      `${fact('Проценты за это время', fmtR(s.totalInterest))}${fact('Внесено пополнений', fmtR(s.totalContrib))}</div>`;

    if (s.rows.length > 1) drawDepositChart(chart, Calc.ymIdx(dep.start), Calc.depositBalanceSeries(s, dep.opening));
    else chart.replaceChildren();

    const ys = Calc.depositYears(s);
    years.innerHTML = `<thead><tr><th>Год</th><th>Проценты</th><th>Пополнения</th><th>Остаток на конец</th></tr></thead><tbody>` +
      ys.map(y => `<tr><td>${y.year}</td><td>${fmt(y.interest)}</td><td>${fmt(y.contrib)}</td><td>${fmt(y.balance)}</td></tr>`).join('') + '</tbody>';
  });
}

function drawDepositChart(box, startIdx, series) {
  const N = series.length;
  if (N < 2) { box.replaceChildren(); return; }
  const W = Math.max(300, box.clientWidth || 640), L = 58, R = 12, T = 8, H1 = 150, XB = 24, H = T + H1 + XB;
  const ticks = niceTicks(0, Math.max(...series), 4), hi = ticks[ticks.length - 1] || 1;
  const x = k => L + (W - L - R) * k / (N - 1), y = v => T + H1 * (1 - v / hi);
  let o = '';
  ticks.forEach(v => { o += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${short(v)}</text>`; });
  const perYear = (W - L - R) * 12 / (N - 1), yStep = Math.max(1, Math.ceil(46 / perYear));
  let shown = 0;
  for (let k = 0; k < N; k++) {
    const mi = startIdx + k - 1;
    if (k > 0 && mi % 12 === 11) { if (shown++ % yStep === 0) o += `<text x="${x(k)}" y="${T + H1 + 16}" text-anchor="middle">${Math.floor(mi / 12)}</text>`; }
  }
  o += `<path class="line" d="${series.map((v, k) => (k ? 'L' : 'M') + x(k).toFixed(1) + ' ' + y(v).toFixed(1)).join('')}"/>`;
  box.innerHTML = `<svg class="chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Остаток вклада по месяцам">${o}</svg>`;
}

// ---------- структура расходов: доля каждой статьи в общих тратах, по месяцам или по годам
const SHARE_AGG = { prepay: 'Досрочные погашения', down: 'Первоначальный взнос', depositContrib: 'Пополнение вкладов' };
const SHARE_TOP = 8;   // столько именных категорий + «Остальное»

function monthShares(m) {
  const cat = new Map();
  m.lines.forEach(l => {
    if (l.type === 'income') return;
    const key = l.type === 'expense' ? ((l.category && l.category.trim()) || l.name || 'Без названия')
      : l.type === 'loan' ? (l.name || 'Без названия') : SHARE_AGG[l.type];
    cat.set(key, (cat.get(key) || 0) + l.amount);
  });
  return cat;
}

function shareCategoryColor(i) {
  const name = i < 8 ? '--c' + (i + 1) : '--muted';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function buildSharePeriods(mode) {
  const perMonth = F.months.map(m => ({ idx: m.idx, cats: monthShares(m) }));
  const totals = new Map();
  perMonth.forEach(({ cats }) => cats.forEach((v, k) => totals.set(k, (totals.get(k) || 0) + v)));
  const order = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const named = order.slice(0, SHARE_TOP), hasOther = order.length > SHARE_TOP;
  const cats = hasOther ? [...named, 'Остальное'] : named;
  const regroup = raw => {
    const out = new Map();
    raw.forEach((v, k) => { const key = named.includes(k) ? k : (hasOther ? 'Остальное' : k); out.set(key, (out.get(key) || 0) + v); });
    return out;
  };
  const monthly = perMonth.map(p => { const m = regroup(p.cats); return { key: p.idx, label: MON[p.idx % 12], year: Math.floor(p.idx / 12), full: monthFull(p.idx), map: m, total: [...m.values()].reduce((a, b) => a + b, 0) }; });
  if (mode === 'month') return { cats, periods: monthly };
  const byYear = new Map();
  monthly.forEach(p => {
    const y = Math.floor(p.key / 12);
    if (!byYear.has(y)) byYear.set(y, new Map());
    const acc = byYear.get(y);
    p.map.forEach((v, k) => acc.set(k, (acc.get(k) || 0) + v));
  });
  const periods = [...byYear.entries()].sort((a, b) => a[0] - b[0])
    .map(([y, m]) => ({ key: y, label: String(y), full: String(y) + ' год', map: m, total: [...m.values()].reduce((a, b) => a + b, 0) }));
  return { cats, periods };
}

function drawShareChart(box, roEl, cats, periods) {
  const N = periods.length;
  if (!N || !cats.length) { box.innerHTML = ''; roEl.textContent = 'Пока нечего показать: добавьте расходы, кредиты или вклады.'; return; }
  const colors = cats.map((_, i) => shareCategoryColor(i));
  const W = Math.max(300, box.clientWidth || 640), L = 34, R = 12, T = 8, H1 = 170, XB = 38, H = T + H1 + XB;
  const bw = (W - L - R) / N, cx = k => L + bw * (k + 0.5);
  let o = '';
  [0, 25, 50, 75, 100].forEach(p => {
    const yy = T + H1 * (1 - p / 100);
    o += `<line class="grid" x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/><text x="${L - 6}" y="${yy + 4}" text-anchor="end">${p}%</text>`;
  });
  periods.forEach((per, k) => {
    let y = T + H1;
    const total = per.total || 1;
    cats.forEach((c, ci) => {
      const v = per.map.get(c) || 0; if (!v) return;
      const h = H1 * v / total;
      o += `<rect x="${(L + bw * k + bw * 0.1).toFixed(1)}" y="${(y - h).toFixed(1)}" width="${Math.max(1, bw * 0.8).toFixed(1)}" height="${h.toFixed(1)}" fill="${colors[ci]}"/>`;
      y -= h;
    });
  });
  const step = Math.max(1, Math.ceil(34 / bw));
  let lastYear = null;
  periods.forEach((per, k) => {
    if (k % step) return;
    o += `<text x="${cx(k)}" y="${T + H1 + 16}" text-anchor="middle">${per.label}</text>`;
    if (per.year !== undefined && per.year !== lastYear) { o += `<text x="${cx(k)}" y="${T + H1 + 29}" text-anchor="middle">${per.year}</text>`; lastYear = per.year; }
  });
  o += `<line class="cursor" id="share-cur" x1="0" x2="0" y1="${T}" y2="${T + H1}" style="display:none"/>`;
  box.innerHTML = `<svg class="chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Доли статей в общих тратах по периодам">${o}</svg>`;
  const svg = box.firstChild, cur = svg.querySelector('#share-cur');
  const show = ev => {
    const r = svg.getBoundingClientRect();
    const k = Math.max(0, Math.min(N - 1, Math.floor((ev.clientX - r.left - L) / bw)));
    const per = periods[k];
    cur.setAttribute('x1', cx(k)); cur.setAttribute('x2', cx(k)); cur.style.display = '';
    const total = per.total || 1;
    const list = [...per.map.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
      .map(([k2, v]) => `${esc(k2)}: <b>${fmt(v)} ₽</b> (${Math.round(v / total * 100)}%)`).join(' · ');
    roEl.innerHTML = `<b>${per.full}</b>, всего ${fmt(total)} ₽: ` + (list || 'ничего не запланировано');
  };
  svg.onpointerdown = svg.onpointermove = show;
  show({ clientX: svg.getBoundingClientRect().left + L + bw * (periods.length - 0.5) });
}

function renderShare() {
  const { cats, periods } = buildSharePeriods(shareMode);
  drawShareChart($('share-chart'), $('share-ro'), cats, periods);
  const colors = cats.map((_, i) => shareCategoryColor(i));
  $('share-legend').innerHTML = cats.map((c, i) => `<span><i style="background:${colors[i]}"></i>${esc(c)}</span>`).join('');
}

function renderLoans() {
  S.loans.forEach(ln => {
    const res = $(`loan-${ln.id}-res`);
    if (!res) return;
    const st = Calc.loanStats(ln, S.prepayments.filter(p => p.loan_id === ln.id));
    const a = st.actual, b = st.base, chart = $(`loan-${ln.id}-chart`), years = $(`loan-${ln.id}-years`);
    if (!a.rows.length) {
      res.textContent = 'Укажите сумму, ставку и срок, тогда посчитается платёж.';
      chart.replaceChildren(); years.innerHTML = ''; return;
    }
    const lastPmt = a.rows.length > 1 ? a.rows[a.rows.length - 2].payment : a.rows[0].payment;
    const fact = (label, val) => `<div><span>${label}</span><b>${val}</b></div>`;
    let html = '';
    if (!st.hasPrepay) {
      html = `<div class="facts">${fact('Платёж в месяц', fmtR(a.firstPayment))}${fact('Закроется', monthFull(a.endIdx))}` +
        `${fact('Проценты за всё время', fmtR(a.totalInterest))}${fact('Всего выплат', fmtR(a.totalPayments))}</div>`;
    } else {
      const money = n => fmtR(n);
      html = `<table class="cmp"><thead><tr><th></th><th>Без досрочных</th><th>С досрочными</th><th>Разница</th></tr></thead><tbody>` +
        `<tr><td>Закроется</td><td>${monthFull(b.endIdx)}</td><td>${monthFull(a.endIdx)}</td><td class="win">${st.savedMonths > 0 ? '−' + termText(st.savedMonths) : '—'}</td></tr>` +
        `<tr><td>Срок</td><td>${termText(b.months)}</td><td>${termText(a.months)}</td><td></td></tr>` +
        `<tr><td>Платёж в месяц (в конце срока)</td><td>${money(b.firstPayment)}</td><td>${money(lastPmt)}</td><td class="${lastPmt < b.firstPayment - 1 ? 'win' : ''}">${lastPmt < b.firstPayment - 1 ? '−' + fmtR(b.firstPayment - lastPmt) : '—'}</td></tr>` +
        `<tr><td>Проценты за всё время</td><td>${money(b.totalInterest)}</td><td>${money(a.totalInterest)}</td><td class="win">−${money(st.savedInterest)}</td></tr>` +
        `<tr><td>Внесено досрочно</td><td>—</td><td>${money(a.totalExtra)}</td><td></td></tr>` +
        `<tr><td>Всего выплат</td><td>${money(b.totalPayments)}</td><td>${money(a.totalPayments + a.totalExtra)}</td><td class="win">−${money(b.totalPayments - a.totalPayments - a.totalExtra)}</td></tr></tbody></table>`;
    }
    res.innerHTML = html;

    if (st.hasPrepay) drawLoanChart(chart, Calc.ymIdx(ln.start), Calc.balanceSeries(a, ln.principal), Calc.balanceSeries(b, ln.principal));
    else chart.replaceChildren();

    const ys = Calc.loanYears(st);
    years.innerHTML = `<thead><tr><th>Год</th><th>Заплатите</th><th>Проценты</th><th>Долг погашен</th><th>Остаток на конец</th>${st.hasPrepay ? '<th>Без досрочных</th>' : ''}</tr></thead><tbody>` +
      ys.map(y => `<tr><td>${y.year}</td><td>${fmt(y.paid)}</td><td>${fmt(y.interest)}</td><td>${fmt(y.principal)}</td><td>${fmt(y.balance)}</td>${st.hasPrepay ? `<td>${fmt(y.baseBalance)}</td>` : ''}</tr>`).join('') + '</tbody>';
  });
}

// Обновляет только текст сводки «Факт» у каждой статьи расхода — сами поля ввода не трогает,
// поэтому можно спокойно вызывать на каждый рендер, не сбивая фокус во время печати.
function renderActuals() {
  if (!S.actuals.length) return;
  const pf = Calc.planVsFact(S);
  const byItem = new Map();
  pf.rows.forEach(r => {
    if (!byItem.has(r.item_id)) byItem.set(r.item_id, { planned: 0, actual: 0 });
    const b = byItem.get(r.item_id); b.planned += r.planned; b.actual += r.actual;
  });
  S.items.forEach(it => {
    const sm = $(`item-${it.id}-fact-sm`); if (!sm) return;
    const b = byItem.get(it.id);
    sm.textContent = b ? `Факт: план ${fmt(b.planned)} ₽, факт ${fmt(b.actual)} ₽, разница ${signed(b.actual - b.planned)} ₽` : 'Факт';
  });
}

let raf = 0;
function renderResults() {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => {
    F = Calc.forecast(S);
    $('empty').hidden = S.items.length > 0 || S.loans.length > 0 || S.deposits.length > 0;
    renderVerdict();
    drawFlow($('chart'), F.months, S.settings);
    renderTable();
    renderShare();
    renderLoans();
    renderDeposits();
    renderActuals();
    const inc = S.items.filter(i => i.kind === 'income').length, exp = S.items.filter(i => i.kind === 'expense').length;
    $('tinc').innerHTML = inc ? `в среднем <b>${fmtR(F.avgIncome)}</b> в месяц` : '';
    const pf = S.actuals.length ? Calc.planVsFact(S) : null;
    $('texp').innerHTML = (exp ? `в среднем <b>${fmtR(F.avgExpense)}</b> в месяц` : '') +
      (pf && pf.rows.length ? ` · факт против плана: <b class="${pf.diff > 0 ? 'neg' : pf.diff < 0 ? 'pos' : ''}">${signed(pf.diff)} ₽</b>` : '');
    $('tloan').innerHTML = S.loans.length ? `платежи в среднем <b>${fmtR(F.avgLoan)}</b> в месяц` : '';
    $('tdep').innerHTML = S.deposits.length ? `пополнения в среднем <b>${fmtR(F.avgDepositContrib)}</b> в месяц` : '';
  });
}

// ---------- запуск
$('add-income').addEventListener('click', () => addItem('income'));
$('add-expense').addEventListener('click', () => addItem('expense'));
$('add-loan').addEventListener('click', addLoan);
$('add-deposit').addEventListener('click', addDeposit);
$('demo').addEventListener('click', async () => {
  try { S = await api('POST', '/api/demo'); buildSetup(); buildLists(); renderResults(); }
  catch (e) { setSaved('err', e.message); }
});
$('share-mode').addEventListener('click', ev => {
  const btn = ev.target.closest('button[data-mode]'); if (!btn || !F) return;
  shareMode = btn.dataset.mode;
  [...$('share-mode').children].forEach(b => b.setAttribute('aria-selected', String(b === btn)));
  renderShare();
});
// пересчитать цвета графика долей, если поменялась системная тема
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (F) renderShare(); });
$('months').addEventListener('click', ev => {
  const tr = ev.target.closest('tr.m'); if (!tr) return;
  const idx = +tr.dataset.idx;
  openMonths.has(idx) ? openMonths.delete(idx) : openMonths.add(idx);
  renderTable();
});
$('months').addEventListener('keydown', ev => {
  if (ev.key !== 'Enter' && ev.key !== ' ') return;
  const tr = ev.target.closest('tr.m'); if (!tr) return;
  ev.preventDefault();
  const idx = +tr.dataset.idx;
  openMonths.has(idx) ? openMonths.delete(idx) : openMonths.add(idx);
  renderTable();
  const again = document.querySelector(`tr.m[data-idx="${idx}"]`); if (again) again.focus();
});
window.addEventListener('resize', renderResults);

// Свёрнутые/развёрнутые разделы запоминаются в этом браузере между визитами.
const SECT_STORE = 'budget-sections-v1';
document.querySelectorAll('details.sect').forEach(d => {
  try { const saved = JSON.parse(localStorage.getItem(SECT_STORE) || '{}'); if (d.id in saved) d.open = saved[d.id]; } catch (e) {}
  d.addEventListener('toggle', () => {
    try {
      const all = JSON.parse(localStorage.getItem(SECT_STORE) || '{}');
      all[d.id] = d.open; localStorage.setItem(SECT_STORE, JSON.stringify(all));
    } catch (e) {}
  });
});

(async function init() {
  try {
    S = await api('GET', '/api/state');
    buildSetup(); buildLists(); renderResults();
  } catch (e) {
    $('verdict').innerHTML = `<div class="big short">Не удалось загрузить данные</div><div class="sub">${esc(e.message)}. Запущен ли server.py?</div>`;
  }
})();
