/* © 2020 Robert Grimm */

import Call from '@grr/loader/call';
import { filePath, fileURL } from '@grr/loader';
import launch from '@grr/loader/launch';
import { fileURLToPath } from 'url';
import harness from './harness.js';
import invoke, { returnOrThrow } from '@grr/loader/invoke';

const { assign } = Object;
const DUMMY = new URL('./dummy.js', fileURL).href;
const DummyHash = n => `${DUMMY}#${n}`;
const LOADER_TEST = fileURLToPath(import.meta.url);

function main() {
  harness.test('@grr/loader', async t => {
    t.test('call', async t => {
      // ------------------------------------------------------------ new Call()
      t.throws(() => new Call());
      t.throws(() => new Call(665));

      // -- Call.Request.is, Call.Request.to, Call.Response.is, Call.Response.to
      const log = [];
      const call = new Call({
        billy: data => {
          log.push({ command: 'billy', data });
          return { data };
        },
        silly: data => {
          throw new Error(`data is ${data}`);
        },
      });

      t.ok(!Call.Request.is('@grr/rollcall'));
      t.ok(Call.Request.is('@grr/loader/invoke/almostTheBeast/665'));

      t.throws(() => Call.Request.to('boo'));
      t.same(Call.Request.to('@grr/loader/invoke/commandissimo'), {});
      t.same(Call.Request.to('@grr/loader/invoke/commando/"conquer"'), {
        command: 'commando',
        data: 'conquer',
      });

      t.ok(!Call.Response.is('https://apparebit.com'));
      t.ok(Call.Response.is(DummyHash(123)));

      t.same(Call.Response.to({ beastly: 665 }), {
        source: `export default {"beastly":665};`,
      });

      // ------------------------------------------------------- returnOrThrow()
      t.throws(() => returnOrThrow(), /^Malformed XPC response "undefined"/u);
      t.throws(() => returnOrThrow(null), /^Malformed XPC response "null"/u);
      t.throws(() => returnOrThrow(665), /^Malformed XPC response "665"/u);
      t.throws(
        () => returnOrThrow({ what: 42, ever: 13 }),
        /^Malformed XPC response "\[object Object\]"/u
      );
      t.throws(() => returnOrThrow({ error: 'boo!' }), /^boo!/u);
      t.throws(
        () => returnOrThrow({ error: 'boo!', stack: 'empty' }),
        /^boo!/u
      );
      t.is(returnOrThrow({ value: 665 }), 665);

      // ---------------------------------------------------- @grr/loader/invoke
      const request = async specifier =>
        (await call.handleRequest(specifier)).url;
      const response = num => call.handleResponse(DummyHash(num)).source;

      t.is(await request('@grr/loader/invoke/billy'), DummyHash(1));
      t.is(await request('@grr/loader/invoke/frilly/13'), DummyHash(2));
      t.is(await request('@grr/loader/invoke/billy/665'), DummyHash(3));
      t.is(await request('@grr/loader/invoke/silly/665'), DummyHash(4));

      t.is(
        response(1),
        `export default ` +
          `{"error":"Malformed XPC request \\"@grr/loader/invoke/billy\\""};`
      );

      t.is(
        response(2),
        `export default ` +
          `{"error":"XPC command \\"frilly\\" is not implemented"};`
      );

      t.is(response(3), `export default ` + `{"value":{"data":665}};`);
      t.ok(response(4).startsWith(`export default {"error":"data is 665"`));

      t.end();
    });

    let { default: status } = await import('@grr/loader/status');
    t.is(status, 'no loader');

    const { execPath: node } = process;
    t.spawn(node, [`--experimental-loader=${filePath}`, LOADER_TEST], {
      env: assign({ GRR_LOADER_LAUNCH_TEST: true }, process.env),
    });

    t.end();
  });
}

function withLoader() {
  harness.test('@grr/loader/invoke', async t => {
    let status = await import('@grr/loader/status');
    t.is(status.default, '@grr/loader');

    t.same(await invoke('ping', 665), { pong: 665 });
    t.same(await invoke('ping', { ping: 42 }), { pong: { ping: 42 } });
    t.rejects(invoke('fail', 'boohoo'));
    t.rejects(invoke('it-the-program-that-must-not-be-named'));

    t.end();
  });
}

if (!process.env.GRR_LOADER_LAUNCH_TEST) {
  main();
} else {
  launch({ fn: withLoader });
}
