const test=require('node:test'),assert=require('node:assert/strict'),express=require('express'),cookieParser=require('cookie-parser');
const auth=require('../services/auth.service'),finance=require('../services/finance.service'),routes=require('../routes/finance.routes');
const id='11111111-1111-4111-8111-111111111111';
test('all finance routes require owner/admin, use session organization, and never cache balances',async()=>{
 const oldAuth=auth.getSession,methods=['summary','saveAccount','movements','createMovement','updateMovement','voidMovement','fixedExpenses','saveFixedExpense','payFixedExpense'],originals=Object.fromEntries(methods.map(k=>[k,finance[k]])),calls=[];
 auth.getSession=async token=>token?{organizationId:'session-org',user:{id:'session-user',role:token}}:null;
 for(const name of methods)finance[name]=async(...args)=>{calls.push({name,args});return {ok:true};};
 const app=express();app.use(express.json(),cookieParser());app.use('/finances',routes);
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),base=`http://127.0.0.1:${server.address().port}/finances`;
 try{
  for(const [method,path,name] of [['GET','/summary?month=2026-10','summary'],['PUT','/account','saveAccount'],['GET','/movements?month=2026-10','movements'],['POST','/movements','createMovement'],['PUT',`/movements/${id}`,'updateMovement'],['POST',`/movements/${id}/void`,'voidMovement'],['GET','/fixed-expenses','fixedExpenses'],['POST','/fixed-expenses','saveFixedExpense'],['PUT',`/fixed-expenses/${id}`,'saveFixedExpense'],['POST',`/fixed-expenses/${id}/pay`,'payFixedExpense']]){
   const before=calls.length;
   for(const role of ['', 'agent','supervisor']){const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',cookie:role?`${auth.sessionCookie}=${role}`:''},body:method==='GET'?undefined:'{}'});assert.equal(r.status,role?403:401);}
   assert.equal(calls.length,before);
   for(const role of ['owner','admin']){const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',cookie:`${auth.sessionCookie}=${role}`},body:method==='GET'?undefined:JSON.stringify({organizationId:'forged'})});assert.equal(r.ok,true);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(calls.at(-1).name,name);assert.equal(calls.at(-1).args[0],'session-org');if(method!=='GET')assert.equal(calls.at(-1).args[1],'session-user');}
  }
 }finally{auth.getSession=oldAuth;for(const k of methods)finance[k]=originals[k];await new Promise(resolve=>server.close(resolve));}
});
