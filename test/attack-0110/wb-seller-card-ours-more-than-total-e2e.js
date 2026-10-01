// Склады WB, сводка на карточке продавца («Продавцы» → карточка: «Склады WB:
// ваших N из M»): склад, отмеченный человеком и потом удалённый продавцом на
// WB, считается в «ваших», но не в «всего». Получается «ваших 2 из 1».
//
// listOffices(): total = count(*) FILTER (WHERE gone_at IS NULL), а
// ours = count(*) FILTER (WHERE ours) — без того же условия. В окне продавца
// при этом «Вашими отмечены 2 из 2» (там считаются все строки) — два экрана
// про одно и то же расходятся.
//
// Ожидаемо: «ваших» не больше «всего», и обе сводки считают склады одинаково.
const { WB, startApp, warehouse, verdicts, fail } = require('./_lib');

(async () => {
  const { ok, stop } = await startApp();
  const v = verdicts('Сводка складов WB на карточке продавца');
  try {
    const ff = await warehouse(ok, 'Восход');
    const s = await ff.seller('Авезов', 'avezov', [
      { id: 11, name: 'ФФ Восход Москва', officeId: 500 },
      { id: 12, name: 'Склад Коледино 2', officeId: 501 },
    ]);
    await ok('PATCH', `/api/marketplaces/${s.companyId}/wb/warehouses/12`, ff.token, { ours: true });
    // Продавец удалил склад 12 на WB; менеджер нажал «Обновить из WB».
    WB.warehouses.avezov = [{ id: 11, name: 'ФФ Восход Москва', officeId: 500 }];
    await ff.q(`UPDATE marketplace_credentials SET wb_warehouses_at = now() - interval '2 minutes' WHERE company_id = $1`, [s.companyId]);
    const panel = await ok('POST', `/api/marketplaces/${s.companyId}/wb/warehouses/refresh`, ff.token);
    const card = (await ok('GET', '/api/marketplaces/wb/offices', ff.token)).sellers.find((x) => x.companyId === s.companyId);
    v.expect('карточка: «ваших» не больше «всего»', card && card.ours <= card.total, 'ours ≤ total',
      `«Склады WB: ваших ${card && card.ours} из ${card && card.total}»`);
    const panelOurs = panel.warehouses.filter((w) => w.ours).length;
    v.expect('карточка и окно продавца считают одинаково', card && card.ours === panelOurs && card.total === panel.warehouses.length,
      'одни и те же числа', `карточка ${card && card.ours} из ${card && card.total}, окно «Вашими отмечены ${panelOurs} из ${panel.warehouses.length}»`);
  } finally {
    v.done();
    await stop();
  }
})().catch(fail);
