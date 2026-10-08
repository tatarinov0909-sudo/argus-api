// Находка: первый вход после обновления сайта 07.10 затирается старым входом.
//
// auth.js переносит старый общий вход (argus_token) на место его роли при
// первом открытии кабинета — «он всегда свежее того, что уже лежит на месте».
// Но login.html этот перенос не запускает (ArgusAuth.get там не вызывается до
// входа): человек входит, новый вход ложится на своё место, а на следующей
// странице кабинет переносит поверх него СТАРЫЙ вход, оставшийся в браузере с
// прошлой недели (обычно истёкший). Итог:
//  - продавец, вошедший на login.html, снова видит форму входа (вход пропал);
//  - если в этом браузере вошёл ещё и руководитель — кабинет продавца
//    открывается «глазами руководителя» (переключатель продавцов, «← К складу»).
// То же у руководителя (cabinet_main) и грузчика (loader).
//
// Ожидание (хендофф 07.10-2, «Старый вход при первом открытии переезжает
// сам»): свежий вход не теряется; старый, истёкший вход не перекрывает новый.
// Запуск: ARGUS_PLAYWRIGHT_MODULE=… node test/attack-0810/ui-old-login-overwrites-fresh-login.js
const { launch, context, token, claimsOf, ORIGIN } = require('./_ui');

(async () => {
  let failed = 0;
  const check = (label, ok, expected, got) => {
    if (ok) console.log(`  ok    ${label}`);
    else { failed += 1; console.log(`  FAIL  ${label}\n        ожидалось: ${expected}\n        получили:  ${got}`); }
  };
  const browser = await launch();
  try {
    // Старый общий вход продавца, истёк неделю назад (до обновления сайта).
    const stale = token({ role: 'seller', companyId: 'old-company', sellerKeyId: 'old-key', warehouseId: 'w', exp: 1790000000 });
    const fresh = token({ role: 'seller', companyId: 'new-company', sellerKeyId: 'new-key', warehouseId: 'w' });
    const { page, ctx } = await context(browser, {
      init: { argus_token: stale, argus_role: 'seller' },
      api: (p) => {
        if (p === '/api/auth/seller/login') return { json: { token: fresh, companyName: 'Новый продавец', warehouseName: 'Склад' } };
        if (p === '/api/sellers/profile') return { json: { companyId: 'new-company', name: 'Новый продавец', warehouseName: 'Склад', directOrders: true } };
        if (p === '/api/sellers/catalog') return { json: { products: [] } };
        return undefined;
      },
    });
    await page.goto(ORIGIN + '/login.html');
    await page.evaluate(async () => {
      hideAll(); document.getElementById('formSeller').classList.add('show');
      document.getElementById('sellerName').value = 'Продавец';
      document.getElementById('sellerKey').value = 'RM-0000-K';
      await checkSellerKey();
    });
    const afterLogin = claimsOf(await page.evaluate(() => localStorage.getItem('argus_auth_seller')));
    check('после входа на login.html на месте продавца — новый вход', afterLogin && afterLogin.companyId === 'new-company',
      'new-company', JSON.stringify(afterLogin));
    // «Перейти к актам» — в кабинет продавца.
    await page.goto(ORIGIN + '/client_access.html');
    await page.waitForTimeout(1500);
    const slot = claimsOf(await page.evaluate(() => localStorage.getItem('argus_auth_seller')));
    const loginShown = await page.evaluate(() => !document.getElementById('loginScreen').hidden);
    check('в кабинете продавца вход тот же, новый (не затёрт старым)', slot && slot.companyId === 'new-company',
      'new-company', JSON.stringify(slot));
    check('продавцу не показывают форму входа сразу после входа', !loginShown, 'кабинет открыт', loginShown ? 'снова форма входа' : 'кабинет');
    await ctx.close();
  } catch (e) {
    console.error('ОШИБКА ТЕСТА', e); process.exitCode = 2;
  } finally {
    await browser.close();
    console.log(`\nСтарый вход затирает свежий: ${failed} нарушений`);
    if (failed && process.exitCode !== 2) process.exitCode = 1;
  }
})();
