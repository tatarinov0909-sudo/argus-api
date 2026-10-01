// Смена пароля владельца (миграция 1754403800000, «Настройки склада»).
//
// Зачем её делали (аудит 30.09): «забытый или утёкший пароль нельзя было
// сменить»; в коде: «вход могли оставить открытым на чужом компьютере».
// Но смена пароля не закрывает уже открытые входы: токен, выданный до смены,
// продолжает работать, а сервер ещё и продлевает его (X-Argus-Token), так что
// чужой вход живёт сколько угодно.
//
// Ожидаемо: после смены пароля старые входы владельца перестают работать
// (кроме, возможно, того, с которого пароль меняли).
const { startApp, warehouse, verdicts, fail } = require('./_lib');

(async () => {
  const { api, ok, stop } = await startApp();
  const v = verdicts('Смена пароля и открытые входы');
  try {
    const ff = await warehouse(ok, 'Ромашка');
    // «Чужой компьютер»: вход по тому же паролю, сделан до смены.
    const stolen = (await ok('POST', '/api/auth/owner/login', null, { email: ff.email, password: ff.password })).token;
    const mine = (await ok('POST', '/api/auth/owner/login', null, { email: ff.email, password: ff.password })).token;
    const changed = await api('POST', '/api/auth/owner/password', mine,
      { currentPassword: ff.password, newPassword: 'brand-new-password-1' });
    v.expect('пароль сменён', changed.status === 200, '200', `${changed.status} ${JSON.stringify(changed.body)}`);
    const oldLogin = await api('POST', '/api/auth/owner/login', null, { email: ff.email, password: ff.password });
    v.expect('старым паролем войти нельзя', oldLogin.status === 401, '401', String(oldLogin.status));

    const probe = await api('GET', '/api/warehouses/me', stolen);
    v.expect('вход, открытый до смены пароля, больше не пускает', probe.status === 401,
      '401', `${probe.status}, склад «${probe.body && probe.body.name}»`);
    const act = await api('PATCH', '/api/warehouses/me', stolen, { city: 'Чужой город' });
    v.expect('старым входом нельзя менять настройки склада', act.status === 401, '401',
      `${act.status}, город теперь «${act.body && act.body.city}»`);
  } finally {
    v.done();
    await stop();
  }
})().catch(fail);
