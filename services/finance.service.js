const {z} = require('zod');
const {randomUUID} = require('node:crypto');
const db = require('../lib/db');
const values = require('./finance-values');
const fail = (status,message) => Object.assign(new Error(message),{status});
const parse = (schema,input) => {const r=schema.safeParse(input);if(!r.success)throw fail(400,r.error.issues[0].message);return r.data;};
const date = z.string().refine(values.validDate,'Usa una fecha válida entre 1900 y 2199.');
const month = z.string().refine(values.validMonth,'Selecciona un mes válido.');
const revision = z.number().int().positive().max(2147483646);
const idSchema = z.string().uuid('Identificador inválido.');
const reason = z.string().trim().min(1,'Escribe el motivo.').max(200,'El motivo puede tener hasta 200 caracteres.');
const notes = z.string().trim().max(2000).default('');
const amount = z.string().max(16).transform(value=>values.cents(value).toString());
const movementFields = {kind:z.enum(['income','expense']),date,amount,reason,notes};
const fixedFields = {reason,notes,amount,dueDay:z.number().int().min(1).max(31),startMonth:month,endMonth:month.nullable().default(null),isActive:z.boolean().default(true)};
const paging = {page:z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().max(100000)).default(0),size:z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(50)).default(20)};
const accountColumns = `organization_id AS "organizationId", currency, to_char(opening_date,'YYYY-MM-DD') AS "openingDate", opening_balance_cents::text AS "openingCents", revision`;
const movementColumns = `id, kind, to_char(movement_date,'YYYY-MM-DD') AS date, amount_cents::text AS "amountCents", reason, notes, fixed_expense_id AS "fixedExpenseId", to_char(fixed_month,'YYYY-MM') AS "fixedMonth", revision, voided_at AS "voidedAt", void_reason AS "voidReason"`;
const fixedColumns = `id,reason,notes,amount_cents::text AS "amountCents",due_day AS "dueDay",to_char(start_month,'YYYY-MM') AS "startMonth",to_char(end_month,'YYYY-MM') AS "endMonth",is_active AS "isActive",revision`;
const accountView = a => a?{currency:a.currency,openingDate:a.openingDate,openingBalance:values.money(a.openingCents),revision:a.revision}:null;
const moneyView = row => {const {amountCents,...rest}=row;return {...rest,amount:values.money(amountCents)};};
function selectedMonth(value){if(value>values.today().slice(0,7))throw fail(400,'Elige el mes actual o uno anterior.');return value;}
function actualDate(value,account){if(value>values.today())throw fail(400,'Registra el movimiento cuando ocurra; no puede tener una fecha futura.');if(value<account.openingDate)throw fail(400,'La fecha no puede ser anterior a tu saldo inicial.');}
async function account(client,org,lock=false){return (await client.query(`SELECT ${accountColumns} FROM finance_accounts WHERE organization_id=$1${lock?' FOR UPDATE':''}`,[org])).rows[0];}
async function audit(client,org,actor,action,id,before,after){await client.query('INSERT INTO finance_audit (organization_id,actor_id,action,entity_id,previous_value,next_value) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)',[org,actor||null,action,id,JSON.stringify(before),JSON.stringify(after)]);}
// Serialize money-changing operations within one organization, not across stores.
async function write(org,actor,action,entityId,change){return db.transaction(async client=>{
 const a=await account(client,org,true);if(!a)throw fail(409,'Primero configura tu saldo inicial.');
 const {before=null,after,result}=await change(client,a);
 if(after!==undefined)await audit(client,org,actor,action,entityId,before,after);
 return result;
});}
async function existingMovement(client,org,id){return (await client.query(`SELECT ${movementColumns} FROM finance_movements WHERE id=$1 AND organization_id=$2`,[id,org])).rows[0];}
function sameRevision(row,rev){if(!row)throw fail(404,'Registro no encontrado.');if(row.revision!==rev)throw fail(409,'El registro cambió en otra sesión. Actualiza antes de guardar.');}

