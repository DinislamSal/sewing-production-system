import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import ExcelJS from 'exceljs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query, transaction } from './db.js';
import { initializeDatabase } from './schema.js';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

function sign(user) {
  return jwt.sign({ id: user.id, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '12h' });
}
function auth(req, res, next) {
  try {
    req.user = jwt.verify(req.cookies.session, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Нужно войти в систему' });
  }
}
function roles(...allowed) {
  return (req, res, next) => allowed.includes(req.user.role) ? next() : res.status(403).json({ error: 'Недостаточно прав' });
}
function positiveInt(value, allowZero = false) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < (allowZero ? 0 : 1)) return null;
  return n;
}

app.post('/api/login', async (req, res) => {
  const login = String(req.body.login || '').trim().toLowerCase();
  const pin = String(req.body.pin || '');
  const result = await query('SELECT * FROM employees WHERE lower(login)=$1 AND active=true', [login]);
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(pin, user.pin_hash))) return res.status(401).json({ error: 'Неверный логин или PIN-код' });
  res.cookie('session', sign(user), { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: 12 * 60 * 60 * 1000 });
  res.json({ user: { id: user.id, name: user.name, role: user.role } });
});
app.post('/api/logout', (_req, res) => { res.clearCookie('session'); res.json({ ok: true }); });
app.get('/api/me', auth, (req, res) => res.json({ user: req.user }));

app.get('/api/dashboard', auth, async (req, res) => {
  const managerRoles=['controller','owner','admin'];
  if(managerRoles.includes(req.user.role)){
    const data=await query(`WITH clock AS (
      SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Yekaterinburg')::date AS today
    ), period AS (
      SELECT today,
        CASE WHEN EXTRACT(DAY FROM today) BETWEEN 11 AND 25
          THEN date_trunc('month',today)::date + 10
          WHEN EXTRACT(DAY FROM today) >= 26
          THEN date_trunc('month',today)::date + 25
          ELSE (date_trunc('month',today)::date - INTERVAL '1 month')::date + 25 END AS period_start,
        CASE WHEN EXTRACT(DAY FROM today) BETWEEN 11 AND 25
          THEN date_trunc('month',today)::date + 24
          WHEN EXTRACT(DAY FROM today) >= 26
          THEN (date_trunc('month',today)::date + INTERVAL '1 month')::date + 9
          ELSE date_trunc('month',today)::date + 9 END AS period_end
      FROM clock
    ), work AS (
      SELECT work_date,total_qty-defect_qty good,defect_qty,(total_qty-defect_qty)*rate amount FROM cutting_log WHERE voided_at IS NULL AND is_opening=false
      UNION ALL SELECT work_date,good_qty,defect_qty,good_qty*rate FROM sewing_log WHERE voided_at IS NULL AND is_opening=false
    ) SELECT
      COALESCE(SUM(w.good) FILTER (WHERE w.work_date=p.today),0)::int today_good,
      COALESCE(SUM(w.defect_qty) FILTER (WHERE w.work_date=p.today),0)::int today_defect,
      COALESCE(SUM(w.amount) FILTER (WHERE w.work_date=p.today),0)::numeric today_amount,
      COALESCE(SUM(w.good) FILTER (WHERE w.work_date BETWEEN p.period_start AND p.today),0)::int month_good,
      COALESCE(SUM(w.defect_qty) FILTER (WHERE w.work_date BETWEEN p.period_start AND p.today),0)::int month_defect,
      COALESCE(SUM(w.amount) FILTER (WHERE w.work_date BETWEEN p.period_start AND p.today),0)::numeric month_amount,
      to_char(p.today,'YYYY-MM-DD') today,to_char(p.period_start,'YYYY-MM-DD') period_start,to_char(p.period_end,'YYYY-MM-DD') period_end,
      (SELECT COUNT(*)::int FROM batches WHERE status='active') active_batches
    FROM period p LEFT JOIN work w ON true GROUP BY p.today,p.period_start,p.period_end`);
    return res.json({scope:'workshop',...data.rows[0]});
  }
  const data = await query(`
    WITH clock AS (
      SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Yekaterinburg')::date AS today
    ), period AS (
      SELECT today,
        CASE WHEN EXTRACT(DAY FROM today) BETWEEN 11 AND 25
          THEN date_trunc('month',today)::date + 10
          WHEN EXTRACT(DAY FROM today) >= 26
          THEN date_trunc('month',today)::date + 25
          ELSE (date_trunc('month',today)::date - INTERVAL '1 month')::date + 25 END AS period_start,
        CASE WHEN EXTRACT(DAY FROM today) BETWEEN 11 AND 25
          THEN date_trunc('month',today)::date + 24
          WHEN EXTRACT(DAY FROM today) >= 26
          THEN (date_trunc('month',today)::date + INTERVAL '1 month')::date + 9
          ELSE date_trunc('month',today)::date + 9 END AS period_end
      FROM clock
    ), work AS (
      SELECT work_date, total_qty-defect_qty AS good, defect_qty, (total_qty-defect_qty)*rate AS amount
      FROM cutting_log WHERE employee_id=$1 AND voided_at IS NULL AND is_opening=false
      UNION ALL
      SELECT work_date, good_qty, defect_qty, good_qty*rate
      FROM sewing_log WHERE employee_id=$1 AND voided_at IS NULL AND is_opening=false
    )
    SELECT
      COALESCE(SUM(w.good) FILTER (WHERE w.work_date=p.today),0)::int AS today_good,
      COALESCE(SUM(w.defect_qty) FILTER (WHERE w.work_date=p.today),0)::int AS today_defect,
      COALESCE(SUM(w.amount) FILTER (WHERE w.work_date=p.today),0)::numeric AS today_amount,
      COALESCE(SUM(w.good) FILTER (WHERE w.work_date BETWEEN p.period_start AND p.today),0)::int AS month_good,
      COALESCE(SUM(w.defect_qty) FILTER (WHERE w.work_date BETWEEN p.period_start AND p.today),0)::int AS month_defect,
      COALESCE(SUM(w.amount) FILTER (WHERE w.work_date BETWEEN p.period_start AND p.today),0)::numeric AS month_amount,
      to_char(p.today,'YYYY-MM-DD') today,to_char(p.period_start,'YYYY-MM-DD') period_start,to_char(p.period_end,'YYYY-MM-DD') period_end
    FROM period p LEFT JOIN work w ON true GROUP BY p.today,p.period_start,p.period_end`, [req.user.id]);
  res.json({scope:'personal',...data.rows[0]});
});

