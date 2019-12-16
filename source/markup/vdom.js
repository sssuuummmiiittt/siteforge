/* © 2019 Robert Grimm */

import htm from 'htm';
import { not } from '../tooling/function.js';

const { apply } = Reflect;
const configurable = true;
const { defineProperty, freeze } = Object;
const { isArray } = Array;

/**
 * Create a new node. This version of the core vDOM element constructor is a bit
 * unusual in that it does almost nothing. Notably, it only adds the `type` and
 * `children` to the `props` object instead of freshly allocating a new node.
 */
export const h = (type, props, ...children) => {
  props = Object(props);
  props.type = type;
  props.children = children;
  return props;
};

/** Parse a thusly tagged string template into the vDOM. */
export const html = htm.bind(h);

/** Determine the tag name for a vDOM node including view components. */
export const tag = node => {
  if (typeof node.type === 'function') {
    return node.type.name || 'ViewComponent';
  } else {
    return node.type;
  }
};

/** Determine whether the given name is for an internal property. */
export const isInternalProperty = name =>
  name === 'type' || name === 'children';

const IgnoredTypes = new Set(['boolean', 'function', 'symbol']);
const TextualTypes = new Set(['bigint', 'number', 'string']);

/**
 * Determine whether the given value is treated as internal, i.e., an artifact
 * of vDOM rendering.
 */
export const isInternalChild = child =>
  child == null || child === '' || IgnoredTypes.has(typeof child);

/**
 * Determine whether the given value is textual, i.e., contributes to text
 * between tags.
 */
export const isTextualChild = child => TextualTypes.has(typeof child);

defineProperty(isInternalChild, 'not', {
  configurable,
  value: not(isInternalChild),
});

/** Determine whether the value is a component. */
export const isComponent = value =>
  value != null && typeof value.type === 'function';

/** Opcodes when traversing the vDOM. */
export const Opcode = freeze({
  Text: Symbol('text'),
  EnterNode: Symbol('enter-node'),
  ExitNode: Symbol('exit-node'),
});

/**
 * Traverse the vDOM rooted at the given node. This function traverses the vDOM
 * tree rooted at the given node. It ignores children that are considered
 * internal—`undefined`, `null`, `false`, `true`, and symbols. It also coalesces
 * subsequent text fragments into a single string, while ignoring any
 * interspersed internal values. Finally, it evaluates embedded function hooks
 * and renders embedded components. The resulting, significantly cleaned up vDOM
 * is not reified but rather yielded by the returned generator. Every record
 * yielded has three fields: `code` for the opcode, `parent` for the parent node
 * in the vDOM, and `node` for the current node, which may be a string. Valid
 * opcodes are `Text` for text nodes, `EnterNode` when first encountering a
 * node, and `ExitNode` after its children have been processed. Function hooks
 * and render methods may execute asynchronously.
 */
export async function* traverse(
  node,
  { context = {}, hooks = {}, traverseChildren = true } = {}
) {
  const ancestors = [];
  const pending = [node];
  const fragments = [];
  const bufferFragment = fragment => fragments.push(fragment);
  const hasFragments = () => fragments.length > 0;
  const joinFragments = () => {
    const text = fragments.join('');
    fragments.length = 0;
    return text;
  };

  while (pending.length) {
    const parent = ancestors[ancestors.length - 1];
    let node = pending.pop();
    const type = typeof node;

    if (isInternalChild(node)) {
      // >>> Ingore internal values
      continue;
    } else if (type === 'bigint' || type === 'number' || type === 'string') {
      // >>> Buffer Any Number or String
      bufferFragment(String(node));
      continue;
    } else if (isArray(node)) {
      // >>> Unwrap Array Elements
      for (let index = node.length - 1; index >= 0; index--) {
        pending.push(node[index]);
      }
      continue;
    } else if (hasFragments()) {
      // >>> Yield Buffered Fragments Since Node Actually Is a Node!
      yield { code: Opcode.Text, parent, node: joinFragments() };
    }

    if (typeof node.type === 'string') {
      // >>> Enter Node
      if (hooks[node.type]) node = hooks[node.type](node, context);
      yield { code: Opcode.EnterNode, parent, node };

      ancestors.push(node);
      pending.push({ code: Opcode.ExitNode, parent, node });
      if (traverseChildren) pending.push(node.children);
    } else if (node.code === Opcode.ExitNode) {
      // >>> Exit Node
      ancestors.pop();
      yield node;
    } else if (typeof node === 'function') {
      // >>> Apply Function
      let result = apply(node, null, [null, context]);
      if (result && typeof result.then === 'function') {
        result = await result;
      }
      pending.push(result);
    } else if (typeof node.type === 'function') {
      // >>> Apply vDOM Component
      let result = apply(node.type, node, [node, context]);
      if (result && typeof result.then === 'function') {
        result = await result;
      }
      pending.push(result);
    } else {
      throw Error(`Object "${node}" is not a view component`);
    }
  }

  if (hasFragments()) {
    yield {
      code: Opcode.Text,
      parent: ancestors[ancestors.length - 1],
      node: joinFragments(),
    };
  }
}