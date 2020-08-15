/* © 2020 Robert Grimm */

import { strict as assert } from 'assert';
import { constants } from 'http2';
import { escapeText } from '@grr/html/syntax';
import { isAbsolute } from 'path';
import MediaType from './media-type.js';
import parseDate from './date.js';
import { parsePath } from './path-util.js';
import pickle from '@grr/oddjob/pickle';
import { promises } from 'fs';
import { readOnlyView } from '@grr/oddjob/object';
import { settleable } from '../async/promise.js';
import { STATUS_CODES } from 'http';
import templatize from '@grr/temple';
import { types } from 'util';

const {
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,

  HTTP_STATUS_OK,
  HTTP2_HEADER_ACCEPT,
  HTTP2_HEADER_ACCESS_CONTROL_ALLOW_ORIGIN,
  HTTP2_HEADER_CONTENT_LENGTH,
  HTTP2_HEADER_CONTENT_TYPE,
  HTTP2_HEADER_IF_MODIFIED_SINCE,
  HTTP2_HEADER_IF_UNMODIFIED_SINCE,
  HTTP2_HEADER_LOCATION,
  HTTP2_HEADER_METHOD,
  HTTP2_HEADER_PATH,
  HTTP2_HEADER_STATUS,
  HTTP2_HEADER_STRICT_TRANSPORT_SECURITY,
  HTTP2_HEADER_X_CONTENT_TYPE_OPTIONS,
  HTTP2_HEADER_X_FRAME_OPTIONS,
  HTTP2_HEADER_X_XSS_PROTECTION,
  HTTP2_METHOD_HEAD,
} = constants;

// Yet for us there is but one markup language, HTML née HTML5,
// from which all text came and for which text exists.
const HTML_DOCUMENT = /^<!DOCTYPE html>/iu;
const HTTP2_HEADER_REFERRER_POLICY = 'referrer-policy';
const HTTP2_HEADER_X_PERMITTED_CROSS_DOMAIN_POLICIES =
  'x-permitted-cross-domain-policies';
const HTTP2_HEADER_X_POWERED_BY = 'x-powered-by';
const PRODUCTION = process.env.NODE_ENV === 'production';
const STATIC_CONTENT = Symbol('static-content');

const { byteLength, isBuffer } = Buffer;
const { create, entries: entriesOf, freeze } = Object;
const { isMediaType } = MediaType;
const { isNativeError } = types;
const { isSafeInteger } = Number;
const { readFile } = promises;

const Stage = freeze({
  Ready: Symbol('ready'),
  Responding: Symbol('responding'),
  Done: Symbol('done'),
});

// =============================================================================
// Helper Functions
// =============================================================================

const checkStatus = (min, status, max) =>
  assert(isSafeInteger(status) && min <= status && status <= max);

const HeaderUpdate = freeze({
  [HTTP2_HEADER_CONTENT_LENGTH](headers, value) {
    assert(isSafeInteger(value) && value >= 0);
    headers[HTTP2_HEADER_CONTENT_LENGTH] = value;
  },
  [HTTP2_HEADER_CONTENT_TYPE](headers, value) {
    const mediaType = !isMediaType(value) ? MediaType.from(value) : value;
    assert(mediaType != null && typeof mediaType === 'object');
    headers[HTTP2_HEADER_CONTENT_TYPE] = mediaType;
  },
  [HTTP2_HEADER_LOCATION](headers, value) {
    // Parsing the URL not only enforces wellformedness but also escapes
    // characters in the domain name and path as necessary.
    const url = new URL(value);
    headers[HTTP2_HEADER_LOCATION] = url.href;
  },
  [HTTP2_HEADER_STATUS](headers, value) {
    checkStatus(100, value, 599);
    headers[HTTP2_HEADER_STATUS] = value;
  },
});

// -----------------------------------------------------------------------------

let doFormatRedirect;
const formatRedirect = async data => {
  if (!doFormatRedirect) {
    const url = new URL('redirect.html', import.meta.url);
    doFormatRedirect = templatize({
      bindings: ['status', 'statusMessage', 'location'],
      source: await readFile(url, 'utf-8'),
      name: 'generate(redirect.html)',
    });
  }
  return doFormatRedirect(data);
};

