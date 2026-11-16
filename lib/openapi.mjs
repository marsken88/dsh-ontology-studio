/**
 * 从本体生成 OpenAPI 3.1 文档。
 *
 * 方向是「本体 → OpenAPI」，不是反过来。本体已经声明了对象、主键、属性类型和
 * 动作入参，这些正好是接口定义需要的；反过来（文档 → 本体）要做语义判断，那是
 * 另一回事。
 *
 * 只产出规格，不产出服务端代码：路径和 schema 都在文档里，谁来接是实现方的事。
 */

/** 本体属性类型 → OpenAPI schema。 */
export function propertySchema(property) {
  const type = property.type;
  if (type === 'integer') return { type: 'integer' };
  if (type === 'number') return { type: 'number', format: 'double' };
  if (type === 'money') return { type: 'number', format: 'double', 'x-unit': 'currency' };
  if (type === 'boolean') return { type: 'boolean' };
  if (type === 'date') return { type: 'string', format: 'date' };
  if (type === 'datetime') return { type: 'string', format: 'date-time' };
  if (type === 'enum') return { type: 'string', enum: (property.enum || []).slice() };
  if (type === 'json') return { type: 'object', additionalProperties: true };
  return { type: 'string' };
}

function objectSchema(object) {
  const properties = {};
  const required = [];
  for (const p of object.properties || []) {
    const schema = propertySchema(p);
    if (p.label) schema.title = p.label;
    properties[p.name] = schema;
    if (p.required === true) required.push(p.name);
  }
  const out = {
    type: 'object',
    title: object.name || object.id,
    properties,
    additionalProperties: false,
  };
  if (required.length) out.required = required;
  if ((object.keys || []).length) out['x-primary-key'] = object.keys.slice();
  if (object.description) out.description = object.description;
  return out;
}

/** 路径名：Inventory → /inventory（复数不猜，避免不自洽）。 */
function pathOf(objectId) {
  return '/' + String(objectId).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function keyPathOf(object) {
  const keys = object.keys || [];
  if (!keys.length) return null;
  return keys.map((k) => '{' + k + '}').join('/');
}

/**
 * @param {object} ir validated package
 * @param {{ title?: string }} options
 */
export function generateOpenApi(ir, options = {}) {
  const schemas = {};
  const paths = {};
  const notes = [];

  for (const object of ir.objects || []) {
    schemas[object.id] = objectSchema(object);
    const base = pathOf(object.id);
    const listPath = {
      get: {
        operationId: 'list' + object.id,
        summary: '列出 ' + (object.name || object.id),
        tags: [object.id],
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0 } },
        ],
        responses: {
          200: {
            description: '对象列表',
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/' + object.id } },
              },
            },
          },
        },
      },
    };
    paths[base] = listPath;

    const keyPath = keyPathOf(object);
    if (keyPath) {
      paths[base + '/' + keyPath] = {
        get: {
          operationId: 'get' + object.id,
          summary: '按主键取一个 ' + (object.name || object.id),
          tags: [object.id],
          parameters: (object.keys || []).map((k) => {
            const property = (object.properties || []).find((p) => p.name === k) || { name: k, type: 'string' };
            return Object.assign({ name: k, in: 'path', required: true }, { schema: propertySchema(property) });
          }),
          responses: {
            200: {
              description: '对象',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/' + object.id } } },
            },
            404: { description: '不存在' },
          },
        },
      };
    } else {
      notes.push(object.id + ' 没有声明主键，不生成按主键查询的路径');
    }
  }

  for (const action of ir.actions || []) {
    const executable = Boolean(action.effect && Array.isArray(action.inputSchema) && action.inputSchema.length);
    if (!executable) {
      notes.push('动作 ' + action.id + ' 只有声明（缺 inputSchema 或 effect），没有生成路径');
      continue;
    }
    const body = {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    };
    for (const field of action.inputSchema) {
      const schema = propertySchema({ type: field.type, enum: field.enum });
      if (field.label) schema.title = field.label;
      body.properties[field.name] = schema;
      if (field.required === true) body.required.push(field.name);
    }
    if (!body.required.length) delete body.required;

    paths['/actions/' + action.id] = {
      post: {
        operationId: 'do_' + action.id,
        summary: action.name || action.id,
        description:
          (action.approvalRequired ? '需要人工审批。' : '免审批。') +
          '写 ' + (action.writes || []).join(', ') +
          '。这是声明式副作用在示例事实数据上的执行，不接业务系统。',
        tags: ['Actions'],
        requestBody: { required: true, content: { 'application/json': { schema: body } } },
        responses: {
          200: { description: '执行结果（含命中行数与规则回验）' },
          409: { description: '需要审批' },
          422: { description: '入参校验失败' },
        },
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: options.title || (ir.name || ir.id) + ' API',
      version: ir.version || '0.0.0',
      description: '由本体 ' + ir.id + ' 自动生成；对象与动作来自 IR 声明，不反映底层存储。',
    },
    tags: [
      ...(ir.objects || []).map((o) => ({ name: o.id, description: o.name || o.id })),
      { name: 'Actions', description: '声明式业务动作' },
    ],
    paths,
    components: { schemas },
    notes,
  };
}
