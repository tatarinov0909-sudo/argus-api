const express = require('express');
const { requireAuth, requireRole, requireGrant, GRANTS } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { randomPart } = require('../middleware/keys');
const { HttpError } = require('../middleware/errorHandler');

const router = express.Router();

// Список ключей. Менеджеру — только работники, и вот почему.
//
// В списке отдаётся сам код ключа: без него владелец не может передать ключ
// человеку. Значит любой, кто видит список, видит и рабочие ключи целиком.
// Пока список был общим, менеджер с правом на сотрудников читал ключ другого
// менеджера и входил им — со всеми ЕГО правами, включая деньги. Запрет
// «второго менеджера не выдать» при этом никуда не делся, он просто стал
// не нужен: зачем выдавать новый ключ, если можно взять готовый.
//
// Отсюда правило: менеджер распоряжается работниками, а ключи менеджеров —
// дело владельца, и даже посмотреть на них нельзя.
router.get('/', requireAuth, requireGrant('staff'), async (req, res, next) => {
  try {
    const { warehouseId, role } = req.auth;
    const onlyWorkers = role !== 'owner';
    const rows = await withTenantContext({ warehouseId }, async (client) => {
      const result = await client.query(
        `SELECT id, key_code, name, active, issued_at, revoked_at, kind, permissions
         FROM staff_keys
         WHERE warehouse_id = $1 AND ($2::bool IS NOT TRUE OR kind = 'worker')
         ORDER BY issued_at ASC`,
        [warehouseId, onlyWorkers],
      );
      return result.rows;
    });
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, requireGrant('staff'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const { name, kind = 'worker', permissions = [] } = req.body;
    if (!name || !name.trim()) throw new HttpError(400, 'Введите имя сотрудника');
    if (kind !== 'worker' && kind !== 'manager') {
      throw new HttpError(400, 'Сотрудник бывает либо работником, либо менеджером');
    }

    // Ключ МЕНЕДЖЕРА выдаёт только владелец, и открытое право «выдавать
    // ключи работникам» этого не позволяет. Иначе менеджер с этим правом
    // завёл бы себе второго менеджера с любыми правами, и всё урезание
    // превратилось бы в вежливую просьбу.
    if (kind === 'manager' && req.auth.role !== 'owner') {
      throw new HttpError(403, 'Ключ менеджера может выдать только руководитель склада');
    }
    const grants = Array.isArray(permissions)
      ? permissions.filter((g) => Object.prototype.hasOwnProperty.call(GRANTS, g))
      : [];
    const unknown = Array.isArray(permissions)
      ? permissions.filter((g) => !Object.prototype.hasOwnProperty.call(GRANTS, g))
      : [];
    if (unknown.length > 0) {
      throw new HttpError(400, `Неизвестное право: ${unknown.join(', ')}. `
        + `Бывают: ${Object.keys(GRANTS).join(', ')}`);
    }
    if (kind === 'worker' && grants.length > 0) {
      throw new HttpError(400, 'Права открываются менеджеру, а не работнику');
    }

    const key = await withTenantContext({ warehouseId }, async (client) => {
      const whResult = await client.query(`SELECT warehouse_code FROM warehouses WHERE id = $1`, [warehouseId]);
      const code = whResult.rows[0].warehouse_code;

      const countResult = await client.query(
        `SELECT COUNT(*)::int AS n FROM staff_keys WHERE warehouse_id = $1`,
        [warehouseId],
      );
      const seq = countResult.rows[0].n + 1;

      // Номер по порядку остаётся — по нему владелец узнаёт ключ в списке, —
      // но сам по себе он не пускает никуда: секрет в случайной части.
      // Раньше её не было, и ключ «7721-05» подбирался с двадцатой попытки,
      // потому что код склада написан в кабинете, а номера шли подряд.
      //
      // Порядковый номер к тому же считался как COUNT(*) + 1: два ключа,
      // выданных одновременно, получали один номер, и второй запрос падал
      // на уникальном индексе. Случайная часть закрывает и это, а повтор
      // на всякий случай остался.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const keyCode = `${code}-${String(seq).padStart(2, '0')}-${randomPart(4)}`;
        try {
          const insertResult = await client.query(
            `INSERT INTO staff_keys (warehouse_id, key_code, name, kind, permissions)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, key_code, name, active, issued_at, kind, permissions`,
            [warehouseId, keyCode, name.trim(), kind, grants],
          );
          return insertResult.rows[0];
        } catch (err) {
          if (err.code === '23505' && attempt < 4) continue;
          throw err;
        }
      }
      throw new HttpError(500, 'Не удалось выдать ключ — попробуйте ещё раз');
    });
    res.status(201).json(key);
  } catch (err) {
    next(err);
  }
});

// Отозвать или восстановить ключ.
//
// Ключ менеджера — только владельцу, по той же причине, что и выдача. Иначе
// один менеджер отзывает ключ другого, а хуже — ВОССТАНАВЛИВАЕТ отозванный:
// владелец уволил человека и закрыл ему доступ, а доступ вернули без него.
router.patch('/:id/toggle', requireAuth, requireGrant('staff'), async (req, res, next) => {
  try {
    const { warehouseId, role } = req.auth;
    const { id } = req.params;

    const key = await withTenantContext({ warehouseId }, async (client) => {
      const target = await client.query(
        'SELECT kind FROM staff_keys WHERE id = $1 AND warehouse_id = $2', [id, warehouseId],
      );
      if (!target.rows[0]) return null;
      if (target.rows[0].kind === 'manager' && role !== 'owner') {
        throw new HttpError(403,
          'Ключом менеджера распоряжается только руководитель склада');
      }
      const result = await client.query(
        `UPDATE staff_keys
         SET active = NOT active, revoked_at = CASE WHEN active THEN now() ELSE NULL END
         WHERE id = $1 AND warehouse_id = $2
         RETURNING id, key_code, name, active, issued_at, revoked_at`,
        [id, warehouseId],
      );
      return result.rows[0];
    });
    if (!key) throw new HttpError(404, 'Ключ не найден');
    res.json(key);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
