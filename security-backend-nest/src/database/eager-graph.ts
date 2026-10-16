import { DataSource, EntityManager, FindManyOptions, In, ObjectLiteral } from 'typeorm';
import { EntityMetadata } from 'typeorm/metadata/EntityMetadata';
import { RelationMetadata } from 'typeorm/metadata/RelationMetadata';

/**
 * Batched entity-graph loading (Performance P3).
 *
 * Most entities here mark their relations `eager: true`, and eagerness is recursive: a plain `find()`
 * on Shift, Incident, SafetyAlert, DailyLog, AttendanceEvent or Timesheet joined the whole reachable
 * graph (Shift -> Assignment -> Job -> Site -> Client -> Company -> User, and so on) into ONE statement
 * of 57-71 JOINs and 100-145 KB of SQL. On the production database such statements ran for minutes,
 * kept running past the statement timeout and after the process that issued them had gone, and took
 * the connection pooler down with them (S4 incident, 15 Oct 2026, ~22:04 UTC).
 *
 * With `enableGraphLoading(dataSource)`, a `find`, `findBy`, `findOne` or `findOneBy` whose eager graph
 * would need 9 JOINs or more returns the SAME entities, with the SAME nested objects, but reads them as:
 *  1. the root rows are read with no eager joins (a `where` or `order` on a relation still joins only
 *     what it filters on, exactly as before), carrying each relation's foreign key instead;
 *  2. related rows are then read by primary key, ONE `WHERE id IN (...)` per entity type at a time,
 *     never one per row; a row already read is reused wherever else the graph reaches it. Each of these
 *     statements also joins whole small subtrees (a Site with its Client, Company and their Users), up to
 *     JOIN_BUDGET JOINs, which keeps the number of round trips down;
 *  3. the objects are assembled as TypeORM's joins would have assembled them.
 *
 * Which relations are loaded is decided exactly as TypeORM 0.3 decides it (see `closure`): the root's
 * eager relations recursively, and each explicit relation with its own direct eager relations.
 * Anything it does not model (custom `select`, locks, relations other than many-to-one, owning
 * one-to-one and one-to-many, composite keys) is passed to `repo.find` unchanged, so the result is
 * never different, at worst not faster. Proven against TypeORM's own find in scripts/perf-dashboard-p3.spec.ts.
 */

type Tree = { [property: string]: Tree };

const MAX_DEPTH = 16;

function toTree(relations: FindManyOptions['relations']): Tree {
  const tree: Tree = {};
  if (!relations) return tree;
  if (Array.isArray(relations)) {
    for (const path of relations) {
      let node = tree;
      for (const part of String(path).split('.')) node = node[part] ??= {};
    }
    return tree;
  }
  for (const [key, value] of Object.entries(relations)) {
    if (!value) continue;
    tree[key] = typeof value === 'object' ? toTree(value as any) : {};
  }
  return tree;
}

function supported(relation: RelationMetadata): boolean {
  if (relation.inverseEntityMetadata.primaryColumns.length !== 1) return false;
  if (relation.isManyToOne || (relation.isOneToOne && relation.isOwning)) return relation.joinColumns.length === 1;
  if (relation.isOneToMany) {
    const inverse = relation.inverseRelation;
    return Boolean(inverse && inverse.isManyToOne && inverse.joinColumns.length === 1);
  }
  return false;
}

function merge(a: Tree, b: Tree): Tree {
  const out: Tree = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = out[k] ? merge(out[k], v) : v;
  return out;
}

/** Every eager relation reachable from `metadata`, recursively (FindOptionsUtils.joinEagerRelations). */
function eagerTree(metadata: EntityMetadata, depth: number): Tree | null {
  if (depth > MAX_DEPTH) return null;
  const tree: Tree = {};
  for (const relation of metadata.eagerRelations) {
    if (!supported(relation)) return null;
    const child = eagerTree(relation.inverseEntityMetadata, depth + 1);
    if (!child) return null;
    tree[relation.propertyPath] = child;
  }
  return tree;
}

/**
 * An explicitly requested relation: its entity's DIRECT eager relations only, one level, plus what is
 * explicitly nested under it (SelectQueryBuilder.buildEagerRelations, TypeORM 0.3).
 */
