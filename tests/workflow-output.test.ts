import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlannerSession, dispatchPlannerSession } from '../lib/plannerSession';
import { plannerWorkflowOutput } from '../lib/workflowOutput';
test('complete mix copy uses actual wells, includes units and cannot publish stale layout',()=>{
 let session=createPlannerSession({samples:[{id:'s1',name:'S1',kind:'sample'}],genes:[{id:'g1',name:'G1',role:'target'},{id:'r1',name:'REF',role:'reference'}],replicates:3});
 session=dispatchPlannerSession(session,{type:'generate-layout',generatedAt:'2026-11-03T00:00:00.000Z'}).session;
 const result=plannerWorkflowOutput(session);
 assert.match(result.mixTsv,/µL/);
 assert.equal(result.images.length,0);
 assert.equal(result.plates.length,1);
 assert.deepEqual(Object.keys(result.plates[0].wells).length,6);
 assert.equal(result.plates[0].plateSize,96);
 assert.equal(result.table.rows[0][1],'3');
 session=dispatchPlannerSession(session,{type:'patch-setup',patch:{replicates:2}}).session;
 assert.throws(()=>plannerWorkflowOutput(session));
});
test('the shared reaction system gives the same volumes as LabNest calculators (Q402)',()=>{
 let session=createPlannerSession({samples:Array.from({length:8},(_,i)=>({id:`s${i}`,name:`S${i}`,kind:'sample' as const})),genes:[{id:'g1',name:'G1',role:'target'},{id:'r1',name:'REF',role:'reference'}],replicates:3});
 session=dispatchPlannerSession(session,{type:'generate-layout',generatedAt:'2026-11-03T00:00:00.000Z'}).session;
 const row=plannerWorkflowOutput(session).table.rows[0];
 assert.deepEqual(row.slice(1),['24','0','241.92','134.4','5.376','5.376','96.768']);
});