app.get('/api/batches', auth, async (_req, res) => {
  const result = await query(`SELECT b.id,m.name AS model,b.color,b.opened_on,b.status FROM batches b JOIN models m ON m.id=b.model_id WHERE b.status='active' ORDER BY b.id DESC`);
  res.json(result.rows);
});

app.get('/api/batches-all', auth, roles('controller','owner','admin'), async (_req,res)=>{
  const result=await query(`SELECT b.id,m.name AS model,b.color,b.opened_on,b.status FROM batches b JOIN models m ON m.id=b.model_id ORDER BY b.id DESC`);
  res.json(result.rows);
});

app.get('/api/batches/:id/cutting-sizes',auth,roles('cutter','controller'),async(req,res)=>{
  const batchId=positiveInt(req.params.id);if(!batchId)return res.status(400).json({error:'Неверная партия'});
  const result=await query(`SELECT DISTINCT size::int FROM batches b
    JOIN rates r ON r.model_id=b.model_id AND r.role='cutter' AND r.operation_id IS NULL
    CROSS JOIN LATERAL generate_series(r.min_size,r.max_size,6) size
    WHERE b.id=$1 AND b.status='active' ORDER BY size`,[batchId]);
  if(!result.rows.length)return res.status(400).json({error:'Для этой модели не настроены размеры кройщика'});
  res.json(result.rows.map(r=>r.size));
});

app.get('/api/models', auth, roles('controller','owner','admin'), async (_req, res) => {
  const result = await query('SELECT id,name FROM models WHERE active=true ORDER BY name');
  res.json(result.rows);
});

app.get('/api/admin/models', auth, roles('admin'), async (_req,res)=>{
  const [models,operations,rates]=await Promise.all([
    query('SELECT id,name,active FROM models WHERE active=true ORDER BY name'),
    query('SELECT id,model_id,name,equipment,sort_order,active FROM model_operations ORDER BY model_id,sort_order,id'),
    query('SELECT id,model_id,operation_id,role,min_size,max_size,price FROM rates ORDER BY model_id,role,operation_id,min_size')
  ]);
  const result=models.rows.map(model=>({
    ...model,
    cutterRates:rates.rows.filter(r=>String(r.model_id)===String(model.id)&&r.role==='cutter').map(r=>({id:r.id,minSize:r.min_size,maxSize:r.max_size,price:r.price})),
    operations:operations.rows.filter(o=>String(o.model_id)===String(model.id)).map(o=>({
      ...o,
      rates:rates.rows.filter(r=>String(r.operation_id)===String(o.id)&&r.role==='seamstress').map(r=>({id:r.id,minSize:r.min_size,maxSize:r.max_size,price:r.price}))
    }))
  }));
  res.json(result);
});

function adminRate(raw){
  const minSize=positiveInt(raw?.minSize),maxSize=positiveInt(raw?.maxSize),price=Number(raw?.price);
  if(!minSize||!maxSize||maxSize<minSize||!Number.isFinite(price)||price<0)throw Object.assign(new Error('Проверьте диапазон размеров и цену'),{status:400});
  return {minSize,maxSize,price};
}

async function saveAdminModel(client,modelId,payload){
  const name=String(payload.name||'').trim();
  if(name.length<1||name.length>100)throw Object.assign(new Error('Укажите название модели'),{status:400});
  const cutterRates=Array.isArray(payload.cutterRates)?payload.cutterRates.map(adminRate):[];
  if(!cutterRates.length)throw Object.assign(new Error('Добавьте размер и ставку кройщика'),{status:400});
  const operations=Array.isArray(payload.operations)?payload.operations:[];
  if(!operations.length)throw Object.assign(new Error('Добавьте хотя бы одну операцию швеи'),{status:400});
  if(modelId){
    const updated=await client.query('UPDATE models SET name=$1,active=$2 WHERE id=$3 RETURNING id',[name,payload.active!==false,modelId]);
    if(!updated.rows[0])throw Object.assign(new Error('Модель не найдена'),{status:404});
  }else{
    const created=await client.query('INSERT INTO models(name,active) VALUES($1,true) RETURNING id',[name]);
    modelId=created.rows[0].id;
  }
  await client.query("DELETE FROM rates WHERE model_id=$1 AND role='cutter'",[modelId]);
  for(const rate of cutterRates)await client.query('INSERT INTO rates(model_id,operation_id,role,min_size,max_size,price) VALUES($1,NULL,$2,$3,$4,$5)',[modelId,'cutter',rate.minSize,rate.maxSize,rate.price]);
  const kept=[];
  for(let i=0;i<operations.length;i++){
    const raw=operations[i],opName=String(raw.name||'').trim(),equipment=String(raw.equipment||'').trim();
    if(!opName)throw Object.assign(new Error(`Укажите название операции №${i+1}`),{status:400});
    let operationId=positiveInt(raw.id);
    if(operationId){
      const updated=await client.query('UPDATE model_operations SET name=$1,equipment=$2,sort_order=$3,active=$4 WHERE id=$5 AND model_id=$6 RETURNING id',[opName,equipment,i+1,raw.active!==false,operationId,modelId]);
      if(!updated.rows[0])throw Object.assign(new Error('Операция не относится к выбранной модели'),{status:400});
    }else{
      const created=await client.query('INSERT INTO model_operations(model_id,name,equipment,sort_order,active) VALUES($1,$2,$3,$4,true) RETURNING id',[modelId,opName,equipment,i+1]);
      operationId=created.rows[0].id;
    }
    kept.push(operationId);
    const opRates=Array.isArray(raw.rates)?raw.rates.map(adminRate):[];
    if(raw.active!==false&&!opRates.length)throw Object.assign(new Error(`Добавьте размер и цену для операции «${opName}»`),{status:400});
    await client.query('DELETE FROM rates WHERE operation_id=$1',[operationId]);
    for(const rate of opRates)await client.query('INSERT INTO rates(model_id,operation_id,role,min_size,max_size,price) VALUES($1,$2,$3,$4,$5,$6)',[modelId,operationId,'seamstress',rate.minSize,rate.maxSize,rate.price]);
  }
  if(kept.length)await client.query('UPDATE model_operations SET active=false WHERE model_id=$1 AND NOT(id=ANY($2::bigint[]))',[modelId,kept]);
  return modelId;
}

