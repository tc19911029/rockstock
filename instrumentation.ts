// Next.js loads instrumentation in both Node.js and Edge runtimes. The local
// cron scheduler depends on Node-only APIs through its route support modules,
// so keep that dependency graph out of the Edge bundle.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const nodeInstrumentation = await import('./instrumentation.node');
    await nodeInstrumentation.register();
  }
}
