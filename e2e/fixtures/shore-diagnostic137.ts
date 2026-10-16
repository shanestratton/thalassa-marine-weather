/** Representative import-time telemetry/history observers, fixture RAM only. */
if (!import.meta.env.DEV) throw new Error('Development fixture only');
const diagnostics = { firstHash: window.location.hash, hashEvents: [] as string[], historyEvents: [] as string[] };
window.addEventListener('hashchange', (event) => diagnostics.hashEvents.push(event.newURL));
const replace = history.replaceState.bind(history);
history.replaceState = (...args) => {
    diagnostics.historyEvents.push(location.href);
    return replace(...args);
};
Object.assign(window, { __shoreDiagnostics: diagnostics });
export {};
