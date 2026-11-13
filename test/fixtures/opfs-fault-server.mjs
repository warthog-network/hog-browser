// Hog's node-tab site server on a random port with a throwaway disk store,
// for the storage fault-injection tests. Faults come from HOG_OPFS_FAULTS /
// HOG_OPFS_OUTAGE in the environment. Prints {port, hosts} once listening;
// "stats" on stdin prints the injected-fault counters.
const { createRuntime, opfsFaultInternals } = await import("../../server.mjs");
const runtime = createRuntime();
const site = await runtime.ensureSite("https://browser-node.netlify.app");
const hosts = site.servers.map((server) => server.address().address);
process.stdout.write(`${JSON.stringify({ port: site.port, hosts })}\n`);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (text) => {
  if (text.includes("stats")) {
    const { calls, injected } = opfsFaultInternals;
    process.stdout.write(`${JSON.stringify({ calls, injected })}\n`);
  }
});
process.stdin.on("end", () => process.exit(0));
