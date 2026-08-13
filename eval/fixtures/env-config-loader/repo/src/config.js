/** Reads the service settings out of the environment. */

export function loadConfig(schema, env = process.env) {
  const result = {};

  for (const [key, spec] of Object.entries(schema)) {
    result[key] = env[spec.env] ?? spec.default;
  }

  return result;
}