let doFormatError;
const formatError = async data => {
  if (!doFormatError) {
    const url = new URL('error.html', import.meta.url);
    doFormatError = templatize({
      bindings: ['status', 'statusMessage', 'error', 'requestHeaders'],
      source: await readFile(url, 'utf-8'),
      name: 'generate(error.html)',
    });
  }
  if (data.requestHeaders && typeof data.requestHeaders === 'object') {
    data.requestHeaders = entriesOf(data.requestHeaders);
  }
  return doFormatError(data);
};

// =============================================================================
// Exchange State
// =============================================================================

/**
 * An HTTP request/response exchange. This class implements a thin veneer over
 * Node.js' HTTP/2 stream abstraction. It is loosely inspired by Koa.js, which
 * exposes a unified context object to middleware instead of the distinct
 * request and response objects exposed by Node.js and Express.js for HTTP/1.1.
 *
 * Since this class builds on HTTP/2 streams directly, it also is restricted to
 * that protocol version. In contrast, Koa.js builds on the request/response API
 * supported by both protocol versions. However, in case of HTTP/2, the
 * implementation comes with some overhead, since it is implemented on top of
 * the HTTP/2 stream API. It also diverges from the earlier API in some corner
 * cases, which is not surprising since the two versions have fundamentally
 * different network communications patterns.
 *
 * Each exchange goes through three user-discernible stages, from __Ready__ to
 * __Responding__ to __Done__. During the first stage, user-code inspects the
 * request and builds up the response headers and body. When done, it invokes
 * `redirect()`, `respond()`, or `fail()`, which transition the exchange into
 * the second stage and initiate I/O, including the transmission of the
 * response. Once the underlying stream has finished with the transmission, the
 * exchange enters the third and final stage.
 *
 * The implementation internally uses two more stages, __TryingIndexFile__ to
 * check for an `index.html` file when the request path names a directory and
 * __TryingDotHtml__ to check for a file with the `.html` extension when the
 * request path does not exist. While both states are necessary for
 * implementation correctness, they are refinements of the __Responding__ stage
 * and not exposed to user-code.
 */
export default class Exchange {
  #stage = Stage.Ready;
  #origin;
  #stream;
  #request;
  #method;
  #path;
  #endsInSlash;
  #accept = undefined;
  #response = create(null);
  #body = undefined;
  #didRespond;