function explicitTree(metadata: EntityMetadata, explicit: Tree, withEager: boolean, depth: number): Tree | null {
  if (depth > MAX_DEPTH) return null;
  const tree: Tree = {};
  for (const [name, nested] of Object.entries(explicit)) {
    const relation = metadata.findRelationWithPropertyPath(name);
    if (!relation || !supported(relation)) return null;
    const node: Tree = {};
    if (withEager) {
      for (const eager of relation.inverseEntityMetadata.eagerRelations) {
        if (!supported(eager)) return null;
        node[eager.propertyPath] = {};
      }
    }
    const below = explicitTree(relation.inverseEntityMetadata, nested, withEager, depth + 1);
    if (!below) return null;
    tree[name] = merge(node, below);
  }
  return tree;
}

/**
 * The relation tree a TypeORM 0.3 `find` loads (join strategy): the root's eager relations recursively,
 * merged with the explicit relations, each of which brings only its own direct eager relations.
 */
function closure(metadata: EntityMetadata, explicit: Tree, withEager: boolean): Tree | null {
  const fromExplicit = explicitTree(metadata, explicit, withEager, 0);
  if (!fromExplicit) return null;
  if (!withEager) return fromExplicit;
  const fromEager = eagerTree(metadata, 0);
  return fromEager ? merge(fromEager, fromExplicit) : null;
}

function modelled(options: FindManyOptions<any>): boolean {
  const outside = ['select', 'lock', 'relationLoadStrategy', 'loadRelationIds', 'join', 'cache', 'transaction'];
  return !outside.some((key) => (options as any)[key] !== undefined);
}

/** A subtree as a key, independent of the order its relations were listed in. */
const canonical = (tree: Tree): string =>
  `{${Object.keys(tree).sort().map((k) => `${k}:${canonical(tree[k])}`).join(',')}}`;

const keyOf = (value: unknown) => (value === null || value === undefined ? null : String(value));

/** A foreign key left by loadRelationIds: the raw value, or (TypeORM 0.3) an object holding the primary key. */
const fkOf = (value: unknown, target: EntityMetadata): string | null => {
  if (value !== null && typeof value === 'object') return keyOf(target.primaryColumns[0].getEntityValue(value as ObjectLiteral));
  return keyOf(value);
};

const owningNames = (metadata: EntityMetadata, tree: Tree) =>
  Object.keys(tree).filter((name) => !metadata.findRelationWithPropertyPath(name)!.isOneToMany);

const idsOption = (names: string[]) => (names.length ? { loadRelationIds: { relations: names, disableMixedMap: true } } : {});

/** Edges in the relation tree: the number of JOINs TypeORM would have written for it. */
export function treeSize(tree: Tree): number {
  return Object.values(tree).reduce((sum, child) => sum + 1 + treeSize(child), 0);
}

/**
 * JOINs one batched statement may spend on reading complete subtrees with its rows, leaving room for the
 * joins a `where` on a relation needs: every statement stays within PostgreSQL's join_collapse_limit (8).
 */
const JOIN_BUDGET = 6;

/** True when the subtree reaches a one-to-many relation (joining it would multiply rows). */
function reachesMany(metadata: EntityMetadata, tree: Tree): boolean {
  return Object.entries(tree).some(([name, sub]) => {
    const relation = metadata.findRelationWithPropertyPath(name)!;
    return relation.isOneToMany || reachesMany(relation.inverseEntityMetadata, sub);
  });
}

/**
 * Splits `tree` into the complete subtrees one statement reads by joining (smallest first, within
 * `budget` JOINs, many-to-one / one-to-one only) and the rest, read in later batches.
 */
function split(metadata: EntityMetadata, tree: Tree, budget: number): { joined: Tree; deferred: Tree } {
  const joined: Tree = {};
  const deferred: Tree = {};
  let left = budget;
  const bySize = Object.entries(tree).sort(([, a], [, b]) => treeSize(a) - treeSize(b));
  for (const [name, sub] of bySize) {
    const relation = metadata.findRelationWithPropertyPath(name)!;
    const cost = treeSize(sub) + 1;
    if (!relation.isOneToMany && cost <= left && !reachesMany(relation.inverseEntityMetadata, sub)) {
      joined[name] = sub;
      left -= cost;
    } else {
      deferred[name] = sub;
    }
  }
  return { joined, deferred };
}

/** A relation tree as TypeORM `relations` find options. */
const asRelations = (tree: Tree): Record<string, any> =>
  Object.fromEntries(Object.entries(tree).map(([k, v]) => [k, Object.keys(v).length ? asRelations(v) : true]));

/** Find options that join `joined` and leave each deferred relation's foreign key on the rows. */
function readOptions(metadata: EntityMetadata, joined: Tree, deferred: Tree) {
  return {
    loadEagerRelations: false,
    ...(Object.keys(joined).length ? { relations: asRelations(joined) } : {}),
    ...idsOption(owningNames(metadata, deferred)),
  };
}

