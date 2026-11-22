import { ROLE_META, ROLE_ORDER } from '../shared/protocol.js'

const NODE_PREFIX = 'ms-node:'
const EDGE_PREFIX = 'ms-edge:'
const COL_GAP = 290
const ROW_GAP = 135
const GROUP_GAP = 180
const MAX_COLS = 5

export function consIdFromElement(element) {
  if (typeof element?.customData?.consId === 'string') return element.customData.consId
  if (typeof element?.id === 'string' && element.id.startsWith(NODE_PREFIX)) {
    return element.id.slice(NODE_PREFIX.length)
  }
  return null
}

export function primaryRole(node) {
  const roles = Array.isArray(node?.roles) ? node.roles : []
  for (const r of ROLE_ORDER) {
    if (roles.includes(r)) return r
  }
  return roles[0] ?? 'object'
}

function measureNode(node) {
  const title = typeof node.title === 'string' && node.title.trim() !== '' ? node.title.trim() : node.id
  const width = Math.min(260, Math.max(176, 86 + Math.min(title.length, 20) * 8))
  const height = title.length > 16 ? 82 : 68
  return { width, height }
}

function truncateLabel(text, max = 34) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, max - 1)}…`
}

function rectEdgePoint(box, targetX, targetY, gap = 6) {
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const dx = targetX - cx
  const dy = targetY - cy
  const len = Math.hypot(dx, dy)
  if (len < 1e-6) return { x: cx, y: cy }
  const hw = box.width / 2
  const hh = box.height / 2
  const scale = Math.min(
    Math.abs(dx) > 1e-6 ? hw / Math.abs(dx) : Infinity,
    Math.abs(dy) > 1e-6 ? hh / Math.abs(dy) : Infinity,
  )
  return {
    x: cx + dx * scale + (dx / len) * gap,
    y: cy + dy * scale + (dy / len) * gap,
  }
}

function computeArrowEndpoints(fromBox, toBox) {
  const fromCx = fromBox.x + fromBox.width / 2
  const fromCy = fromBox.y + fromBox.height / 2
  const toCx = toBox.x + toBox.width / 2
  const toCy = toBox.y + toBox.height / 2
  const startPt = rectEdgePoint(fromBox, toCx, toCy, 6)
  const endPt = rectEdgePoint(toBox, fromCx, fromCy, 6)
  const vx = toCx - fromCx
  const vy = toCy - fromCy
  const dx = endPt.x - startPt.x
  const dy = endPt.y - startPt.y
  if (dx * vx + dy * vy <= 0) {
    return {
      x: fromCx,
      y: fromCy,
      dx: toCx - fromCx,
      dy: toCy - fromCy,
    }
  }
  return {
    x: startPt.x,
    y: startPt.y,
    dx,
    dy,
  }
}

function overlapsAny(x, y, width, height, occupied) {
  const pad = 28
  for (const box of occupied) {
    if (
      x < box.x + box.width + pad &&
      x + width + pad > box.x &&
      y < box.y + box.height + pad &&
      y + height + pad > box.y
    ) {
      return true
    }
  }
  return false
}

function findFreeSpotNear(anchor, width, height, occupied) {
  const offsets = [
    [300, 0],
    [0, 145],
    [300, 145],
    [-300, 0],
    [0, -145],
    [300, -145],
    [-300, 145],
    [600, 0],
    [0, 290],
    [600, 145],
  ]
  for (let ring = 1; ring <= 4; ring += 1) {
    for (const [dx, dy] of offsets) {
      const x = Math.round(anchor.x + dx * ring)
      const y = Math.round(anchor.y + dy * ring)
      if (!overlapsAny(x, y, width, height, occupied)) {
        return { x, y }
      }
    }
  }
  return { x: Math.round(anchor.x + 320), y: Math.round(anchor.y + 150) }
}

export function computeNodePositions(graph, savedPositions = {}) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const edges = Array.isArray(graph?.edges) ? graph.edges : []
  const result = {}
  const occupied = []

  const adjacency = new Map()
  for (const edge of edges) {
    const a = edge.from?.consId
    const b = edge.to?.consId
    if (!a || !b || a === b) continue
    if (!adjacency.has(a)) adjacency.set(a, new Set())
    if (!adjacency.has(b)) adjacency.set(b, new Set())
    adjacency.get(a).add(b)
    adjacency.get(b).add(a)
  }

  for (const node of nodes) {
    const saved = savedPositions?.[node.id]
    const measured = measureNode(node)
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      const box = {
        x: Math.round(saved.x),
        y: Math.round(saved.y),
        width: Number.isFinite(saved.width) ? Math.round(saved.width) : measured.width,
        height: Number.isFinite(saved.height) ? Math.round(saved.height) : measured.height,
      }
      result[node.id] = box
      occupied.push(box)
    }
  }

  const missing = nodes.filter((n) => result[n.id] === undefined)
  if (missing.length === 0) return result

  const hasSavedAny = Object.keys(result).length > 0
  if (hasSavedAny) {
    const stillMissing = []
    for (const node of missing) {
      const neighbors = adjacency.get(node.id)
      let placed = null
      if (neighbors) {
        for (const nbId of neighbors) {
          if (result[nbId]) {
            const measured = measureNode(node)
            const spot = findFreeSpotNear(result[nbId], measured.width, measured.height, occupied)
            placed = { ...spot, ...measured }
            break
          }
        }
      }
      if (placed !== null) {
        result[node.id] = placed
        occupied.push(placed)
      } else {
        stillMissing.push(node)
      }
    }
    if (stillMissing.length === 0) return result
    let maxY = 0
    for (const box of occupied) {
      if (box.y + box.height > maxY) maxY = box.y + box.height
    }
    const baseY = maxY + 140
    stillMissing.forEach((node, idx) => {
      const measured = measureNode(node)
      const col = idx % MAX_COLS
      const row = Math.floor(idx / MAX_COLS)
      const box = {
        x: col * COL_GAP,
        y: baseY + row * ROW_GAP,
        ...measured,
      }
      result[node.id] = box
      occupied.push(box)
    })
    return result
  }

  const groups = new Map()
  for (const node of missing) {
    const role = primaryRole(node)
    if (!groups.has(role)) groups.set(role, [])
    groups.get(role).push(node)
  }

  const orderedRoles = [...groups.keys()].sort((a, b) => {
    const ia = ROLE_ORDER.indexOf(a)
    const ib = ROLE_ORDER.indexOf(b)
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
  })

  let cursorY = 0
  for (const role of orderedRoles) {
    const list = groups.get(role)
    const cols = Math.min(MAX_COLS, Math.max(1, Math.ceil(Math.sqrt(list.length))))
    list.forEach((node, idx) => {
      const measured = measureNode(node)
      const col = idx % cols
      const row = Math.floor(idx / cols)
      const box = {
        x: col * COL_GAP,
        y: cursorY + row * ROW_GAP,
        ...measured,
      }
      result[node.id] = box
      occupied.push(box)
    })
    const rows = Math.ceil(list.length / cols)
    cursorY += rows * ROW_GAP + GROUP_GAP
  }

  return result
}

export function buildSceneElements({ graph, savedPositions, highlightNodeIds, convertToExcalidrawElements }) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const edges = Array.isArray(graph?.edges) ? graph.edges : []
  const highlightSet = new Set(Array.isArray(highlightNodeIds) ? highlightNodeIds : [])

  const nodeMap = new Map(nodes.map((n) => [n.id, n]))
  const positions = computeNodePositions(graph, savedPositions)

  const skeletons = []

  for (const node of nodes) {
    const pos = positions[node.id]
    if (!pos) continue
    const role = primaryRole(node)
    const meta = ROLE_META[role] ?? { label: role, stroke: '#334155', fill: '#f1f5f9', badge: role.toUpperCase() }
    const isHighlighted = highlightSet.has(node.id)
    const title = truncateLabel(node.title || node.id, 30)
    const labelText = `[${meta.label}] ${title}`
    skeletons.push({
      id: `${NODE_PREFIX}${node.id}`,
      type: 'rectangle',
      x: pos.x,
      y: pos.y,
      width: pos.width,
      height: pos.height,
      strokeColor: isHighlighted ? '#ea580c' : meta.stroke,
      backgroundColor: isHighlighted ? '#ffedd5' : meta.fill,
      fillStyle: 'solid',
      strokeWidth: isHighlighted ? 3 : 2,
      strokeStyle: node.status === 'draft' ? 'dashed' : 'solid',
      roughness: 0,
      roundness: { type: 3 },
      opacity: node.status === 'archived' ? 50 : 100,
      label: {
        text: labelText,
        fontSize: 14,
        fontFamily: 2,
        strokeColor: '#0f172a',
        textAlign: 'center',
        verticalAlign: 'middle',
      },
      customData: {
        kind: 'node',
        consId: node.id,
        role,
      },
    })
  }

  for (const edge of edges) {
    const fromId = edge.from?.consId
    const toId = edge.to?.consId
    if (!fromId || !toId || !positions[fromId] || !positions[toId]) continue
    const fromBox = positions[fromId]
    const toBox = positions[toId]
    const relNode = nodeMap.get(edge.relationConsId)
    const relLabel = truncateLabel(relNode?.title || edge.relationConsId, 18)

    if (fromId === toId) {
      skeletons.push({
        id: `${EDGE_PREFIX}${edge.id}`,
        type: 'arrow',
        x: fromBox.x + fromBox.width,
        y: fromBox.y + fromBox.height / 2,
        points: [
          [0, 0],
          [42, -32],
          [0, -48],
        ],
        strokeColor: '#64748b',
        strokeWidth: 1.5,
        strokeStyle: edge.status === 'archived' ? 'dotted' : 'solid',
        roughness: 0,
        opacity: edge.status === 'archived' ? 45 : 85,
        label: {
          text: relLabel,
          fontSize: 11,
          fontFamily: 2,
          strokeColor: '#475569',
        },
        customData: {
          kind: 'edge',
          edgeId: edge.id,
          fromConsId: fromId,
          toConsId: toId,
          relationConsId: edge.relationConsId,
        },
      })
      continue
    }

    const arrowGeom = computeArrowEndpoints(fromBox, toBox)
    skeletons.push({
      id: `${EDGE_PREFIX}${edge.id}`,
      type: 'arrow',
      x: arrowGeom.x,
      y: arrowGeom.y,
      width: Math.abs(arrowGeom.dx),
      height: Math.abs(arrowGeom.dy),
      points: [
        [0, 0],
        [arrowGeom.dx, arrowGeom.dy],
      ],
      start: { id: `${NODE_PREFIX}${fromId}` },
      end: { id: `${NODE_PREFIX}${toId}` },
      strokeColor: '#64748b',
      strokeWidth: 1.5,
      strokeStyle: edge.status === 'archived' ? 'dotted' : 'solid',
      roughness: 0,
      opacity: edge.status === 'archived' ? 45 : 85,
      endArrowhead: 'arrow',
      label: {
        text: relLabel,
        fontSize: 11,
        fontFamily: 2,
        strokeColor: '#334155',
      },
      customData: {
        kind: 'edge',
        edgeId: edge.id,
        fromConsId: fromId,
        toConsId: toId,
        relationConsId: edge.relationConsId,
      },
    })
  }

  const elements = convertToExcalidrawElements(skeletons, { regenerateIds: false })
  return { elements, positions }
}

export function extractPositionsFromScene(elements) {
  const next = {}
  for (const el of elements ?? []) {
    if (el?.isDeleted) continue
    const consId = consIdFromElement(el)
    if (consId !== null && el.type === 'rectangle' && Number.isFinite(el.x) && Number.isFinite(el.y)) {
      next[consId] = {
        x: Math.round(el.x),
        y: Math.round(el.y),
        width: Math.round(el.width ?? 200),
        height: Math.round(el.height ?? 72),
      }
    }
  }
  return next
}
