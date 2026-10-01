// Расчёты бюджета и кредитов. Без DOM: работает и в браузере (window.Calc), и в Node (тесты).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Calc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Месяц хранится строкой 'ГГГГ-ММ', в расчётах это целый индекс: год * 12 + (месяц - 1).
  const ymIdx = s => { const p = s.split('-'); return +p[0] * 12 + (+p[1] - 1); };
  const idxYm = i => String(Math.floor(i / 12)).padStart(4, '0') + '-' + String(i % 12 + 1).padStart(2, '0');

  function annuity(balance, ratePct, months) {
    if (balance <= 0 || months <= 0) return 0;
    const r = ratePct / 100 / 12;
    return r === 0 ? balance / months : balance * r / (1 - Math.pow(1 + r, -months));
  }

  // Происходит ли повторяющееся событие {start, every, until} в месяце idx.
  // every = 0: один раз в месяце start; иначе каждые every месяцев до until (включительно).
  function occurs(rec, idx) {
    const s = ymIdx(rec.start);
    if (idx < s) return false;
    if (rec.until && idx > ymIdx(rec.until)) return false;
    const e = +rec.every || 0;
    return e === 0 ? idx === s : (idx - s) % e === 0;
  }

  // Помесячный график кредита. Платёж вносится в месяце start и далее.
  // Досрочное гасится в тот же месяц после обычного платежа.
  // mode 'term': платёж прежний, срок короче. mode 'payment': срок прежний, платёж меньше.
  function loanSchedule(loan, prepays) {
    const s = ymIdx(loan.start), term = Math.round(loan.term), r = loan.rate / 100 / 12;
    let bal = loan.principal, pmt = annuity(bal, loan.rate, term);
    const firstPayment = pmt;
    const rows = [], byIdx = new Map();
    let totalInterest = 0, totalExtra = 0, totalPayments = 0;
    for (let k = 0; k < term && bal > 0.005; k++) {
      const idx = s + k;
      const interest = bal * r;
      const pay = Math.min(pmt, bal + interest);
      bal -= pay - interest;
      let extra = 0;
      for (const p of prepays) {
        if (bal <= 0.005 || !(p.amount > 0) || !occurs(p, idx)) continue;
        const e = Math.min(p.amount, bal);
        bal -= e; extra += e;
        if (p.mode === 'payment' && bal > 0.005) {
          const left = term - k - 1;
          pmt = left > 0 ? annuity(bal, loan.rate, left) : bal;
        }
      }
      if (bal < 0.005) bal = 0;
      const row = { idx, payment: pay, interest, principal: pay - interest, extra, balance: bal };
      rows.push(row); byIdx.set(idx, row);
      totalInterest += interest; totalExtra += extra; totalPayments += pay;
    }
    return {
      rows, byIdx, firstPayment, totalInterest, totalExtra, totalPayments,
      months: rows.length, endIdx: rows.length ? rows[rows.length - 1].idx : null,
    };
  }

  // Результат досрочных погашений: график с ними против графика без них.
  function loanStats(loan, prepays) {
    const actual = loanSchedule(loan, prepays), base = loanSchedule(loan, []);
    return {
      actual, base,
      savedInterest: base.totalInterest - actual.totalInterest,
      savedMonths: base.months - actual.months,
      hasPrepay: actual.totalExtra > 0,
    };
  }

  // Остаток долга по месяцам: индекс 0 это сумма кредита, затем остаток после каждого платежа.
  function balanceSeries(sched, principal) {
    return [principal, ...sched.rows.map(r => r.balance)];
  }

  // Итоги по календарным годам: платежи, проценты, погашение долга, остаток на конец года (с досрочными и без).
  function loanYears(stats) {
    const years = new Map();
    const get = y => { if (!years.has(y)) years.set(y, { year: y, paid: 0, interest: 0, principal: 0, balance: 0, baseBalance: 0 }); return years.get(y); };
    stats.actual.rows.forEach(r => {
      const y = get(Math.floor(r.idx / 12));
      y.paid += r.payment + r.extra; y.interest += r.interest; y.principal += r.principal + r.extra; y.balance = r.balance;
    });
    stats.base.rows.forEach(r => { get(Math.floor(r.idx / 12)).baseBalance = r.balance; });
    // если с досрочными кредит закрылся раньше, остаток в поздних годах 0 (get уже вернул нули)
    return [...years.values()].sort((a, b) => a.year - b.year);
  }

  // Помесячный график вклада: проценты капают на остаток вклада (после налога), пополнения прибавляются.
  // Деньги на основных счетах вклад не трогает — это отдельный «счёт» со своей ставкой.
  function depositSchedule(dep, contribs, endIdx) {
    const s = ymIdx(dep.start), rows = [], byIdx = new Map();
    if (endIdx < s) return { rows, byIdx, totalInterest: 0, totalContrib: 0, endIdx: null };
    const cap = Math.min(endIdx - s + 1, 1200);   // защита от бесконечного цикла при странной дате
    const r = (dep.rate / 100 / 12) * (1 - (+dep.tax || 0) / 100);
    let bal = 0, totalInterest = 0, totalContrib = 0;
    for (let k = 0; k < cap; k++) {
      const idx = s + k;
      if (k === 0) bal = +dep.opening || 0;
      const interest = bal > 0 ? bal * r : 0;
      bal += interest;
      let contrib = 0;
      contribs.forEach(c => { if (c.amount > 0 && occurs(c, idx)) contrib += c.amount; });
      bal += contrib;
      const row = { idx, interest, contrib, balance: bal };
      rows.push(row); byIdx.set(idx, row);
      totalInterest += interest; totalContrib += contrib;
    }
    return { rows, byIdx, totalInterest, totalContrib, endIdx: rows.length ? rows[rows.length - 1].idx : null };
  }

  // Остаток вклада по месяцам для графика: индекс 0 это остаток до первого начисления.
  function depositBalanceSeries(sched, opening) {
    return [+opening || 0, ...sched.rows.map(r => r.balance)];
  }

  // Итоги по календарным годам: проценты, пополнения, остаток на конец года.
  function depositYears(sched) {
    const years = new Map();
    const get = y => { if (!years.has(y)) years.set(y, { year: y, interest: 0, contrib: 0, balance: 0 }); return years.get(y); };
    sched.rows.forEach(r => { const y = get(Math.floor(r.idx / 12)); y.interest += r.interest; y.contrib += r.contrib; y.balance = r.balance; });
    return [...years.values()].sort((a, b) => a.year - b.year);
  }

  // Прогноз денег по месяцам. state = {settings, items, loans, prepayments, deposits, deposit_contributions, actuals}.
  // Деньги на вкладах в остаток на счетах не входят: пополнение вклада списывается со счёта как расход,
  // проценты по вкладу остаются на вкладе (см. depositSchedule/depositBalanceSeries для его собственного графика).
  // actuals: {item_id, month, amount} — фактическая сумма расхода заменяет плановую в этом конкретном месяце
  // (только для расходов). Если факт не введён, месяц считается по плану как раньше.
  function forecast(state) {
    const { settings, items, loans, prepayments } = state;
    const deposits = state.deposits || [], contribs = state.deposit_contributions || [];
    const actuals = state.actuals || [];
    const actualByKey = new Map(actuals.map(a => [a.item_id + '|' + a.month, a.amount]));
    const start = ymIdx(settings.start), N = settings.horizon, endIdx = start + N - 1;
    const sched = loans.map(l => ({ loan: l, s: loanSchedule(l, prepayments.filter(p => p.loan_id === l.id)) }));
    const depSched = deposits.map(d => ({ dep: d, s: depositSchedule(d, contribs.filter(c => c.deposit_id === d.id), endIdx) }));
    const months = [];
    let bal = +settings.opening || 0;
    for (let k = 0; k < N; k++) {
      const idx = start + k;
      const m = { idx, k, income: 0, expense: 0, loan: 0, prepay: 0, down: 0, depositContrib: 0, depositInterest: 0, lines: [] };
      items.forEach(it => {
        const fact = it.kind === 'expense' ? actualByKey.get(it.id + '|' + idxYm(idx)) : undefined;
        const scheduled = it.amount > 0 && occurs(it, idx);
        if (fact === undefined && !scheduled) return;
        const amount = fact !== undefined ? fact : it.amount;
        m[it.kind === 'income' ? 'income' : 'expense'] += amount;
        m.lines.push({ type: it.kind, name: it.name || 'Без названия', category: it.category || '', amount, factual: fact !== undefined });
      });
      sched.forEach(({ loan, s }) => {
        const name = loan.name || 'Кредит';
        const row = s.byIdx.get(idx);
        if (row) {
          m.loan += row.payment;
          m.lines.push({ type: 'loan', name, amount: row.payment });
          if (row.extra > 0) { m.prepay += row.extra; m.lines.push({ type: 'prepay', name: 'Досрочное: ' + name, amount: row.extra }); }
        }
        if (loan.down_payment > 0 && idx === ymIdx(loan.start)) {
          m.down += loan.down_payment;
          m.lines.push({ type: 'down', name: 'Первоначальный взнос: ' + name, amount: loan.down_payment });
        }
      });
      depSched.forEach(({ dep, s }) => {
        const row = s.byIdx.get(idx);
        if (!row) return;
        m.depositInterest += row.interest;   // информационно: остаётся на вкладе, на счета не влияет
        if (row.contrib > 0) {
          m.depositContrib += row.contrib;
          m.lines.push({ type: 'depositContrib', name: 'Пополнение вклада: ' + (dep.name || 'Вклад'), amount: row.contrib });
        }
      });
      m.regular = m.income - m.expense - m.loan;      // «свободные» деньги без досрочных, взносов и пополнений вклада
      m.net = m.regular - m.prepay - m.down - m.depositContrib;
      bal += m.net;
      m.balance = bal;
      m.gap = bal < 0;
      m.low = !m.gap && bal < (+settings.reserve || 0);
      months.push(m);
    }
    const sum = k => months.reduce((s, m) => s + m[k], 0);
    const n = Math.max(1, months.length);
    let minM = months[0] || null;
    months.forEach(m => { if (!minM || m.balance < minM.balance) minM = m; });
    const income = sum('income') / n, loan = sum('loan') / n;
    return {
      months, sched, depSched,
      firstGap: months.find(m => m.gap) || null,
      gapCount: months.filter(m => m.gap).length,
      lowCount: months.filter(m => m.low).length,
      minMonth: minM,
      endBalance: months.length ? months[months.length - 1].balance : +settings.opening || 0,
      avgIncome: income, avgExpense: sum('expense') / n, avgLoan: loan,
      avgRegular: sum('regular') / n, avgDepositContrib: sum('depositContrib') / n,
      totalDepositInterest: sum('depositInterest'),
      debtLoad: income > 0 ? loan / income : null,
    };
  }

  // Сверка плана и факта: по каждой введённой фактической сумме — что было запланировано в тот же месяц
  // у той же статьи (0, если статья в этом месяце не должна была случиться), и разница факт минус план.
  // Группировка — по категории статьи, а если категория не задана, по названию статьи.
  function planVsFact(state) {
    const items = new Map((state.items || []).map(it => [it.id, it]));
    const rows = (state.actuals || []).map(a => {
      const it = items.get(a.item_id);
      if (!it) return null;
      const idx = ymIdx(a.month);
      const planned = (it.amount > 0 && occurs(it, idx)) ? it.amount : 0;
      const group = (it.category && it.category.trim()) || it.name || 'Без названия';
      return { item_id: it.id, name: it.name || 'Без названия', group, month: a.month, planned, actual: a.amount, diff: a.amount - planned };
    }).filter(Boolean).sort((x, y) => ymIdx(x.month) - ymIdx(y.month));

    const byGroup = new Map();
    rows.forEach(r => {
      if (!byGroup.has(r.group)) byGroup.set(r.group, { group: r.group, planned: 0, actual: 0, count: 0 });
      const g = byGroup.get(r.group);
      g.planned += r.planned; g.actual += r.actual; g.count++;
    });
    const totals = rows.reduce((s, r) => ({ planned: s.planned + r.planned, actual: s.actual + r.actual }), { planned: 0, actual: 0 });
    const groups = [...byGroup.values()].sort((a, b) => Math.abs(b.actual - b.planned) - Math.abs(a.actual - a.planned));
    return { rows, groups, totals, diff: totals.actual - totals.planned };
  }

  return {
    ymIdx, idxYm, annuity, occurs, loanSchedule, loanStats, balanceSeries, loanYears,
    depositSchedule, depositBalanceSeries, depositYears, forecast, planVsFact,
  };
});
