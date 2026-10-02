import type { WorkflowActivityBinding, WorkflowActivityDescriptor, WorkflowActivityRef, WorkflowJsonSchema, WorkflowStep } from '../../shared/api/runtime';

export const workflowPermissionOptions = [
  ['none', 'None'],
  ['read', 'Read only'],
  ['read-write', 'Read and write'],
  ['full', 'Read, write and shell'],
] as const satisfies readonly [NonNullable<WorkflowStep['permissions']>, string][];

export function activityDeclaresWorkflowTools(descriptor: WorkflowActivityDescriptor | undefined): boolean {
  return descriptor?.resources.location === 'agent' &&
    (Boolean(descriptor.resources.workspace) || Boolean(descriptor.resources.tools?.length));
}

export function workflowPermissionIsUnavailable(value: string | undefined): boolean {
  return Boolean(value) && !workflowPermissionOptions.some(([permission]) => permission === value);
}

export function activityPermissionEditor(descriptor: WorkflowActivityDescriptor | undefined, permission: string | undefined) {
  if (!activityDeclaresWorkflowTools(descriptor)) return null;
  const value = permission ?? 'none';
  return {
    value,
    options: [
      ...(workflowPermissionIsUnavailable(permission) ? [{ value: permission!, label: `${permission} · unavailable`, disabled: true }] : []),
      ...workflowPermissionOptions.map(([item, label]) => ({ value: item, label, disabled: false })),
    ],
  };
}

export type JsonEditResult = { value: unknown } | { error: string };

export function parseActivityJsonEdit(text: string, schema: WorkflowJsonSchema): JsonEditResult {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return { error: 'Enter valid JSON.' }; }
  const error = activityValueError(value, schema);
  return error ? { error } : { value };
}

export function parseRunInputSchemaEdit(text: string): JsonEditResult {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return { error: 'Enter a valid JSON schema.' }; }
  const error = schemaDocumentError(value);
  return error ? { error } : { value };
}

function schemaDocumentError(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value as WorkflowJsonSchema).type !== 'object')
    return 'Run input schema must be a JSON object schema.';
  const schema = value as WorkflowJsonSchema;
  if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties))
    return 'Run input schema needs an object of properties.';
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string' || !Object.hasOwn(schema.properties!, key))))
    return 'Required fields must name declared properties.';
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean')
    return 'additionalProperties must be true or false.';
  return nestedSchemaError(schema);
}

function nestedSchemaError(schema: WorkflowJsonSchema, path = 'Schema', depth = 0): string | null {
  if (depth > 12) return `${path} is too deeply nested.`;
  const supported = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || !supported.has(schema.type)) return `${path} has an unsupported type.`;
  const allowed = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems']);
  if (Object.keys(schema).some(key => !allowed.has(key))) return `${path} contains an unsupported schema keyword.`;
  if (schema.type === 'object') {
    if (schema.properties !== undefined && (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties))) return `${path}.properties must be an object.`;
    if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.length > 128 || schema.required.some(key => typeof key !== 'string' || !Object.hasOwn(schema.properties ?? {}, key)))) return `${path}.required must name declared fields.`;
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      const error = nestedSchemaError(child, `${path}.${key}`, depth + 1);
      if (error) return error;
    }
  } else if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) return `${path} uses object keywords on a non-object type.`;
  if (schema.type === 'array') {
    if (!schema.items) return `${path}.items is required for array values.`;
    const error = nestedSchemaError(schema.items, `${path}[]`, depth + 1);
    if (error) return error;
  } else if (schema.items !== undefined || schema.minItems !== undefined || schema.maxItems !== undefined) return `${path} uses array keywords on a non-array type.`;
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length || schema.enum.length > 256)) return `${path}.enum must be a bounded, nonempty array.`;
  const bounds = schema as unknown as Record<string, unknown>;
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems']) if (bounds[key] !== undefined && (!Number.isInteger(bounds[key]) || Number(bounds[key]) < 0 || Number(bounds[key]) > 64_000)) return `${path}.${key} must be a bounded nonnegative integer.`;
  for (const key of ['minimum', 'maximum']) if (bounds[key] !== undefined && (typeof bounds[key] !== 'number' || !Number.isFinite(bounds[key]))) return `${path}.${key} must be finite.`;
  if (schema.minLength !== undefined && schema.maxLength !== undefined && schema.minLength > schema.maxLength) return `${path}.minLength exceeds maxLength.`;
  if (schema.minItems !== undefined && schema.maxItems !== undefined && schema.minItems > schema.maxItems) return `${path}.minItems exceeds maxItems.`;
  if (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum) return `${path}.minimum exceeds maximum.`;
  return null;
}