app.post('/api/admin/models',auth,roles('admin'),async(req,res)=>{
  try{
    const id=await transaction(async client=>saveAdminModel(client,null,req.body));
    await query(`INSERT INTO audit_log(employee_id,action,entity_type,entity_id,details) VALUES($1,'create','model',$2,$3)`,[req.user.id,id,JSON.stringify({name:req.body.name})]);
    res.json({ok:true,id});
  }catch(e){if(e.code==='23505')return res.status(409).json({error:'Такая модель или операция уже существует'});throw e}
});

app.put('/api/admin/models/:id',auth,roles('admin'),async(req,res)=>{
  const id=positiveInt(req.params.id);if(!id)return res.status(400).json({error:'Неверная модель'});
  try{
    await transaction(async client=>saveAdminModel(client,id,req.body));
    await query(`INSERT INTO audit_log(employee_id,action,entity_type,entity_id,details) VALUES($1,'update','model',$2,$3)`,[req.user.id,id,JSON.stringify({name:req.body.name})]);
    res.json({ok:true,id});
  }catch(e){if(e.code==='23505')return res.status(409).json({error:'Такая модель, операция или диапазон уже существует'});throw e}
});

app.post('/api/batches', auth, roles('controller','admin'), async (req, res) => {
  const modelId=positiveInt(req.body.modelId); const color=String(req.body.color||'').trim();
  if (!modelId || !color) return res.status(400).json({error:'Выберите модель и укажите расцветку'});
  const result=await query(`INSERT INTO batches(model_id,color,created_by) SELECT id,$2,$3 FROM models WHERE id=$1 AND active=true RETURNING id`,[modelId,color,req.user.id]);
  if(!result.rows[0]) return res.status(400).json({error:'Модель не найдена'});
  await query(`INSERT INTO audit_log(employee_id,action,entity_type,entity_id,details) VALUES($1,'create','batch',$2,$3)`,[req.user.id,result.rows[0].id,JSON.stringify({modelId,color})]);
  res.json({ok:true,id:result.rows[0].id});
});

app.patch('/api/batches/:id/close', auth, roles('controller','admin'), async (req,res)=>{
  const id=positiveInt(req.params.id); if(!id)return res.status(400).json({error:'Неверная партия'});
  const result=await query("UPDATE batches SET status='closed' WHERE id=$1 AND status='active' RETURNING id",[id]);
  if(!result.rows[0])return res.status(404).json({error:'Активная партия не найдена'});
  await query(`INSERT INTO audit_log(employee_id,action,entity_type,entity_id) VALUES($1,'close','batch',$2)`,[req.user.id,id]);
  res.json({ok:true});
});

app.get('/api/employees', auth, roles('controller','owner','admin'), async (_req,res)=>{
  const result=await query(`SELECT id,name,login,role,active,created_at FROM employees ORDER BY active DESC,name`);
  res.json(result.rows);
});

app.post('/api/employees', auth, roles('admin'), async (req,res)=>{
  const name=String(req.body.name||'').trim(),login=String(req.body.login||'').trim().toLowerCase(),pin=String(req.body.pin||''),role=String(req.body.role||'');
  if(!name||!login||!/^[a-zA-Z0-9._-]{3,30}$/.test(login))return res.status(400).json({error:'Укажите имя и логин латинскими буквами'});
  if(!/^\d{4,8}$/.test(pin))return res.status(400).json({error:'PIN должен состоять из 4–8 цифр'});
  if(!['cutter','seamstress','controller','owner','admin'].includes(role))return res.status(400).json({error:'Выберите роль'});
  try{const result=await query(`INSERT INTO employees(name,login,pin_hash,role) VALUES($1,$2,$3,$4) RETURNING id`,[name,login,await bcrypt.hash(pin,12),role]);res.json({ok:true,id:result.rows[0].id})}
  catch(e){if(e.code==='23505')return res.status(409).json({error:'Такой логин уже используется'});throw e}
});

app.patch('/api/employees/:id/pin', auth, roles('admin'), async (req,res)=>{
  const id=positiveInt(req.params.id),pin=String(req.body.pin||'');
  if(!id||!/^\d{4,8}$/.test(pin))return res.status(400).json({error:'PIN должен состоять из 4–8 цифр'});
  await query('UPDATE employees SET pin_hash=$1 WHERE id=$2',[await bcrypt.hash(pin,12),id]);res.json({ok:true});
});

