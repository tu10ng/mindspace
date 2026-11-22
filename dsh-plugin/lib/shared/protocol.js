export const VERSION = '0.1.0'
export const PANEL_ID = 'mindspace'
export const PANEL_ORDER = 85
export const LOCALE_NS = 'dsh-mindspace'
export const ROUTE_BASE = '/api/mindspace'
export const ASSET_BASE = 'api/mindspace/assets'

export const ROUTES = Object.freeze({
  state: `${ROUTE_BASE}/state`,
  ingest: `${ROUTE_BASE}/ingest`,
  layout: `${ROUTE_BASE}/layout`,
  models: `${ROUTE_BASE}/models`,
  stream: `${ROUTE_BASE}/stream`,
  assets: `${ROUTE_BASE}/assets`,
})

export const ROLE_ORDER = Object.freeze([
  'object',
  'concept',
  'proposition',
  'method',
  'tendency',
  'constraint',
  'action',
  'flow',
  'relation_type',
  'case',
  'record',
])

export const ROLE_META = Object.freeze({
  object: { label: '对象', stroke: '#1d4ed8', fill: '#dbeafe', badge: 'OBJ' },
  concept: { label: '概念', stroke: '#0f766e', fill: '#ccfbf1', badge: 'CON' },
  proposition: { label: '命题', stroke: '#b45309', fill: '#fef3c7', badge: 'PROP' },
  method: { label: '方法', stroke: '#15803d', fill: '#dcfce7', badge: 'MTD' },
  tendency: { label: '倾向', stroke: '#7e22ce', fill: '#f3e8ff', badge: 'TND' },
  constraint: { label: '约束', stroke: '#b91c1c', fill: '#fee2e2', badge: 'CST' },
  action: { label: '动作', stroke: '#0369a1', fill: '#e0f2fe', badge: 'ACT' },
  flow: { label: '流程', stroke: '#4338ca', fill: '#e0e7ff', badge: 'FLW' },
  relation_type: { label: '关系类型', stroke: '#be185d', fill: '#fce7f3', badge: 'REL' },
  case: { label: '案例', stroke: '#475569', fill: '#f1f5f9', badge: 'CASE' },
  record: { label: '记录', stroke: '#57534e', fill: '#f5f5f4', badge: 'REC' },
})
