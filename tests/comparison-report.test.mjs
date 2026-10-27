import test from 'node:test';
import assert from 'node:assert/strict';
import {comparisonSeries} from '../benchmarking/comparison-report.mjs';
import {progressSeries,linearPath} from '../benchmarking/ui/comparison-chart-data.mjs';
import {scale} from '../benchmarking/ui/comparison-chart.mjs';
const summary={action_count:3,actions:[
 {index:1,at:'2026-01-01T00:00:02Z',totalGems:1,gemsCollected:1,roomsVisited:1},
 {index:2,at:'2026-01-01T00:00:04Z',totalGems:1,gemsCollected:0,roomsVisited:2},
 {index:3,at:'2026-01-01T00:00:06Z',totalGems:2,gemsCollected:1,roomsVisited:2}
]};
const record=(second,usage={})=>({timestamp:Date.parse(`2026-01-01T00:00:0${second}Z`),usage:{input_tokens:100,cached_input_tokens:80,output_tokens:10,...usage}});
test('response checkpoints join retained actions, subtract cache once, and keep final tool moves',()=>{
 const series=comparisonSeries(summary,[record(1),record(3),record(5)],{model:'test'}, {price:{rates:[2,.2,2,10]}});
 assert.deepEqual(series.progress.map(p=>[p.moves,p.gems,p.rooms]),[[0,0,1],[1,1,1],[2,1,2],[3,2,2]]);
 assert.deepEqual(series.performance.map(p=>[p.moves,p.responses,p.input_tokens_uncached,p.total_tokens]),[[0,0,0,0],[0,1,20,110],[1,2,40,220],[2,3,60,330],[3,3,60,330]]);
 assert.ok(Math.abs(series.performance.at(-1).cost_usd-.000468)<1e-10);
 assert.deepEqual(progressSeries({series},'responses','gems').points,[{x:0,y:0},{x:2,y:1},{x:3,y:2}]);
});
test('unknown costs are missing, never a fabricated zero-cost run',()=>{
 const series=comparisonSeries(summary,[record(3)],{model:'unknown-model'});
 assert.equal(progressSeries({series},'cost_usd','gems').points.length,0);
 assert.ok(progressSeries({series},'total_tokens','rooms').points.length>0);
 assert.equal(comparisonSeries(summary,[]).performance.length,0);
 assert.deepEqual(comparisonSeries({action_count:100,gems_collected:4},[]).progress,[]);
});
test('per-response prices use historical speed and reported provider cost',()=>{
 const seen=[];
 const series=comparisonSeries(summary,[record(1),record(3),record(5,{cost_usd:.02})],{model:'test',service_tier_history:[{at:'2026-01-01T00:00:00Z',service_tier:'standard'},{at:'2026-01-01T00:00:02Z',service_tier:'fast'}]}, {priceFor:(_model,_at,tier)=>{seen.push(tier);return {rates:[1,0,1,tier==='fast'?20:10]};}});
 assert.deepEqual(seen,['standard','fast']);
 assert.ok(series.performance.at(-1).cost_usd>.02);
});
test('cost scale supports fractions and chart uses diagonal segments',()=>{
 const axis=scale(.0034,5);
 assert.ok(axis.maximum>=.0034&&axis.maximum<.01);
 assert.equal(linearPath([{x:0,y:0},{x:10,y:2}],x=>x,y=>y),'M0,0L10,2');
 assert.equal(progressSeries({series:{performance:[{total_tokens:10,gems:0},{total_tokens:5,gems:1}]}},'total_tokens','gems').points.length,0);
});