app.patch('/api/employees/:id/status', auth, roles('admin'), async (req,res)=>{
  const id=positiveInt(req.params.id);if(!id||id===Number(req.user.id))return res.status(400).json({error:'Нельзя отключить текущую учётную запись'});
  await query('UPDATE employees SET active=$1 WHERE id=$2',[Boolean(req.body.active),id]);res.json({ok:true});
});

app.get('/api/entries', auth, roles('controller','owner','admin'), async (req,res)=>{
  const params=[];
  const add=(value)=>{params.push(value);return `$${params.length}`};
  const where=[];
  if(/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from||''))) where.push(`x.work_date>=${add(req.query.from)}`);
  if(/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to||''))) where.push(`x.work_date<=${add(req.query.to)}`);
  const employeeId=positiveInt(req.query.employeeId); if(employeeId) where.push(`x.employee_id=${add(employeeId)}`);
  const batchId=positiveInt(req.query.batchId); if(batchId) where.push(`x.batch=${add(batchId)}`);
  if(['cutting','sewing'].includes(String(req.query.type||''))) where.push(`x.type=${add(req.query.type)}`);
  if(req.query.status==='active') where.push('x.voided_at IS NULL');
  if(req.query.status==='voided') where.push('x.voided_at IS NOT NULL');
  const operation=String(req.query.operation||'').trim(); if(operation) where.push(`x.operation ILIKE ${add(`%${operation}%`)}`);
  const result=await query(`SELECT * FROM (
    SELECT 'cutting' type,c.id,c.employee_id,c.created_at,c.work_date,e.name employee,b.id batch,m.name model,c.size,'Крой' operation,
      c.total_qty good,c.defect_qty defect,c.is_opening,c.voided_at,c.void_reason,ve.name voided_by_name
    FROM cutting_log c JOIN employees e ON e.id=c.employee_id JOIN batches b ON b.id=c.batch_id JOIN models m ON m.id=b.model_id LEFT JOIN employees ve ON ve.id=c.voided_by
    UNION ALL
    SELECT 'sewing',s.id,s.employee_id,s.created_at,s.work_date,e.name,b.id,m.name,s.size,mo.name,
      s.good_qty,s.defect_qty,s.is_opening,s.voided_at,s.void_reason,ve.name
    FROM sewing_log s JOIN employees e ON e.id=s.employee_id JOIN batches b ON b.id=s.batch_id JOIN models m ON m.id=b.model_id
      JOIN model_operations mo ON mo.id=s.operation_id LEFT JOIN employees ve ON ve.id=s.voided_by
  ) x ${where.length?`WHERE ${where.join(' AND ')}`:''} ORDER BY x.work_date DESC,x.created_at DESC LIMIT 500`,params);
  res.json(result.rows);
});

app.get('/api/batches/:id/all-operations', auth, roles('controller','owner','admin'), async (req,res)=>{
  const id=positiveInt(req.params.id); if(!id)return res.status(400).json({error:'Неверная партия'});
  const result=await query(`SELECT mo.id,mo.name,mo.equipment,mo.sort_order FROM batches b JOIN model_operations mo ON mo.model_id=b.model_id WHERE b.id=$1 AND mo.active=true ORDER BY mo.sort_order,mo.name`,[id]);
  res.json(result.rows);
});

app.post('/api/opening/cutting', auth, roles('controller','admin'), async (req,res)=>{
  const batchId=positiveInt(req.body.batchId),size=positiveInt(req.body.size),good=positiveInt(req.body.goodQty);
  if(!batchId||!size||!good)return res.status(400).json({error:'Выберите партию, размер и укажите годный остаток'});
  const batch=await query("SELECT id FROM batches WHERE id=$1 AND status='active'",[batchId]);
  if(!batch.rows[0])return res.status(404).json({error:'Активная партия не найдена'});
  const row=await query(`INSERT INTO cutting_log(employee_id,batch_id,size,total_qty,defect_qty,rate,is_opening) VALUES($1,$2,$3,$4,0,0,true) RETURNING id`,[req.user.id,batchId,size,good]);
  await query(`INSERT INTO audit_log(employee_id,action,entity_type,entity_id,details) VALUES($1,'opening','cutting_log',$2,$3)`,[req.user.id,row.rows[0].id,JSON.stringify({batchId,size,goodQty:good})]);
  res.json({ok:true,id:row.rows[0].id});
});

app.post('/api/opening/sewing', auth, roles('controller','admin'), async (req,res)=>{
  const batchId=positiveInt(req.body.batchId),operationId=positiveInt(req.body.operationId),size=positiveInt(req.body.size);
  const good=positiveInt(req.body.goodQty,true),defect=positiveInt(req.body.defectQty,true);
  if([batchId,operationId,size,good,defect].includes(null)||good+defect<1)return res.status(400).json({error:'Проверьте размер, выполненное количество и брак'});
  const result=await transaction(async client=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`${batchId}:${operationId}:${size}`]);
    const valid=await client.query(`SELECT 1 FROM batches b JOIN model_operations mo ON mo.model_id=b.model_id WHERE b.id=$1 AND b.status='active' AND mo.id=$2`,[batchId,operationId]);
    if(!valid.rows[0])throw Object.assign(new Error('Операция не относится к выбранной активной партии'),{status:400});
    const available=await client.query(`SELECT
      COALESCE((SELECT SUM(total_qty-defect_qty) FROM cutting_log WHERE batch_id=$1 AND size=$3 AND voided_at IS NULL),0)::int
      - COALESCE((SELECT SUM(good_qty+defect_qty) FROM sewing_log WHERE batch_id=$1 AND operation_id=$2 AND size=$3 AND voided_at IS NULL),0)::int remaining`,[batchId,operationId,size]);
    if(good+defect>available.rows[0].remaining)throw Object.assign(new Error(`Доступно только ${available.rows[0].remaining} шт.`),{status:409});
    const row=await client.query(`INSERT INTO sewing_log(employee_id,batch_id,operation_id,size,good_qty,defect_qty,rate,is_opening) VALUES($1,$2,$3,$4,$5,$6,0,true) RETURNING id`,[req.user.id,batchId,operationId,size,good,defect]);
    await client.query(`INSERT INTO audit_log(employee_id,action,entity_type,entity_id,details) VALUES($1,'opening','sewing_log',$2,$3)`,[req.user.id,row.rows[0].id,JSON.stringify({batchId,operationId,size,goodQty:good,defectQty:defect})]);
    return row.rows[0];
  });
  res.json({ok:true,id:result.id});
});

