import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import {createDb} from '../src/db.ts';
import {Hub} from '../src/domain.ts';
import {PreservedMaterials} from '../src/preserved_materials.ts';
import {sha256Hex} from '../src/migration.ts';
Deno.test('retired Google snapshots remain readable offline with exact hash, structure and owner isolation',async()=>{
 const db=createDb(Deno.env.get('LOCAL_DATABASE_URL')??'postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub'),hub=new Hub(db);
 const p={ownerId:crypto.randomUUID()},q={ownerId:crypto.randomUUID()};
 try{
  await db`insert into auth.users(id) values(${p.ownerId}),(${q.ownerId})`;
  const c=await hub.connect(p,'google','Historical synthetic',null,null,{}),e=await hub.entity(p,c.id,'document','historical','Historical material',{});
  const value={tabs:[{table:{cells:[{value:'A',formula:'=SUM(1,2)'}]},text:'á🚀'.repeat(5000)}], 'a/b':{'~key':'preserved'}};
  const bytes=new TextEncoder().encode(JSON.stringify({format:'arahub.google.native.v1',native:value})),hash=await sha256Hex(bytes);
  const [file]=await db`insert into public.hub_files(owner_id,entity_id,name,mime_type,sha256,bytes,binary_content,extraction) values(${p.ownerId},${e.id},'Historical snapshot','application/json',${hash},${bytes.length},${Buffer.from(bytes)},'{}') returning id`;
  const reader=new PreservedMaterials(hub);
  assert.deepEqual((await reader.read(p,file.id,hash,'/tabs/0/table')).result,value.tabs[0].table);
  assert.equal((await reader.read(p,file.id,hash,'/a~1b/~0key')).result,'preserved');
  let offset:number|null=0,restored='';while(offset!==null){const part=await reader.read(p,file.id,hash,'/tabs/0/text',offset,500);restored+=part.result;offset=part.next_offset;}
  assert.equal(restored,value.tabs[0].text);
  await assert.rejects(()=>reader.read(q,file.id,hash));await assert.rejects(()=>reader.read(p,file.id,'0'.repeat(64)));
  const [after]=await db`select sha256,bytes from public.hub_files where id=${file.id}`;assert.equal(after.sha256,hash);assert.equal(Number(after.bytes),bytes.length);
 }finally{await db`delete from auth.users where id in (${p.ownerId},${q.ownerId})`;await db.end();}
});
