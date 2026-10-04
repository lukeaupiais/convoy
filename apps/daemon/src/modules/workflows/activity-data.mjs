import { createHash } from 'node:crypto';

export const MAX_ACTIVITY_SCHEMA_BYTES = 24_000;
export const MAX_ACTIVITY_VALUE_BYTES = 64_000;
export const MAX_ACTIVITY_DEPTH = 12;
export const MAX_ACTIVITY_ITEMS = 256;
export const MAX_ACTIVITY_KEYS = 128;

const schemaKeys = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum',
  'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems',
]);
const safePathPart = value => typeof value === 'string' && value.length > 0 &&
  value.length <= 128 && !['__proto__', 'prototype', 'constructor'].includes(value);
const primitiveTypes = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function activityDigest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function assertPlainJson(value, path = '$', depth = 0) {
  if (depth > MAX_ACTIVITY_DEPTH) throw new Error(`${path}: activity data is too deeply nested.`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path}: activity numbers must be finite.`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ACTIVITY_ITEMS) throw new Error(`${path}: activity arrays are too large.`);
    value.forEach((item, index) => assertPlainJson(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error(`${path}: activity data must contain plain JSON values.`);
  const keys = Object.keys(value);
  if (keys.length > MAX_ACTIVITY_KEYS) throw new Error(`${path}: activity objects contain too many fields.`);
  for (const key of keys) {
    if (!safePathPart(key)) throw new Error(`${path}: activity data contains an unsafe key.`);
    assertPlainJson(value[key], `${path}.${key}`, depth + 1);
  }
}

export function validateActivitySchema(schema, path = '$schema', depth = 0) {
  if (depth > MAX_ACTIVITY_DEPTH || !schema || typeof schema !== 'object' || Array.isArray(schema))
    throw new Error(`${path}: invalid activity schema.`);
  const bytes = Buffer.byteLength(JSON.stringify(schema));
  if (bytes > MAX_ACTIVITY_SCHEMA_BYTES) throw new Error(`${path}: activity schema is too large.`);
  for (const key of Object.keys(schema)) {
    if (!schemaKeys.has(key)) throw new Error(`${path}: unsupported activity schema keyword ${key}.`);
  }
  if (!primitiveTypes.has(schema.type)) throw new Error(`${path}: activity schema needs a supported type.`);
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || !schema.enum.length || schema.enum.length > MAX_ACTIVITY_ITEMS)
      throw new Error(`${path}: activity enum must be a bounded, nonempty list.`);
    for (const value of schema.enum) assertPlainJson(value, `${path}.enum`);
  }
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
    if (schema[key] !== undefined && (!Number.isInteger(schema[key]) || schema[key] < 0 || schema[key] > MAX_ACTIVITY_VALUE_BYTES))
      throw new Error(`${path}: ${key} must be a bounded nonnegative integer.`);
  }
  for (const key of ['minimum', 'maximum']) {
    if (schema[key] !== undefined && !Number.isFinite(schema[key])) throw new Error(`${path}: ${key} must be finite.`);
  }
  if (schema.minLength !== undefined && schema.maxLength !== undefined && schema.minLength > schema.maxLength)
    throw new Error(`${path}: minLength exceeds maxLength.`);
  if (schema.minItems !== undefined && schema.maxItems !== undefined && schema.minItems > schema.maxItems)
    throw new Error(`${path}: minItems exceeds maxItems.`);
  if (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum)
    throw new Error(`${path}: minimum exceeds maximum.`);
  if (schema.type === 'object') {
    if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties))
      throw new Error(`${path}: object schema needs properties.`);
    if (Object.keys(schema.properties).length > MAX_ACTIVITY_KEYS) throw new Error(`${path}: too many object properties.`);
    const required = schema.required ?? [];
    if (!Array.isArray(required) || required.length > MAX_ACTIVITY_KEYS || required.some(key => !safePathPart(key) || !Object.hasOwn(schema.properties, key)))
      throw new Error(`${path}: invalid required properties.`);
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean')
      throw new Error(`${path}: additionalProperties must be boolean.`);
    if (schema.items !== undefined || schema.minItems !== undefined || schema.maxItems !== undefined || schema.minLength !== undefined || schema.maxLength !== undefined || schema.minimum !== undefined || schema.maximum !== undefined)
      throw new Error(`${path}: schema keywords do not match object.`);
    for (const [key, value] of Object.entries(schema.properties)) {
      if (!safePathPart(key)) throw new Error(`${path}: unsafe object property.`);
      validateActivitySchema(value, `${path}.properties.${key}`, depth + 1);
    }
  } else if (schema.type === 'array') {
    if (!schema.items) throw new Error(`${path}: array schema needs items.`);
    if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined || schema.minLength !== undefined || schema.maxLength !== undefined || schema.minimum !== undefined || schema.maximum !== undefined)
      throw new Error(`${path}: schema keywords do not match array.`);
    validateActivitySchema(schema.items, `${path}.items`, depth + 1);
  } else {
    if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined || schema.items !== undefined || schema.minItems !== undefined || schema.maxItems !== undefined)
      throw new Error(`${path}: object/array keywords do not match ${schema.type}.`);
    if (schema.type !== 'string' && (schema.minLength !== undefined || schema.maxLength !== undefined) ||
        schema.type !== 'number' && schema.type !== 'integer' && (schema.minimum !== undefined || schema.maximum !== undefined))
      throw new Error(`${path}: scalar bounds do not match ${schema.type}.`);
  }
  return schema;
}

function matchesType(value, type) {
  return type === 'null' ? value === null
    : type === 'array' ? Array.isArray(value)
      : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
        : type === 'integer' ? Number.isInteger(value)
          : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
            : typeof value === type;
}

export function validateActivityValue(value, schema, path = '$') {
  validateActivitySchema(schema);
  assertPlainJson(value, path);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > MAX_ACTIVITY_VALUE_BYTES) throw new Error(`${path}: activity value is too large.`);
  if (!matchesType(value, schema.type)) throw new Error(`${path}: expected ${schema.type}.`);
  if (schema.enum && !schema.enum.some(item => activityDigest(item) === activityDigest(value))) throw new Error(`${path}: value is outside the declared enum.`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new Error(`${path}: string is too short.`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new Error(`${path}: string is too long.`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum)
      throw new Error(`${path}: number is outside the declared bounds.`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems || schema.maxItems !== undefined && value.length > schema.maxItems)
      throw new Error(`${path}: array length is outside the declared bounds.`);
    value.forEach((item, index) => validateActivityValue(item, schema.items, `${path}[${index}]`));
  }
  if (matchesType(value, 'object')) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) throw new Error(`${path}.${key}: required value is missing.`);
    if (schema.additionalProperties === false) {
      const extra = Object.keys(value).find(key => !Object.hasOwn(properties, key));
      if (extra !== undefined) throw new Error(`${path}.${extra}: property is not declared.`);
    }
    for (const [key, nested] of Object.entries(properties)) if (Object.hasOwn(value, key))
      validateActivityValue(value[key], nested, `${path}.${key}`);
  }
  return structuredClone(value);
}

export function activitySchemaAtPath(schema, path) {
  if (!Array.isArray(path) || !path.length || path.length > MAX_ACTIVITY_DEPTH || path.some(part => !safePathPart(part)))
    throw new Error('Activity output reference path is invalid.');
  let current = schema;
  for (const part of path) {
    if (current.type === 'object' && Object.hasOwn(current.properties ?? {}, part)) current = current.properties[part];
    else if (current.type === 'array' && /^(0|[1-9]\d*)$/.test(part) && Number(part) < MAX_ACTIVITY_ITEMS) current = current.items;
    else throw new Error('Activity output reference path is not declared by its source schema.');
  }
  return current;
}

export function resolveActivityPath(value, path) {
  let current = value;
  for (const part of path) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, part))
      throw new Error('Referenced workflow input or activity output is not available.');
    current = current[part];
  }
  return structuredClone(current);
}

export function resolveActivityBindings(bindings, inputSchema, sources) {
  const value = {};
  for (const [key, binding] of Object.entries(bindings ?? {})) {
    if (!safePathPart(key) || !Object.hasOwn(inputSchema.properties ?? {}, key))
      throw new Error(`Activity input ${key} is not declared.`);
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) throw new Error(`Activity input ${key} has an invalid binding.`);
    const keys = Object.keys(binding);
    if (keys.length !== 1 || !['literal', 'from'].includes(keys[0])) throw new Error(`Activity input ${key} has an invalid binding.`);
    if (Object.hasOwn(binding, 'literal')) value[key] = structuredClone(binding.literal);
    else {
      const from = binding.from;
      if (!from || typeof from !== 'object' || Array.isArray(from)) throw new Error(`Activity input ${key} has an invalid reference.`);
      if (from.kind === 'run_input') {
        activitySchemaAtPath(sources.runInputSchema, from.path);
        value[key] = resolveActivityPath(sources.runInput, from.path);
      } else if (from.kind === 'activity_output') {
        const output = sources.activityOutputs?.[from.nodeId];
        if (!output || output.status !== 'completed' || !Object.hasOwn(output, 'value')) throw new Error(`Activity output ${from.nodeId} is not complete in this run.`);
        activitySchemaAtPath(output.schema, from.path);
        value[key] = resolveActivityPath(output.value, from.path);
      } else if (from.kind === 'human_response') {
        const response = sources.humanResponses?.[from.nodeId];
        if (!response || !response.value || !response.schema) throw new Error(`Human response ${from.nodeId} is not available for this workflow effect.`);
        activitySchemaAtPath(response.schema, from.path);
        value[key] = resolveActivityPath(response.value, from.path);
      } else if (from.kind === 'agent_submission') {
        const submission = sources.agentSubmissions?.[from.nodeId];
        if (!submission || !submission.value || !submission.schema)
          throw new Error(`Accepted agent submission ${from.nodeId} is not available for this workflow effect.`);
        activitySchemaAtPath(submission.schema, from.path);
        value[key] = resolveActivityPath(submission.value, from.path);
      } else throw new Error(`Activity input ${key} has an unsupported reference kind.`);
    }
  }
  for (const key of inputSchema.required ?? []) if (!Object.hasOwn(value, key)) throw new Error(`Activity input ${key} is required.`);
  return validateActivityValue(value, inputSchema);
}

export function humanFormSchema(node) {
  const properties = {};
  const required = [];
  for (const field of node?.humanTask?.form?.fields ?? []) {
    const schema = field.type === 'text' ? { type: 'string', minLength: field.minLength ?? 0, maxLength: field.maxLength ?? 2000 }
      : field.type === 'number' ? { type: 'number', ...(field.minimum !== undefined ? { minimum: field.minimum } : {}), ...(field.maximum !== undefined ? { maximum: field.maximum } : {}) }
        : field.type === 'boolean' ? { type: 'boolean' }
          : field.type === 'date' ? { type: 'string', minLength: 10, maxLength: 10 }
            : { type: 'string', enum: field.options.map(option => option.value) };
    properties[field.id] = schema;
    if (field.required) required.push(field.id);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

export function agentSubmissionSchema(node) {
  const fields = [...new Set(Object.values(node?.submissionRequirements ?? {}).flatMap(rule => rule.fields ?? []))];
  return { type: 'object', properties: {
    summary: { type: 'string', minLength: 1, maxLength: 4000 },
    details: { type: 'object', properties: Object.fromEntries(fields.map(field => [field, { type: 'string', minLength: 1, maxLength: 4000 }])),
      required: [], additionalProperties: false },
  }, required: ['summary'], additionalProperties: false };
}

export function validateActivityBindings(node, workflow, activityCatalog) {
  const descriptor = activityCatalog.get(node.activity);
  if (!descriptor) throw new Error(`${node.name}: pinned activity revision is unavailable.`);
  const descriptorDigest = activityCatalog.digest(node.activity);
  if (node.activityDescriptorDigest !== undefined && node.activityDescriptorDigest !== descriptorDigest)
    throw new Error(`${node.name}: pinned activity descriptor changed or is unavailable.`);
  node.activityDescriptorDigest ??= descriptorDigest;
  const inputSchema = descriptor.inputSchema;
  const properties = inputSchema.properties ?? {};
  const bindings = node.bindings ?? {};
  for (const key of Object.keys(bindings)) if (!Object.hasOwn(properties, key))
    throw new Error(`${node.name}: activity input ${key} is not declared.`);
  for (const key of inputSchema.required ?? []) if (!Object.hasOwn(bindings, key))
    throw new Error(`${node.name}: activity input ${key} is required.`);
  const nodeIndex = new Map(workflow.nodes.map((candidate, index) => [candidate.id, index]));
  const canReach = (from, to) => {
    const pending = [from]; const seen = new Set();
    while (pending.length) {
      const current = pending.pop();
      if (current === to && current !== from) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      pending.push(...workflow.edges.filter(edge => edge.from === current).map(edge => edge.to));
    }
    return false;
  };
  for (const [key, binding] of Object.entries(bindings)) {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding) || Object.getPrototypeOf(binding) !== Object.prototype)
      throw new Error(`${node.name}: activity input ${key} has an invalid binding.`);
    const bindingKeys = Object.keys(binding);
    if (bindingKeys.length !== 1 || !['literal', 'from'].includes(bindingKeys[0]))
      throw new Error(`${node.name}: activity input ${key} has an invalid binding.`);
    if (Object.hasOwn(binding, 'literal')) validateActivityValue(binding.literal, properties[key], `${node.name}.${key}`);
    else if (binding.from?.kind === 'run_input') {
      if (Object.keys(binding.from).some(field => !['kind', 'path'].includes(field)) || !Array.isArray(binding.from.path) || binding.from.path.some(part => !safePathPart(part)))
        throw new Error(`${node.name}: run input reference is invalid.`);
      const sourceSchema = activitySchemaAtPath(workflow.runInputSchema, binding.from.path);
      if (!schemaAssignable(sourceSchema, properties[key])) throw new Error(`${node.name}: run input reference is incompatible with activity input ${key}.`);
    }
    else if (binding.from?.kind === 'activity_output') {
      const sourceIndex = nodeIndex.get(binding.from.nodeId);
      const source = workflow.nodes[sourceIndex];
      const sourceDescriptor = source && (source.activity ? activityCatalog.get(source.activity) : null);
      const sourceSchema = sourceDescriptor?.outputSchema ?? (['child', 'parallel', 'map'].includes(source?.kind) ? source.outputSchema : null);
      if (Object.keys(binding.from).some(field => !['kind', 'nodeId', 'path'].includes(field)) || typeof binding.from.nodeId !== 'string' ||
          sourceIndex === undefined || !canReach(source.id, node.id) || !sourceSchema || !Array.isArray(binding.from.path) || binding.from.path.some(part => !safePathPart(part)))
        throw new Error(`${node.name}: activity output reference must name a prior registered activity.`);
      const sourcePropertySchema = activitySchemaAtPath(sourceSchema, binding.from.path);
      if (!schemaAssignable(sourcePropertySchema, properties[key])) throw new Error(`${node.name}: activity output reference is incompatible with activity input ${key}.`);
    } else if (binding.from?.kind === 'human_response') {
      const sourceIndex = nodeIndex.get(binding.from.nodeId);
      const source = workflow.nodes[sourceIndex];
      if (Object.keys(binding.from).some(field => !['kind', 'nodeId', 'path'].includes(field)) || typeof binding.from.nodeId !== 'string' ||
          sourceIndex === undefined || !canReach(source.id, node.id) || source.kind !== 'human' || !Array.isArray(binding.from.path) || binding.from.path.some(part => !safePathPart(part)))
        throw new Error(`${node.name}: form response reference must name a prior human task field.`);
      const sourceSchema = activitySchemaAtPath(humanFormSchema(source), binding.from.path);
      if (!schemaAssignable(sourceSchema, properties[key])) throw new Error(`${node.name}: human response reference is incompatible with activity input ${key}.`);
    } else if (binding.from?.kind === 'agent_submission') {
      const sourceIndex = nodeIndex.get(binding.from.nodeId);
      const source = workflow.nodes[sourceIndex];
      if (Object.keys(binding.from).some(field => !['kind', 'nodeId', 'path'].includes(field)) || typeof binding.from.nodeId !== 'string' ||
          sourceIndex === undefined || !canReach(source.id, node.id) || source.kind !== 'agent' ||
          !Array.isArray(binding.from.path) || binding.from.path.some(part => !safePathPart(part)))
        throw new Error(`${node.name}: agent submission reference must name a prior configured submission field.`);
      const sourceSchema = activitySchemaAtPath(agentSubmissionSchema(source), binding.from.path);
      if (!schemaAssignable(sourceSchema, properties[key])) throw new Error(`${node.name}: agent submission reference is incompatible with activity input ${key}.`);
    } else throw new Error(`${node.name}: activity input ${key} has an invalid binding.`);
  }
}

export function schemaAssignable(source, target) {
  if (source.type !== target.type && !(source.type === 'integer' && target.type === 'number')) return false;
  if (source.type === 'number' || source.type === 'integer') {
    if (target.minimum !== undefined && (source.minimum === undefined || source.minimum < target.minimum)) return false;
    if (target.maximum !== undefined && (source.maximum === undefined || source.maximum > target.maximum)) return false;
  }
  if (source.type === 'string') {
    if (target.minLength !== undefined && (source.minLength === undefined || source.minLength < target.minLength)) return false;
    if (target.maxLength !== undefined && (source.maxLength === undefined || source.maxLength > target.maxLength)) return false;
  }
  if (source.type === 'array') {
    if (!schemaAssignable(source.items, target.items)) return false;
    if (target.minItems !== undefined && (source.minItems === undefined || source.minItems < target.minItems)) return false;
    if (target.maxItems !== undefined && (source.maxItems === undefined || source.maxItems > target.maxItems)) return false;
  }
  if (source.type === 'object') {
    if (target.additionalProperties === false && source.additionalProperties !== false) return false;
    for (const key of target.required ?? []) if (!(source.required ?? []).includes(key)) return false;
    if (source.additionalProperties !== false && Object.keys(target.properties ?? {}).some(key => !Object.hasOwn(source.properties ?? {}, key)))
      return false;
    for (const [key, sourceProperty] of Object.entries(source.properties ?? {})) {
      const targetProperty = target.properties?.[key];
      if (!targetProperty && target.additionalProperties === false) return false;
      if (targetProperty && !schemaAssignable(sourceProperty, targetProperty)) return false;
    }
    for (const [key, targetProperty] of Object.entries(target.properties ?? {})) {
      const sourceProperty = source.properties?.[key];
      if ((target.required ?? []).includes(key) && !sourceProperty) return false;
    }
  }
  if (target.enum && (!source.enum || source.enum.some(value => !target.enum.some(candidate => activityDigest(candidate) === activityDigest(value))))) return false;
  return true;
}

export function validateWorkflowResultBindings(workflow, activityCatalog) {
  if (!workflow.resultSchema) return;
  const schema = workflow.resultSchema;
  const properties = schema.properties ?? {};
  const nodeIds = new Set(workflow.nodes.map(node => node.id));
  const nodeById = new Map(workflow.nodes.map(node => [node.id, node]));
  const reaches = (from, to) => {
    if (from === to) return true;
    const todo = [from], seen = new Set();
    while (todo.length) {
      const current = todo.pop();
      if (current === to) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const edge of workflow.edges) if (edge.from === current) todo.push(edge.to);
    }
    return false;
  };
  const terminalNodes = workflow.nodes.filter(node => !workflow.edges.some(edge => edge.from === node.id));
  const mappings = workflow.resultBindingsByTerminal ?? {};
  for (const terminalId of Object.keys(mappings)) if (!nodeIds.has(terminalId) || workflow.edges.some(edge => edge.from === terminalId))
    throw new Error(`Workflow result mapping ${terminalId} must identify a successful terminal node.`);
  for (const terminal of terminalNodes) {
    const bindings = mappings[terminal.id] ?? workflow.resultBindings;
    if (!bindings) throw new Error(`Workflow terminal ${terminal.id} needs an explicit result mapping.`);
    if (Object.keys(bindings).some(key => !Object.hasOwn(properties, key)) ||
        (schema.required ?? []).some(key => !Object.hasOwn(bindings, key)))
      throw new Error(`Workflow result bindings for ${terminal.id} must provide the declared result fields.`);
    for (const [key, binding] of Object.entries(bindings)) {
      if (!binding || typeof binding !== 'object' || Array.isArray(binding) || Object.getPrototypeOf(binding) !== Object.prototype)
        throw new Error(`Workflow result ${terminal.id}.${key} has an invalid binding.`);
      const fields = Object.keys(binding);
      if (fields.length !== 1 || !['literal', 'from'].includes(fields[0])) throw new Error(`Workflow result ${terminal.id}.${key} has an invalid binding.`);
      if (Object.hasOwn(binding, 'literal')) { validateActivityValue(binding.literal, properties[key], `result.${key}`); continue; }
      const from = binding.from;
      if (!from || typeof from !== 'object' || Array.isArray(from)) throw new Error(`Workflow result ${terminal.id}.${key} has an invalid reference.`);
      let source;
      if (from.kind === 'run_input' && Object.keys(from).every(field => ['kind', 'path'].includes(field)) && Array.isArray(from.path))
        source = activitySchemaAtPath(workflow.runInputSchema, from.path);
      else if (['activity_output', 'human_response', 'agent_submission'].includes(from.kind) &&
          Object.keys(from).every(field => ['kind', 'nodeId', 'path'].includes(field)) && typeof from.nodeId === 'string' &&
          nodeIds.has(from.nodeId) && Array.isArray(from.path) && reaches(from.nodeId, terminal.id)) {
        const node = nodeById.get(from.nodeId);
        if (from.kind === 'activity_output') {
          const descriptor = node?.activity ? activityCatalog.get(node.activity) : null;
          const outputSchema = descriptor?.outputSchema ?? (['child', 'parallel', 'map'].includes(node?.kind) ? node.outputSchema : null);
          if (!outputSchema) throw new Error(`Workflow result ${terminal.id}.${key} must reference a declared activity output.`);
          source = activitySchemaAtPath(outputSchema, from.path);
        } else if (from.kind === 'human_response') {
          if (node?.kind !== 'human') throw new Error(`Workflow result ${terminal.id}.${key} must reference a human task response.`);
          source = activitySchemaAtPath(humanFormSchema(node), from.path);
        } else {
          if (node?.kind !== 'agent') throw new Error(`Workflow result ${terminal.id}.${key} must reference an agent submission.`);
          source = activitySchemaAtPath(agentSubmissionSchema(node), from.path);
        }
      } else throw new Error(`Workflow result ${terminal.id}.${key} has an invalid reference.`);
      if (!schemaAssignable(source, properties[key])) throw new Error(`Workflow result ${terminal.id}.${key} is incompatible with its source.`);
    }
  }
}