app.get('/api/entries/recent', auth, roles('controller','owner','admin'), async (_req,res)=>{
  const result=await query(`
    SELECT * FROM (
      SELECT 'cutting' type,c.id,c.created_at,c.work_date,e.name employee,b.id batch,m.name model,c.size,'Крой' operation,c.total_qty good,c.defect_qty defect
      FROM cutting_log c JOIN employees e ON e.id=c.employee_id JOIN batches b ON b.id=c.batch_id JOIN models m ON m.id=b.model_id WHERE c.voided_at IS NULL
      UNION ALL
      SELECT 'sewing',s.id,s.created_at,s.work_date,e.name,b.id,m.name,s.size,mo.name,s.good_qty,s.defect_qty
      FROM sewing_log s JOIN employees e ON e.id=s.employee_id JOIN batches b ON b.id=s.batch_id JOIN models m ON m.id=b.model_id JOIN model_operations mo ON mo.id=s.operation_id WHERE s.voided_at IS NULL
    ) x ORDER BY created_at DESC LIMIT 100`);
  res.json(result.rows);
});

app.post('/api/entries/:type/:id/void', auth, roles('controller','admin'), async (req,res)=>{
  const id=positiveInt(req.params.id),type=String(req.params.type),reason=String(req.body.reason||'').trim();
  if(!id||!['cutting','sewing'].includes(type))return res.status(400).json({error:'Неверная запись'});
  if(reason.length<3)return res.status(400).json({error:'Укажите причину отмены'});
  const table=type==='cutting'?'cutting_log':'sewing_log';
  const result=await query(`UPDATE ${table} SET voided_at=NOW(),voided_by=$1,void_reason=$2 WHERE id=$3 AND voided_at IS NULL RETURNING id`,[req.user.id,reason,id]);
  if(!result.rows[0])return res.status(404).json({error:'Запись уже отменена или не найдена'});
  await query(`INSERT INTO audit_log(employee_id,action,entity_type,entity_id,details) VALUES($1,'void',$2,$3,$4)`,[req.user.id,table,id,JSON.stringify({reason})]);
  res.json({ok:true});
});