exports.saveAccount = async(org,actor,input)=>{
 const v=parse(z.object({openingDate:date,openingBalance:z.string().max(16),revision:z.number().int().min(0).max(2147483646)}).strict(),input);
 const cents=values.cents(v.openingBalance,true).toString();if(v.openingDate>values.today())throw fail(400,'La fecha del saldo inicial no puede ser futura.');
 return db.transaction(async client=>{
  const created=await client.query(`INSERT INTO finance_accounts (organization_id,opening_date,opening_balance_cents) VALUES ($1,$2,$3) ON CONFLICT (organization_id) DO NOTHING RETURNING organization_id`,[org,v.openingDate,cents]);
  const a=await account(client,org,true);
  if(v.revision===0){
   if(a.openingDate!==v.openingDate||a.openingCents!==cents)throw fail(409,'Ya existe un saldo inicial. Actualiza la pantalla.');
   if(created.rows.length)await audit(client,org,actor,'opening_balance',org,null,accountView(a));
   return accountView(a);
  }
  if(created.rows.length)throw fail(409,'La configuración cambió. Actualiza la pantalla.');
  sameRevision(a,v.revision);
  const earlier=await client.query('SELECT id FROM finance_movements WHERE organization_id=$1 AND voided_at IS NULL AND movement_date<$2::date LIMIT 1',[org,v.openingDate]);
  if(earlier.rows.length)throw fail(400,'Hay movimientos anteriores a esa fecha. No se puede dejarlos fuera del saldo.');
  const saved=(await client.query(`UPDATE finance_accounts SET opening_date=$2,opening_balance_cents=$3,revision=revision+1,updated_at=now() WHERE organization_id=$1 RETURNING ${accountColumns}`,[org,v.openingDate,cents])).rows[0];
  await audit(client,org,actor,'opening_balance',org,accountView(a),accountView(saved));
  return accountView(saved);
 });
};

exports.summary = async(org,input)=>{
 const v=parse(z.object({month}).strict(),input),m=selectedMonth(v.month),start=`${m}-01`,end=values.nextMonth(m);
 return db.transaction(async client=>{
  await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const a=await account(client,org);if(!a)return {month:m,account:null,totals:null,fixed:[]};
  const totals=(await client.query(`SELECT
   COALESCE(sum(CASE WHEN kind='income' THEN amount_cents ELSE -amount_cents END) FILTER (WHERE movement_date<$2::date),0)::text AS before,
   COALESCE(sum(amount_cents) FILTER (WHERE movement_date >= $2::date AND kind='income'),0)::text AS income,
   COALESCE(sum(amount_cents) FILTER (WHERE movement_date >= $2::date AND kind='expense'),0)::text AS expense,
   count(*) FILTER (WHERE movement_date >= $2::date)::int AS count
   FROM finance_movements WHERE organization_id=$1 AND voided_at IS NULL AND movement_date >= $4::date AND movement_date < $3::date`,[org,start,end,a.openingDate])).rows[0];
  const rows=(await client.query(`SELECT f.id,f.reason,f.notes,f.amount_cents::text AS "amountCents",f.due_day AS "dueDay",f.revision,
    p.id AS "paymentId",to_char(p.movement_date,'YYYY-MM-DD') AS "paidOn",p.amount_cents::text AS "paidCents",p.reason AS "paidReason"
   FROM finance_fixed_expenses f LEFT JOIN finance_movements p ON p.organization_id=f.organization_id AND p.fixed_expense_id=f.id AND p.fixed_month=$2::date AND p.voided_at IS NULL
   WHERE f.organization_id=$1 AND ((f.is_active AND f.start_month <= $2::date AND (f.end_month IS NULL OR f.end_month >= $2::date)) OR p.id IS NOT NULL)
   ORDER BY f.due_day,f.created_at,f.id`,[org,start])).rows;
  let pending=0n;
  const fixed=rows.map(row=>{
   const status=row.paymentId?(row.paidOn<end?'paid':'paid_later'):'pending';
   const amountCents=row.paymentId?row.paidCents:row.amountCents;
   if(status!=='paid')pending+=BigInt(amountCents);
   return {id:row.id,reason:row.paymentId?row.paidReason:row.reason,notes:row.notes,amount:values.money(amountCents),dueDate:values.dueDate(m,row.dueDay),revision:row.revision,status,paymentId:row.paymentId,paidOn:row.paidOn};
  });
  const beforeOpening=end<=a.openingDate;
  return {month:m,account:accountView(a),totals:values.balances({opening:beforeOpening?0:a.openingCents,...totals,pending:beforeOpening?0:pending}),count:totals.count,fixed:beforeOpening?[]:fixed,beforeOpening};
 });
};

