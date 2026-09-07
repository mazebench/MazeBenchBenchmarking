const nativeFetch=window.fetch.bind(window);
const origin=`http://${location.hostname}:8082`;
let checkedAt=0,available=false,pending;
export async function visionAvailable(){
  if(Date.now()-checkedAt<15000)return available;
  if(!pending)pending=(async()=>{try{const r=await nativeFetch(origin+'/api/benchmark/vision/status',{signal:AbortSignal.timeout(1200)});available=r.ok&&(await r.json()).observation_mode==='vision';}catch{available=false;}checkedAt=Date.now();pending=null;return available;})();
  return pending;
}
export async function benchmarkFetch(url,options={}){
  const vision=await visionAvailable();
  if(!vision&&options.body){try{if(JSON.parse(options.body).observation_mode==='vision')throw new Error('Vision runner is unavailable. Start node benchmarking/vision/server.mjs.');}catch(error){if(!(error instanceof SyntaxError))throw error;}}
  return nativeFetch(vision?origin+url:url,options);
}
export const visionUrl=path=>origin+path;