/**
 * The relation tree to assemble for `options` on `metadata`, or null when `repo.find` should run as it
 * is: options outside what is modelled, or a graph small enough (at most `minJoins - 1` JOINs) that one
 * statement is the cheaper way to read it.
 */
export function graphPlan(metadata: EntityMetadata, options: FindManyOptions<any> | undefined, minJoins: number): Tree | null {
  const opts = options ?? {};
  if (!modelled(opts) || metadata.primaryColumns.length !== 1) return null;
  const tree = closure(metadata, toTree(opts.relations), opts.loadEagerRelations !== false);
  return tree && treeSize(tree) >= minJoins ? tree : null;
}

async function loadGraph(manager: EntityManager, original: OriginalFinders, target: any, metadata: EntityMetadata, options: FindManyOptions<any>, tree: Tree) {
  const { relations: _relations, loadEagerRelations: _eager, ...rest } = options;
  const { joined, deferred } = split(metadata, tree, JOIN_BUDGET);
  const roots: ObjectLiteral[] = await original.find.call(manager, target, { ...rest, ...readOptions(metadata, joined, deferred) });
  await new GraphAssembler(manager, original).run(metadata, roots, deferred);
  return roots;
}

interface OriginalFinders {
  find: (this: EntityManager, target: any, options?: any) => Promise<any[]>;
  findOne: (this: EntityManager, target: any, options: any) => Promise<any>;
}

let originals: OriginalFinders | null = null;
const enabled = new WeakMap<DataSource, number>();

/**
 * Routes this DataSource's `find`, `findBy`, `findOne` and `findOneBy` (repositories, the manager and
 * transaction managers alike) through the batched loader whenever the eager graph would need
 * `minJoins` JOINs or more. Everything else, and every other DataSource, behaves exactly as before.
 */
export function enableGraphLoading(dataSource: DataSource, minJoins = GRAPH_LOADING_MIN_JOINS): DataSource {
  enabled.set(dataSource, minJoins);
  if (originals) return dataSource;
  const proto = EntityManager.prototype as any;
  originals = { find: proto.find, findOne: proto.findOne };
  const o = originals;
  const plan = (manager: EntityManager, target: any, options: any) => {
    const minimum = enabled.get(manager.connection);
    if (minimum === undefined) return null;
    const metadata = manager.connection.getMetadata(target);
    const tree = graphPlan(metadata, options, minimum);
    return tree ? { metadata, tree } : null;
  };
  proto.find = function find(this: EntityManager, target: any, options?: any) {
    const p = plan(this, target, options);
    return p ? loadGraph(this, o, target, p.metadata, options ?? {}, p.tree) : o.find.call(this, target, options);
  };
  proto.findBy = function findBy(this: EntityManager, target: any, where: any) {
    return this.find(target, { where });
  };
  proto.findOne = async function findOne(this: EntityManager, target: any, options: any) {
    const p = plan(this, target, options);
    if (!p) return o.findOne.call(this, target, options);
    const [first] = await loadGraph(this, o, target, p.metadata, { ...options, take: 1 }, p.tree);
    return first ?? null;
  };
  proto.findOneBy = function findOneBy(this: EntityManager, target: any, where: any) {
    return this.findOne(target, { where });
  };
  return dataSource;
}

/**
 * From 9 JOINs: beyond PostgreSQL's join_collapse_limit (8) the planner stops searching join orders
 * exhaustively, and every eager graph that hurt production was far past it (57-71).
 */
export const GRAPH_LOADING_MIN_JOINS = 9;

/** Rows of one entity type that share one relation subtree, keyed by primary key. */
interface Node {
  metadata: EntityMetadata;
  subtree: Tree;
  rows: Map<string, ObjectLiteral>;
  pending: Set<string>;
}

/** Children of one one-to-many relation, grouped by parent key. */
interface ChildNode {
  relation: RelationMetadata;
  subtree: Tree;
  byParent: Map<string, ObjectLiteral[]>;
  pending: Set<string>;
}

class GraphAssembler {
  private readonly nodes = new Map<string, Node>();
  private readonly childNodes = new Map<string, ChildNode>();
  private readonly owningLinks: Array<{ entity: ObjectLiteral; relation: RelationMetadata; node: Node; fk: string | null }> = [];
  private readonly childLinks: Array<{ entity: ObjectLiteral; relation: RelationMetadata; node: ChildNode; parent: string | null }> = [];

  constructor(private readonly manager: EntityManager, private readonly original: OriginalFinders) {}

