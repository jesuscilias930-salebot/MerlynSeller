const test=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const db=require('../lib/db');
const finance=require('../services/finance.service');
const values=require('../services/finance-values');
const id='11111111-1111-4111-8111-111111111111',fixedId='22222222-2222-4222-8222-222222222222';
const org='org-a',actor='actor-a';
const account={organizationId:org,currency:'MXN',openingDate:'2026-09-01',openingCents:'100000',revision:1};
const entry={id,kind:'income',date:'2026-10-10',amount:'0.30',reason:'  Motivo de prueba  ',notes:''};
const row={id,kind:'income',date:entry.date,amountCents:'30',reason:'Motivo de prueba',notes:'',fixedExpenseId:null,fixedMonth:null,revision:1,voidedAt:null,voidReason:''};
const fixed={id:fixedId,reason:'Servicio de prueba',notes:'',amountCents:'25000',dueDay:31,startMonth:'2026-09',endMonth:null,isActive:true,revision:1};
async function mockWrite(query,run){const original=db.transaction;db.transaction=cb=>cb({query});try{return await run();}finally{db.transaction=original;}}
test('cents remain exact; monthly carry, negative balances and fixed forecasts are separate',()=>{
 assert.equal(values.cents('0.10')+values.cents('0.20'),30n);assert.equal(values.cents('-0.01',true),-1n);assert.equal(values.cents('0',true),0n);
 assert.equal(values.money(-1n),'-0.01');assert.equal(values.money(100000000000000001n),'1000000000000000.01');
 assert.deepEqual(values.balances({opening:'100000',before:'-10000',income:'30000',expense:'20000',pending:'40000'}),{openingBalance:'900.00',income:'300.00',expense:'200.00',balance:'1000.00',pendingFixed:'400.00',afterFixed:'600.00'});
 assert.equal(values.balances({opening:0,expense:1}).balance,'-0.01');
 for(const input of ['1.001','-1','0','1e3','1,000.00',1,null,'Infinity'])assert.throws(()=>values.cents(input),{status:400});
});
test('monthly due days clamp at month end and calendar dates are validated',()=>{
 assert.equal(values.dueDate('2026-02',31),'2026-02-28');assert.equal(values.dueDate('2028-02',31),'2028-02-29');
 assert.equal(values.dueDate('2026-04',31),'2026-04-30');assert.equal(values.nextMonth('2026-12'),'2027-01-01');
 assert.equal(values.validDate('2026-02-29'),false);assert.equal(values.validDate('2028-02-29'),true);assert.equal(values.validMonth('2026-13'),false);
 assert.match(values.today(),/^\d{4}-\d{2}-\d{2}$/);
});
test('invalid records, dates, arbitrary tenant IDs and unbounded pages cannot touch storage',async()=>{
 const old=db.transaction,oldQuery=db.query;db.transaction=db.query=async()=>{throw Error('Unexpected database access');};
 try{
  for(const input of [{...entry,amount:'1.001'},{...entry,reason:' '},{...entry,organizationId:'foreign'},{...entry,date:'2026-02-29'},{...entry,kind:'transfer'},{...entry,id:'bad'}])await assert.rejects(finance.createMovement(org,actor,input),{status:400});
  for(const input of [{month:'2026-13'},{month:'2026-10',size:'51'},{month:'2026-10',page:'-1'},{month:'2026-10',q:'a'.repeat(121)},{month:'2026-10',organizationId:'foreign'}])await assert.rejects(finance.movements(org,input),{status:400});
  await assert.rejects(finance.summary(org,{month:'2199-01'}),{status:400});
 }finally{db.transaction=old;db.query=oldQuery;}
});
test('monthly summary is a consistent read-only snapshot and never resets carried cash',async()=>{
 const queries=[];
 await mockWrite(async(sql,args)=>{
  queries.push(sql);if(sql.startsWith('SET'))return {rows:[]};assert.equal(args[0],org);
  if(sql.includes('FROM finance_accounts'))return {rows:[account]};
  if(sql.includes('FROM finance_movements')){assert.match(sql,/movement_date >= \$4::date/);assert.match(sql,/voided_at IS NULL/);assert.deepEqual(args,[org,'2026-10-01','2026-11-01',account.openingDate]);return {rows:[{before:'-10000',income:'30000',expense:'20000',count:2}]};}
  assert.match(sql,/p.organization_id=f.organization_id/);
  return {rows:[{...fixed,paymentId:null,paidOn:null,paidCents:null},{...fixed,id:'paid',paymentId:id,paidOn:'2026-10-01',paidCents:'1000',paidReason:'Importe histórico'},{...fixed,id:'later',paymentId:'later-payment',paidOn:'2026-11-02',paidCents:'5000',paidReason:'Pago posterior'}]};
 },async()=>{
  const summary=await finance.summary(org,{month:'2026-10'});
  assert.equal(summary.totals.openingBalance,'900.00');assert.equal(summary.totals.balance,'1000.00');assert.equal(summary.totals.pendingFixed,'300.00');assert.equal(summary.totals.afterFixed,'700.00');
  assert.equal(summary.fixed[1].amount,'10.00');assert.equal(summary.fixed[1].reason,'Importe histórico');assert.equal(summary.fixed[2].status,'paid_later');
 });
 assert.equal(queries[0],'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');assert.equal(queries.some(q=>/^INSERT|^UPDATE/.test(q)),false);
});
test('unconfigured funds are unknown, not a manufactured zero balance',async()=>{
 await mockWrite(async()=>({rows:[]}),async()=>{
  assert.deepEqual(await finance.summary(org,{month:'2026-10'}),{month:'2026-10',account:null,totals:null,fixed:[]});
  await assert.rejects(finance.createMovement(org,actor,entry),{status:409});
 });
});
test('movement creates exact cents, a scoped account lock and audit in the same transaction',async()=>{
 let inserts=0,audits=0;
 await mockWrite(async(sql,args)=>{
  if(sql.includes('FROM finance_accounts')){assert.match(sql,/organization_id=\$1 FOR UPDATE/);return {rows:[account]};}
  if(sql.startsWith('SELECT')){assert.deepEqual(args,[id,org]);return {rows:[]};}
  if(sql.startsWith('INSERT INTO finance_movements')){inserts++;assert.deepEqual(args,[id,org,'income','2026-10-10','30','Motivo de prueba','']);return {rows:[row]};}
  assert.match(sql,/INSERT INTO finance_audit/);assert.deepEqual(args.slice(0,4),[org,actor,'movement_created',id]);audits++;return {rows:[]};
 },async()=>assert.equal((await finance.createMovement(org,actor,entry)).amount,'0.30'));
 assert.equal(inserts,1);assert.equal(audits,1);
});
test('identical network retries do not duplicate income; changed payloads conflict',async()=>{
 await mockWrite(async sql=>{
  if(sql.includes('FROM finance_accounts'))return {rows:[account]};
  if(sql.startsWith('SELECT'))return {rows:[row]};
  throw Error('Retry must not write');
 },async()=>{
  assert.equal((await finance.createMovement(org,actor,entry)).id,id);
  await assert.rejects(finance.createMovement(org,actor,{...entry,amount:'1.00'}),{status:409});
 });
});
test('future, pre-opening, foreign and stale updates cannot change money',async()=>{
 await mockWrite(async sql=>sql.includes('finance_accounts')?{rows:[account]}:{rows:[]},async()=>{
  await assert.rejects(finance.createMovement(org,actor,{...entry,date:'2199-01-01'}),{status:400});
  await assert.rejects(finance.createMovement(org,actor,{...entry,date:'2026-08-01'}),{status:400});
  const {id:_,...body}=entry;await assert.rejects(finance.updateMovement(org,actor,id,{...body,revision:1}),{status:404});
 });
 await mockWrite(async sql=>sql.includes('finance_accounts')?{rows:[account]}:{rows:[row]},async()=>{const {id:_,...body}=entry;await assert.rejects(finance.updateMovement(org,actor,id,{...body,revision:2}),{status:409});});
});
test('a fixed payment creates one expense snapshot; repeated payment is idempotent',async()=>{
 let saved=null;
 await mockWrite(async(sql,args)=>{
  if(sql.includes('FROM finance_accounts'))return {rows:[account]};
  if(sql.includes('FROM finance_movements')){assert.deepEqual(args,[org,fixedId,'2026-10-01']);return {rows:saved?[saved]:[]};}
  if(sql.includes('FROM finance_fixed_expenses')){assert.deepEqual(args,[fixedId,org]);return {rows:[fixed]};}
  if(sql.startsWith('INSERT INTO finance_movements')){assert.match(sql,/'expense'/);assert.deepEqual(args.slice(1),[org,'2026-10-12','25000',fixed.reason,fixed.notes,fixedId,'2026-10-01']);saved={...row,kind:'expense',amountCents:'25000',fixedExpenseId:fixedId,fixedMonth:'2026-10'};return {rows:[saved]};}
  assert.match(sql,/INSERT INTO finance_audit/);return {rows:[]};
 },async()=>{
  const first=await finance.payFixedExpense(org,actor,fixedId,{month:'2026-10',paidOn:'2026-10-12',revision:1});
  const retry=await finance.payFixedExpense(org,actor,fixedId,{month:'2026-10',paidOn:'2026-10-12',revision:1});
  assert.equal(first.id,retry.id);assert.equal(first.amount,'250.00');
 });
});
test('voiding retains the entry and reason; cannot edit a recurring payment or voided entry',async()=>{
 let updated=false;
 await mockWrite(async(sql,args)=>{
  if(sql.includes('FROM finance_accounts'))return {rows:[account]};
  if(sql.startsWith('SELECT'))return {rows:[row]};
  if(sql.startsWith('UPDATE')){assert.match(sql,/voided_at=now\(\)/);assert.deepEqual(args,[id,org,'Duplicado']);updated=true;return {rows:[{...row,voidedAt:'now',voidReason:'Duplicado',revision:2}]};}
  return {rows:[]};
 },async()=>assert.equal((await finance.voidMovement(org,actor,id,{revision:1,reason:'Duplicado'})).voidReason,'Duplicado'));
 assert.equal(updated,true);
 for(const candidate of [{...row,fixedExpenseId:fixedId},{...row,voidedAt:'now'}])await mockWrite(async sql=>sql.includes('finance_accounts')?{rows:[account]}:{rows:[candidate]},async()=>{const {id:_,...body}=entry;await assert.rejects(finance.updateMovement(org,actor,id,{...body,revision:1}),{status:409});});
});
test('movement filters are scoped and escaped; paid rule history is not overwritten',async()=>{
 const original=db.query;const calls=[];db.query=async(sql,args)=>{calls.push({sql,args});return sql.includes('count(*)')?{rows:[{total:0}]}:{rows:[]};};
 try{
  await finance.movements(org,{month:'2026-10',q:"50%_\\'",kind:'expense',page:'2',size:'20'});
  assert.equal(calls[0].args[0],org);assert.equal(calls[0].args[5],"%50\\%\\_\\\\'%");assert.equal(calls[0].args[7],40);assert.doesNotMatch(calls[0].sql,/50%/);
 }finally{db.query=original;}
 const migration=readFileSync(new URL('../db/migrations/039_finances.sql',`file://${__filename}`),'utf8');
 assert.match(migration,/finance_fixed_payment_once_idx/);assert.match(migration,/WHERE fixed_expense_id IS NOT NULL AND voided_at IS NULL/);
 assert.match(migration,/FOREIGN KEY \(organization_id, fixed_expense_id\)/);assert.match(migration,/CREATE TABLE finance_audit/);
 const app=readFileSync(new URL('../app.js',`file://${__filename}`),'utf8');assert.match(app,/browserSessionPaths = \[[^\]]*'\/finances'/);
});
test('opening balance creation retries safely and correcting it cannot exclude existing movements',async()=>{
 let created=false,audits=0;
 await mockWrite(async(sql,args)=>{
  if(sql.startsWith('INSERT INTO finance_accounts')){assert.deepEqual(args,[org,account.openingDate,account.openingCents]);const rows=created?[]:[{organization_id:org}];created=true;return {rows};}
  if(sql.includes('FROM finance_accounts')){assert.match(sql,/FOR UPDATE/);return {rows:[account]};}
  if(sql.includes('FROM finance_movements'))return {rows:[{id}]};
  assert.match(sql,/INSERT INTO finance_audit/);audits++;return {rows:[]};
 },async()=>{
  const input={openingDate:account.openingDate,openingBalance:'1000',revision:0};
  assert.equal((await finance.saveAccount(org,actor,input)).openingBalance,'1000.00');
  assert.equal((await finance.saveAccount(org,actor,input)).revision,1);
  await assert.rejects(finance.saveAccount(org,actor,{...input,revision:2}),{status:409});
  await assert.rejects(finance.saveAccount(org,actor,{...input,revision:1}),{status:400});
 });
 assert.equal(audits,1);
});
test('fixed rule creation is scoped, idempotent and audited without creating an expense',async()=>{
 let saved=null,inserts=0,audits=0;
 await mockWrite(async(sql,args)=>{
  if(sql.includes('FROM finance_accounts'))return {rows:[account]};
  if(sql.startsWith('SELECT count(*)'))return {rows:[{count:0}]};
  if(sql.includes('FROM finance_fixed_expenses')){assert.deepEqual(args,[fixedId,org]);return {rows:saved?[saved]:[]};}
  if(sql.startsWith('INSERT INTO finance_fixed_expenses')){inserts++;assert.deepEqual(args,[fixedId,org,fixed.reason,'','25000',31,'2026-09-01',null,true]);saved={...fixed};return {rows:[saved]};}
  assert.match(sql,/INSERT INTO finance_audit/);assert.equal(args[2],'fixed_created');audits++;return {rows:[]};
 },async()=>{
  const input={id:fixedId,reason:fixed.reason,amount:'250',dueDay:31,startMonth:'2026-09'};
  assert.equal((await finance.saveFixedExpense(org,actor,null,input)).amount,'250.00');
  assert.equal((await finance.saveFixedExpense(org,actor,null,input)).id,fixedId);
  await assert.rejects(finance.saveFixedExpense(org,actor,null,{...input,amount:'251'}),{status:409});
  await assert.rejects(finance.saveFixedExpense(org,actor,fixedId,{...input,id:undefined,revision:2}),{status:400});
 });
 assert.equal(inserts,1);assert.equal(audits,1);
});
test('fixed rule updates require the current revision and preserve payment snapshots',async()=>{
 const input={reason:'Servicio actualizado',amount:'275',dueDay:15,startMonth:'2026-09',revision:1};
 let updates=0;
 await mockWrite(async(sql,args)=>{
  if(sql.includes('FROM finance_accounts'))return {rows:[account]};
  if(sql.startsWith('SELECT'))return {rows:[fixed]};
  if(sql.startsWith('UPDATE')){assert.match(sql,/^UPDATE finance_fixed_expenses/);assert.equal(args[0],fixedId);assert.equal(args[1],org);updates++;return {rows:[{...fixed,reason:input.reason,amountCents:'27500',revision:2}]};}
  assert.match(sql,/INSERT INTO finance_audit/);return {rows:[]};
 },async()=>{
  await assert.rejects(finance.saveFixedExpense(org,actor,fixedId,{...input,revision:2}),{status:409});
  assert.equal((await finance.saveFixedExpense(org,actor,fixedId,input)).amount,'275.00');
 });
 assert.equal(updates,1);
});
