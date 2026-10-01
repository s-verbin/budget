const C = require('../static/calc.js');
const assert = require('assert');
const near = (a,b,eps=0.01)=>assert(Math.abs(a-b)<eps, `${a} != ${b}`);
// аннуитет 1 млн, 12%, 12 мес = 88 848.79
near(C.annuity(1e6,12,12), 88848.79, 0.01);
assert.strictEqual(C.annuity(1e6,0,10), 100000);
// без досрочных: сумма платежей = pmt*term, остаток 0, срок = term
const loan = {principal:1e6, rate:12, term:12, start:'2027-01'};
let s = C.loanSchedule(loan, []);
assert.strictEqual(s.months, 12); near(s.rows.at(-1).balance, 0);
near(s.totalPayments, C.annuity(1e6,12,12)*12, 0.5);
assert.strictEqual(C.idxYm(s.endIdx), '2027-12');
near(s.totalPayments - 1e6, s.totalInterest, 0.5);
// досрочное «сократить срок»
const long = {principal:5e6, rate:12, term:240, start:'2027-01'};
const pp = [{amount:500000, start:'2028-01', every:0, until:null, mode:'term'}];
let st = C.loanStats(long, pp);
assert(st.savedMonths > 0, 'срок должен сократиться');
assert(st.savedInterest > 0);
near(st.actual.firstPayment, st.base.firstPayment);
near(st.actual.rows.at(-1).balance, 0);
// баланс: полная сумма выплат = основной долг + проценты
near(st.actual.totalPayments + st.actual.totalExtra, 5e6 + st.actual.totalInterest, 1);
// «уменьшить платёж»: срок тот же, платёж после досрочного меньше
const pp2 = [{...pp[0], mode:'payment'}];
let st2 = C.loanStats(long, pp2);
assert.strictEqual(st2.actual.months, st2.base.months);
const before = st2.actual.byIdx.get(C.ymIdx('2027-12')).payment, after = st2.actual.byIdx.get(C.ymIdx('2028-03')).payment;
assert(after < before, 'платёж должен уменьшиться');
assert(st2.savedInterest > 0);
// при равной сумме «сократить срок» экономит на процентах больше
assert(st.savedInterest > st2.savedInterest);
// досрочное больше остатка: гасит всё и закрывает
let big = C.loanStats({principal:1e5, rate:10, term:24, start:'2027-01'}, [{amount:1e9,start:'2027-03',every:0,mode:'term'}]);
assert.strictEqual(big.actual.months, 3); near(big.actual.totalExtra + big.actual.totalPayments, 1e5 + big.actual.totalInterest, 1);
// повторяющиеся
assert(C.occurs({start:'2027-03',every:3,until:null}, C.ymIdx('2027-09')));
assert(!C.occurs({start:'2027-03',every:3,until:null}, C.ymIdx('2027-08')));
assert(!C.occurs({start:'2027-03',every:3,until:'2027-06'}, C.ymIdx('2027-09')));
assert(C.occurs({start:'2027-03',every:0,until:null}, C.ymIdx('2027-03')) && !C.occurs({start:'2027-03',every:0}, C.ymIdx('2027-04')));
// прогноз: кассовый разрыв
const state = {settings:{start:'2027-01',horizon:6,opening:100000,reserve:50000},
  items:[{kind:'income',name:'ЗП',amount:100000,start:'2027-01',every:1,until:null},
         {kind:'expense',name:'Всё',amount:90000,start:'2027-01',every:1,until:null},
         {kind:'expense',name:'Ремонт',amount:300000,start:'2027-03',every:0,until:null}],
  loans:[], prepayments:[]};
let f = C.forecast(state);
assert.strictEqual(f.months.length, 6);
near(f.months[1].balance, 120000);
assert.strictEqual(C.idxYm(f.firstGap.idx), '2027-03');
near(f.firstGap.balance, -170000);
assert(f.months[4].gap && f.gapCount===4); // 03..06 все в минусе (160k → 170k → ...)
// взнос и досрочное попадают в кассу
const st3 = {settings:{start:'2027-01',horizon:3,opening:1e6,reserve:0}, items:[],
  loans:[{id:1,name:'И',principal:1e6,rate:12,term:12,start:'2027-01',down_payment:200000}],
  prepayments:[{loan_id:1,amount:100000,start:'2027-02',every:0,until:null,mode:'term'}]};
f = C.forecast(st3);
near(f.months[0].down, 200000); near(f.months[1].prepay, 100000);
near(f.months[0].balance, 1e6 - 200000 - C.annuity(1e6,12,12));
// годовая таблица
const yrs = C.loanYears(st); assert(yrs.length > 10); near(yrs.at(-1).balance, 0);

