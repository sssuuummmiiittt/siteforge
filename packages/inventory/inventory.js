/* © 2020 Robert Grimm */

import { posix } from 'path';
import { readFile, writeFile, writeVersionedFile } from '@grr/fs';
import { runInNewContext } from 'vm';
import { strict } from 'assert';

const { extname, join, parse } = posix;
const FRONT_OPEN = /\s*(<!--.*?--!>\s*)?<script[^>]*>/u;
const FRONT_CLOSE = '</script>';
const { parse: parseJson, stringify: stringifyJson } = JSON;
const SLASH = '/'.charCodeAt(0);

const NOTICE = new RegExp(
  `^` + // Start at the beginning.
  `(?:#![^\\r?\\n]*\\r?\\n)?` + // Ignore the hashbang if present.
  `\\s*` + // Also ignore any space if present.
  `(?:` + // Match either just a multi-line comment or 1+ single-line comments.
  `(?:\\/\\*` + // Multi-line comment it is.
  `[\\n\\s*_=-]*` + // Ignore any number of spacing or "decorative" characters.
  `((?:\\(c\\)|©|copyright).*?)` + // Extract the copyright notice.
  `[\\n\\s*_=-]*` + // Again, ignore spacing or decorative characters.
  `\\*\\/)` + // Until we reach end of comment: It's safe to split content here.
  `|(?:\\/\\/[\\s*_=-]*\\n)*` + // Or: Single-line comments its is.
    `(?:\\/\\/((?:\\(c\\)|©|copyright).*?)(\\n|$)))`, // Again, extract notice.
  'iu' // Oh yeah, ignore case and embrace the Unicode.
);

// =============================================================================

class File {
  static extension(path) {
    let { name, ext } = parse(path);
    let ext2;
    if (ext === '.js') {
      ext2 = extname(name);
      if (ext2) {
        ext = ext2 + ext;
      }
    }
    return ext;
  }

  static kind(extension) {
    return {
      '.css': 'style',
      '.data.js': 'data',
      '.gif': 'image',
      '.htm': 'markup',
      '.html': 'markup',
      '.jpg': 'image',
      '.jpeg': 'image',
      '.js': 'script',
      '.png': 'image',
      '.sh': 'ignore',
      '.txt': 'etc', // robots.txt
      '.webmanifest': 'etc', // PWA
      '.webp': 'image',
      '.woff': 'font',
      '.woff2': 'font',
    }[extension];
  }

  static frontMatter(path, content) {
    strict.equal(typeof content, 'string');
    const match = content.match(FRONT_OPEN);
    if (match == null) return { content };

    const start = match[0].length;
    const end = content.indexOf(FRONT_CLOSE);
    if (end === -1) {
      throw new Error(`front matter for "${path}" has no closing tag`);
    }

    const metadata = runInNewContext(
      `(${content.slice(start, end)})`,
      undefined, // create fresh sandbox
      {
        filename: path,
        displayErrors: true,
        contextCodeGeneration: {
          strings: false, // no eval()
          wasm: false, // no wasm
        },
      }
    );

    if (metadata == null || typeof metadata !== 'object') {
      throw new Error(`front matter for "${path}" is not an object`);
    }

    content = content.slice(end + FRONT_CLOSE.length).trim();
    return { content, metadata };
  }

  static copyrightNotice(path, content) {
    const [prefix, notice] = this.#content.match(NOTICE) || [];
    if (!prefix) return { content };
    return { notice: notice.trim(), content: content.slice(prefix.length) };
  }

  // ---------------------------------------------------------------------------

  #content;
  #extension;
  #kind;
  #path;
  #props;
  #source;

  constructor(path, properties) {
    strict.equal(typeof path, 'string');

    const { content, source } = properties;
    this.#content = content;
    this.#extension = File.extension(path);
    this.#kind = File.kind(this.#extension);
    this.#path = path;
    this.#source = source;
    this.#props = properties;
  }

  get content() {
    return this.#content;
  }

  get extension() {
    return this.#extension;
  }

  get kind() {
    return this.#kind;
  }

  get path() {
    return this.#path;
  }

  get source() {
    return this.#source;
  }

