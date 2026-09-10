const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { HttpError } = require('../middleware/errorHandler');
const { withTenantContext } = require('../db/pool');
const { tenantContextFromAuth } = require('../auth/tenantContext');
const router = express.Router();
router.use(requireAuth);
const companyFor = req => req.auth.role === 'seller' ? req.auth.companyId : req.query.companyId;

// A deliberately published snapshot is not an invoice, receipt or stock operation.
// Only the warehouse owner may share it. Sellers never gain access to the source company.
router.post('/', requireRole('owner'), async (req,res,next) => {
  try {
    const { companyId,invoiceId }=req.body;
    if(!companyId||!invoiceId)throw new HttpError(400,'Укажите продавца и документ');
    const result=await withTenantContext(tenantContextFromAuth(req.auth),async c=>{
      const company=(await c.query('SELECT id FROM companies WHERE id=$1 AND warehouse_id=$2',[companyId,req.auth.warehouseId])).rows[0];
      if(!company)throw new HttpError(404,'Компания не найдена');
      const invoice=(await c.query(`SELECT i.number,i.direction,i.status,i.created_at,i.source_document_type,i.source_document_date,c.name AS source_company_name
        FROM invoices i JOIN companies c ON c.id=i.company_id
        WHERE i.id=$1 AND i.warehouse_id=$2 AND i.source='1c' AND i.direction='in'`,[invoiceId,req.auth.warehouseId])).rows[0];
      if(!invoice)throw new HttpError(404,'Входящий документ 1С не найден');
      const items=(await c.query(`SELECT ii.id,ii.name,ii.sku,ii.declared_qty,rr.accepted_qty
        FROM invoice_items ii LEFT JOIN receiving_records rr ON rr.invoice_item_id=ii.id
        WHERE ii.invoice_id=$1 ORDER BY ii.id`,[invoiceId])).rows;
      if(!items.length)throw new HttpError(400,'В документе нет позиций');
      const snapshot={...invoice,source:'1c',preview:true,items};
      return (await c.query(`INSERT INTO seller_document_examples(warehouse_id,company_id,source_invoice_id,snapshot)
        VALUES($1,$2,$3,$4) ON CONFLICT(company_id,source_invoice_id) DO UPDATE SET snapshot=EXCLUDED.snapshot,created_at=now()
        RETURNING id`,[req.auth.warehouseId,companyId,invoiceId,JSON.stringify(snapshot)])).rows[0];
    });res.status(201).json(result);
  }catch(e){next(e);}
});
router.get('/',requireRole('seller','owner','manager'),async(req,res,next)=>{
  try {
    const companyId=companyFor(req);if(!companyId)throw new HttpError(400,'Укажите продавца');
    const rows=await withTenantContext(tenantContextFromAuth(req.auth),async c=>(await c.query(
      `SELECT e.id,e.source_invoice_id,e.snapshot FROM seller_document_examples e
       WHERE e.company_id=$1 AND NOT EXISTS (
         SELECT 1 FROM invoices i WHERE i.id=e.source_invoice_id AND i.company_id=$1
       ) ORDER BY e.created_at DESC LIMIT 100`,[companyId])).rows);
    res.set('Cache-Control','no-store').json({rows:rows.map(({id,source_invoice_id,snapshot:s})=>({id,source_invoice_id,number:s.number,direction:s.direction,status:s.status,created_at:s.created_at,source_document_type:s.source_document_type||null,source_document_date:s.source_document_date||null,source:'1c',preview:true,source_company_name:s.source_company_name,item_count:s.items.length,declared_qty:s.items.reduce((sum,r)=>sum+Number(r.declared_qty),0)}))});
  }catch(e){next(e);}
});
router.get('/:id',requireRole('seller','owner','manager'),async(req,res,next)=>{
  try {
    const companyId=companyFor(req);
    const row=await withTenantContext(tenantContextFromAuth(req.auth),async c=>(await c.query(
      'SELECT id,snapshot FROM seller_document_examples WHERE id=$1 AND company_id=$2',[req.params.id,companyId])).rows[0]);
    if(!row)throw new HttpError(404,'Образец не найден');
    res.set('Cache-Control','no-store').json({...row.snapshot,id:row.id});
  }catch(e){next(e);}
});
router.delete('/:id',requireRole('owner'),async(req,res,next)=>{
  try {
    const result=await withTenantContext(tenantContextFromAuth(req.auth),c=>c.query(
      'DELETE FROM seller_document_examples WHERE id=$1 AND warehouse_id=$2',[req.params.id,req.auth.warehouseId]));
    if(!result.rowCount)throw new HttpError(404,'Образец не найден');
    res.json({removed:true});
  }catch(e){next(e);}
});
module.exports=router;
