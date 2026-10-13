/**
 * 插件的先后：拓扑排序。nodes 按装载顺序给出，同级的保持这个顺序；edges 里的 [a, b] 表示 a 排在 b 之前。
 * 排不出来（有环）时返回环上的一圈，首尾相同，如 [a, b, a]。
 */
export function topo(nodes: readonly string[], edges: readonly (readonly [string, string])[]): { sorted: string[] } | { cycle: string[] } {
  const rank = new Map(nodes.map((node, i) => [node, i]));
  const indegree = new Map(nodes.map((node) => [node, 0]));
  const next = new Map(nodes.map((node) => [node, [] as string[]]));
  for (const [a, b] of edges) {
    next.get(a)!.push(b);
    indegree.set(b, indegree.get(b)! + 1);
  }

  const sorted: string[] = [];
  const ready = nodes.filter((node) => indegree.get(node) === 0);
  while (ready.length > 0) {
    ready.sort((a, b) => rank.get(a)! - rank.get(b)!);
    const node = ready.shift()!;
    sorted.push(node);
    for (const b of next.get(node)!) {
      indegree.set(b, indegree.get(b)! - 1);
      if (indegree.get(b) === 0) ready.push(b);
    }
  }
  if (sorted.length === nodes.length) return { sorted };

  // 剩下的每个节点都有来自剩下节点的边：从任一个沿着来边往回走，走到重复的就是一圈
  const left = new Set(nodes.filter((node) => !sorted.includes(node)));
  const from = (b: string) => edges.find(([a, to]) => to === b && left.has(a))![0];
  const path: string[] = [];
  let node = [...left][0]!;
  while (!path.includes(node)) {
    path.push(node);
    node = from(node);
  }
  const cycle = path.slice(path.indexOf(node)).reverse();
  return { cycle: [...cycle, cycle[0]!] };
}
