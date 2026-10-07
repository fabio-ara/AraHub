import assert from 'node:assert/strict';
import {createDb} from '../src/db.ts';
import {Hub} from '../src/domain.ts';
const db=createDb('postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub'),hub=new Hub(db),p={ownerId:crypto.randomUUID()};
try{
 await db`insert into auth.users(id) values(${p.ownerId})`;
 const c=await hub.connect(p,'moodle','Scale synthetic',null,null,{});
 const start=performance.now();
 await db`insert into public.hub_entities(owner_id,connection_id,kind,external_id,title,state) select ${p.ownerId},${c.id},'forum_post',n::text,'Synthetic post '||n,jsonb_build_object('course_id',1) from generate_series(1,10000) n`;
 await db`insert into public.hub_observations(owner_id,entity_id,content,content_hash,provenance,coverage,observed_at) select ${p.ownerId},e.id,jsonb_build_object('subject',e.title,'message','Synthetic version '||n),md5(e.id::text||n::text),jsonb_build_object('system','synthetic_scale'),'complete',now()-n*interval '1 minute' from public.hub_entities e cross join generate_series(1,10) n where e.owner_id=${p.ownerId}`;
 const insertMs=performance.now()-start;
 const [{id}]=await db`select id from public.hub_entities where owner_id=${p.ownerId} limit 1`;
 const samples:number[]=[];
 for(let i=0;i<20;i++){
  const before=performance.now();
  const [entities,history,context,search]=await Promise.all([hub.entities(p,{connection_id:c.id,kind:'forum_post',offset:i*20}),hub.observations(p,id),hub.entityContext(p,id),hub.entities(p,{connection_id:c.id,query:'Synthetic post',offset:i*20})]);
  assert.equal(entities.records.length,20);assert.equal(history.records.length,10);assert.ok(context.entity);assert.equal(search.records.length,20);
  samples.push(performance.now()-before);
 }
 const ordered=[...samples].sort((a,b)=>a-b),p95=ordered[Math.ceil(ordered.length*.95)-1];
 const [{bytes}]=await db`select coalesce(sum(pg_column_size(o)),0)::text as bytes from public.hub_observations o where owner_id=${p.ownerId}`;
 const [{occurrence_bytes}]=await db`select coalesce(sum(pg_column_size(o)),0)::text as occurrence_bytes from public.hub_observation_occurrences o where owner_id=${p.ownerId}`;
 const evidence={environment:'local_postgres_synthetic',posts:10000,observations:100000,occurrences:100000,queries:['entity_list','paginated_timeline','entity_context','title_search'],insert_ms:Math.round(insertMs),samples_ms:samples.map(n=>Math.round(n)),p95_ms:Math.round(p95),target_ms:2000,target_met:p95<=2000,logical_observation_row_bytes:bytes,logical_occurrence_row_bytes:occurrence_bytes,network:'loopback',cold_start:'first sample included; process/database already running',source_calls:0,university_load:0};
 await Deno.mkdir('.private/entrega-1',{recursive:true});
 await Deno.writeTextFile('.private/entrega-1/scale-proof.json',JSON.stringify(evidence,null,2));
 console.log(JSON.stringify({posts:10000,observations:100000,p95_ms:evidence.p95_ms,target_met:evidence.target_met}));
 assert.ok(evidence.target_met,'Measured local p95 exceeds 2 seconds');
}finally{await db`delete from auth.users where id=${p.ownerId}`;await db.end();}