app.patch('/api/entries/:type/:id', auth, roles('controller'), async (req,res)=>{
  const id=positiveInt(req.params.id),type=String(req.params.type);
  if(!id||!['cutting','sewing'].includes(type))return res.status(400).json({error:'Неверная запись'});

  const result=await transaction(async client=>{
    if(type==='cutting'){
      const size=positiveInt(req.body.size),total=positiveInt(req.body.totalQty),defect=positiveInt(req.body.defectQty,true);
      if([size,total,defect].includes(null)||defect>total)throw Object.assign(new Error('Проверьте размер, количество и брак'),{status:400});
      const current=await client.query(`SELECT c.*,b.model_id FROM cutting_log c JOIN batches b ON b.id=c.batch_id WHERE c.id=$1 AND c.voided_at IS NULL FOR UPDATE`,[id]);
      const old=current.rows[0];if(!old)throw Object.assign(new Error('Запись не найдена или уже отменена'),{status:404});
      const rate=await client.query(`SELECT price FROM rates WHERE model_id=$1 AND role='cutter' AND operation_id IS NULL AND $2 BETWEEN min_size AND max_size AND MOD($2-min_size,6)=0 ORDER BY id DESC LIMIT 1`,[old.model_id,size]);
      if(!rate.rows[0]&&!old.is_opening)throw Object.assign(new Error('Для выбранного размера не найдена ставка кройщика'),{status:400});

      const affectedSizes=[...new Set([Number(old.size),size])];
      for(const affectedSize of affectedSizes){
        const goodCut=await client.query(`SELECT COALESCE(SUM(total_qty-defect_qty),0)::int good FROM cutting_log WHERE batch_id=$1 AND size=$2 AND voided_at IS NULL AND id<>$3`,[old.batch_id,affectedSize,id]);
        const available=goodCut.rows[0].good+(affectedSize===size?total-defect:0);
        const used=await client.query(`SELECT COALESCE(MAX(qty),0)::int used FROM (SELECT SUM(good_qty+defect_qty)::int qty FROM sewing_log WHERE batch_id=$1 AND size=$2 AND voided_at IS NULL GROUP BY operation_id) x`,[old.batch_id,affectedSize]);
        if(used.rows[0].used>available)throw Object.assign(new Error(`Нельзя уменьшить размер ${affectedSize}: швеи уже использовали ${used.rows[0].used} шт., а останется ${available} шт.`),{status:409});
      }

      const before={size:Number(old.size),totalQty:Number(old.total_qty),defectQty:Number(old.defect_qty),rate:Number(old.rate)};
      const after={size,totalQty:total,defectQty:defect,rate:old.is_opening?0:Number(rate.rows[0].price)};
      await client.query(`UPDATE cutting_log SET size=$1,total_qty=$2,defect_qty=$3,rate=$4 WHERE id=$5`,[size,total,defect,after.rate,id]);
      await client.query(`INSERT INTO audit_log(employee_id,action,entity_type,entity_id,details) VALUES($1,'update','cutting_log',$2,$3)`,[req.user.id,id,JSON.stringify({before,after})]);
      return after;
    }

    const operationId=positiveInt(req.body.operationId),size=positiveInt(req.body.size),good=positiveInt(req.body.goodQty,true),defect=positiveInt(req.body.defectQty,true);
    if([operationId,size,good,defect].includes(null)||good+defect<1)throw Object.assign(new Error('Проверьте операцию, размер, количество и брак'),{status:400});
    const current=await client.query(`SELECT s.*,b.model_id FROM sewing_log s JOIN batches b ON b.id=s.batch_id WHERE s.id=$1 AND s.voided_at IS NULL FOR UPDATE`,[id]);
    const old=current.rows[0];if(!old)throw Object.assign(new Error('Запись не найдена или уже отменена'),{status:404});
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`${old.batch_id}:${operationId}:${size}`]);
    const valid=await client.query(`SELECT 1 FROM model_operations WHERE id=$1 AND model_id=$2 AND active=true`,[operationId,old.model_id]);
    if(!valid.rows[0])throw Object.assign(new Error('Операция не относится к модели выбранной партии'),{status:400});
    const available=await client.query(`SELECT
      COALESCE((SELECT SUM(total_qty-defect_qty) FROM cutting_log WHERE batch_id=$1 AND size=$3 AND voided_at IS NULL),0)::int
      - COALESCE((SELECT SUM(good_qty+defect_qty) FROM sewing_log WHERE batch_id=$1 AND operation_id=$2 AND size=$3 AND voided_at IS NULL AND id<>$4),0)::int remaining`,[old.batch_id,operationId,size,id]);
    if(good+defect>available.rows[0].remaining)throw Object.assign(new Error(`Для этой операции и размера доступно только ${available.rows[0].remaining} шт.`),{status:409});
    const rate=await client.query(`SELECT price FROM rates WHERE model_id=$1 AND role='seamstress' AND operation_id=$2 AND $3 BETWEEN min_size AND max_size ORDER BY id DESC LIMIT 1`,[old.model_id,operationId,size]);
    if(!rate.rows[0]&&!old.is_opening)throw Object.assign(new Error('Для выбранной операции и размера не найдена ставка'),{status:400});
    const before={operationId:Number(old.operation_id),size:Number(old.size),goodQty:Number(old.good_qty),defectQty:Number(old.defect_qty),rate:Number(old.rate)};
    const after={operationId,size,goodQty:good,defectQty:defect,rate:old.is_opening?0:Number(rate.rows[0].price)};
    await client.query(`UPDATE sewing_log SET operation_id=$1,size=$2,good_qty=$3,defect_qty=$4,rate=$5 WHERE id=$6`,[operationId,size,good,defect,after.rate,id]);
    await client.query(`INSERT INTO audit_log(employee_id,action,entity_type,entity_id,details) VALUES($1,'update','sewing_log',$2,$3)`,[req.user.id,id,JSON.stringify({before,after})]);
    return after;
  });
  res.json({ok:true,entry:result});
});

app.get('/api/batches/:id/operations', auth, async (req, res) => {
  const result = await query(`
    SELECT mo.id,mo.name,mo.equipment,mo.sort_order,
      COALESCE((SELECT SUM(c.total_qty-c.defect_qty) FROM cutting_log c WHERE c.batch_id=b.id AND c.voided_at IS NULL),0)::int
      - COALESCE((SELECT SUM(s.good_qty+s.defect_qty) FROM sewing_log s WHERE s.batch_id=b.id AND s.operation_id=mo.id AND s.voided_at IS NULL),0)::int AS remaining
    FROM batches b JOIN model_operations mo ON mo.model_id=b.model_id
    WHERE b.id=$1 AND b.status='active' AND mo.active=true ORDER BY mo.sort_order,mo.name`, [req.params.id]);
  res.json(result.rows);
});

app.get('/api/batches/:batchId/operations/:operationId/sizes', auth, async (req, res) => {
  const result = await query(`
    SELECT c.size,
      SUM(c.total_qty-c.defect_qty)::int - COALESCE((SELECT SUM(s.good_qty+s.defect_qty) FROM sewing_log s WHERE s.batch_id=c.batch_id AND s.operation_id=$2 AND s.size=c.size AND s.voided_at IS NULL),0)::int AS remaining
    FROM cutting_log c WHERE c.batch_id=$1 AND c.voided_at IS NULL
    GROUP BY c.batch_id,c.size ORDER BY c.size`, [req.params.batchId, req.params.operationId]);
  res.json(result.rows.filter(r => r.remaining > 0));
});

