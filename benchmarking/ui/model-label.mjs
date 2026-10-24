import { modelIdentity } from '../model-catalog/normalize.mjs';
// Presentation never rewrites the exact provider ID pinned in run.json.
export function modelLabel(model, fallback = model) {
  if (["kimi/k3", "moonshotai/kimi-k3", "kimi-k3", "k3"].includes(model)) return "Kimi K3";
  if (model === 'k3-256k') return 'Kimi K3 · 256K';
  if (/^k3\.1-pro(?:-highspeed)?$/.test(model)) return 'Kimi K3.1 Pro';
  if (model === 'kimi-for-coding') return 'Kimi K2.8 Preview';
  if (model === 'kimi-for-coding-highspeed') return 'Kimi K2.7 Code';
  const provider = /^(?:gemini-|claude-|gpt-oss-).+-(?:minimal|low|medium|high|xhigh|max)$/.test(model) ? 'antigravity' : /^grok-/.test(model) ? 'grok-build' : '';
  return modelIdentity({ id: model || '', name: fallback || model, provider }).name
    .replace(provider === 'antigravity' ? /-(minimal|low|medium|high|xhigh|max)$/ : /$^/, '')
    .replace(provider === 'grok-build' ? /-build-fast$/ : /$^/, '');
}
export const modelSpeed = run => run.service_tier === 'fast' || /(?:-highspeed|-build-fast)$/.test(run.model || '') ? 'fast' : 'standard';

export function modelGroupId(model) {
  if (['k3', 'kimi/k3', 'moonshotai/kimi-k3', 'kimi-k3'].includes(model)) return 'kimi-k3';
  return String(model || '').replace(/^(k3\.1-pro)-highspeed$/, '$1').replace(/^(grok-.+)-build-fast$/, '$1')
    .replace(/^((?:gemini-|claude-|gpt-oss-).+)-(minimal|low|medium|high|xhigh|max)$/, '$1');
}