  under(newroot) {
    return join(newroot, this.#path.slice(1));
  }

  async read(options = 'utf8') {
    // Options: add json encoding, which decays to utf8 for system call.
    let json = false;
    if (options === 'json') {
      options = 'utf8';
      json = true;
    } else if (options && options.encoding === 'json') {
      options.encoding = 'utf8';
      json = true;
    }

    // Actually read the file contents and post-process.
    let content = await readFile(this.#source, options);
    if (typeof content === 'string' && content.charCodeAt(0) === 0xfeff) {
      // Eliminate any byte order mark.
      content = content.slice(1);
    }
    if (json) {
      // Parse any JSON.
      content = parseJson(content);
    }

    // Done.
    this.#content = content;
    return content;
  }

  frontMatter() {
    const { content, metadata } = File.frontMatter(this.#path, this.#content);
    this.#content = content;
    this.metadata = metadata;
    return this;
  }

  async process(mapper) {
    this.#content = await mapper(this.#content);
    return this;
  }

  async processWithCopyright(mapper) {
    const { notice, content } = File.copyrightNotice(this.#path, this.#content);
    if (!notice) {
      this.#content = await mapper(content);
    } else {
      this.#content = `/* ${notice} */ ${await mapper(content)}`;
    }
    return this;
  }

  async write(path, options) {
    if (options.versioned) {
      await writeVersionedFile(path, this.#content, options);
    } else {
      await writeFile(path, this.#content, options);
    }
    return this;
  }

  toString() {
    return `File(${this.#path})`;
  }
}

// =============================================================================

class Directory {
  static is(value) {
    return value instanceof Directory;
  }

  #inventory;
  #path;
  #entries;

  constructor(parent, name) {
    this.#entries = new Map();
    this.#entries.set('.', this);

    if (!Directory.is(parent)) {
      this.#inventory = parent;
      this.#entries.set('..', this);
      this.#path = '/';
    } else {
      this.#inventory = parent.#inventory;
      this.#entries.set('..', parent);
      parent.#entries.set(name, this);
      this.#path = join(parent.#path, name);
    }
  }

  // prettier-ignore
  get path() { return this.#path; }

  lookup(
    path,
    { fillInMissingSegments = false, validateLastSegment = false } = {}
  ) {
    strict.equal(typeof path, 'string');

    if (path === '/') return this.#inventory.root;

    let segments, cursor;
    if (path.charCodeAt(0) === SLASH) {
      segments = path.split('/').slice(1);
      cursor = this.#inventory.root;
    } else {
      segments = path.split('/');
      cursor = this;
    }

    for (let index = 0; index < segments.length; index++) {
      const name = segments[index];

      if (cursor.#entries.has(name)) {
        const skip = index < segments.length - 1 || !validateLastSegment;
        const entry = cursor.#entries.get(name);

        if (skip || Directory.is(entry)) {
          cursor = entry;
        } else {
          throw new Error(
            `entry "${name}" in directory "${cursor.#path}" is not a directory`
          );
        }
      } else if (fillInMissingSegments) {
        cursor = new Directory(cursor, name);
      } else {
        throw new Error(
          `entry "${name}" in directory "${cursor.#path}" does not exist`
        );
      }
    }

    return cursor;
  }

  addFile(name, data = {}) {
    if (this.#entries.has(name)) {
      throw new Error(
        `entry "${name}" in directory "${this.#path}" already exists`
      );
    }

    const file = new File(join(this.#path, name), data);
    this.#entries.set(name, file);
    this.#inventory.index(file);
    return file;
  }

  toJSON() {
    const entries = {};
    for (const [name, value] of this.#entries) {
      if (name !== '.' && name !== '..') {
        if (Directory.is(value)) {
          entries[name] = value.toJSON();
        } else {
          entries[name] = value.toString();
        }
      }
    }
    return entries;
  }

  toString() {
    return stringifyJson(this.toJSON(), null, 2);
  }
}

// =============================================================================

export default class Inventory {
  static create() {
    return new Inventory();
  }

  #root;
  #byKind;
  #renamed;

  constructor() {
    this.#root = new Directory(this);

    const init = () => new Map();
    this.#byKind = {
      data: init(),
      etc: init(),
      font: init(),
      image: init(),
      markup: init(),
      script: init(),
      style: init(),
    };

    this.#renamed = {
      from: init(),
      to: init(),
    };
  }

  get root() {
    return this.#root;
  }

  lookup(path, options) {
    return this.#root.lookup(path, options);
  }

  addFile(path, data = {}) {
    const { dir, base } = parse(path);
    return this.#root
      .lookup(dir, { fillInMissingSegments: true, validateLastSegment: true })
      .addFile(base, data);
  }

  index(file) {
    const { kind } = file;
    if (kind && kind !== 'ignore') {
      this.#byKind[kind].set(file.path, file);
    }
    return this;
  }

  *byKind(...kinds) {
    for (const kind of kinds) {
      yield* this.#byKind[kind];
    }
  }

  toString() {
    return stringifyJson({ '/': this.#root.toJSON() }, null, 2);
  }
}