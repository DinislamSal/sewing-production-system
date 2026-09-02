import bcrypt from 'bcryptjs';
import { query } from './db.js';

export async function initializeDatabase() {
  await query(`
    CREATE TABLE IF NOT EXISTS employees (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      login TEXT NOT NULL UNIQUE,
      pin_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('cutter','seamstress','controller','owner','admin')),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS models (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      active BOOLEAN NOT NULL DEFAULT TRUE
    );
    CREATE TABLE IF NOT EXISTS model_operations (
      id BIGSERIAL PRIMARY KEY,
      model_id BIGINT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'sewing' CHECK (kind IN ('cutting','sewing')),
      sort_order INTEGER NOT NULL DEFAULT 0,
      UNIQUE(model_id, name)
    );
    ALTER TABLE model_operations ADD COLUMN IF NOT EXISTS equipment TEXT NOT NULL DEFAULT '';
    ALTER TABLE model_operations ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
    CREATE TABLE IF NOT EXISTS rates (
      id BIGSERIAL PRIMARY KEY,
      model_id BIGINT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
      operation_id BIGINT REFERENCES model_operations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('cutter','seamstress')),
      min_size INTEGER NOT NULL,
      max_size INTEGER NOT NULL,
      price NUMERIC(12,2) NOT NULL CHECK (price >= 0),
      UNIQUE(model_id, operation_id, role, min_size, max_size)
    );
    CREATE TABLE IF NOT EXISTS batches (
      id BIGSERIAL PRIMARY KEY,
      model_id BIGINT NOT NULL REFERENCES models(id),
      color TEXT NOT NULL DEFAULT '',
      opened_on DATE NOT NULL DEFAULT ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Yekaterinburg')::date),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
      created_by BIGINT REFERENCES employees(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS cutting_log (
      id BIGSERIAL PRIMARY KEY,
      work_date DATE NOT NULL DEFAULT ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Yekaterinburg')::date),
      employee_id BIGINT NOT NULL REFERENCES employees(id),
      batch_id BIGINT NOT NULL REFERENCES batches(id),
      size INTEGER NOT NULL,
      total_qty INTEGER NOT NULL CHECK (total_qty > 0),
      defect_qty INTEGER NOT NULL DEFAULT 0 CHECK (defect_qty >= 0 AND defect_qty <= total_qty),
      rate NUMERIC(12,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      voided_at TIMESTAMPTZ,
      voided_by BIGINT REFERENCES employees(id),
      void_reason TEXT
    );
    CREATE TABLE IF NOT EXISTS sewing_log (
      id BIGSERIAL PRIMARY KEY,
      work_date DATE NOT NULL DEFAULT ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Yekaterinburg')::date),
      employee_id BIGINT NOT NULL REFERENCES employees(id),
      batch_id BIGINT NOT NULL REFERENCES batches(id),
      operation_id BIGINT NOT NULL REFERENCES model_operations(id),
      size INTEGER NOT NULL,
      good_qty INTEGER NOT NULL CHECK (good_qty >= 0),
      defect_qty INTEGER NOT NULL DEFAULT 0 CHECK (defect_qty >= 0),
      rate NUMERIC(12,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      voided_at TIMESTAMPTZ,
      voided_by BIGINT REFERENCES employees(id),
      void_reason TEXT,
      CHECK (good_qty + defect_qty > 0)
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id BIGSERIAL PRIMARY KEY,
      employee_id BIGINT REFERENCES employees(id),
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id BIGINT,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_cutting_balance ON cutting_log(batch_id, size) WHERE voided_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_sewing_balance ON sewing_log(batch_id, operation_id, size) WHERE voided_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_cutting_employee_date ON cutting_log(employee_id, work_date) WHERE voided_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_sewing_employee_date ON sewing_log(employee_id, work_date) WHERE voided_at IS NULL;
    ALTER TABLE cutting_log ADD COLUMN IF NOT EXISTS is_opening BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE sewing_log ADD COLUMN IF NOT EXISTS is_opening BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE INDEX IF NOT EXISTS idx_cutting_opening ON cutting_log(batch_id, size, is_opening) WHERE voided_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_sewing_opening ON sewing_log(batch_id, operation_id, size, is_opening) WHERE voided_at IS NULL;
  `);

  const count = await query('SELECT COUNT(*)::int AS count FROM employees');
  if (count.rows[0].count === 0 && process.env.SEED_DEMO_DATA === 'true') {
    await seedDemoData();
  }
}

async function seedDemoData() {
  const users = [
    ['Администратор', 'admin', '2580', 'admin'],
    ['Кройщик 1', 'cutter1', '1111', 'cutter'],
    ['Швея 1', 'seamstress1', '2222', 'seamstress'],
    ['Швея 2', 'seamstress2', '2222', 'seamstress'],
    ['Контроллер', 'controller', '3333', 'controller'],
    ['Владелец', 'owner', '4444', 'owner']
  ];
  for (const [name, login, pin, role] of users) {
    await query('INSERT INTO employees(name,login,pin_hash,role) VALUES($1,$2,$3,$4)', [name, login, await bcrypt.hash(pin, 12), role]);
  }
  const model = await query("INSERT INTO models(name) VALUES('33 (92-122)') RETURNING id");
  const modelId = model.rows[0].id;
  const operations = ['сборка кофты','горловина','втачивание манжет','соед манжет, вывор','соед горловины','киперная лента','распошив низа кофт','сборка брюк','втачать резинку','распошив пояса','соед манжет','втач манжет'];
  for (let i = 0; i < operations.length; i++) {
    const op = await query('INSERT INTO model_operations(model_id,name,sort_order) VALUES($1,$2,$3) ON CONFLICT(model_id,name) DO UPDATE SET sort_order=LEAST(model_operations.sort_order, EXCLUDED.sort_order) RETURNING id', [modelId, operations[i], i + 1]);
    await query('INSERT INTO rates(model_id,operation_id,role,min_size,max_size,price) VALUES($1,$2,$3,92,122,25) ON CONFLICT DO NOTHING', [modelId, op.rows[0].id, 'seamstress']);
  }
  await query('INSERT INTO rates(model_id,operation_id,role,min_size,max_size,price) VALUES($1,NULL,$2,92,122,23)', [modelId, 'cutter']);
  const admin = await query("SELECT id FROM employees WHERE login='admin'");
  await query("INSERT INTO batches(model_id,color,created_by) VALUES($1,'Тестовая расцветка',$2)", [modelId, admin.rows[0].id]);
}
