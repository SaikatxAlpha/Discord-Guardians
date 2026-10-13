// Minimal schema validation for structured action parameters. Unknown keys
// are dropped, so neither users nor an AI model can smuggle extra fields.

const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Field spec: { type: 'string'|'integer'|'number'|'boolean'|'enum'|'snowflake'|'ref',
 *   required?, default?, min?, max?, maxLength?, values?, pattern? }
 * 'ref' is a free-text reference to a Discord entity (name, mention or id)
 * that must be resolved against the guild before execution.
 */
export function validateParams(schema, input = {}) {
  const errors = [];
  const value = {};
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['parameters must be an object'], value };
  }
  for (const [key, spec] of Object.entries(schema)) {
    let v = input[key];
    if (v === undefined || v === null || v === '') {
      if (spec.default !== undefined) value[key] = spec.default;
      else if (spec.required) errors.push(`${key} is required`);
      continue;
    }
    switch (spec.type) {
      case 'string':
      case 'ref': {
        if (typeof v === 'number') v = String(v);
        if (typeof v !== 'string') {
          errors.push(`${key} must be text`);
          continue;
        }
        v = v.trim();
        const maxLength = spec.maxLength ?? (spec.type === 'ref' ? 100 : 2000);
        if (v.length > maxLength) errors.push(`${key} is longer than ${maxLength} characters`);
        if (spec.minLength && v.length < spec.minLength) errors.push(`${key} is too short`);
        if (spec.pattern && !spec.pattern.test(v)) errors.push(`${key} has an invalid format`);
        break;
      }
      case 'snowflake':
        v = String(v);
        if (!SNOWFLAKE.test(v)) errors.push(`${key} must be a Discord ID`);
        break;
      case 'integer':
      case 'number': {
        const n = typeof v === 'string' ? Number(v) : v;
        if (typeof n !== 'number' || !Number.isFinite(n) || (spec.type === 'integer' && !Number.isInteger(n))) {
          errors.push(`${key} must be ${spec.type === 'integer' ? 'a whole number' : 'a number'}`);
          continue;
        }
        if (spec.min !== undefined && n < spec.min) errors.push(`${key} must be at least ${spec.min}`);
        if (spec.max !== undefined && n > spec.max) errors.push(`${key} must be at most ${spec.max}`);
        v = n;
        break;
      }
      case 'boolean':
        if (typeof v === 'string') v = /^(true|yes|1|on)$/i.test(v);
        if (typeof v !== 'boolean') errors.push(`${key} must be true or false`);
        break;
      case 'enum':
        v = String(v).toLowerCase();
        if (!spec.values.includes(v)) errors.push(`${key} must be one of: ${spec.values.join(', ')}`);
        break;
      default:
        errors.push(`${key} has unsupported type`);
    }
    value[key] = v;
  }
  return { ok: errors.length === 0, errors, value };
}