exports.movements = async(org,input)=>{
 const v=parse(z.object({month,kind:z.enum(['all','income','expense']).default('all'),status:z.enum(['active','all','voided']).default('active'),q:z.string().trim().max(120).default(''),...paging}).strict(),input);selectedMonth(v.month);
 const q=v.q.replace(/[\\%_]/g,'\\$&'),args=[org,`${v.month}-01`,values.nextMonth(v.month),v.kind==='all'?null:v.kind,v.status,`%${q}%`];
 const where=`organization_id=$1 AND movement_date >= $2::date AND movement_date < $3::date AND ($4::text IS NULL OR kind=$4) AND ($5='all' OR ($5='active' AND voided_at IS NULL) OR ($5='voided' AND voided_at IS NOT NULL)) AND reason ILIKE $6 ESCAPE '\\'`;
 const [items,count]=await Promise.all([db.query(`SELECT ${movementColumns} FROM finance_movements WHERE ${where} ORDER BY movement_date DESC,created_at DESC,id LIMIT $7 OFFSET $8`,[...args,v.size,v.page*v.size]),db.query(`SELECT count(*)::int AS total FROM finance_movements WHERE ${where}`,args)]);
 return {items:items.rows.map(moneyView),total:count.rows[0].total,page:v.page,size:v.size};
};
exports.createMovement = async(org,actor,input)=>{
 const v=parse(z.object({id:idSchema,...movementFields}).strict(),input);
 return write(org,actor,'movement_created',v.id,async(client,a)=>{
  actualDate(v.date,a);const existing=await existingMovement(client,org,v.id);
  if(existing){if(!existing.voidedAt&&!existing.fixedExpenseId&&existing.kind===v.kind&&existing.date===v.date&&existing.amountCents===v.amount&&existing.reason===v.reason&&existing.notes===v.notes)return {result:moneyView(existing)};throw fail(409,'Ese envío ya se registró con otros datos. Cierra y abre un movimiento nuevo.');}
  const row=(await client.query(`INSERT INTO finance_movements (id,organization_id,kind,movement_date,amount_cents,reason,notes) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING RETURNING ${movementColumns}`,[v.id,org,v.kind,v.date,v.amount,v.reason,v.notes])).rows[0];
  if(!row)throw fail(409,'No se pudo registrar el movimiento. Abre uno nuevo e inténtalo otra vez.');
  return {after:moneyView(row),result:moneyView(row)};
 });
};
exports.updateMovement = async(org,actor,rawId,input)=>{
 const id=parse(idSchema,rawId),v=parse(z.object({...movementFields,revision}).strict(),input);
 return write(org,actor,'movement_updated',id,async(client,a)=>{
  actualDate(v.date,a);const old=await existingMovement(client,org,id);sameRevision(old,v.revision);
  if(old.voidedAt||old.fixedExpenseId)throw fail(409,'Un pago fijo o movimiento anulado no se edita. Anula el pago y registra la corrección.');
  const row=(await client.query(`UPDATE finance_movements SET kind=$3,movement_date=$4,amount_cents=$5,reason=$6,notes=$7,revision=revision+1,updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING ${movementColumns}`,[id,org,v.kind,v.date,v.amount,v.reason,v.notes])).rows[0];
  return {before:moneyView(old),after:moneyView(row),result:moneyView(row)};
 });
};
exports.voidMovement = async(org,actor,rawId,input)=>{
 const id=parse(idSchema,rawId),v=parse(z.object({revision,reason:z.string().trim().min(1,'Indica por qué anulas el movimiento.').max(500)}).strict(),input);
 return write(org,actor,'movement_voided',id,async client=>{
  const old=await existingMovement(client,org,id);if(old?.voidedAt)return {result:moneyView(old)};sameRevision(old,v.revision);
  const row=(await client.query(`UPDATE finance_movements SET voided_at=now(),void_reason=$3,revision=revision+1,updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING ${movementColumns}`,[id,org,v.reason])).rows[0];
  return {before:moneyView(old),after:moneyView(row),result:moneyView(row)};
 });
};
exports.fixedExpenses = async(org,input)=>{
 const v=parse(z.object({...paging}).strict(),input);
 const [items,count]=await Promise.all([db.query(`SELECT ${fixedColumns} FROM finance_fixed_expenses WHERE organization_id=$1 ORDER BY is_active DESC,created_at DESC,id LIMIT $2 OFFSET $3`,[org,v.size,v.page*v.size]),db.query('SELECT count(*)::int AS total FROM finance_fixed_expenses WHERE organization_id=$1',[org])]);
 return {items:items.rows.map(moneyView),total:count.rows[0].total,page:v.page,size:v.size};
};
exports.saveFixedExpense = async(org,actor,rawId,input)=>{
 const v=parse(z.object({...fixedFields,...(rawId?{revision}:{id:idSchema})}).strict(),input),id=rawId?parse(idSchema,rawId):v.id;
 if(v.endMonth&&v.endMonth<v.startMonth)throw fail(400,'El mes final debe ser igual o posterior al inicial.');
 return write(org,actor,rawId?'fixed_updated':'fixed_created',id,async(client,a)=>{
  if(v.startMonth<a.openingDate.slice(0,7))throw fail(400,'El gasto no puede comenzar antes de tu saldo inicial.');
  const old=(await client.query(`SELECT ${fixedColumns} FROM finance_fixed_expenses WHERE id=$1 AND organization_id=$2`,[id,org])).rows[0]||null;
  if(rawId)sameRevision(old,v.revision);
  else if(old){
   if(old.reason===v.reason&&old.notes===v.notes&&old.amountCents===v.amount&&old.dueDay===v.dueDay&&old.startMonth===v.startMonth&&old.endMonth===v.endMonth&&old.isActive===v.isActive)return {result:moneyView(old)};
   throw fail(409,'Ese gasto fijo ya se registró con otros datos. Abre uno nuevo.');
  }
  if(v.isActive&&!old?.isActive){const count=await client.query('SELECT count(*)::int AS count FROM finance_fixed_expenses WHERE organization_id=$1 AND is_active',[org]);if(count.rows[0].count>=100)throw fail(400,'Puedes tener hasta 100 gastos fijos activos. Desactiva los que ya no uses.');}
  const args=[id,org,v.reason,v.notes,v.amount,v.dueDay,`${v.startMonth}-01`,v.endMonth?`${v.endMonth}-01`:null,v.isActive];
  const row=(await client.query(rawId?`UPDATE finance_fixed_expenses SET reason=$3,notes=$4,amount_cents=$5,due_day=$6,start_month=$7,end_month=$8,is_active=$9,revision=revision+1,updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING ${fixedColumns}`:`INSERT INTO finance_fixed_expenses (id,organization_id,reason,notes,amount_cents,due_day,start_month,end_month,is_active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING RETURNING ${fixedColumns}`,args)).rows[0];
  if(!row)throw fail(409,'No se pudo guardar ese gasto fijo. Abre uno nuevo.');
  return {before:old?moneyView(old):null,after:moneyView(row),result:moneyView(row)};
 });
};
exports.payFixedExpense = async(org,actor,rawId,input)=>{
 const id=parse(idSchema,rawId),v=parse(z.object({month,paidOn:date,revision}).strict(),input);selectedMonth(v.month);
 return write(org,actor,'fixed_paid',id,async(client,a)=>{
  actualDate(v.paidOn,a);
  const existing=(await client.query(`SELECT ${movementColumns} FROM finance_movements WHERE organization_id=$1 AND fixed_expense_id=$2 AND fixed_month=$3::date AND voided_at IS NULL`,[org,id,`${v.month}-01`])).rows[0];
  if(existing)return {result:moneyView(existing)};
  const f=(await client.query(`SELECT ${fixedColumns} FROM finance_fixed_expenses WHERE id=$1 AND organization_id=$2`,[id,org])).rows[0];sameRevision(f,v.revision);
  if(!f.isActive||v.month<f.startMonth||(f.endMonth&&v.month>f.endMonth)||v.month<a.openingDate.slice(0,7))throw fail(400,'Este gasto fijo no está programado para ese mes.');
  const row=(await client.query(`INSERT INTO finance_movements (id,organization_id,kind,movement_date,amount_cents,reason,notes,fixed_expense_id,fixed_month) VALUES ($1,$2,'expense',$3,$4,$5,$6,$7,$8) RETURNING ${movementColumns}`,[randomUUID(),org,v.paidOn,f.amountCents,f.reason,f.notes,id,`${v.month}-01`])).rows[0];
  return {after:moneyView(row),result:moneyView(row)};
 });
};
