// A small client for chat completions on a Microsoft Foundry resource (OpenAI v1 surface), signed in
// with an Entra token. No keys: the endpoint has local authentication disabled.

const TIMEOUT_MS = 120_000;

/**
 * @param {{ endpoint: string, token: string, fetchImpl?: typeof fetch }} options
 * @returns {(request: { deployment: string, system: string, user: string, schema: object, schemaName: string, structured?: boolean }) => Promise<{ data: any, usage: object }>}
 */
export function createModelClient({ endpoint, token, fetchImpl = fetch }) {
  // An account endpoint (https://<name>.openai.azure.com) or a Foundry project endpoint (with a path).
  if (!/^https:\/\/[a-z0-9.-]+(\/[\w.-]+)*\/?$/i.test(endpoint ?? '')) throw new Error('model endpoint must be an https URL');
  if (!token) throw new Error('model token is missing');
  const url = `${endpoint.replace(/\/$/, '')}/openai/v1/chat/completions`;

  return async function complete({ deployment, system, user, schema, schemaName, structured = true }) {
    const body = {
      model: deployment,
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: structured
        ? { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } }
        : { type: 'json_object' },
    };
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${deployment}: HTTP ${res.status}`);
    const json = await res.json();
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error(`${deployment}: no message content`);
    let data;
    try {
      data = JSON.parse(content);
    } catch {
      throw new Error(`${deployment}: answer is not JSON`);
    }
    const problem = validate(data, schema);
    if (problem) throw new Error(`${deployment}: answer does not match the schema (${problem})`);
    return { data, usage: json.usage ?? {} };
  };
}

/** Enough JSON Schema to check our own schemas: object, array, string, integer, enum, required. */
export function validate(value, schema, at = '$') {
  if (schema.enum && !schema.enum.includes(value)) return `${at} not one of ${schema.enum.join(', ')}`;
  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return `${at} is not an object`;
      for (const key of schema.required ?? []) if (!(key in value)) return `${at}.${key} is missing`;
      for (const [key, sub] of Object.entries(schema.properties ?? {})) {
        if (key in value) {
          const p = validate(value[key], sub, `${at}.${key}`);
          if (p) return p;
        }
      }
      return null;
    }
    case 'array': {
      if (!Array.isArray(value)) return `${at} is not an array`;
      if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${at} has more than ${schema.maxItems} items`;
      for (let i = 0; i < value.length; i++) {
        const p = validate(value[i], schema.items, `${at}[${i}]`);
        if (p) return p;
      }
      return null;
    }
    case 'string':
      return typeof value === 'string' ? null : `${at} is not a string`;
    case 'integer':
      return Number.isInteger(value) ? null : `${at} is not an integer`;
    default:
      return null;
  }
}
