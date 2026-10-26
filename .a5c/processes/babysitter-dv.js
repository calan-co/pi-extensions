exports.process = async function babysitterDv(inputs, ctx) {
  return (await import("./babysitter-dv/process.mjs")).process(inputs, ctx);
};
