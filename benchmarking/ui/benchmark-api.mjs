const nativeFetch=window.fetch.bind(window);
const origin=`http://${location.hostname}:8082`;
let checkedAt=0,available=false,pending;
export async function visionAvailable(){
  if(Date.now()-checkedAt<15000)return available;
  if(!pending)pending=(async()=>{try{const r=await nativeFetch(origin+'/api/benchmark/vision/status',{signal:AbortSignal.timeout(1200)});available=r.ok&&(await r.json()).observation_mode==='vision';}catch{available=false;}checkedAt=Date.now();pending=null;return available;})();
  return pending;
}
const capabilityOrigin=`http://${location.hostname}:8083`;
let capabilitiesAt=0,capabilities=false,capabilitiesPending;
export async function capabilitiesAvailable(){
  if(Date.now()-capabilitiesAt<15000)return capabilities;
  capabilitiesPending ||= (async()=>{
    try{const r=await nativeFetch(capabilityOrigin+'/api/benchmark/capabilities/status',{signal:AbortSignal.timeout(1200)});capabilities=r.ok&&(await r.json()).version===2;}catch{capabilities=false;}
    capabilitiesAt=Date.now();capabilitiesPending=null;return capabilities;
  })();
  return capabilitiesPending;
}
export async function benchmarkFetch(url,options={}){
  if(await capabilitiesAvailable())return nativeFetch(capabilityOrigin+url,options);
  const vision=await visionAvailable();
  if(!vision&&options.body){try{if(JSON.parse(options.body).observation_mode==='vision')throw new Error('Vision runner is unavailable. Start node benchmarking/vision/server.mjs.');}catch(error){if(!(error instanceof SyntaxError))throw error;}}
  return nativeFetch(vision?origin+url:url,options);
}
export const visionUrl=path=>origin+path;
