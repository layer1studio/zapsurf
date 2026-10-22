export async function settleRelayPublishes(relayPromises, onProgress = () => {}) {
  let accepted = 0;
  let settled = 0;
  const report = () => {
    try { onProgress({ accepted, settled, total: relayPromises.length }); } catch { /* reporting must not interrupt publication */ }
  };
  report();
  const results = await Promise.allSettled(relayPromises.map(result => Promise.resolve(result).then(value => {
    accepted++;
    settled++;
    report();
    return value;
  }, error => {
    settled++;
    report();
    throw error;
  })));
  return { results, accepted, total: relayPromises.length };
}