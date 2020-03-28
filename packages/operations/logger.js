/* © 2019–2020 Robert Grimm */

import { LEVELS, objectify, STYLES, toCount, toTime } from './format.js';
import { types } from 'util';

const BOLDED = /<b>(.*?)<\/b>/gu;
const configurable = true;
const { defineProperties, defineProperty, keys: keysOf } = Object;
const { has } = Reflect;
const { isArray } = Array;
const { isNativeError } = types;
const { stringify } = JSON;
const writable = true;

// -----------------------------------------------------------------------------

const createJSONLogger = ({ println, level, label }) => {
  const count = `${level}s`;

  const log = function log(message, detail) {
    this[count]++;

    let line = `{"timestamp":"${new Date().toISOString()}",`;
    if (label) line += `"label":"${label}",`;
    line += `"level":"${level}",`;
    line += `"message":${stringify(message)}`;
    if (detail) line += `,"detail":${stringify(objectify(detail))}`;
    line += `}`;

    println(line);
  };

  defineProperty(log, 'name', {
    configurable,
    value: level,
  });

  return log;
};

const signOffJSON = function signOff({ files, duration }) {
  const { errors, warnings } = this;
  const details = { files, duration, errors, warnings };
  const method = errors ? 'error' : warnings ? 'warning' : 'success';
  this[method](`site:forge is done`, details);
};

// -----------------------------------------------------------------------------

const createTextLogger = ({
  println,
  formatPrimary,
  formatDetail,
  level,
  label,
}) => {
  const count = `${level}s`;
  const status = `${label ? ` ${label}` : ``} [${LEVELS[level].display}] `;
  const log = function log(message, detail) {
    this[count]++;

    const timestamp = new Date().toISOString();
    message = status + message;

    let extraLines;
    if (isNativeError(detail) || detail instanceof Error) {
      // Check stack even if formatDetail is null...
      extraLines = detail.stack.split(/\r?\n/u);
      if (extraLines.length === 1) {
        // Since we hoist error message if stack trace is missing.
        message += ': ' + detail.message;
        // FIXME: Check for cause
        extraLines = null;
      } else {
        extraLines[0] = detail.message;
      }
    } else if (
      formatDetail == null ||
      detail == null ||
      typeof detail !== 'object'
    ) {
      extraLines = null;
    } else if (isArray(detail)) {
      extraLines = detail.map(String);
    } else {
      const keys = keysOf(detail);
      const width = keys.reduce((w, n) => (n.length > w ? n.length : w), 0);
      extraLines = keys.map(
        key => `${key.padEnd(width)}: ${stringify(detail[key])}`
      );
    }

    println(timestamp + formatPrimary(message));
    if (formatDetail && extraLines) {
      const indent = ''.padEnd(timestamp.length + 1);
      for (const line of extraLines) {
        println(indent + formatDetail(line));
      }
    }
  };

  defineProperty(log, 'name', {
    configurable,
    value: level,
  });

  return log;
};

const signOffText = function signOff({ files, duration }) {
  let { errors, warnings } = this;
  let message =
    'site:forge processed ' +
    toCount(files, 'file') +
    ' in ' +
    toTime(duration);

  if (errors) {
    message += ` with ${toCount(errors, 'error')}`;
    if (warnings) message += ` and ${toCount(warnings, 'warning')}`;
    this.error(message);
  } else if (warnings) {
    message += ` with ${toCount(warnings, 'warning')}`;
    this.warning(message);
  } else {
    this.success(message);
  }
};

// -----------------------------------------------------------------------------

export default function Logger(options = {}) {
  if (!new.target) return new Logger(options);

  const { env } = process;
  const {
    json = false,
    label,
    println = console.error,
    stylish = !has(env, 'NODE_DISABLE_COLORS') && !has(env, 'NO_COLOR'),
    volume = 0,
  } = options;

  const formatBold = stylish ? STYLES.bold : STYLES.plain;
  const formatDetail =
    volume < LEVELS['info'] ? null : stylish ? STYLES.faint : STYLES.plain;

  for (const level of keysOf(LEVELS)) {
    const descriptor = LEVELS[level];

    if (volume < descriptor.volume) {
      defineProperty(this, level, { configurable, value: () => {} });
    } else {
      const logger = (json ? createJSONLogger : createTextLogger)({
        println,
        label,
        level,
        formatPrimary: stylish ? descriptor.format : STYLES.plain,
        formatDetail,
      });
      defineProperty(this, level, { configurable, value: logger });
    }

    defineProperty(this, `${level}s`, { configurable, writable, value: 0 });
  }

  defineProperties(this, {
    embolden: {
      configurable,
      value: s => s.replace(BOLDED, (_, span) => formatBold(span)),
    },
    newline: {
      configurable,
      value: () => println(),
    },
    signOff: {
      configurable,
      value: json ? signOffJSON : signOffText,
    },
  });
}
