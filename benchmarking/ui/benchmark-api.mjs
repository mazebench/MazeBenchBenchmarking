const nativeFetch=window.fetch.bind(window);
const origin=`http://${location.hostname}:8082`;
let checkedAt=0,available=false,pending;
export async function visionAvailable(){
  if(Date.now()-checkedAt<15000)return available;
  if(!pending)pending=(async()=>{try{const r=await nativeFetch(origin+'/api/benchmark/vision/status',{signal:AbortSignal.timeout(1200)});available=r.ok&&(await r.json()).observation_mode==='vision';}catch{available=false;}checkedAt=Date.now();pending=null;return available;})();
  return pending;
}
const capabilityOrigin=`http://${location.hostname}:8083`;
let capabilitiesAt=0,capabilities=false,capabilitiesPending,activeCapabilityOrigin=capabilityOrigin;
export async function capabilitiesAvailable(){
  if(Date.now()-capabilitiesAt<15000)return capabilities;
  capabilitiesPending ||= (async()=>{
    // v3 added recovery metadata without changing the v2 routes. Accept both
    // during rolling updates so live runs never fall back to another owner.
    capabilities=false;
    for(const candidate of [`http://${location.hostname}:8084`,capabilityOrigin]){
      try{const r=await nativeFetch(candidate+'/api/benchmark/capabilities/status',{signal:AbortSignal.timeout(1200)});if(r.ok&&[2,3].includes((await r.json()).version)){capabilities=true;activeCapabilityOrigin=candidate;break;}}catch{/* Try the existing owner during an upgrade. */}
    }
    capabilitiesAt=Date.now();capabilitiesPending=null;return capabilities;
  })();
  return capabilitiesPending;
}
export async function benchmarkFetch(url,options={}){
  // Image launches must never fall through a generic companion to ASCII.
  // Check the image owner first even when catalog/capability servers are online.
  let visionLaunch=false;
  if(options.method?.toUpperCase()==='POST'&&/\/api\/benchmark\/v1\/(runs|pairs)$/.test(url)&&options.body){
    try{visionLaunch=JSON.parse(options.body).observation_mode==='vision';}catch{}
  }
  if(visionLaunch){
    if(!await visionAvailable())throw new Error('Vision runner is unavailable. Start npm run start:vision; no run was launched.');
    return nativeFetch(origin+url,options);
  }
  if(await capabilitiesAvailable())return nativeFetch(activeCapabilityOrigin+url,options);
  const vision=await visionAvailable();
  if(!vision&&options.body){try{if(JSON.parse(options.body).observation_mode==='vision')throw new Error('Vision runner is unavailable. Start node benchmarking/vision/server.mjs.');}catch(error){if(!(error instanceof SyntaxError))throw error;}}
  return nativeFetch(vision?origin+url:url,options);
}
export const visionUrl=path=>origin+path;
