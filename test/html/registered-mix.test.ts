// A registered custom property between two values: interpolated as the
// type its syntax names, a list item by item, and added as it, where an
// unregistered one goes over half-way (CSS Properties and Values 1, 2.6).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addRegistered,
  mixRegistered,
  mixesRegistered,
} from '../../src/html/css/registered-mix.js';

test('a registered property of a type that interpolates runs as that type', () => {
  assert.equal(mixRegistered('<length>', '100px', '200px', 0.5), '150px');
  assert.equal(mixRegistered('<number>', '0', '1', 0.25), '0.25');
  assert.equal(mixRegistered('<integer>', '0', '3', 0.5), '2');
  assert.equal(mixRegistered('<angle>', '0deg', '0.5turn', 0.5), '90deg');
  assert.equal(mixRegistered('<time>', '100ms', '1s', 0.5), '0.55s');
  assert.equal(
    mixRegistered('<length-percentage>', '100px', '100%', 0.5),
    'calc(50% + 50px)',
  );
  assert.equal(
    mixRegistered('<color>', 'rgb(100, 100, 100)', 'rgb(200, 200, 200)', 0.5),
    'rgb(150, 150, 150)',
  );
  // a list item by item, and one of another length not at all
  assert.equal(
    mixRegistered('<length>#', '0px, 10px', '10px, 20px', 0.5),
    '5px, 15px',
  );
  assert.equal(mixRegistered('<length>+', '0px', '10px 20px', 0.5), null);
  // a syntax that does not interpolate
  assert.equal(mixesRegistered('*'), false);
  assert.equal(mixesRegistered('<custom-ident>'), false);
  assert.equal(mixesRegistered('<length> | auto'), false);
});

test('a registered property adds as its type', () => {
  assert.equal(addRegistered('<length>', '100px', '50px'), '150px');
  assert.equal(
    addRegistered('<color>', 'rgb(100, 100, 100)', 'rgb(50, 50, 50)'),
    'rgb(150, 150, 150)',
  );
  assert.equal(addRegistered('<number>+', '1 2', '3 4'), '4 6');
});
