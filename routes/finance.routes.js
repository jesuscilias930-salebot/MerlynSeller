const router=require('express').Router();
const {requireUser,requireRole}=require('../middleware/auth.middleware');
const finance=require('../services/finance.service');
router.use(requireUser,requireRole('owner','admin'));
router.use((req,res,next)=>{res.set('Cache-Control','no-store');next();});
const handle=(method,source,status=200)=>(async(req,res,next)=>{
 try {
  const org=req.auth.organizationId,actor=req.auth.user.id;
  let result;
  if(source==='query')result=await finance[method](org,req.query);
  else if(source==='id')result=await finance[method](org,actor,req.params.id||null,req.body);
  else result=await finance[method](org,actor,req.body);
  res.status(status).json(result);
 }catch(e){if([400,404,409].includes(e.status))return res.status(e.status).json({error:e.message});next(e);}
});
router.get('/summary',handle('summary','query'));
router.put('/account',handle('saveAccount','body'));
router.get('/movements',handle('movements','query'));
router.post('/movements',handle('createMovement','body',201));
router.put('/movements/:id',handle('updateMovement','id'));
router.post('/movements/:id/void',handle('voidMovement','id'));
router.get('/fixed-expenses',handle('fixedExpenses','query'));
router.post('/fixed-expenses',handle('saveFixedExpense','id',201));
router.put('/fixed-expenses/:id',handle('saveFixedExpense','id'));
router.post('/fixed-expenses/:id/pay',handle('payFixedExpense','id'));
module.exports=router;