app.post('/api/cutting', auth, roles('cutter','controller','admin'), async (req, res) => {
  const batchId = positiveInt(req.body.batchId), size = positiveInt(req.body.size), total = positiveInt(req.body.totalQty), defect = positiveInt(req.body.defectQty, true);
  if ([batchId,size,total,defect].includes(null) || defect > total) return res.status(400).json({ error: 'Проверьте количество и брак' });
  const result = await transaction(async client => {
    const rate = await client.query(`SELECT r.price FROM rates r JOIN batches b ON b.model_id=r.model_id WHERE b.id=$1 AND r.role='cutter' AND r.operation_id IS NULL AND $2 BETWEEN r.min_size AND r.max_size AND MOD($2-r.min_size,6)=0 ORDER BY r.id DESC LIMIT 1`, [batchId,size]);
    if (!rate.rows[0]) throw Object.assign(new Error('Для модели и размера не найдена ставка кройщика'), { status: 400 });
    const row = await client.query(`INSERT INTO cutting_log(employee_id,batch_id,size,total_qty,defect_qty,rate) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [req.user.id,batchId,size,total,defect,rate.rows[0].price]);
    await client.query(`INSERT INTO audit_log(employee_id,action,entity_type,entity_id,details) VALUES($1,'create','cutting_log',$2,$3)`, [req.user.id,row.rows[0].id,JSON.stringify(req.body)]);
    return row.rows[0];
  });
  res.json({ ok: true, id: result.id });
});

app.post('/api/sewing', auth, roles('seamstress','controller','admin'), async (req, res) => {
  const batchId=positiveInt(req.body.batchId), operationId=positiveInt(req.body.operationId), size=positiveInt(req.body.size), good=positiveInt(req.body.goodQty,true), defect=positiveInt(req.body.defectQty,true);
  if ([batchId,operationId,size,good,defect].includes(null) || good+defect < 1) return res.status(400).json({ error: 'Введите сделанное количество или брак' });
  const result = await transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${batchId}:${operationId}:${size}`]);
    const available = await client.query(`SELECT
      COALESCE((SELECT SUM(total_qty-defect_qty) FROM cutting_log WHERE batch_id=$1 AND size=$3 AND voided_at IS NULL),0)::int
      - COALESCE((SELECT SUM(good_qty+defect_qty) FROM sewing_log WHERE batch_id=$1 AND operation_id=$2 AND size=$3 AND voided_at IS NULL),0)::int AS remaining`, [batchId,operationId,size]);
    if (good+defect > available.rows[0].remaining) throw Object.assign(new Error(`Доступно только ${available.rows[0].remaining} шт.`), { status: 409 });
    const rate = await client.query(`SELECT r.price FROM rates r JOIN batches b ON b.model_id=r.model_id WHERE b.id=$1 AND r.role='seamstress' AND r.operation_id=$2 AND $3 BETWEEN r.min_size AND r.max_size ORDER BY r.id DESC LIMIT 1`, [batchId,operationId,size]);
    if (!rate.rows[0]) throw Object.assign(new Error('Для операции и размера не найдена ставка'), { status: 400 });
    const row = await client.query(`INSERT INTO sewing_log(employee_id,batch_id,operation_id,size,good_qty,defect_qty,rate) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [req.user.id,batchId,operationId,size,good,defect,rate.rows[0].price]);
    await client.query(`INSERT INTO audit_log(employee_id,action,entity_type,entity_id,details) VALUES($1,'create','sewing_log',$2,$3)`, [req.user.id,row.rows[0].id,JSON.stringify(req.body)]);
    return row.rows[0];
  });
  res.json({ ok: true, id: result.id });
});

app.get('/api/report', auth, roles('controller','owner','admin'), async (_req, res) => {
  const period = await query(`WITH clock AS (
    SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Yekaterinburg')::date AS today
  ) SELECT to_char(today,'YYYY-MM-DD') today,
    CASE WHEN EXTRACT(DAY FROM today) BETWEEN 11 AND 25 THEN date_trunc('month',today)::date + 10
      WHEN EXTRACT(DAY FROM today) >= 26 THEN date_trunc('month',today)::date + 25
      ELSE (date_trunc('month',today)::date - INTERVAL '1 month')::date + 25 END AS period_start_raw,
    CASE WHEN EXTRACT(DAY FROM today) BETWEEN 11 AND 25 THEN date_trunc('month',today)::date + 24
      WHEN EXTRACT(DAY FROM today) >= 26 THEN (date_trunc('month',today)::date + INTERVAL '1 month')::date + 9
      ELSE date_trunc('month',today)::date + 9 END AS period_end_raw
    FROM clock`);
  const rawDates = period.rows[0];
  const dates = {
    today: rawDates.today,
    period_start: rawDates.period_start_raw,
    period_end: rawDates.period_end_raw
  };
  const employees = await query(`
    WITH work AS (
      SELECT e.id,e.name,c.work_date,c.total_qty-c.defect_qty good,c.defect_qty,(c.total_qty-c.defect_qty)*c.rate amount FROM cutting_log c JOIN employees e ON e.id=c.employee_id WHERE c.voided_at IS NULL AND c.is_opening=false
      UNION ALL
      SELECT e.id,e.name,s.work_date,s.good_qty,s.defect_qty,s.good_qty*s.rate FROM sewing_log s JOIN employees e ON e.id=s.employee_id WHERE s.voided_at IS NULL AND s.is_opening=false
    ) SELECT id,name,COALESCE(SUM(good),0)::int good,COALESCE(SUM(defect_qty),0)::int defect,COALESCE(SUM(amount),0)::numeric amount
      FROM work WHERE work_date BETWEEN $1 AND $2 GROUP BY id,name ORDER BY name`,[dates.period_start,dates.today]);
  const batches = await query(`SELECT b.id,m.name model,b.color,
    COALESCE(SUM(c.total_qty-c.defect_qty),0)::int good_cut,
    COALESCE((SELECT SUM(s.defect_qty) FROM sewing_log s WHERE s.batch_id=b.id AND s.voided_at IS NULL),0)::int sewing_defect
    FROM batches b JOIN models m ON m.id=b.model_id LEFT JOIN cutting_log c ON c.batch_id=b.id AND c.voided_at IS NULL WHERE b.status='active' GROUP BY b.id,m.name,b.color ORDER BY b.id DESC`);
  res.json({ employees: employees.rows, batches: batches.rows, ...dates });
});

app.get('/api/report.xlsx', auth, roles('controller','owner','admin'), async (req, res) => {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || '')) ? req.query.from : new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0,10);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || '')) ? req.query.to : new Date().toISOString().slice(0,10);
  const [summary, sewing, cutting, balances] = await Promise.all([
    query(`WITH work AS (
      SELECT e.name employee,c.work_date,c.total_qty-c.defect_qty good,c.defect_qty,(c.total_qty-c.defect_qty)*c.rate amount FROM cutting_log c JOIN employees e ON e.id=c.employee_id WHERE c.voided_at IS NULL AND c.is_opening=false AND c.work_date BETWEEN $1 AND $2
      UNION ALL SELECT e.name,s.work_date,s.good_qty,s.defect_qty,s.good_qty*s.rate FROM sewing_log s JOIN employees e ON e.id=s.employee_id WHERE s.voided_at IS NULL AND s.is_opening=false AND s.work_date BETWEEN $1 AND $2
    ) SELECT employee,SUM(good)::int good,SUM(defect_qty)::int defect,SUM(amount)::numeric amount FROM work GROUP BY employee ORDER BY employee`,[from,to]),
    query(`SELECT s.work_date,e.name employee,b.id batch,m.name model,s.size,mo.name operation,s.good_qty,s.defect_qty,s.rate,(s.good_qty*s.rate)::numeric amount
      FROM sewing_log s JOIN employees e ON e.id=s.employee_id JOIN batches b ON b.id=s.batch_id JOIN models m ON m.id=b.model_id JOIN model_operations mo ON mo.id=s.operation_id
      WHERE s.voided_at IS NULL AND s.is_opening=false AND s.work_date BETWEEN $1 AND $2 ORDER BY s.work_date,e.name,s.id`,[from,to]),
    query(`SELECT c.work_date,e.name employee,b.id batch,m.name model,c.size,c.total_qty,c.defect_qty,(c.total_qty-c.defect_qty)::int good,c.rate,((c.total_qty-c.defect_qty)*c.rate)::numeric amount
      FROM cutting_log c JOIN employees e ON e.id=c.employee_id JOIN batches b ON b.id=c.batch_id JOIN models m ON m.id=b.model_id
      WHERE c.voided_at IS NULL AND c.is_opening=false AND c.work_date BETWEEN $1 AND $2 ORDER BY c.work_date,e.name,c.id`,[from,to]),
    query(`SELECT b.id batch,m.name model,b.color,mo.name operation,x.size,x.good_cut,
      (x.good_cut-COALESCE(y.used,0))::int remaining,COALESCE(y.defect,0)::int defect
      FROM batches b JOIN models m ON m.id=b.model_id JOIN model_operations mo ON mo.model_id=b.model_id
      JOIN LATERAL (SELECT c.size,SUM(c.total_qty-c.defect_qty)::int good_cut FROM cutting_log c WHERE c.batch_id=b.id AND c.voided_at IS NULL GROUP BY c.size) x ON true
      LEFT JOIN LATERAL (SELECT SUM(s.good_qty+s.defect_qty)::int used,SUM(s.defect_qty)::int defect FROM sewing_log s WHERE s.batch_id=b.id AND s.operation_id=mo.id AND s.size=x.size AND s.voided_at IS NULL) y ON true
      WHERE b.status='active' ORDER BY b.id,mo.sort_order,x.size`)
  ]);
  const wb = new ExcelJS.Workbook(); wb.creator='Швейный цех'; wb.created=new Date();
  const add=(name,columns,rows)=>{const ws=wb.addWorksheet(name,{views:[{state:'frozen',ySplit:1}]});ws.columns=columns.map(c=>({header:c[0],key:c[1],width:c[2]||18}));ws.addRows(rows);ws.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};ws.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF604BD8'}};ws.autoFilter={from:'A1',to:ws.getCell(1,columns.length).address};ws.eachRow((r,n)=>{if(n>1&&n%2===0)r.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF3F1FB'}}});return ws};
  const s1=add('Итоги',[['Сотрудник','employee',24],['Годных деталей','good'],['Брак','defect'],['Заработано, ₽','amount']],summary.rows);s1.getColumn('amount').numFmt='#,##0.00';
  const s2=add('Работа швей',[['Дата','work_date'],['Сотрудница','employee',22],['Партия','batch'],['Модель','model',24],['Размер','size'],['Операция','operation',32],['Сделано','good_qty'],['Брак','defect_qty'],['Ставка, ₽','rate'],['Сумма, ₽','amount']],sewing.rows);s2.getColumn('work_date').numFmt='dd.mm.yyyy';s2.getColumn('rate').numFmt=s2.getColumn('amount').numFmt='#,##0.00';
  const s3=add('Работа кройщиков',[['Дата','work_date'],['Сотрудник','employee',22],['Партия','batch'],['Модель','model',24],['Размер','size'],['Скроено','total_qty'],['Брак','defect_qty'],['Годных','good'],['Ставка, ₽','rate'],['Сумма, ₽','amount']],cutting.rows);s3.getColumn('work_date').numFmt='dd.mm.yyyy';s3.getColumn('rate').numFmt=s3.getColumn('amount').numFmt='#,##0.00';
  add('Остатки',[['Партия','batch'],['Модель','model',24],['Расцветка','color',22],['Операция','operation',32],['Размер','size'],['Годный крой','good_cut'],['Остаток','remaining'],['Брак','defect']],balances.rows);
  const buffer=await wb.xlsx.writeBuffer();
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',`attachment; filename="sewing-report-${from}-${to}.xlsx"`);
  res.send(Buffer.from(buffer));
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Не найдено' }));
app.use((err, _req, res, _next) => { console.error(err); res.status(err.status || 500).json({ error: err.status ? err.message : 'Ошибка сервера' }); });
app.get('*splat', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

await initializeDatabase();
app.listen(PORT, '0.0.0.0', () => console.log(`Server started on ${PORT}`));
