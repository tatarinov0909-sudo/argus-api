// Provision platform access explicitly. Never make every warehouse owner a platform administrator.
// ADMIN_DATABASE_URL must use the database operator role. No email, token or secret is printed.
const {Client}=require('pg');
const ownerId=process.argv[2];
const revoke=process.argv[3]==='--revoke';
if(!/^[0-9a-f-]{36}$/i.test(ownerId||'') || !process.env.ADMIN_DATABASE_URL) {
  console.error('Usage: ADMIN_DATABASE_URL=<operator connection> node scripts/lead-admin.js <existing-owner-uuid> [--revoke]');
  process.exit(1);
}
(async()=>{
  const c=new Client({connectionString:process.env.ADMIN_DATABASE_URL});await c.connect();
  try{
    const r=await c.query(`INSERT INTO platform_administrators(owner_id,active)
      SELECT id,$2 FROM owners WHERE id=$1
      ON CONFLICT(owner_id) DO UPDATE SET active=EXCLUDED.active RETURNING active`,[ownerId,!revoke]);
    if(!r.rowCount)throw Error('Owner account not found');
    console.log(revoke?'Platform lead access revoked.':'Platform lead access enabled.');
  }finally{await c.end();}
})().catch(()=>{console.error('Provisioning failed; check the operator connection and existing owner id.');process.exitCode=1;});