// --- вклад: свой график, проценты капают на остаток ВКЛАДА, а не на остаток на счетах
{
  const dep = { id:1, name:'Копилка', opening:100000, rate:12, tax:0, start:'2027-01' };
  let s = C.depositSchedule(dep, [], C.ymIdx('2027-03'));
  near(s.rows[0].interest, 1000); near(s.rows[0].balance, 101000);
  near(s.rows[1].interest, 1010); near(s.totalInterest, 1000+1010+1020.1, 0.01);
  // налог уменьшает доходность
  s = C.depositSchedule({ ...dep, tax: 13 }, [], C.ymIdx('2027-01'));
  near(s.rows[0].interest, 870);
  // пополнение прибавляется после начисления процентов
  s = C.depositSchedule(dep, [{amount:20000,start:'2027-02',every:0,until:null}], C.ymIdx('2027-02'));
  near(s.rows[1].contrib, 20000); near(s.rows[1].balance, 101000*1.01 + 20000);
  // регулярные пополнения
  s = C.depositSchedule(dep, [{amount:5000,start:'2027-01',every:1,until:null}], C.ymIdx('2027-06'));
  near(s.totalContrib, 30000);
  // вклад, который ещё не открыт в пределах горизонта
  s = C.depositSchedule({ ...dep, start:'2030-01' }, [], C.ymIdx('2027-01'));
  assert.strictEqual(s.rows.length, 0);
}
// --- прогноз: пополнение вклада списывается со счёта, проценты по вкладу счёт не трогают
{
  const st = { settings:{start:'2027-01',horizon:3,opening:200000,reserve:0},
    items:[{kind:'income',name:'ЗП',amount:100000,start:'2027-01',every:1,until:null}], loans:[], prepayments:[],
    deposits:[{id:1,name:'Копилка',opening:0,rate:12,tax:0,start:'2027-01'}],
    deposit_contributions:[{id:1,deposit_id:1,amount:50000,start:'2027-01',every:0,until:null}] };
  const f = C.forecast(st);
  near(f.months[0].depositContrib, 50000); near(f.months[0].balance, 200000 + 100000 - 50000);
  near(f.months[0].depositInterest, 0);       // в месяц открытия начислять не на что
  near(f.months[1].depositInterest, 50000*0.01, 0.01);
  near(f.months[1].balance, f.months[0].balance + 100000);   // проценты по вкладу на счёт не попадают
  assert(f.months[0].lines.some(l => l.type === 'depositContrib' && l.amount === 50000));
  near(f.totalDepositInterest, f.months[1].depositInterest + f.months[2].depositInterest, 0.01);
}
// --- вклад с несколькими взносами и таблица по годам
{
  const dep = { id:1, name:'В', opening:500000, rate:10, tax:0, start:'2027-01' };
  const contribs = [{amount:10000,start:'2027-01',every:1,until:null}];
  const s = C.depositSchedule(dep, contribs, C.ymIdx('2028-12'));
  const series = C.depositBalanceSeries(s, dep.opening);
  assert.strictEqual(series[0], 500000); assert.strictEqual(series.length, s.rows.length + 1);
  const ys = C.depositYears(s);
  assert.strictEqual(ys.length, 2); near(ys[0].contrib, 120000); assert(ys[1].balance > ys[0].balance);
}
// --- факт вместо плана: только для расходов, только в указанный месяц
{
  const items = [
    { id:1, kind:'expense', name:'Продукты', category:'Еда', amount:40000, start:'2027-01', every:1, until:null },
    { id:2, kind:'income', name:'ЗП', amount:100000, start:'2027-01', every:1, until:null },
  ];
  const st = { settings:{start:'2027-01',horizon:3,opening:0,reserve:0}, items, loans:[], prepayments:[],
    actuals:[{id:1,item_id:1,month:'2027-02',amount:45500}] };
  const f = C.forecast(st);
  near(f.months[0].expense, 40000);                 // январь — по плану
  near(f.months[1].expense, 45500);                  // февраль — факт вместо плана
  near(f.months[2].expense, 40000);                  // март снова по плану
  const febLine = f.months[1].lines.find(l => l.type === 'expense');
  assert(febLine.factual === true && febLine.amount === 45500);
  assert(!f.months[0].lines.find(l => l.type === 'expense').factual);
  // факт по доходу не учитывается (сверяем только расходы)
  const st2 = { ...st, actuals:[{id:2,item_id:2,month:'2027-01',amount:999999}] };
  near(C.forecast(st2).months[0].income, 100000);
  // факт для месяца, где статья не была запланирована — тоже подставляется (незапланированная трата)
  const st3 = { ...st, items:[{...items[0], every:0}], actuals:[{id:3,item_id:1,month:'2027-02',amount:5000}] };
  near(C.forecast(st3).months[1].expense, 5000);
  near(C.forecast(st3).months[0].expense, 40000);
}
// --- план/факт: сверка и группировка по категории
{
  const items = [
    { id:1, kind:'expense', name:'Продукты', category:'Еда', amount:40000, start:'2027-01', every:1, until:null },
    { id:2, kind:'expense', name:'Кафе', category:'Еда', amount:10000, start:'2027-01', every:1, until:null },
    { id:3, kind:'expense', name:'Такси', amount:5000, start:'2027-01', every:1, until:null },   // без категории — группа по имени
    { id:4, kind:'expense', name:'Подарок', category:'Прочее', amount:20000, start:'2027-01', every:0, until:null }, // разовая, только в январе
  ];
  const actuals = [
    { id:1, item_id:1, month:'2027-01', amount:42000 },
    { id:2, item_id:2, month:'2027-01', amount:9000 },
    { id:3, item_id:3, month:'2027-01', amount:5000 },
    { id:4, item_id:4, month:'2027-05', amount:3000 },   // подарок случился и в мае, хотя по плану был только в январе
  ];
  const st = { items, actuals };
  const pf = C.planVsFact(st);
  assert.strictEqual(pf.rows.length, 4);
  const eda = pf.groups.find(g => g.group === 'Еда');
  near(eda.planned, 50000); near(eda.actual, 51000); assert.strictEqual(eda.count, 2);
  const taxi = pf.groups.find(g => g.group === 'Такси');
  near(taxi.planned, 5000); near(taxi.actual, 5000);
  const mayRow = pf.rows.find(r => r.month === '2027-05');
  near(mayRow.planned, 0); near(mayRow.actual, 3000);       // в мае не по плану — план 0, а факт есть
  near(pf.totals.planned, 55000); near(pf.totals.actual, 59000); near(pf.diff, 4000);
}
console.log('ALL OK; сокращение срока:', st.savedMonths, 'мес, экономия', Math.round(st.savedInterest));
