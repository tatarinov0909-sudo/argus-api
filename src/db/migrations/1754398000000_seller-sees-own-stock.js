/* eslint-disable camelcase */

exports.shorthands = undefined;

// Продавец должен видеть свой остаток — и только свой.
//
// У cell_stock изоляция была только по складу: `warehouse_id = ...`. У запроса
// продавца warehouse_id намеренно не выставляется (см. auth/tenantContext.js —
// это защита от бага, который проект уже однажды ловил: один ключ открывал
// несколько компаний). В итоге продавец не мог прочитать из остатков ни строки,
// и кабинет показывал ему сумму приёмок вместо того, что лежит на полке.
//
// Приводим политику к той же форме, что у receiving_records, shipping_records и
// return_records: склад видит всё своё, продавец — строки своей компании.
// Ничего не «открывается»: доступ по-прежнему решает Postgres, а не код.
exports.up = (pgm) => {
  pgm.sql(`
    DROP POLICY IF EXISTS tenant_isolation ON cell_stock;
    CREATE POLICY tenant_isolation ON cell_stock USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
      OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP POLICY IF EXISTS tenant_isolation ON cell_stock;
    CREATE POLICY tenant_isolation ON cell_stock USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
    );
  `);
};