  constructor({ origin, stream, headers }) {
    this.#origin = origin;
    this.#stream = stream;
    this.#request = headers;
    this.#method = this.#request[HTTP2_HEADER_METHOD];

    const { promise, resolve } = settleable();
    stream.on('close', () => {
      this.#stage = Stage.Done;
      resolve();
    });
    this.#didRespond = promise;

    try {
      const { path, endsInSlash } = parsePath(this.#request[HTTP2_HEADER_PATH]);
      this.#path = path;
      this.#endsInSlash = endsInSlash;
    } catch (x) {
      this.#path = '/.well-known/bad-path';
      this.fail(HTTP_STATUS_BAD_REQUEST, x);
    }
  }

  /**
   * Access the underlying Node.js HTTP/2 stream. This getter is an escape hatch
   * from this class to enable functionality, such as server-sent events, that
   * requires streaming the response instead of sending it in one chunk right
   * after the headers.
   */
  get stream() {
    return this.#stream;
  }

  // ===========================================================================
  // Middleware
  // ===========================================================================

  /** Handle this exchange with the given middleware handlers. */
  handleWith(...handlers) {
    let index = -1;

    const dispatch = step => {
      if (step <= index) throw new Error(`next() called repeatedly`);
      index = step;

      if (step < handlers.length) {
        const fn = handlers[step];
        return fn(this, dispatch.bind(null, step + 1));
      } else {
        return this.respond();
      }
    };

    return dispatch(0);
  }

  // ===========================================================================
  // The Three Stages of an Exchange
  // ===========================================================================

  /** Determine whether this exchange is in the initial ready stage. */
  isReady() {
    return this.#stage === Stage.Ready;
  }

  /** Determine whether this exchange is in the responding stage. */
  isResponding() {
    return this.#stage !== Stage.Ready && this.#stage !== Stage.Done;
  }

  /** Determine whether this exchange is done. */
  isDone() {
    return this.#stage === Stage.Done;
  }

  /** Return a promise that resolves once this exchange is done. */
  didRespond() {
    return this.#didRespond;
  }

  // ===========================================================================
  // Request Headers
  // ===========================================================================

  /** Get the server origin. */
  get origin() {
    return this.#origin;
  }

  /** Get the request method. */
  get method() {
    return this.#method;
  }

  /** Get the cleaned up request path. */
  get path() {
    return this.#path;
  }

  /**
   * Determine whether the raw request path ends in a slash. The cleaned up
   * path does not have a trailing slash.
   */
  get endsInSlash() {
    return this.#endsInSlash;
  }

  // ---------------------------------------------------------------------------

  /** Get the request */
  get request() {
    return this.#request;
  }

  /**
   * Determine the quality factor for the given media type. This method
   * implements the semantics of the `accept` header.
   */
  quality(type) {
    if (typeof type === 'string') {
      type = MediaType.from(type);
    }

    if (!this.#accept) {
      this.#accept = MediaType.parseAll(this.#request[HTTP2_HEADER_ACCEPT])
        .map(MediaType.create)
        .sort(MediaType.compare);
    }
    return type.matchForQuality(...this.#accept);
  }

  /**
   * Determine whether the resource has been modified. This method implements
   * the semantics of the `last-modified`, `if-modified-since`, and
   * `if-unmodified-since` headers.
   */
  isModified(lastModified) {
    let validator = parseDate(this.#request[HTTP2_HEADER_IF_MODIFIED_SINCE]);
    if (validator) {
      return lastModified > validator;
    }

    validator = parseDate(this.#request[HTTP2_HEADER_IF_UNMODIFIED_SINCE]);
    if (validator) {
      return lastModified <= validator;
    }

    return true;
  }

  // ===========================================================================
  // Response Headers
  // ===========================================================================

  /** Get a read-only view onto the response headers. */
  get response() {
    return readOnlyView(this.#response);
  }

  /** Get the value for the given response header. */
  getResponseHeader(name) {
    return this.#response[name];
  }

  /** Set the value for the given response header. */
  setResponseHeader(name, value) {
    assert(this.#stage !== Stage.Done);
    assert(name && typeof name === 'string');

    const setter = HeaderUpdate[name];
    if (setter) {
      setter(this.#response, value);
    } else {
      assert(typeof value === 'string');
      this.#response[name] = value;
    }

    return this;
  }

  /** Delete the given response header. */
  deleteResponseHeader(name) {
    assert(this.#stage !== Stage.Done);
    assert(name && typeof name === 'string');
    delete this.#response[name];
  }

  /** Clear all response headers. */
  clearResponseHeader() {
    assert(this.#stage !== Stage.Done);
    this.#response = create(null);
  }

  // ---------------------------------------------------------------------------

  /** Get the response status. */
  get status() {
    return this.#response[HTTP2_HEADER_STATUS];
  }

  /** Set the response status. */
  set status(value) {
    assert(this.#stage !== Stage.Done);
    HeaderUpdate[HTTP2_HEADER_STATUS](this.#response, value);
  }

  /** Get the content type. */
  get type() {
    return this.#response[HTTP2_HEADER_CONTENT_TYPE];
  }

  /** Set the content type. */
  set type(value) {
    assert(this.#stage !== Stage.Done);
    HeaderUpdate[HTTP2_HEADER_CONTENT_TYPE](this.#response, value);
  }

  /** Get the content length. */
  get length() {
    return this.#response[HTTP2_HEADER_CONTENT_LENGTH];
  }

  /** Set the content length. */
  set length(value) {
    assert(this.#stage !== Stage.Done);
    HeaderUpdate[HTTP2_HEADER_CONTENT_LENGTH](this.#response, value);
  }

  ooh() {
    assert(this.#stage !== Stage.Done);
    this.#response[HTTP2_HEADER_X_POWERED_BY] = 'George Soros';
    return this;
  }

  // ===========================================================================
  // Response Body
  // ===========================================================================

  /**
   * Get the body value. The value is either `undefined`, a buffer, or a
   * string.
   */
  getBody() {
    return this.#body;
  }

  /**
   * Set the body to the given value and update the content length and type
   * headers accordingly. If the given body value is `undefined` or `null`, it
   * denotes an absence of a body. In that case, this method ignores the type
   * argument and deletes the body as well as the content length and type
   * headers. Otherwise, the given body value must be a string or buffer. In
   * that case, this method updates the body as well as the content length and
   * type headers. Note that a zero-length string or buffer still denote the
   * presence of a body; it just happens to be empty. This method only works in
   * the ready stage.
   */
  body(value, type = MediaType.Binary) {
    assert(this.#stage === Stage.Ready);
    if (value == null) {
      this.#body = undefined;
      return this;
    }

    assert(typeof value === 'string' || isBuffer(value));
    this.#body = value;
    this.#response[HTTP2_HEADER_CONTENT_LENGTH] = byteLength(value);
    HeaderUpdate[HTTP2_HEADER_CONTENT_TYPE](this.#response, type);
    return this;
  }

  /**
   * Get the symbol indicating static content. If the body is an object whose
   * `type` property has this symbol as its value, then `path` possibly denotes
   * a file to be used for response body and `responder` is a function that
   * takes care of the logistics.
   */
  static get StaticContent() {
    return STATIC_CONTENT;
  }

  /**
   * Set the response body to the contents of the file with given path. Use the
   * given responder function to read the file from disk and write it to the
   * network. This method simply records the path and responder. It only works
   * in the ready stage. The `respond()` method then triggers the actual I/O by
   * invoking the responder.
   */
  file(path, responder) {
    assert(this.#stage === Stage.Ready);
    assert(typeof path === 'string' && isAbsolute(path));
    assert(typeof responder === 'function');

    this.#body = { type: STATIC_CONTENT, path, responder };
    return this;
  }

  /**
   * Set the response body to the given HTML value. This method also sets the
   * content length and type. It only works in the ready stage. The given HTML
   * string must start with the document type declaration for HTML5.
   */
  html(value) {
    assert(this.#stage === Stage.Ready);
    assert(typeof value === 'string' && HTML_DOCUMENT.test(value));

    this.#body = value;
    this.#response[HTTP2_HEADER_CONTENT_LENGTH] = byteLength(value);
    this.#response[HTTP2_HEADER_CONTENT_TYPE] = MediaType.HTML;
    return this;
  }

  /**
   * Serialize the given value to JSON and set the response body to the result.
   * This method also sets the content length and type. It only works in the
   * ready stage.
   */
  json(value, { stringify = pickle } = {}) {
    assert(this.#stage === Stage.Ready);

    this.#body = stringify(value);
    this.#response[HTTP2_HEADER_CONTENT_LENGTH] = byteLength(this.#body);
    this.#response[HTTP2_HEADER_CONTENT_TYPE] = MediaType.JSON;
    return this;
  }

  // ===========================================================================
  // Initiate I/O via Fail, Redirect, and Respond
  // ===========================================================================

  /**
   * Fail this exchange. The arguments are optional, with the status defaulting
   * to `500 Internal Server Error`. If this exchange is in the ready stage,
   * calling this method transitions it to the responding stage.
   */
  async fail(status = HTTP_STATUS_INTERNAL_SERVER_ERROR, error = undefined) {
    checkStatus(400, status, 599);
    if (error != null) assert(isNativeError(error));

    if (this.#stream.headersSent || this.#stage === Stage.Done) {
      return this.#didRespond;
    } else if (this.#stage === Stage.Ready) {
      this.#stage = Stage.Responding;
    }

    // The body.
    this.#body = await formatError({
      status,
      statusMessage: STATUS_CODES[status] ?? '',
      error: !PRODUCTION ? error : undefined,
      requestHeaders: !PRODUCTION ? this.#request : undefined,
    });

    // The headers.
    const headers = this.#response;
    headers[HTTP2_HEADER_CONTENT_LENGTH] = byteLength(this.#body);
    headers[HTTP2_HEADER_CONTENT_TYPE] = MediaType.HTML;
    headers[HTTP2_HEADER_STATUS] = status;

    // Prepare and send.
    this.prepare();
    this.send();
    return this.#didRespond;
  }

  // ---------------------------------------------------------------------------

  /**
   * Redirect the exchange. This method transitions from the ready to the
   * responding stage.
   */
  async redirect(status, location) {
    assert(this.#stage === Stage.Ready);
    this.#stage = Stage.Responding;

    checkStatus(300, status, 399);
    // Make sure location is well-formed and escape for response header.
    const sanitizedLocation = new URL(location).href;

    // The body.
    this.#body = await formatRedirect({
      status,
      statusMessage: STATUS_CODES[status] ?? '',
      // Escape the original location string for embedding in HTML.
      location: escapeText(location),
    });

    // The headers.
    const headers = this.#response;
    headers[HTTP2_HEADER_CONTENT_LENGTH] = byteLength(this.#body);
    headers[HTTP2_HEADER_CONTENT_TYPE] = MediaType.HTML;
    headers[HTTP2_HEADER_LOCATION] = sanitizedLocation;
    headers[HTTP2_HEADER_STATUS] = status;

    // Prepare and send.
    this.prepare();
    this.send();
    return this.#didRespond;
  }

  // ---------------------------------------------------------------------------

  /**
   * Respond to the request. If neither status nor body have been set, this
   * method responds with a `500 Internal Server Error`. If there is no body or
   * the body is not a file path, this method simply invokes `prepare()` and
   * `send()`. Finally, if the body is a file path, this method tries to respond
   * with the contents of the file at that path, at `path + "/index.html"` if
   * the path is a directory, and at `path + ".html"` if the path does not
   * exist. This method returns a promise for the completion of the exchange.
   */
  /* async */ respond() {
    if (this.#stage === Stage.Ready) {
      this.#stage = Stage.Responding;
    } else {
      return this.#didRespond;
    }

    const status = this.#response[HTTP2_HEADER_STATUS];
    const body = this.#body;

    if (status == null && body == null) {
      // If there is no status and no body, somebody didn't do their work.
      return this.fail(HTTP_STATUS_INTERNAL_SERVER_ERROR);
    } else if (body == null || typeof body === 'string' || isBuffer(body)) {
      // If there is no body or the body is a (byte) string, just send it.
      this.prepare();
      this.send();
      return this.#didRespond;
    }

    // Respond with file content.
    const { type, responder, path } = this.#body;
    assert(type === STATIC_CONTENT);
    responder(this, path);
    return this.#didRespond;
  }

  // ===========================================================================

  /** Prepare the response by filling in common headers. */
  prepare(headers = this.#response) {
    assert(this.#stage !== Stage.Ready && this.#stage !== Stage.Done);

    // Also see https://owasp.org/www-project-secure-headers/

    const type = headers[HTTP2_HEADER_CONTENT_TYPE];
    if (type.type === 'font') {
      // Enable CORS for font preloading to work.
      if (!headers[HTTP2_HEADER_ACCESS_CONTROL_ALLOW_ORIGIN]) {
        headers[HTTP2_HEADER_ACCESS_CONTROL_ALLOW_ORIGIN] = this.origin;
      }
    } else if (type.type === 'text' && type.subtype === 'html') {
      if (!headers[HTTP2_HEADER_REFERRER_POLICY]) {
        headers[HTTP2_HEADER_REFERRER_POLICY] = 'origin-when-cross-origin';
      }
      if (!headers[HTTP2_HEADER_X_FRAME_OPTIONS]) {
        headers[HTTP2_HEADER_X_FRAME_OPTIONS] = 'DENY';
      }
      if (!headers[HTTP2_HEADER_X_XSS_PROTECTION]) {
        headers[HTTP2_HEADER_X_XSS_PROTECTION] = '1; mode-block';
      }
    }

    if (!headers[HTTP2_HEADER_STRICT_TRANSPORT_SECURITY]) {
      headers[HTTP2_HEADER_STRICT_TRANSPORT_SECURITY] = `max-age=${
        // Limit recommended minimum of 120 days to production.
        (PRODUCTION ? 120 : 1) * 24 * 60 * 60
      }`;
    }
    if (!headers[HTTP2_HEADER_X_CONTENT_TYPE_OPTIONS]) {
      headers[HTTP2_HEADER_X_CONTENT_TYPE_OPTIONS] = 'nosniff';
    }
    if (!headers[HTTP2_HEADER_X_PERMITTED_CROSS_DOMAIN_POLICIES]) {
      headers[HTTP2_HEADER_X_PERMITTED_CROSS_DOMAIN_POLICIES] = 'none';
    }

    return headers;
  }

  // ---------------------------------------------------------------------------

  /** Send the response headers and body. */
  send(status = undefined) {
    assert(this.#stage !== Stage.Ready && this.#stage !== Stage.Done);

    // Fill in response status.
    this.#response[HTTP2_HEADER_STATUS] =
      status ?? this.#response[HTTP2_HEADER_STATUS] ?? HTTP_STATUS_OK;

    // Send response.
    const endStream = this.#method === HTTP2_METHOD_HEAD || this.#body == null;
    this.#stream.respond(this.#response, { endStream });
    if (endStream) return;

    if (typeof this.#body === 'string') {
      this.#stream.end(this.#body, 'utf8');
    } else {
      this.#stream.end(this.#body);
    }
  }
}
