/** Add reviewed input alternatives to ordinary native Pi tool declarations. */
export function withInputContract(tool, { variants, examples }) {
  const parameters = JSON.parse(JSON.stringify(tool.parameters));
  if (parameters.anyOf || parameters.allOf || parameters.oneOf) throw new Error(`Compose ${tool.name}'s existing input alternatives explicitly.`);
  const alternatives = variants.map(({ when = {}, required = [] }) => {
    const branch = JSON.parse(JSON.stringify(parameters));
    const properties = branch.properties ?? {};
    for (const field of [...Object.keys(when), ...required]) {
      if (!Object.hasOwn(properties, field)) throw new Error(`Unknown input field ${field} for ${tool.name}.`);
      // These fields identify files or targets. Empty text in unrelated fields
      // (for example, clearing an input) retains its native meaning.
      if (required.includes(field) && properties[field].type === "string") properties[field].minLength = Math.max(1, properties[field].minLength ?? 0);
    }
    for (const [field, value] of Object.entries(when)) properties[field] = { ...properties[field], enum: [value] };
    return { ...branch, required: [...new Set([...(branch.required ?? []), ...Object.keys(when), ...required])] };
  });
  const requirements = variants.map(({ when = {}, required = [] }) => {
    const condition = Object.entries(when).map(([field, value]) => `${field}=${JSON.stringify(value)}`).join(", ");
    return `${condition ? `${condition}: ` : ""}${required.length ? required.join(" + ") : "no additional inputs"}`;
  }).join("; or ");
  // Providers such as OpenAI reject composition at the function-schema root.
  // The required input object keeps each alternative an ordinary object schema.
  // This is an explicit argument shape, never a missing-argument repair.
  return {
    ...tool,
    parameters: { type: "object", properties: { input: { anyOf: alternatives } }, required: ["input"], additionalProperties: false },
    description: `Pass all parameters inside the required input object. ${tool.description}\nInput alternatives: ${requirements}.\nExample inputs (replace targets with observed values): ${examples.map(input => JSON.stringify({ input })).join("; ")}`,
    execute(id, args, ...rest) { return tool.execute.call(tool, id, args.input, ...rest); },
  };
}

/** Preserve the native API and lifecycle; decorate only reviewed declarations. */
export function withToolContracts(pi, contracts) {
  return new Proxy(pi, { get(target, key, receiver) {
    if (key !== "registerTool") return Reflect.get(target, key, receiver);
    return tool => target.registerTool(contracts[tool.name] ? withInputContract(tool, contracts[tool.name]) : tool);
  } });
}
