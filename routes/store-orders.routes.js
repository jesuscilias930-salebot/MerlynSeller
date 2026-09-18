const router = require('express').Router();
const crypto = require('node:crypto');
const { z } = require('zod');
const db = require('../lib/db');
const leads = require('../services/lead.service');
const realtime = require('../lib/realtime');
const { requireUser } = require('../middleware/auth.middleware');
const schema = z.object({tenantId:z.string().min(1),order:z.object({id:z.string().uuid(),folio:z.string().max(50),customerName:z.string().min(1).max(120),customerPhone:z.string().regex(/^[1-9]\d{7,14}$/),status:z.enum(['PENDING','CONFIRMED']),saleId:z.number().int().nullable(),subtotal:z.coerce.number().nonnegative(),lines:z.array(z.object({kind:z.enum(['PRODUCT','BUNDLE']),itemId:z.number().int(),name:z.string(),quantity:z.number().int().positive(),unitPrice:z.coerce.number().nonnegative(),contents:z.string().nullable().optional()})).min(1).max(200)})});
router.post('/events',async(req,res,next)=>{
 const expected=process.env.STORE_WEBHOOK_SECRET||'',provided=req.get('X-Store-Secret')||'';
 if(expected.length<32||Buffer.byteLength(expected)!==Buffer.byteLength(provided)||!crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(provided)))return res.sendStatus(401);
 const parsed=schema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:'Invalid order'});
 const {tenantId,order}=parsed.data,org=process.env.STORE_ORGANIZATION_ID;
 if(!org||tenantId!==process.env.STORE_STOCK_TENANT_ID)return res.sendStatus(403);
 try{
 await db.transaction(async client=>{
  const contact=await client.query('INSERT INTO contacts (organization_id,phone_number,name) VALUES ($1,$2,$3) ON CONFLICT (organization_id,phone_number) DO UPDATE SET name=COALESCE(contacts.name,EXCLUDED.name) RETURNING id',[org,order.customerPhone,order.customerName]);
  const column=await leads.initialColumnId(client,org);
  const chat=await client.query('INSERT INTO conversations (organization_id,contact_id,lead_column_id,auto_reply_enabled,scenario_enabled) VALUES ($1,$2,$3,false,false) ON CONFLICT (organization_id,contact_id) DO UPDATE SET contact_id=EXCLUDED.contact_id RETURNING id',[org,contact.rows[0].id,column]);
  await client.query(`INSERT INTO store_orders (organization_id,order_id,conversation_id,payload) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (organization_id,order_id) DO UPDATE SET payload=CASE WHEN store_orders.payload->>'status'='CONFIRMED' THEN store_orders.payload ELSE EXCLUDED.payload END, conversation_id=EXCLUDED.conversation_id`,[org,order.id,chat.rows[0].id,JSON.stringify(order)]);
 });
 await realtime.publish(org,'store.order_updated');return res.sendStatus(204);
 }catch(e){return next(e);}
});
router.get('/conversation/:id',requireUser,async(req,res,next)=>{try{if(!z.string().uuid().safeParse(req.params.id).success)return res.sendStatus(400);const result=await db.query('SELECT payload FROM store_orders WHERE organization_id=$1 AND conversation_id=$2 ORDER BY created_at DESC',[req.auth.organizationId,req.params.id]);return res.json(result.rows.map(r=>r.payload));}catch(e){return next(e);}});
module.exports=router;
