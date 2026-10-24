// Benchmark generations are assigned by repository origin, not inferred from hashes.
export function versionPresentation(value = {}) {
  const release = value?.benchmark_release || (value?.evidence === 'legacy-archive' ? '1.0' : '1.1');
  const detail = [
    `Benchmark v${release}`,
    release === '1.0' ? 'Prior run from an earlier repository.' : 'Run created in MazeBenchBenchmarking.',
    'Version labels identify the repository generation.',
    value?.engine?.sha256 && `Recorded engine SHA-256: ${value.engine.sha256}`,
    value?.world?.sha256 && `Recorded world inventory SHA-256: ${value.world.sha256}`
  ].filter(Boolean).join('\n');
  return { label: `v${release}`, detail };
}

export function repositoryRunVersion(value = {}, origin = 'current') {
  const result = { ...value, schema_version: 1, benchmark_release: origin === 'legacy' ? '1.0' : '1.1',
    classification: 'repository-generation' };
  return { ...result, ...versionPresentation(result) };
}

export function legacyRunVersion() {
  return repositoryRunVersion({ evidence: 'legacy-archive' }, 'legacy');
}
