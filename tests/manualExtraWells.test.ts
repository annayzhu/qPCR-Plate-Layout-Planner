import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlannerSession, dispatchPlannerSession, plannerSessionAudit, plannerSessionReactionCalculation, restorePlannerSession, serializePlannerSession } from '../lib/plannerSession';
import { DEFAULT_REACTION_SYSTEM } from '../lib/reactionCalculator';
import { plannerWorkflowOutput } from '../lib/workflowOutput';

test('free wells add complete reagent and template requirements without expanding automatic inputs', () => {
  let session = createPlannerSession({
    loadingUnit: 'well', loadingPattern: 'sequential',
    samples: [{id:'s1',name:'S1',kind:'sample'}],
    genes: [{id:'g1',name:'G1',role:'target'},{id:'r1',name:'REF',role:'reference'}],
    replicates: 3,
    reactionSystem: {...DEFAULT_REACTION_SYSTEM, overagePercent:0, geneMixPreparationMode:'single-tube'},
  });
  session = dispatchPlannerSession(session,{type:'generate-layout',generatedAt:'synthetic'}).session;
  const baseline = structuredClone(session.plateEditing!.plan.plates[0].wells);
  const setup = structuredClone(session.setup);
  session = dispatchPlannerSession(session,{type:'edit-plate-many',commands:[
    {type:'select',plateNumber:1,wellIds:['H11','H12'],mode:'replace'},
    {type:'assign',sample:'Extra sample',gene:'Extra gene',geneType:'target'},
  ]}).session;
  const calculation = plannerSessionReactionCalculation(session);
  assert.equal(calculation.totalWells,8);
  assert.equal(plannerSessionAudit(session).valid,true,"manual-only names do not create automatic combination errors");
  assert.deepEqual(session.plateEditing!.plan.plates[0].sampleNames,["S1","Extra sample"]);
  const gene = calculation.geneRequirements.find(item=>item.gene==='Extra gene');
  assert.ok(gene,'each extra gene needs a mix row');
  assert.equal(gene.wellCount,2);
  assert.equal(gene.masterMixUl,10);
  assert.equal(gene.forwardPrimerUl,0.4);
  const sample = calculation.sampleRequirements.find(item=>item.sample==='Extra sample');
  assert.ok(sample,'each extra sample needs a template row');
  assert.equal(sample.recommendedCdnaUl,2);
  assert.deepEqual(session.setup,setup);
  assert.deepEqual(session.plateEditing!.plan.plates[0].wells.filter(well=>!['H11','H12'].includes(well.wellId)),baseline.filter(well=>!['H11','H12'].includes(well.wellId)));
  const restored = restorePlannerSession(serializePlannerSession(session)).session;
  const output = plannerWorkflowOutput(restored);
  assert.equal(output.plates[0].wells.H11.sample,'Extra sample');
  assert.ok(output.table.rows.some(row=>row[0]==='Extra gene'&&row[1]==='2'));
  assert.match(output.mixTsv,/Extra sample\t2\t2/);
  session = dispatchPlannerSession(session,{type:'edit-plate',command:{type:'undo'}}).session;
  assert.equal(plannerSessionReactionCalculation(session).totalWells,6);
  assert.deepEqual(session.plateEditing!.plan.plates[0].wells,baseline);
});

test('manual entry reuses canonical sample names and a shared role for the same assay', () => {
  let session = createPlannerSession({
    loadingUnit:'well',loadingPattern:'sequential',replicates:1,
    samples:[{id:'s1',name:'S1',kind:'sample'},{id:'ntc',name:'NTC',kind:'blank'}],
    genes:[{id:'g1',name:'G1',role:'target'},{id:'r1',name:'REF',role:'reference'}],
  });
  session=dispatchPlannerSession(session,{type:'generate-layout',generatedAt:'synthetic'}).session;
  session=dispatchPlannerSession(session,{type:'edit-plate-many',commands:[
    {type:'select',plateNumber:1,wellIds:['H10'],mode:'replace'},
    {type:'assign',sample:'S1',gene:'Extra gene',geneType:'target'},
    {type:'select',plateNumber:1,wellIds:['H11'],mode:'replace'},
    {type:'assign',sample:' ntc ',gene:' extra GENE ',geneType:'reference'},
  ]}).session;
  const well=session.plateEditing!.plan.plates[0].wells.find(item=>item.wellId==='H11')!;
  assert.equal(well.sample,'NTC');
  assert.equal(well.gene,'Extra gene');
  assert.equal(well.geneType,'target');
  const template=plannerSessionReactionCalculation(session).sampleRequirements.find(item=>item.sample==='NTC')!;
  assert.equal(template.theoreticalCdnaUl,0);
  assert.ok(Math.abs(template.replacementWaterUl-3.36)<1e-9);
});
