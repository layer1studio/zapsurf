export function buildReplyTree(rootId, replies, getParentId) {
  const nodes = new Map();
  for (const event of replies) {
    if (event.id && !nodes.has(event.id)) nodes.set(event.id, { event, children: [] });
  }

  const roots = [];
  for (const node of nodes.values()) {
    const parentId = getParentId(node.event);
    if (parentId === rootId) roots.push(node);
    else nodes.get(parentId)?.children.push(node);
  }

  const sort = siblings => {
    siblings.sort((a, b) => a.event.created_at - b.event.created_at || a.event.id.localeCompare(b.event.id));
    for (const node of siblings) sort(node.children);
  };
  sort(roots);
  return roots;
}