function activityValueError(value: unknown, schema: WorkflowJsonSchema, path = 'Value'): string | null {
  const type = schema.type;
  const matches = type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object'
    ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : type === 'integer' ? Number.isInteger(value)
    : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
    : type === 'boolean' ? typeof value === 'boolean' : typeof value === 'string';
  if (!matches) return `${path} must be ${type === 'integer' ? 'an integer' : `a ${type}`}.`;
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) return `${path} must match one of the configured values.`;
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) return `${path} is shorter than the minimum length.`;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${path} exceeds the maximum length.`;
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return `${path} is below the minimum.`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path} exceeds the maximum.`;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return `${path} has too few items.`;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path} has too many items.`;
    if (schema.items) for (let i = 0; i < value.length; i++) {
      const error = activityValueError(value[i], schema.items, `${path}[${i}]`);
      if (error) return error;
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const objectValue = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!Object.hasOwn(objectValue, key)) return `${path}.${key} is required.`;
    for (const [key, item] of Object.entries(objectValue)) {
      const child = schema.properties?.[key];
      if (!child) {
        if (schema.additionalProperties === false) return `${path}.${key} is not allowed.`;
        continue;
      }
      const error = activityValueError(item, child, `${path}.${key}`);
      if (error) return error;
    }
  }
  return null;
}

export function activityBindingSourceKey(binding: WorkflowActivityBinding | undefined): string {
  return binding && 'from' in binding ? JSON.stringify(binding.from) : 'literal';
}

export function activityBindingSelectionValue(binding: WorkflowActivityBinding | undefined): string {
  return binding ? activityBindingSourceKey(binding) : 'omit';
}

export function activitySourceOptionKey(binding: WorkflowActivityBinding): string {
  return 'from' in binding ? JSON.stringify(binding.from) : 'literal';
}

export function activityBindingSourceIsAvailable(binding: WorkflowActivityBinding | undefined, sources: WorkflowActivityBinding[]): boolean {
  return !binding || !('from' in binding) || sources.some(source => activitySourceOptionKey(source) === activitySourceOptionKey(binding));
}

export type DeclaredObjectPath = { path: string[]; schema: WorkflowJsonSchema };

/** Enumerate declared object fields, including nested objects, without evaluating expressions or array indexes. */
export function declaredObjectPaths(schema: WorkflowJsonSchema | undefined, limit = 256): DeclaredObjectPath[] {
  if (!schema || !Number.isInteger(limit) || limit < 1) return [];
  const result: DeclaredObjectPath[] = [];
  const visit = (current: WorkflowJsonSchema, prefix: string[], depth: number) => {
    if (depth >= 12 || result.length >= limit || current.type !== 'object' || !Object.hasOwn(current, 'properties')) return;
    const properties = current.properties;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return;
    for (const key of Object.keys(properties)) {
      if (result.length >= limit) return;
      if (!Object.hasOwn(properties, key) || key.length > 128 || !key || ['__proto__', 'prototype', 'constructor'].includes(key)) continue;
      const child = properties[key];
      if (!child || typeof child !== 'object' || Array.isArray(child)) continue;
      const path = [...prefix, key];
      result.push({ path, schema: child });
      visit(child, path, depth + 1);
    }
  };
  visit(schema, [], 0);
  return result;
}

export function activitySchemaPathLabel(path: string[]): string {
  return path.map(segment => JSON.stringify(segment)).join(' › ');
}

export function activityJsonEditKey(nodeId: string, ref: WorkflowActivityRef, field: string): string {
  return JSON.stringify([nodeId, ref.id, ref.revision, field]);
}

export function changedActivityPin(current: WorkflowActivityRef | undefined, selected: WorkflowActivityRef): boolean {
  return current?.id !== selected.id || current?.revision !== selected.revision;
}

export function activityPinIsStale(pinnedDigest: string | undefined, currentDigest: string | undefined): boolean {
  return Boolean(pinnedDigest && currentDigest && pinnedDigest !== currentDigest);
}

export function activityEnumOptionIndex(values: unknown[], selected: unknown): string {
  const selectedIdentity = canonicalJsonIdentity(selected);
  const index = values.findIndex(value => canonicalJsonIdentity(value) === selectedIdentity);
  return index < 0 ? '' : String(index);
}

export function activityEnumValueAt(values: unknown[], optionIndex: string): unknown {
  if (optionIndex === '') return undefined;
  const index = Number(optionIndex);
  return Number.isInteger(index) && index >= 0 && index < values.length ? structuredClone(values[index]) : undefined;
}

function canonicalJsonIdentity(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonIdentity).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJsonIdentity(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