  async run(metadata: EntityMetadata, roots: ObjectLiteral[], tree: Tree) {
    this.link(metadata, roots, tree);
    for (let wave = 0; wave <= MAX_DEPTH * 2; wave += 1) {
      const owning = [...this.nodes.values()].filter((n) => n.pending.size);
      const children = [...this.childNodes.values()].filter((n) => n.pending.size);
      if (!owning.length && !children.length) break;
      for (const node of owning) await this.loadNode(node);
      for (const node of children) await this.loadChildren(node);
    }
    for (const { entity, relation, node, fk } of this.owningLinks) {
      // Assigned, not setEntityValue: that merges into the { id } object loadRelationIds left there.
      (entity as any)[relation.propertyName] = fk === null ? null : node.rows.get(fk) ?? null;
    }
    for (const { entity, relation, node, parent } of this.childLinks) {
      (entity as any)[relation.propertyName] = parent === null ? [] : node.byParent.get(parent) ?? [];
    }
  }

  /** Records, for each relation in `tree`, which rows `entities` point at. */
  private link(metadata: EntityMetadata, entities: ObjectLiteral[], tree: Tree) {
    if (!entities.length) return;
    const primary = metadata.primaryColumns[0];
    for (const [name, subtree] of Object.entries(tree)) {
      const relation = metadata.findRelationWithPropertyPath(name)!;
      const target = relation.inverseEntityMetadata;
      if (relation.isOneToMany) {
        const key = `${metadata.name}.${name}:${canonical(subtree)}`;
        let node = this.childNodes.get(key);
        if (!node) this.childNodes.set(key, (node = { relation, subtree, byParent: new Map(), pending: new Set() }));
        for (const entity of entities) {
          const parent = keyOf(primary.getEntityValue(entity));
          this.childLinks.push({ entity, relation, node, parent });
          if (parent !== null && !node.byParent.has(parent)) node.pending.add(parent);
        }
        continue;
      }
      const key = `${target.name}:${canonical(subtree)}`;
      let node = this.nodes.get(key);
      if (!node) this.nodes.set(key, (node = { metadata: target, subtree, rows: new Map(), pending: new Set() }));
      for (const entity of entities) {
        const fk = fkOf((entity as any)[name], target);
        this.owningLinks.push({ entity, relation, node, fk });
        if (fk !== null && !node.rows.has(fk)) node.pending.add(fk);
      }
    }
  }

  private async loadNode(node: Node) {
    const ids = [...node.pending];
    node.pending.clear();
    const primary = node.metadata.primaryColumns[0];
    const { joined, deferred } = split(node.metadata, node.subtree, JOIN_BUDGET);
    const rows: ObjectLiteral[] = await this.original.find.call(this.manager, node.metadata.target, {
      where: { [primary.propertyPath]: In(ids) },
      ...readOptions(node.metadata, joined, deferred),
    });
    const fresh: ObjectLiteral[] = [];
    for (const row of rows) {
      const id = keyOf(primary.getEntityValue(row))!;
      if (node.rows.has(id)) continue;
      node.rows.set(id, row);
      fresh.push(row);
    }
    this.link(node.metadata, fresh, deferred);
  }

  private async loadChildren(node: ChildNode) {
    const parents = [...node.pending];
    node.pending.clear();
    const inverse = node.relation.inverseRelation!;
    const target = node.relation.inverseEntityMetadata;
    const parentPrimary = node.relation.entityMetadata.primaryColumns[0];
    const ownOwning = owningNames(target, node.subtree);
    const rows: ObjectLiteral[] = await this.original.find.call(this.manager, target.target, {
      where: { [inverse.propertyPath]: { [parentPrimary.propertyPath]: In(parents) } },
      // A joined load leaves a one-to-many array in whatever order the join produced; primary-key order
      // is the deterministic equivalent.
      order: { [target.primaryColumns[0].propertyPath]: 'ASC' },
      loadEagerRelations: false,
      ...idsOption([...new Set([...ownOwning, inverse.propertyPath])]),
    });
    for (const parent of parents) node.byParent.set(parent, []);
    for (const row of rows) {
      const parent = fkOf((row as any)[inverse.propertyPath], node.relation.entityMetadata);
      // The back-reference was read only to group the children; a joined load leaves it unset.
      if (!ownOwning.includes(inverse.propertyPath)) delete (row as any)[inverse.propertyPath];
      if (parent !== null) node.byParent.get(parent)?.push(row);
    }
    this.link(target, rows, node.subtree);
  }
}
