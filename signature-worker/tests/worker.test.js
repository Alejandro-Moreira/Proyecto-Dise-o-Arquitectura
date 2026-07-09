'use strict';

const { getDeathCount } = require('../index');

describe('Signature Worker getDeathCount helper', () => {
  test('devuelve 0 si no hay headers de x-death', () => {
    const msg = {
      properties: {
        headers: {}
      }
    };
    expect(getDeathCount(msg)).toBe(0);
  });

  test('devuelve 0 si x-death está vacío', () => {
    const msg = {
      properties: {
        headers: {
          'x-death': []
        }
      }
    };
    expect(getDeathCount(msg)).toBe(0);
  });

  test('calcula la suma correcta si hay entradas de x-death', () => {
    const msg = {
      properties: {
        headers: {
          'x-death': [
            { count: 2 },
            { count: 1 }
          ]
        }
      }
    };
    expect(getDeathCount(msg)).toBe(3);
  });
});
